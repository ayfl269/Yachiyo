export abstract class PipelineStage {
  abstract initialize(ctx: import("./context.js").PipelineContext): Promise<void>;
  abstract process(event: import("@yachiyo/message/event.js").MessageEvent): Promise<void> | AsyncGenerator<void, void>;
}

const registeredStages: (new (...args: any[]) => PipelineStage)[] = [];

export function registerStage<T extends new (...args: any[]) => PipelineStage>(cls: T): T {
  registeredStages.push(cls);
  return cls;
}

export function getRegisteredStages(): (new (...args: any[]) => PipelineStage)[] {
  return [...registeredStages];
}

export function clearRegisteredStages(): void {
  registeredStages.length = 0;
}
