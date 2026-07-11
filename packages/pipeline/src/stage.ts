export abstract class PipelineStage {
  abstract initialize(ctx: import("./context.js").PipelineContext): Promise<void>;
  abstract process(event: import("@yachiyo/message/event.js").MessageEvent): Promise<void> | AsyncGenerator<void, void>;
}

const registeredStages: (new (...args: unknown[]) => PipelineStage)[] = [];

export function registerStage<T extends new (...args: unknown[]) => PipelineStage>(cls: T): T {
  registeredStages.push(cls);
  return cls;
}

export function getRegisteredStages(): (new (...args: unknown[]) => PipelineStage)[] {
  return [...registeredStages];
}

export function clearRegisteredStages(): void {
  registeredStages.length = 0;
}
