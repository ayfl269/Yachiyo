/**
 * TaskScheduler: periodically checks for due scheduler tasks and fires them
 * by delivering proactive messages to the user via the platform adapter.
 *
 * Two-phase firing mechanism (model-first, system-fallback):
 *
 * Phase 1 — Pre-fire (model path):
 *   When a task's next_fire_at falls within the pre-fire window (default
 *   60s before due), the task is marked "notifying" and the onPreFire
 *   callback is invoked. The callback injects a system event into the
 *   pipeline so the model can generate a natural reminder. When the
 *   model responds, the onResponded callback marks the task as fired,
 *   preventing the fallback. The model is also expected to delete the
 *   task via the scheduler tool to prevent accumulation.
 *
 * Phase 2 — Fallback (direct path):
 *   If the task reaches its strict due time while still in "notifying"
 *   status (model didn't respond in time), or if no onPreFire callback
 *   is configured, the task fires directly: a raw reminder message is
 *   pushed via adapter.sendProactiveMessage(), bypassing the model.
 */

import type { SqliteSchedulerTaskStore, SchedulerTask } from "@yachiyo/agent/scheduler-task-store.js";
import type { AdapterRegistry } from "@yachiyo/platform/registry.js";
import { ComponentType, type PlainComponent, type MessageComponent } from "@yachiyo/message/components.js";

export interface TaskSchedulerConfig {
  /** Check interval in milliseconds. Default: 30000 (30s). */
  interval?: number;
  /** Whether the scheduler is enabled. Default: true. */
  enabled?: boolean;
  /** Pre-fire window in milliseconds. Tasks within this window before
   *  their next_fire_at are sent to the model early. Default: 60000 (60s). */
  preFireWindow?: number;
  /**
   * Dynamic pre-fire window resolver. When set, called per-task during
   * {@link tick} to determine the pre-fire window for that specific task.
   *
   * This lets callers vary the window by provider — e.g. a longer
   * window (90s) for reasoning models whose first token may take
   * 30-60s, vs. a shorter window (15s) for fast chat models. The
   * resolver can look up the session's provider via the task's UMO
   * (caller-side; this module stays decoupled from the pipeline).
   *
   * When the resolver returns 0, pre-fire is disabled for that task
   * and it falls straight through to the fallback (direct fire) path.
   * When the resolver itself is undefined, the static
   * {@link preFireWindow} value is used for all tasks.
   */
  preFireWindowResolver?: (task: SchedulerTask) => number;
}

/** Callback invoked when a task enters the pre-fire window. */
export type OnPreFireCallback = (task: SchedulerTask) => void;

const DEFAULT_INTERVAL = 30_000;
const DEFAULT_PREFIRE_WINDOW = 60_000;

/**
 * Query horizon used for the pre-fire candidate query when a
 * {@link TaskSchedulerConfig.preFireWindowResolver} is configured (see the
 * comment in {@link TaskScheduler.tick}). Tasks are few (user-created
 * reminders), so scanning 24h of pending tasks per tick is cheap; the
 * per-task window re-check guarantees nothing fires earlier than its own
 * resolved window allows.
 */
