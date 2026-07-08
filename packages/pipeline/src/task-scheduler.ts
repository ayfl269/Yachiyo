/**
 * TaskScheduler: periodically checks for due scheduler tasks and fires them
 * by delivering proactive messages to the user via the platform adapter.
 *
 * When a task fires:
 * 1. Build a reminder message from the task's payload/title.
 * 2. Look up the adapter that created the session (via platformId).
 * 3. Call adapter.sendProactiveMessage() to push the message directly.
 * 4. Mark the task as fired (advances next_fire_at for recurring tasks).
 *
 * If the adapter cannot deliver (no active session, platform doesn't support
 * proactive messages), the task is still marked fired to avoid retry loops.
 */

import type { AsyncQueue } from "@yachiyo/common/async-queue.js";
import type { SqliteSchedulerTaskStore } from "@yachiyo/agent/scheduler-task-store.js";
import type { SchedulerTask } from "@yachiyo/agent/scheduler-task-store.js";
import type { AdapterRegistry } from "@yachiyo/platform/registry.js";
import { ComponentType } from "@yachiyo/message/components.js";

export interface TaskSchedulerConfig {
  /** Check interval in milliseconds. Default: 30000 (30s). */
  interval?: number;
  /** Whether the scheduler is enabled. Default: true. */
  enabled?: boolean;
}

const DEFAULT_INTERVAL = 30_000;

export class TaskScheduler {
  private store: SqliteSchedulerTaskStore;
  private eventQueue: AsyncQueue<any>;
  private adapterRegistry: AdapterRegistry | null;
  private interval: number;
  private enabled: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    store: SqliteSchedulerTaskStore,
    eventQueue: AsyncQueue<any>,
    config?: TaskSchedulerConfig,
    adapterRegistry?: AdapterRegistry,
  ) {
    this.store = store;
    this.eventQueue = eventQueue;
    this.adapterRegistry = adapterRegistry ?? null;
    this.interval = config?.interval ?? DEFAULT_INTERVAL;
    this.enabled = config?.enabled ?? true;
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
    console.log(`[TaskScheduler] Started (interval: ${this.interval}ms).`);
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
    if (wasRunning) this.start();
  }

  /** Process all due tasks now. Exposed for testing/manual triggers. */
  async tick(): Promise<void> {
    let fired = 0;
    let skipped = 0;
    try {
      const dueTasks = this.store.getDueTasks(new Date());
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
    }
    if (fired > 0 || skipped > 0) {
      console.log(`[TaskScheduler] Tick complete: ${fired} fired, ${skipped} skipped.`);
    }
  }

  /**
   * Fire a single task: build a reminder message and push it directly to
   * the user via the platform adapter's proactive message channel.
   *
   * Returns true if the message was delivered (or attempted), false if it
   * was skipped (no routing info or adapter unavailable). In all cases
   * the task is marked fired.
   */
  private async fireTask(task: SchedulerTask): Promise<boolean> {
    // Mark fired first (advances next_fire_at for recurring tasks)
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
    const components = [{
      type: ComponentType.Plain,
      text: messageText,
      toDict() { return { type: "text", data: { text: messageText } }; },
    }];

    // 路由信息：umo 用于平台解析，sessionId 用于 WebChat 等查找连接
    const target = {
      umo: task.umo,
      sessionId: task.sessionId ?? task.umo,
      platformId: task.platformId,
    };

    try {
      const delivered = await adapter.sendProactiveMessage(target, components as any);
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
  lines.push(`⏰ ${label}：${task.title}`);

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
      const marker = i === task.currentStep ? "▶" : " ";
      const step = task.plan[i];
      lines.push(`  ${marker} [${step.status}] ${step.description}`);
    }
  }

  return lines.join("\n");
}
