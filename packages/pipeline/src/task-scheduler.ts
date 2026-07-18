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

export class TaskScheduler {
  private store: SqliteSchedulerTaskStore;
  private adapterRegistry: AdapterRegistry | null;
  private interval: number;
  private enabled: boolean;
  private preFireWindow: number;
  private preFireWindowResolver: ((task: SchedulerTask) => number) | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: boolean = false;

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
      // models). We use the max window across all tasks for the
      // getPreFireTasks query (broadest candidate set), then
      // individually re-check each returned task against its own
      // resolved window before firing.
      if (this.onPreFire) {
        // Compute the broadest window to seed the query.
        let queryWindow = this.preFireWindow;
        if (this.preFireWindowResolver) {
          // Heuristic: use the static default as the query window. Tasks
          // whose resolver returns a smaller window will be filtered out
          // by the per-task check below; tasks with a larger window
          // would be missed, so we cap up to a 2x safety margin.
          queryWindow = Math.max(this.preFireWindow, this.preFireWindow * 2);
        }
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
          // Mark as fired to avoid infinite retry on the same due time
          this.store.markFired(task.id, new Date());
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
   * Returns true if the message was delivered (or attempted), false if it
   * was skipped (no routing info or adapter unavailable). In all cases
   * the task is marked fired.
   */
  private async fireTask(task: SchedulerTask): Promise<boolean> {
    // Mark fired first (advances next_fire_at for recurring tasks).
    // The conditional WHERE in markFired prevents double-advancing if
    // the model already responded and called markFired via onResponded.
    this.store.markFired(task.id, new Date());

    // Build the user-facing reminder text
    const messageText = buildReminderMessage(task);

    // Need routing info to deliver
    if (!task.umo || !task.platformId) {
      console.warn(`[TaskScheduler] Task ${task.id} has no routing info (umo/platformId), skipping delivery.`);
      return false;
    }

    // Look up the adapter that owns this session
    if (!this.adapterRegistry) {
      console.warn(`[TaskScheduler] No adapter registry available, cannot deliver task ${task.id}.`);
      return false;
    }

    const adapter = this.adapterRegistry.getAdapter(task.platformId);
    if (!adapter) {
      console.warn(`[TaskScheduler] Adapter "${task.platformId}" not found for task ${task.id}.`);
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
        console.log(`[TaskScheduler] Task "${task.title}" (${task.id}) delivered to ${target.umo}.`);
      } else {
        console.warn(`[TaskScheduler] Task "${task.title}" (${task.id}) delivery returned false (session may be inactive).`);
      }
      return delivered;
    } catch (e) {
      console.error(`[TaskScheduler] Failed to deliver task ${task.id}:`, e);
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
