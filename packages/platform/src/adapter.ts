import type { AsyncQueue } from "@yachiyo/common/async-queue.js";
import { MessageEvent } from "@yachiyo/message/event.js";
import type { PlatformMetadata } from "./metadata.js";
import { MessageSession } from "@yachiyo/message/message-session.js";
import type { MessageComponent, PlainComponent } from "@yachiyo/message/components.js";
import { ComponentType } from "@yachiyo/message/components.js";
import { PlatformMessage } from "@yachiyo/message/platform-message.js";
import { generateId } from "@yachiyo/common/id-generator.js";
import type { MessageChain } from "@yachiyo/agent/types.js";

export type AdapterStatus = "idle" | "initialized" | "running" | "stopping" | "stopped" | "error";

class SyntheticMessageEvent extends MessageEvent {
  private responseBuffer: MessageComponent[] = [];

  async send(components: MessageComponent[]): Promise<void> {
    this.responseBuffer.push(...components);
  }

  async sendStreaming(generator: AsyncGenerator<MessageChain, void>): Promise<void> {
    const parts: string[] = [];
    for await (const chunk of generator) {
      if (chunk.message) parts.push(chunk.message);
    }
    if (parts.length > 0) {
      await this.send([{
        type: ComponentType.Plain,
        text: parts.join(""),
        toDict() { return { type: "text", data: { text: parts.join("") } }; },
      } as MessageComponent]);
    }
  }

  getResponse(): MessageComponent[] {
    return this.responseBuffer;
  }
}

export abstract class PlatformAdapter {
  protected eventQueue: AsyncQueue<MessageEvent>;
  protected errors: unknown[] = [];
  protected _status: AdapterStatus = "idle";

  /** Callback invoked by the adapter when its persistent config needs updating (e.g. after login) */
  onConfigUpdate?: (updatedConfig: Record<string, unknown>) => void;

  constructor(config: Record<string, unknown>, eventQueue: AsyncQueue<MessageEvent>) {
    this.eventQueue = eventQueue;
  }

  // --- 生命周期方法 ---

  async initialize(): Promise<void> {
    this._status = "initialized";
  }

  abstract run(): Promise<void>;

  async stop(): Promise<void> {
    this._status = "stopped";
  }

  abstract meta(): PlatformMetadata;

  // --- 状态查询 ---

  get status(): AdapterStatus {
    return this._status;
  }

  setStatus(status: AdapterStatus): void {
    this._status = status;
  }

  get isRunning(): boolean {
    return this._status === "running";
  }

  // --- 事件提交 ---

  commitEvent(event: MessageEvent): void {
    this.eventQueue.put(event);
  }

  async sendBySession(session: MessageSession, components: MessageComponent[]): Promise<void> {
    const platformMsg = new PlatformMessage();
    platformMsg.type = session.messageType;
    platformMsg.selfId = this.meta().id;
    platformMsg.sessionId = session.sessionId;
    platformMsg.messageId = generateId();
    platformMsg.sender = { userId: "system", nickname: "System" };
    platformMsg.components = components;
    platformMsg.messageStr = components
      .filter((c): c is PlainComponent => c.type === ComponentType.Plain)
      .map(c => c.text ?? "")
      .join("");
    platformMsg.timestamp = Date.now();

    const event = new SyntheticMessageEvent(
      platformMsg.messageStr,
      platformMsg,
      this.meta(),
      session.sessionId,
    );
    event.session.platformId = session.platformId;
    event.session.messageType = session.messageType;
    event.session.sessionId = session.sessionId;

    this.commitEvent(event);
  }

  // --- 健康检查 ---

  /** 适配器健康检查，返回 null 表示健康，否则返回错误描述 */
  async healthCheck(): Promise<string | null> {
    return this.isRunning ? null : "Adapter not running";
  }
}
