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

export class PipelineScheduler {
  private ctx: PipelineContext;
  private stages: PipelineStage[] = [];

  constructor(context: PipelineContext) {
    this.ctx = context;
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
    try {
      await this.processStages(event);
    } finally {
      event.cleanupTemporaryLocalFiles();
      activeEventRegistry.unregister(event);
    }
  }
}
