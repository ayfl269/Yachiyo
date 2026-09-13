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
   * Number of events accepted into each config's serial chain but not yet
   * executed. Incremented when an event is chained, decremented when its
   * execution settles. This is the real per-config pending depth — the
   * confChains Map only stores the tail Promise, so its `.size` is the
   * number of *active configs*, not events, and cannot express per-config
   * backpressure (a single-config deployment would always have size 1).
   */
  private pendingPerConfig: Map<string, number> = new Map();
  /**
   * Maximum number of pending events per config before the dispatch loop
   * applies backpressure (stops reading from the event queue until the
   * oldest chain settles). Prevents unbounded Promise chain growth under
   * event floods.
   */
  private readonly maxPendingPerConfig: number;
  /**
   * Resolved when `stop()` is called. The dispatch loop races against this
   * so it can exit immediately even when blocked on `eventQueue.get()` or
   * on the backpressure `Promise.race(...)`. Without this signal, `stop()`
   * would only take effect on the next loop iteration — potentially never
   * if no new events arrive to unblock `eventQueue.get()`.
   */
  private stopResolver: (() => void) | null = null;
  private stopPromise: Promise<void> = Promise.resolve();
  /**
   * Aborts the current dispatch cycle's `eventQueue.get()` wait. Without it,
   * a `get()` call blocked when `stop()` fires would leave a registered
   * waiter inside the AsyncQueue; a later `put()` (e.g. after a restart)
   * would resolve that ghost waiter and the event would be swallowed
   * instead of processed by the (new) dispatch loop (#88).
   */
  private dispatchAbort: AbortController | null = null;

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
    // Create a fresh stop promise for this dispatch cycle. If the bus is
    // stopped and later restarted, a new promise ensures the new cycle
    // isn't born already "stopped".
    this.stopPromise = new Promise<void>((resolve) => { this.stopResolver = resolve; });
    // Fresh abort controller per dispatch cycle so stop() can cancel the
    // pending eventQueue.get() waiter of THIS cycle (and only this one).
    const abort = new AbortController();
    this.dispatchAbort = abort;

    while (this.running) {
      try {
        // Backpressure: if any single config has too many events queued
        // in its serial chain, pause reading until the chain drains.
        // This prevents unbounded Promise growth under event floods while
        // still allowing idle configs to accept new events immediately.
        if (this.tooManyPending()) {
          // Race the backpressure wait against the stop signal so stop()
          // can break out immediately instead of waiting for a chain to settle.
          await Promise.race([
            Promise.race(this.confChains.values()).catch(() => {}),
            this.stopPromise,
          ]);
          if (!this.running) break;
          continue;
        }

        // Race the event queue read against the stop signal. The abort
        // signal makes the queue remove its waiter on stop, so no ghost
        // waiter is left behind that could swallow a later put() (#88).
        // Without the race, `eventQueue.get()` would block indefinitely
        // when no events arrive, and stop() could not take effect until
        // an event arrives.
        const getPromise = this.eventQueue.get(abort.signal);
        // Swallow the AbortError if stop() wins the race — the rejection is
        // expected and must not surface as an unhandled error.
        getPromise.catch(() => { /* aborted via stop() */ });
        const event = await Promise.race([getPromise, this.stopPromise]);
        if (!this.running) break;
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
        this.pendingPerConfig.set(confId, (this.pendingPerConfig.get(confId) ?? 0) + 1);

        // Free the chain reference and pending count once settled so the
        // Maps don't grow unboundedly as idle configs come and go. Only
        // delete if `next` is still the tail (a newer event may have
        // already replaced it).
        next.finally(() => {
          if (this.confChains.get(confId) === next) {
            this.confChains.delete(confId);
          }
          const pending = (this.pendingPerConfig.get(confId) ?? 1) - 1;
          if (pending <= 0) {
            this.pendingPerConfig.delete(confId);
          } else {
            this.pendingPerConfig.set(confId, pending);
          }
        });
      } catch (err) {
        console.error("Error in EventBus dispatch loop:", err);
      }
    }
  }

  /**
   * Check if any config's pending event count exceeds the backpressure
   * threshold. Counts come from {@link pendingPerConfig}, which tracks the
   * real per-config chain depth (events accepted but not yet executed) —
   * unlike `confChains.size`, which only counts active configs and would
   * never trigger backpressure in a single-config deployment.
   */
  private tooManyPending(): boolean {
    for (const pending of this.pendingPerConfig.values()) {
      if (pending > this.maxPendingPerConfig) return true;
    }
    return false;
  }

  stop(): void {
    this.running = false;
    // Resolve the stop promise to unblock any pending `Promise.race` in the
    // dispatch loop. This allows immediate shutdown even when the loop is
    // blocked on `eventQueue.get()` or backpressure.
    this.stopResolver?.();
    this.stopResolver = null;
    // Cancel the pending eventQueue.get() waiter so the AsyncQueue removes
    // it. Without this, a `put()` after a restart would resolve the ghost
    // waiter and the first event would be silently swallowed (#88).
    this.dispatchAbort?.abort();
    this.dispatchAbort = null;
  }
}
