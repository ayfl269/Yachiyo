import { PipelineStage, registerStage } from "../stage.js";
import type { PipelineContext } from "../context.js";
import type { MessageEvent } from "@yachiyo/message/event.js";

@registerStage
export class RateLimitStage extends PipelineStage {
  private rateLimitEnabled: boolean = false;
  private maxRequests: number = 10;
  private windowSeconds: number = 60;
  private strategy: "STALL" | "DISCARD" = "DISCARD";
  private counters: Map<string, { count: number; windowStart: number }> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.rateLimitEnabled = ctx.config.rateLimitEnabled ?? false;
    this.maxRequests = ctx.config.rateLimitMaxRequests ?? 10;
    this.windowSeconds = ctx.config.rateLimitWindowSeconds ?? 60;
    this.strategy = ctx.config.rateLimitStrategy ?? "DISCARD";

    // Periodically purge expired counters to prevent unbounded growth
    const cleanupIntervalMs = Math.max(this.windowSeconds * 1000, 60_000);
    this.cleanupTimer = setInterval(() => this.purgeExpired(), cleanupIntervalMs);
    // Allow the Node.js process to exit even if this timer is active
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  private purgeExpired(): void {
    const now = Date.now();
    const threshold = this.windowSeconds * 1000;
    for (const [key, counter] of this.counters) {
      if (now - counter.windowStart > threshold) {
        this.counters.delete(key);
      }
    }
  }

  async process(event: MessageEvent): Promise<void> {
    if (!this.rateLimitEnabled) return;

    const key = event.unifiedMsgOrigin;
    const now = Date.now();
    let counter = this.counters.get(key);

    if (!counter || now - counter.windowStart > this.windowSeconds * 1000) {
      counter = { count: 0, windowStart: now };
      this.counters.set(key, counter);
    }

    counter.count++;

    if (counter.count > this.maxRequests) {
      if (this.strategy === "DISCARD") {
        event.stopEvent();
      } else {
        const waitMs = this.windowSeconds * 1000 - (now - counter.windowStart);
        await new Promise(resolve => setTimeout(resolve, waitMs));
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
