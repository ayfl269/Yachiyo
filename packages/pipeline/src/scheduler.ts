import type { PipelineContext } from "./context.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import { PipelineStage, getRegisteredStages } from "./stage.js";
import { activeEventRegistry } from "./active-event-registry.js";

export const STAGES_ORDER = [
  "WakingCheckStage",
  "SessionStatusCheckStage",
  "RateLimitStage",
  "ContentSafetyCheckStage",
  "PreProcessStage",
  "ProcessStage",
  "ResultDecorateStage",
  "RespondStage",
];

function isAsyncGenerator(obj: unknown): obj is AsyncGenerator<void, void> {
  return obj != null &&
    typeof obj === "object" &&
    Symbol.asyncIterator in obj &&
    typeof obj[Symbol.asyncIterator] === "function" &&
    "next" in obj &&
    typeof (obj as AsyncGenerator<void, void>).next === "function";
}

export interface PipelineSchedulerOptions {
  /**
   * Hard wall-clock timeout for a single event's full pipeline execution
   * (all stages combined). When exceeded, the event is force-stopped via
   * {@link MessageEvent.stopEvent} so {@link processStages} can break out
   * of its loop at the next stage boundary.
   *
   * This is a safety net: per-tool timeouts ({@link ContextWrapper.toolCallTimeout}),
   * per-subagent timeouts (sandbox `maxExecutionTimeSeconds`), and the
   * `maxStep` limit already bound most runs. This total timeout catches
   * pathological cases where a stage hangs without any inner timeout
   * (e.g. a plugin handler stuck in an infinite loop, or a network call
   * ignoring the abort signal).
   *
   * Default: 30 minutes. Set to 0 or negative to disable.
   */
  totalTimeoutMs?: number;
}

/**
 * Default total execution timeout for a single event across all pipeline
 * stages. 30 minutes is intentionally generous — the goal is to catch
 * pathological hangs, not to constrain normal long-running agent tasks
 * (which have their own per-step and per-tool timeouts).
 */
const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60 * 1000;

export class PipelineScheduler {
  private ctx: PipelineContext;
  private stages: PipelineStage[] = [];
  private totalTimeoutMs: number;

  constructor(context: PipelineContext, options?: PipelineSchedulerOptions) {
    this.ctx = context;
    this.totalTimeoutMs = options?.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  }

  async initialize(): Promise<void> {
    const stages = getRegisteredStages();
    stages.sort((a, b) =>
      STAGES_ORDER.indexOf(a.name) - STAGES_ORDER.indexOf(b.name)
    );

    for (const stageCls of stages) {
      const instance = new stageCls() as PipelineStage;
      await instance.initialize(this.ctx);
      this.stages.push(instance);
    }
  }

  private async processStages(event: MessageEvent, fromStage: number = 0): Promise<void> {
    let i = fromStage;
    while (i < this.stages.length) {
      if (event.isStopped()) break;
      const stage = this.stages[i];
      const result = stage.process(event);

      if (isAsyncGenerator(result)) {
        // Onion model: advance generator to first yield (pre-processing),
        // then run subsequent stages, then resume generator (post-processing).
        let genResult = await result.next();
        while (!genResult.done) {
          if (event.isStopped()) {
            await result.return(undefined);
            break;
          }
          // Run all subsequent stages while this stage is yielded
          await this.processStages(event, i + 1);
          if (event.isStopped()) {
            await result.return(undefined);
            break;
          }
          // Resume generator to run post-yield logic
          genResult = await result.next();
        }
        // Generator is done (or stopped); skip remaining stages since
        // they were already executed inside the recursive call above.
        break;
      } else {
        await result;
        if (event.isStopped()) break;
        i++;
      }
    }
  }

  async execute(event: MessageEvent): Promise<void> {
    activeEventRegistry.register(event);
    // Total wall-clock timeout watchdog. Force-stops the event so the
    // processStages loop breaks at the next stage boundary. The timer
    // is unref'd so it doesn't keep the event loop alive on its own;
    // it only fires if the pipeline is genuinely still running.
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (this.totalTimeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (!event.isStopped()) {
          console.warn(
            `[PipelineScheduler] Event ${event.unifiedMsgOrigin} exceeded ` +
            `total timeout (${this.totalTimeoutMs}ms), force-stopping.`
          );
          event.stopEvent();
        }
      }, this.totalTimeoutMs);
      if (typeof timeoutTimer === "object" && "unref" in timeoutTimer) {
        timeoutTimer.unref();
      }
    }
    try {
      await this.processStages(event);
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      event.cleanupTemporaryLocalFiles();
      activeEventRegistry.unregister(event);
    }
  }
}
