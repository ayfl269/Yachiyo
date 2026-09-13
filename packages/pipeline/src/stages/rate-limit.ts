import { PipelineStage, registerStage } from "../stage.js";
import type { PipelineContext } from "../context.js";
import type { MessageEvent } from "@yachiyo/message/event.js";

@registerStage
export class RateLimitStage extends PipelineStage {
  /**
   * NOTE: `counters` is an in-process `Map`. The rate limit is therefore
   * per-process only — when running multiple instances (PM2 workers,
   * containers, horizontal scaling) each process maintains its own counters
   * and the effective limit is `maxRequests * instance_count`. For shared
   * enforcement, migrate the counter store to Redis or another shared
   * KV backend.
   *
   * NOTE: all rate-limit settings are read from `ctx.config` dynamically on
   * every request (same pattern as SessionStatusCheckStage) so Dashboard
   * config changes take effect immediately without restart (#92).
   */
  private ctx: PipelineContext | null = null;
  private counters: Map<string, { count: number; windowStart: number }> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** Number of events currently blocked in the STALL strategy. */
  private pendingStallCount: number = 0;
  /** Max concurrent stalls before excess events are discarded (memory guard). */
  private readonly maxPendingStall: number = 256;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.ctx = ctx;

    // Periodically purge expired counters to prevent unbounded growth
    const cleanupIntervalMs = Math.max((ctx.config.rateLimitWindowSeconds ?? 60) * 1000, 60_000);
    this.cleanupTimer = setInterval(() => this.purgeExpired(), cleanupIntervalMs);
    // Allow the Node.js process to exit even if this timer is active
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  private purgeExpired(): void {
    const now = Date.now();
    const threshold = (this.ctx?.config.rateLimitWindowSeconds ?? 60) * 1000;
    for (const [key, counter] of this.counters) {
      if (now - counter.windowStart > threshold) {
        this.counters.delete(key);
      }
    }
  }

  async process(event: MessageEvent): Promise<void> {
    // Dynamic config read: rate-limit settings follow the live config so
    // Dashboard updates apply without a restart (#92).
    const ctx = this.ctx;
    if (!ctx || !(ctx.config.rateLimitEnabled ?? false)) return;

    // System-generated events bypass rate limiting.
    if (event.isSystem) return;

    const maxRequests = ctx.config.rateLimitMaxRequests ?? 10;
    const windowSeconds = ctx.config.rateLimitWindowSeconds ?? 60;
    const strategy = ctx.config.rateLimitStrategy ?? "DISCARD";

    const key = event.unifiedMsgOrigin;
    const now = Date.now();
    let counter = this.counters.get(key);

    if (!counter || now - counter.windowStart > windowSeconds * 1000) {
      counter = { count: 0, windowStart: now };
      this.counters.set(key, counter);
    }

    counter.count++;

    if (counter.count > maxRequests) {
      if (strategy === "DISCARD") {
        event.stopEvent();
      } else {
        // Guard against unbounded memory growth: if too many events are
        // already waiting, discard excess instead of blocking them.
        if (this.pendingStallCount >= this.maxPendingStall) {
          console.warn(`[RateLimitStage] STALL queue full (${this.pendingStallCount}/${this.maxPendingStall}), discarding event`);
          event.stopEvent();
          return;
        }
        const waitMs = windowSeconds * 1000 - (now - counter.windowStart);
        this.pendingStallCount++;
        try {
          await new Promise(resolve => setTimeout(resolve, waitMs));
        } finally {
          this.pendingStallCount--;
        }
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.counters.clear();
  }
}
