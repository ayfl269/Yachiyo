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

  async initialize(ctx: PipelineContext): Promise<void> {
    this.rateLimitEnabled = ctx.config.rateLimitEnabled ?? false;
    this.maxRequests = ctx.config.rateLimitMaxRequests ?? 10;
    this.windowSeconds = ctx.config.rateLimitWindowSeconds ?? 60;
    this.strategy = ctx.config.rateLimitStrategy ?? "DISCARD";
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
}