const RESOLVER_SCAN_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * Delivery-failure retry policy for the fallback fire path (#86): a task
 * whose delivery failed is retried with exponential backoff
 * (interval * 2^failures, capped at {@link FIRE_RETRY_BACKOFF_MAX_MS}).
 * After {@link MAX_FIRE_ATTEMPTS} consecutive failures the task is marked
 * fired anyway (with an error log) so a permanently broken route cannot
 * retry forever.
 */
const MAX_FIRE_ATTEMPTS = 5;
const FIRE_RETRY_BACKOFF_MAX_MS = 10 * 60 * 1000;

export class TaskScheduler {
  private store: SqliteSchedulerTaskStore;
  private adapterRegistry: AdapterRegistry | null;
  private interval: number;
  private enabled: boolean;
  private preFireWindow: number;
  private preFireWindowResolver: ((task: SchedulerTask) => number) | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: boolean = false;
  /**
   * Consecutive delivery failures per task id (#86), used to throttle
   * retries of the fallback fire path (exponential backoff) and to give up
   * after {@link MAX_FIRE_ATTEMPTS} attempts so a permanently broken route
   * cannot retry forever.
   */
  private fireFailures: Map<string, { count: number; lastAttemptAt: number }> = new Map();

  /** Callback for pre-fire events. When set, tasks in the pre-fire window
   *  are sent to the model instead of firing directly. */
  onPreFire: OnPreFireCallback | null = null;

  constructor(
    store: SqliteSchedulerTaskStore,
    config?: TaskSchedulerConfig,
    adapterRegistry?: AdapterRegistry,
  ) {
    this.store = store;
    this.adapterRegistry = adapterRegistry ?? null;
    this.interval = config?.interval ?? DEFAULT_INTERVAL;
    this.enabled = config?.enabled ?? true;
    this.preFireWindow = config?.preFireWindow ?? DEFAULT_PREFIRE_WINDOW;
    this.preFireWindowResolver = config?.preFireWindowResolver ?? null;
  }

  /** Set the adapter registry (used for proactive message delivery). */
  setAdapterRegistry(registry: AdapterRegistry): void {
    this.adapterRegistry = registry;
  }

  start(): void {
    if (this.timer) return;
    if (!this.enabled) {
      console.log("[TaskScheduler] Disabled, not starting periodic check.");
      return;
    }
    this.timer = setInterval(() => this.tick(), this.interval);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
    console.log(`[TaskScheduler] Started (interval: ${this.interval}ms, preFireWindow: ${this.preFireWindow}ms${this.preFireWindowResolver ? ", resolver: enabled" : ""}).`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[TaskScheduler] Stopped.");
    }
  }

  updateConfig(config: TaskSchedulerConfig): void {
    const wasRunning = this.timer !== null;
    this.stop();
    if (config.interval !== undefined) this.interval = config.interval;
    if (config.enabled !== undefined) this.enabled = config.enabled;
    if (config.preFireWindow !== undefined) this.preFireWindow = config.preFireWindow;
    if (config.preFireWindowResolver !== undefined) this.preFireWindowResolver = config.preFireWindowResolver;
    if (wasRunning) this.start();
  }

  /**
   * Resolve the pre-fire window for a specific task. Uses
   * {@link preFireWindowResolver} when configured, otherwise falls back
   * to the static {@link preFireWindow}.
   */
  private resolvePreFireWindow(task: SchedulerTask): number {
    if (this.preFireWindowResolver) {
      try {
        const resolved = this.preFireWindowResolver(task);
        if (resolved >= 0) return resolved;
      } catch (e) {
        console.warn(`[TaskScheduler] preFireWindowResolver threw for task ${task.id}, falling back to default:`, e);
      }
    }
    return this.preFireWindow;
  }

  /** Process all due tasks now. Exposed for testing/manual triggers. */
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    let prefired = 0;
    let fired = 0;
    let skipped = 0;
    try {
      const now = new Date();

      // Phase 1: Pre-fire — send tasks to the model within the window.
      // Pre-fire window is resolved per-task so callers can vary it by
      // provider (reasoning models need a longer window than fast chat
      // models). We use the broadest window across all tasks for the
      // getPreFireTasks query (broadest candidate set), then
      // individually re-check each returned task against its own
      // resolved window before firing.
      if (this.onPreFire) {
        // The query window must be the UNION of the static window and every
        // per-task resolver window. The resolver output is only known per
        // task, and candidate tasks are only known after the query, so we
        // cannot size the query from resolver values directly. When a
        // resolver is configured we therefore scan a generous fixed horizon
        // and rely on the per-task re-check below to narrow it back down:
        // each task is only pre-fired if it is within its OWN resolved
        // window. This replaces the old `Math.max(x, 2x)` heuristic, which
        // was always 2x (silently dropping tasks whose resolver window
        // exceeded 2x) and completely disabled pre-fire when
        // preFireWindow = 0. Note preFireWindow=0 with a resolver now still
        // pre-fires tasks whose resolver window is > 0 — resolver=0 still
        // routes those tasks straight to the fallback path.
        const queryWindow = this.preFireWindowResolver
          ? RESOLVER_SCAN_HORIZON_MS
          : this.preFireWindow;
        if (queryWindow > 0) {
          const preFireTasks = this.store.getPreFireTasks(now, queryWindow);
          for (const task of preFireTasks) {
            try {
              // Per-task window check: only pre-fire if the task is within
              // its OWN resolved window. This narrows the broad query above
              // back down to the per-task setting.
              const taskWindow = this.resolvePreFireWindow(task);
              if (taskWindow <= 0) continue;
              if (task.nextFireAt) {
                const dueMs = new Date(task.nextFireAt).getTime() - now.getTime();
                if (dueMs > taskWindow) continue;
              }
              // Atomically transition pending → notifying
              const marked = this.store.markNotifying(task.id);
              if (!marked) continue; // Already advanced by another path
              this.onPreFire(task);
              prefired++;
              console.log(`[TaskScheduler] Pre-fired task "${task.title}" (${task.id}) to model (window=${taskWindow}ms).`);
            } catch (e) {
              console.error(`[TaskScheduler] Error pre-firing task ${task.id}:`, e);
            }
          }
        }
      }

      // Phase 2: Fallback — fire tasks that are due (including those still
      // in "notifying" status, meaning the model didn't respond in time)
      const dueTasks = this.store.getDueTasks(now);
      for (const task of dueTasks) {
        try {
          const ok = await this.fireTask(task);
          if (ok) {
            fired++;
          } else {
            skipped++;
          }
        } catch (e) {
          console.error(`[TaskScheduler] Error firing task ${task.id}:`, e);
          // Task stays un-marked: fireTask's failure throttle/backoff (#86)
          // decides when it is retried or given up on, instead of losing the
          // reminder by marking it fired on the first error.
          skipped++;
        }
      }
    } catch (e) {
      console.error("[TaskScheduler] Error during tick:", e);
    } finally {
      this.ticking = false;
    }
    if (prefired > 0 || fired > 0 || skipped > 0) {
      console.log(`[TaskScheduler] Tick complete: ${prefired} pre-fired, ${fired} fired, ${skipped} skipped.`);
    }
  }

  /**
   * Fire a single task: build a reminder message and push it directly to
   * the user via the platform adapter's proactive message channel.
   *
   * This is the fallback path — it fires when the model didn't respond
   * in time (task is still "notifying") or when no pre-fire callback
   * is configured (task is still "pending").
   *
   * Delivery-first ordering (#86): the task is only marked fired AFTER the
   * message was delivered successfully, so a failed delivery keeps the task
   * due and it is retried on a later tick. Retries are throttled with
   * exponential backoff ({@link MAX_FIRE_ATTEMPTS} /
   * {@link FIRE_RETRY_BACKOFF_MAX_MS}) to prevent an infinite retry storm.
   *
   * Returns true if the message was delivered, false if it was skipped,
   * throttled, or the delivery failed (task retained for retry).
   */
  private async fireTask(task: SchedulerTask): Promise<boolean> {
    // Retry throttle: skip this tick if the task failed recently and its
    // backoff window has not elapsed yet.
    const failure = this.fireFailures.get(task.id);
    if (failure) {
      const backoff = Math.min(this.interval * 2 ** failure.count, FIRE_RETRY_BACKOFF_MAX_MS);
      if (Date.now() - failure.lastAttemptAt < backoff) {
        return false;
      }
    }

    /** Record a failed attempt; give up (mark fired) after too many tries. */
    const markAttemptFailed = (): void => {
      const count = (this.fireFailures.get(task.id)?.count ?? 0) + 1;
      this.fireFailures.set(task.id, { count, lastAttemptAt: Date.now() });
      if (count >= MAX_FIRE_ATTEMPTS) {
        console.error(
          `[TaskScheduler] Task ${task.id} failed to deliver ${count} times, giving up and marking as fired.`,
        );
        this.store.markFired(task.id, new Date());
        this.fireFailures.delete(task.id);
      }
    };

    // Build the user-facing reminder text
    const messageText = buildReminderMessage(task);

    // Need routing info to deliver
    if (!task.umo || !task.platformId) {
      console.warn(`[TaskScheduler] Task ${task.id} has no routing info (umo/platformId), skipping delivery.`);
      markAttemptFailed();
      return false;
    }

    // Look up the adapter that owns this session
    if (!this.adapterRegistry) {
      console.warn(`[TaskScheduler] No adapter registry available, cannot deliver task ${task.id}.`);
      markAttemptFailed();
      return false;
    }

    const adapter = this.adapterRegistry.getAdapter(task.platformId);
    if (!adapter) {
      console.warn(`[TaskScheduler] Adapter "${task.platformId}" not found for task ${task.id}.`);
      markAttemptFailed();
      return false;
    }

    // Build message component
    const components: PlainComponent[] = [{
      type: ComponentType.Plain,
      text: messageText,
      toDict() { return { type: "text", data: { text: messageText } }; },
    }];

    // 路由信息：umo 用于平台解析，sessionId 用于查找会话连接
    const target = {
      umo: task.umo,
      sessionId: task.sessionId ?? task.umo,
      platformId: task.platformId,
    };

    try {
      const delivered = await adapter.sendProactiveMessage(target, components as MessageComponent[]);
      if (delivered) {
        // Delivery succeeded — only now advance the task (#86). The
        // conditional WHERE in markFired prevents double-advancing if
        // the model already responded and called markFired via onResponded.
        this.fireFailures.delete(task.id);
        this.store.markFired(task.id, new Date());
        console.log(`[TaskScheduler] Task "${task.title}" (${task.id}) delivered to ${target.umo}.`);
      } else {
        // Delivery rejected (session may be inactive) — keep the task due
        // and retry on a later tick with backoff.
        console.warn(`[TaskScheduler] Task "${task.title}" (${task.id}) delivery returned false (session may be inactive); will retry.`);
        markAttemptFailed();
      }
      return delivered;
    } catch (e) {
      console.error(`[TaskScheduler] Failed to deliver task ${task.id}:`, e);
      markAttemptFailed();
      return false;
    }
  }
}

/**
 * Build the user-facing reminder message text.
 * This is what the user sees when the task fires — NOT the internal
 * instruction format fed to the agent.
 */
function buildReminderMessage(task: SchedulerTask): string {
  const lines: string[] = [];

  const typeLabel: Record<string, string> = {
    reminder: "提醒",
    scheduled: "定时任务",
    recurring: "周期任务",
    goal: "任务目标",
    plan: "执行计划",
  };

  const label = typeLabel[task.type] ?? "任务";
  lines.push(`[${label}] ${task.title}`);

  if (task.description) {
    lines.push(task.description);
  }
  if (task.payload) {
    lines.push(task.payload);
  }
  if (task.goal) {
    lines.push(`目标：${task.goal}`);
  }
  if (task.plan.length > 0) {
    lines.push(`计划进度 (步骤 ${task.currentStep + 1}/${task.plan.length})：`);
    for (let i = 0; i < task.plan.length; i++) {
      const marker = i === task.currentStep ? ">" : " ";
      const step = task.plan[i];
      lines.push(`  ${marker} [${step.status}] ${step.description}`);
    }
  }

  return lines.join("\n");
}
