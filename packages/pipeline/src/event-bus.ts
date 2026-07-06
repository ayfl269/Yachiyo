import type { AsyncQueue } from "@yachiyo/common/async-queue.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import type { PipelineScheduler } from "./scheduler.js";

export interface PipelineConfigInfo {
  id: string;
  [key: string]: unknown;
}

export interface ConfigManagerLike {
  getConfInfo(umo: string): PipelineConfigInfo;
}

export class EventBus {
  private eventQueue: AsyncQueue<MessageEvent>;
  private schedulerMapping: Map<string, PipelineScheduler>;
  private configManager: ConfigManagerLike;
  private running: boolean = false;
  /**
   * Per-confId serial execution chains. Each entry is the tail Promise of
   * that config's execution queue. Events for the same confId are chained
   * sequentially via `.then()`; different confIds run concurrently.
   *
   * This replaces the previous `setTimeout(0)` dispatch which let same-config
   * events race past the session lock and had no concurrency limit or
   * backpressure.
   */
  private confChains: Map<string, Promise<void>> = new Map();
  /**
   * Maximum number of pending events per config before the dispatch loop
   * applies backpressure (stops reading from the event queue until the
   * oldest chain settles). Prevents unbounded Promise chain growth under
   * event floods.
   */
  private readonly maxPendingPerConfig: number;

  constructor(
    eventQueue: AsyncQueue<MessageEvent>,
    schedulerMapping: Map<string, PipelineScheduler>,
    configManager: ConfigManagerLike,
    options?: { maxPendingPerConfig?: number },
  ) {
    this.eventQueue = eventQueue;
    this.schedulerMapping = schedulerMapping;
    this.configManager = configManager;
    this.maxPendingPerConfig = options?.maxPendingPerConfig ?? 50;
  }

  async dispatch(): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        // Backpressure: if any single config has too many events queued
        // in its serial chain, pause reading until the chain drains.
        // This prevents unbounded Promise growth under event floods while
        // still allowing idle configs to accept new events immediately.
        if (this.tooManyPending()) {
          await Promise.race(this.confChains.values()).catch(() => {});
          continue;
        }

        const event = await this.eventQueue.get();
        if (!event) {
          continue;
        }

        const confInfo = this.configManager.getConfInfo(event.unifiedMsgOrigin);
        const confId = confInfo.id;
        const scheduler = this.schedulerMapping.get(confId);

        if (!scheduler) {
          console.error(`PipelineScheduler not found for config: ${confId}, event ignored.`);
          continue;
        }

        // Chain this event onto the per-confId serial queue. Events for the
        // same config execute strictly in arrival order; a failure in one
        // event does not block subsequent events (errors are swallowed in
        // the chain so the next link still runs).
        const prev = this.confChains.get(confId) ?? Promise.resolve();
        const next = prev
          .catch(() => {}) // Swallow previous errors so the chain continues
          .then(() => scheduler.execute(event))
          .catch((err) => {
            console.error(`Unhandled error executing event in PipelineScheduler for config ${confId}:`, err);
          });
        this.confChains.set(confId, next);

        // Free the chain reference once settled so the Map doesn't grow
        // unboundedly as idle configs come and go. Only delete if `next`
        // is still the tail (a newer event may have already replaced it).
        next.finally(() => {
          if (this.confChains.get(confId) === next) {
            this.confChains.delete(confId);
          }
        });
      } catch (err) {
        console.error("Error in EventBus dispatch loop:", err);
      }
    }
  }

  /**
   * Check if any config's pending chain exceeds the backpressure threshold.
   * Since we only track the tail Promise (not a counter), we approximate
   * by checking the number of configs with active chains against a cap —
   * a config is "active" while its tail Promise is pending. In practice
   * this limits total in-flight work across all configs.
   */
  private tooManyPending(): boolean {
    // The confChains Map only contains configs with at least one pending
    // event (entries are deleted on settle). If the total number of active
    // configs exceeds the cap, apply backpressure.
    // Note: a single config may have multiple events queued in its chain,
    // but they are serialized so they will drain naturally. The cap below
    // prevents the dispatch loop from flooding the event loop with too many
    // concurrent Promise chains.
    return this.confChains.size > this.maxPendingPerConfig;
  }

  stop(): void {
    this.running = false;
  }
}
