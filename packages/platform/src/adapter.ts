import type { AsyncQueue } from "@yachiyo/common/async-queue.js";
import { MessageEvent } from "@yachiyo/message/event.js";
import type { PlatformMetadata } from "./metadata.js";
import { MessageSession } from "@yachiyo/message/message-session.js";
import type { MessageComponent, PlainComponent } from "@yachiyo/message/components.js";
import { ComponentType } from "@yachiyo/message/components.js";
import { PlatformMessage } from "@yachiyo/message/platform-message.js";
import { generateId } from "@yachiyo/common/id-generator.js";
import { MessageType } from "@yachiyo/message/types.js";

export type AdapterStatus = "idle" | "initialized" | "running" | "stopping" | "stopped" | "error";

class SyntheticMessageEvent extends MessageEvent {
  private responseBuffer: MessageComponent[] = [];

  async send(components: MessageComponent[]): Promise<void> {
    this.responseBuffer.push(...components);
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
    const ok = await this.adapter.sendProactiveMessage(this.target, components);
    // 仅在投递确认成功后才回调 onResponded，避免投递失败时任务被误标已处理。
    if (ok && !this.hasResponded) {
      this.hasResponded = true;
      this.onResponded?.();
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
    _target: { umo: string; sessionId: string; platformId: string },
    _components: MessageComponent[],
  ): Promise<boolean> {
    // 基类不支持主动消息：注入 pipeline 的合成事件其 send() 只写入无人读取的
    // responseBuffer，消息会被静默丢弃。这里显式抛错，防止调用方误以为投递成功。
    throw new Error(
      `[${this.meta().id}] 该适配器不支持主动消息（未覆写 sendProactiveMessage）`,
    );
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
    // 解析 UMO 前缀（platform:type:rest）判断消息类型：
    //   group  → GROUP_MESSAGE（群聊）
    //   guild  → GROUP_MESSAGE（频道公屏，入站消息在 qqofficial adapter 中
    //             同样按 GROUP_MESSAGE 处理，保持会话语义一致）
    //   private / direct / 其他 → FRIEND_MESSAGE（单聊/私信/兜底）
    const umoType = target.umo.split(":")[1];
    const isGroup = umoType === "group" || umoType === "guild";
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
