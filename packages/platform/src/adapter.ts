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

/**
 * A system-generated event that flows through the pipeline like a normal
 * message, but whose `send()` actually pushes the model's response to
 * the user via the platform adapter's proactive message channel.
 *
 * Used by the pre-fire reminder mechanism: the model receives a reminder
 * prompt, generates a natural response, and `send()` delivers it directly
 * to the user. The `onResponded` callback fires once when the response
 * is sent, allowing the caller to mark the task as handled (preventing
 * the fallback from firing).
 */
class ProactiveTriggerEvent extends MessageEvent {
  private adapter: PlatformAdapter;
  private target: { umo: string; sessionId: string; platformId: string };
  private onResponded?: () => void;
  private hasResponded: boolean = false;

  constructor(
    messageStr: string,
    messageObj: PlatformMessage,
    meta: PlatformMetadata,
    sessionId: string,
    adapter: PlatformAdapter,
    target: { umo: string; sessionId: string; platformId: string },
    onResponded?: () => void,
  ) {
    super(messageStr, messageObj, meta, sessionId);
    this.adapter = adapter;
    this.target = target;
    this.onResponded = onResponded;
    this.isSystem = true;
  }

  get unifiedMsgOrigin(): string {
    return this.target.umo;
  }

  async send(components: MessageComponent[]): Promise<void> {
    if (!this.hasResponded) {
      this.hasResponded = true;
      this.onResponded?.();
    }
    await this.adapter.sendProactiveMessage(this.target, components);
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

  /**
   * Inject a system-generated message into the pipeline for the model to
   * process. The model's response is pushed directly to the user via
   * sendProactiveMessage. Used by the pre-fire reminder mechanism to let
   * the model generate a natural reminder before the strict deadline.
   *
   * @param target Routing info (umo, sessionId, platformId)
   * @param messageStr The prompt text for the model
   * @param onResponded Optional callback invoked once when the model's
   *   response is about to be sent (used to mark the task as handled,
   *   preventing the fallback from firing)
   * @param historyMessage Optional clean text to persist to conversation
   *   history instead of the raw `messageStr` (which may contain internal
   *   instructions). When provided, ProcessStage will save this version.
   */
  triggerAgentMessage(
    target: { umo: string; sessionId: string; platformId: string },
    messageStr: string,
    onResponded?: () => void,
    historyMessage?: string,
  ): void {
    const isGroup = target.umo.includes(":group:");
    const platformMsg = new PlatformMessage();
    platformMsg.type = isGroup ? MessageType.GROUP_MESSAGE : MessageType.FRIEND_MESSAGE;
    platformMsg.selfId = this.meta().id;
    platformMsg.sessionId = target.sessionId;
    platformMsg.messageId = generateId();
    platformMsg.sender = { userId: "system", nickname: "System" };
    platformMsg.components = [{
      type: ComponentType.Plain,
      text: messageStr,
      toDict() { return { type: "text", data: { text: messageStr } }; },
    } as MessageComponent];
    platformMsg.messageStr = messageStr;
    platformMsg.timestamp = Date.now();

    const event = new ProactiveTriggerEvent(
      messageStr,
      platformMsg,
      this.meta(),
      target.sessionId,
      this,
      target,
      onResponded,
    );

    // Persist a clean summary to conversation history instead of the raw
    // prompt (which contains internal instructions like "delete this task").
    if (historyMessage) {
      event.setExtra("_historyUserMessage", historyMessage);
    }

    this.commitEvent(event);
  }
}
