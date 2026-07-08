import type { AsyncQueue } from "@yachiyo/common/async-queue.js";
import { MessageEvent } from "@yachiyo/message/event.js";
import type { PlatformMetadata } from "./metadata.js";
import { MessageSession } from "@yachiyo/message/message-session.js";
import type { MessageComponent, PlainComponent } from "@yachiyo/message/components.js";
import { ComponentType } from "@yachiyo/message/components.js";
import { PlatformMessage } from "@yachiyo/message/platform-message.js";
import { generateId } from "@yachiyo/common/id-generator.js";
import type { MessageChain } from "@yachiyo/agent/types.js";
import { MessageType } from "@yachiyo/message/types.js";

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

  /**
   * 主动推送消息到指定会话（不依赖事件回调）。
   * 用于定时任务到期、提醒等场景向用户主动发送消息。
   *
   * @param target 路由信息（umo + sessionId + platformId）
   * @param components 消息组件列表
   * @returns true 表示推送成功，false 表示无法推送
   */
  async sendProactiveMessage(
    target: { umo: string; sessionId: string; platformId: string },
    components: MessageComponent[],
  ): Promise<boolean> {
    // 默认实现：调用 sendBySession 注入事件到 pipeline。
    // 支持主动消息的 adapter 应覆盖此方法直接通过平台 API 推送。
    try {
      const session = new MessageSession();
      session.platformId = target.platformId;
      session.messageType = MessageType.FRIEND_MESSAGE;
      session.sessionId = target.sessionId;
      await this.sendBySession(session, components);
      return true;
    } catch (e) {
      console.error(`[PlatformAdapter] sendProactiveMessage failed:`, e);
      return false;
    }
  }

  async healthCheck(): Promise<string | null> {
    return this.isRunning ? null : "Adapter not running";
  }
}
