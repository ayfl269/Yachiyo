import { ComponentType, MessageComponent, PlainComponent } from "./components.js";
import { MessageChain } from "@yachiyo/agent/types.js";

export enum EventResultType {
  CONTINUE = "CONTINUE",
  STOP = "STOP",
}

export enum ResultContentType {
  LLM_RESULT = "LLM_RESULT",
  GENERAL_RESULT = "GENERAL_RESULT",
  STREAMING_RESULT = "STREAMING_RESULT",
  STREAMING_FINISH = "STREAMING_FINISH",
  AGENT_RUNNER_ERROR = "AGENT_RUNNER_ERROR",
}

export class EventResult {
  resultType: EventResultType = EventResultType.CONTINUE;
  resultContentType: ResultContentType = ResultContentType.GENERAL_RESULT;
  components: MessageComponent[] = [];
  asyncStream: AsyncGenerator<MessageChain, void> | null = null;

  plain(text: string): this {
    this.components.push({
      type: ComponentType.Plain,
      text,
      toDict() { return { type: "text", data: { text } }; },
    } as MessageComponent);
    return this;
  }

  image(url: string): this {
    this.components.push({
      type: ComponentType.Image,
      url,
      toDict() { return { type: "image", data: { url } }; },
    } as MessageComponent);
    return this;
  }

  stopEvent(): this {
    this.resultType = EventResultType.STOP;
    return this;
  }

  continueEvent(): this {
    this.resultType = EventResultType.CONTINUE;
    return this;
  }

  isStopped(): boolean {
    return this.resultType === EventResultType.STOP;
  }

  setAsyncStream(stream: AsyncGenerator<MessageChain, void>): this {
    this.asyncStream = stream;
    this.resultContentType = ResultContentType.STREAMING_RESULT;
    return this;
  }

  setResultContentType(type: ResultContentType): this {
    this.resultContentType = type;
    return this;
  }

  isLlmResult(): boolean {
    return this.resultContentType === ResultContentType.LLM_RESULT;
  }

  getPlainText(): string {
    return this.components
      .filter((c): c is PlainComponent => c.type === ComponentType.Plain)
      .map(c => c.text)
      .join("");
  }
}
