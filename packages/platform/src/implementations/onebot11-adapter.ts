/**
 * OneBot 11 Adapter — 支持 正向WS (Forward WS) 和 反向WS (Reverse WS)
 *
 * 正向WS: 主动连接到 OneBot 实现的 WS 服务器
 * 反向WS: 本地启动 WS 服务器，等待 OneBot 实现连接
 *
 * 协议参考: https://github.com/botuniverse/onebot-11
 */

import { PlatformAdapter } from "../adapter.js";
import type { PlatformMetadata } from "../metadata.js";
import type { AsyncQueue } from "@yachiyo/common/async-queue.js";
import { MessageEvent } from "@yachiyo/message/event.js";
import type { MessageComponent, PlainComponent, ImageComponent, AtComponent, FileComponent } from "@yachiyo/message/components.js";
import { ComponentType } from "@yachiyo/message/components.js";
import { PlatformMessage } from "@yachiyo/message/platform-message.js";
import { MessageType } from "@yachiyo/message/types.js";
import { generateId } from "@yachiyo/common/id-generator.js";
import type { MessageChain } from "@yachiyo/agent/types.js";
import type { OneBot11AdapterConfig } from "../config.js";

import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server, type IncomingMessage } from "http";

/** 解码常见的 HTML 实体（CQ 码中 &amp; 等）— 单次扫描避免双重解码 */
function decodeHtmlEntities(str: string): string {
  if (!str) return str;
  return str.replace(/&(amp|lt|gt|quot|#0?39|nbsp);/g, (_match, entity: string) => {
    switch (entity) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "39":
      case "039": return "'";
      case "nbsp": return " ";
      default: return _match;
    }
  });
}

// ── OneBot 11 Protocol Types ──

interface OB11MessageSegment {
  type: string;
  data: Record<string, unknown>;
}

interface OB11MessageEvent {
  time: number;
  self_id: number;
  post_type: "message";
  message_type: "private" | "group";
  sub_type: string;
  message_id: number;
  user_id: number;
  group_id?: number;
  message: OB11MessageSegment[] | string;
  raw_message: string;
  font: number;
  sender: {
    user_id: number;
    nickname: string;
    card?: string;
    role?: string;
    sex?: string;
    age?: number;
  };
}

// ── OneBot 11 API Result Types ──

/** get_file / get_image / get_record 返回 */
export interface Ob11FileResult {
  file?: string;
  url?: string;
  file_name?: string;
  file_size?: number;
  filename?: string;
  size?: number;
  base64?: string;
}

/** get_msg 返回 */
export interface Ob11GetMsgResult {
  message_id: number;
  real_id?: number;
  message_type: "private" | "group";
  sender: { user_id: number; nickname: string; card?: string };
  message: OB11MessageSegment[] | string;
  raw_message: string;
  time: number;
  group_id?: number;
  user_id: number;
  self_id: number;
}

/** get_forward_msg 返回 */
export interface Ob11GetForwardMsgResult {
  messages: OB11MessageSegment[];
}

/** send_group_msg / send_private_msg 返回 */
export interface Ob11SendMsgResult {
  message_id: number;
}

/** get_login_info 返回 */
export interface Ob11LoginInfo {
  user_id: number;
  nickname: string;
}

// ── Request / Notice Event Types ──

/** 加好友请求事件 */
export interface Ob11FriendRequestEvent {
  post_type: "request";
  request_type: "friend";
  user_id: number;
  comment: string;
  flag: string;
  time: number;
  self_id: number;
}

/** 加群请求/邀请事件 */
export interface Ob11GroupRequestEvent {
  post_type: "request";
  request_type: "group";
  sub_type: "add" | "invite";
  group_id: number;
  user_id: number;
  comment: string;
  flag: string;
  time: number;
  self_id: number;
}

/** 通知事件 (通用) */
export interface Ob11NoticeEvent {
  post_type: "notice";
  notice_type: string;
  time: number;
  self_id: number;
  group_id?: number;
  user_id?: number;
  operator_id?: number;
  sub_type?: string;
  // group_recall
  message_id?: number;
  // group_upload
  file?: { id: string; name: string; size: number; busid?: number };
  // group_mute
  duration?: number;
  // poke
  target_id?: number;
  // group_admin
  set?: boolean;
  // group_increase/decrease
  member_id?: number;
}

// ── Group Info Types (for Phase 5/6) ──

export interface Ob11GroupInfo {
  group_id: number;
  group_name: string;
  member_count: number;
  max_member_count: number;
}

export interface Ob11GroupMemberInfo {
  user_id: number;
  nickname: string;
  card?: string;
  role: "owner" | "admin" | "member";
  join_time?: number;
  last_sent_time?: number;
  title?: string;
  shut_up_timestamp?: number;
}

// ── OneBot11Event ──

class OneBot11Event extends MessageEvent {
  private ws: WebSocket | null = null;
  private adapter: OneBot11Adapter | null = null;
  private apiResponseResolve: ((data: unknown) => void) | null = null;
  private echo: string = "";
  private _umo: string;

  constructor(
    messageStr: string,
    messageObj: PlatformMessage,
    sessionId: string,
    platformMeta: PlatformMetadata,
  ) {
    super(messageStr, messageObj, platformMeta, sessionId);
    // Build unique message origin: onebot11:{group|private}:{id}
    const isGroup = messageObj.type === MessageType.GROUP_MESSAGE;
    const uid = messageObj.sender.userId;
    this._umo = isGroup
      ? `onebot11:group:${sessionId.replace("group_", "")}`
      : `onebot11:private:${uid}`;
  }

  get unifiedMsgOrigin(): string {
    return this._umo;
  }

  setWebSocket(ws: WebSocket): void {
    this.ws = ws;
  }

  /** 设置适配器引用，用于在反向WS重连后获取最新的WS连接 */
  setAdapter(adapter: OneBot11Adapter): void {
    this.adapter = adapter;
  }

  setEcho(echo: string): void {
    this.echo = echo;
  }

  /** 获取当前可用的WS连接（优先使用事件创建时的连接，若已断开则回退到适配器的活跃连接） */
  private getActiveWs(): WebSocket | null {
    // 优先使用事件创建时绑定的WS
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.ws;
    }
    // 回退：从适配器获取当前活跃的WS连接（反向WS重连后可能已变更）
    if (this.adapter) {
      const activeWs = this.adapter.getActiveWs();
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        return activeWs;
      }
    }
    return null;
  }

  async send(components: MessageComponent[]): Promise<void> {
    const ws = this.getActiveWs();
    if (!ws) {
      console.warn("[OneBot11] Cannot send reply: no active WS connection");
      return;
    }

    const action = this.messageObj.type === MessageType.GROUP_MESSAGE
      ? "send_group_msg"
      : "send_private_msg";

    const params: Record<string, unknown> = {};
    if (this.messageObj.type === MessageType.GROUP_MESSAGE) {
      const gid = this.getExtra<number>("group_id");
      if (!gid) {
        console.warn("[OneBot11] Group message missing group_id, skipping reply");
        return;
      }
      params.group_id = gid;
    } else {
      const uid = this.getExtra<number>("user_id");
      params.user_id = (uid ?? Number(this.messageObj.sender.userId)) || 0;
    }

    params.message = this.componentsToOB11(components);

    // Use response-awaited call to get message_id; fall back to fire-and-forget
    try {
      const result = await this.adapter?.callApiWithResponse(action, params);
      if (result && typeof result === "object" && "message_id" in result) {
        this.setExtra("sent_message_id", (result as Ob11SendMsgResult).message_id);
      }
    } catch (e) {
      console.warn(`[OneBot11] send() response await failed, message may still have been sent:`, e);
    }
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

  async sendTyping(): Promise<void> {
    // OneBot 11 doesn't have a standard typing indicator
  }

  async stopTyping(): Promise<void> {
    // No-op
  }

  // ── API convenience methods (delegate to adapter) ──

  /** 获取收到的文件信息（file_id → URL） */
  async getFile(fileId: string): Promise<Ob11FileResult> {
    return this.adapter!.callApiWithResponse("get_file", { file_id: fileId }) as Promise<Ob11FileResult>;
  }

  /** 获取图片信息 */
  async getImage(file: string): Promise<Ob11FileResult> {
    return this.adapter!.callApiWithResponse("get_image", { file }) as Promise<Ob11FileResult>;
  }

  /** 获取语音转码 */
  async getRecord(file: string, outFormat: string = "mp3"): Promise<Ob11FileResult> {
    return this.adapter!.callApiWithResponse("get_record", { file, out_format: outFormat }) as Promise<Ob11FileResult>;
  }

  /** 撤回消息 */
  async deleteMsg(messageId: string | number): Promise<void> {
    await this.adapter!.callApiWithResponse("delete_msg", { message_id: Number(messageId) });
  }

  /** 获取消息详情 */
  async getMsg(messageId: string | number): Promise<Ob11GetMsgResult> {
    return this.adapter!.callApiWithResponse("get_msg", { message_id: Number(messageId) }) as Promise<Ob11GetMsgResult>;
  }

  /** 获取合并转发消息内容 */
  async getForwardMsg(resId: string): Promise<Ob11GetForwardMsgResult> {
    return this.adapter!.callApiWithResponse("get_forward_msg", { id: resId }) as Promise<Ob11GetForwardMsgResult>;
  }

  private componentsToOB11(components: MessageComponent[]): OB11MessageSegment[] {
    const segments: OB11MessageSegment[] = [];
    for (const comp of components) {
      switch (comp.type) {
        case ComponentType.Plain:
          segments.push({ type: "text", data: { text: (comp as PlainComponent).text ?? "" } });
          break;
        case ComponentType.Image: {
          const img = comp as ImageComponent;
          segments.push({ type: "image", data: { file: img.url ?? "", url: img.url ?? "" } });
          break;
        }
        case ComponentType.At: {
          const atComp = comp as AtComponent;
          segments.push({ type: "at", data: { qq: atComp.qq ?? "all" } });
          break;
        }
        case ComponentType.Reply:
          segments.push({ type: "reply", data: { id: (comp as { messageId?: string }).messageId ?? "" } });
          break;
        default:
          segments.push({ type: "text", data: { text: JSON.stringify(comp.toDict()) } });
      }
    }
    return segments;
  }
}

// ── OneBot11Adapter ──

export class OneBot11Adapter extends PlatformAdapter {
  private config: OneBot11AdapterConfig;
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private reverseWs: WebSocket | null = null;
  private reverseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private startTime: number = 0;

  // ── API Response Correlation (echo-based) ──
  /** Pending API requests waiting for echo responses */
  private pendingRequests = new Map<string, {
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** Default timeout for API calls (30s) */
  static readonly API_TIMEOUT_MS = 30_000;

  constructor(config: OneBot11AdapterConfig, eventQueue: AsyncQueue<MessageEvent>) {
    super(config as unknown as Record<string, unknown>, eventQueue);
    this.config = config;
  }

  async initialize(): Promise<void> {
    await super.initialize();
  }

  async run(): Promise<void> {
    this._status = "running";
    this.startTime = Date.now();

    if (this.config.direction === "forward") {
      await this.startForwardWs();
    } else {
      await this.startReverseWs();
    }
  }

  async stop(): Promise<void> {
    this._status = "stopping";

    // Reject all pending API requests
    this.rejectAllPending("Adapter is stopping");

    if (this.reverseReconnectTimer) {
      clearTimeout(this.reverseReconnectTimer);
      this.reverseReconnectTimer = null;
    }

    if (this.reverseWs) {
      try { this.reverseWs.close(); } catch { /* ignore */ }
      this.reverseWs = null;
    }

    if (this.wss) {
      for (const ws of this.wss.clients) {
        try { ws.close(); } catch { /* ignore */ }
      }
      try { this.wss.close(); } catch { /* ignore */ }
      this.wss = null;
    }

    if (this.httpServer) {
      try {
        await new Promise<void>(resolve => {
          this.httpServer!.close(() => resolve());
          // Force resolve after 3s if close hangs
          setTimeout(resolve, 3000);
        });
      } catch { /* ignore */ }
      this.httpServer = null;
    }

    try {
      await super.stop();
    } catch { /* ignore */ }
  }

  meta(): PlatformMetadata {
    return {
      name: "onebot11",
      description: `OneBot 11 (${this.config.direction === "forward" ? "反向WS" : "正向WS"})`,
      id: this.config.id,
      supportStreamingMessage: false,
      supportProactiveMessage: true,
    };
  }

  /** 获取当前活跃的WS连接（供 OneBot11Event 回退使用） */
  getActiveWs(): WebSocket | null {
    // 反向WS：返回当前连接
    if (this.config.direction === "reverse") {
      return this.reverseWs;
    }
    // 正向WS：返回第一个已连接的客户端
    if (this.wss) {
      for (const client of this.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          return client;
        }
      }
    }
    return null;
  }

  async healthCheck(): Promise<string | null> {
    if (!this.isRunning) return "Adapter not running";
    if (this.config.direction === "forward") {
      if (!this.wss) return "Forward WS server not started";
    } else {
      if (!this.reverseWs || this.reverseWs.readyState !== WebSocket.OPEN) {
        return "Reverse WS not connected";
      }
    }
    return null;
  }

  /**
   * 主动推送消息到指定会话。
   * 通过解析 UMO 确定是群消息还是私聊消息，然后调用 OneBot 11 的 send_group_msg / send_private_msg API。
   * UMO 格式: onebot11:group:<groupId> 或 onebot11:private:<userId>
   */
  override async sendProactiveMessage(
    target: { umo: string; sessionId: string; platformId: string },
    components: MessageComponent[],
  ): Promise<boolean> {
    const ws = this.getActiveWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn("[OneBot11] Cannot send proactive message: no active WS connection");
      return false;
    }

    // 解析 UMO: onebot11:group:<id> 或 onebot11:private:<id>
    const match = target.umo.match(/^onebot11:(group|private):(.+)$/);
    if (!match) {
      console.warn(`[OneBot11] Cannot parse UMO for proactive message: ${target.umo}`);
      return false;
    }
    const [, typeStr, idStr] = match;
    const id = Number(idStr);
    if (!Number.isFinite(id) || id <= 0) {
      console.warn(`[OneBot11] Invalid target id in UMO: ${target.umo}`);
      return false;
    }

    const action = typeStr === "group" ? "send_group_msg" : "send_private_msg";
    const params: Record<string, unknown> =
      typeStr === "group" ? { group_id: id } : { user_id: id };
    params.message = this.componentsToOB11(components);

    try {
      await this.callApiWithResponse(action, params);
      return true;
    } catch (e) {
      console.error(`[OneBot11] Proactive message failed:`, e);
      return false;
    }
  }

  // ── API Call Infrastructure ──

  /**
   * 调用 OneBot 11 API 并等待响应。
   * 使用 echo 字段关联请求和响应，超时自动 reject。
   */
  async callApiWithResponse(
    action: string,
    params: Record<string, unknown>,
    timeoutMs: number = OneBot11Adapter.API_TIMEOUT_MS,
  ): Promise<unknown> {
    const ws = this.getActiveWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Cannot call API ${action}: no active WS connection`);
    }

    const echo = generateId();
    const payload = { action, params, echo };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(echo);
        reject(new Error(`API call '${action}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(echo, { resolve, reject, timer });

      try {
        ws.send(JSON.stringify(payload));
      } catch (e) {
        this.pendingRequests.delete(echo);
        clearTimeout(timer);
        reject(new Error(`Failed to send API call '${action}': ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  /**
   * 调用 OneBot 11 API（fire-and-forget，不等待响应）。
   * 保留用于不需要返回值的场景。
   */
  callApiFireAndForget(action: string, params: Record<string, unknown>): void {
    const ws = this.getActiveWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn(`[OneBot11] Cannot call API ${action}: WS not open`);
      return;
    }
    const echo = generateId();
    const payload = { action, params, echo };
    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      console.error(`[OneBot11] Failed to send API call ${action}:`, e);
    }
  }

  /** 拒绝所有等待中的 API 请求（在断开连接/停止时调用） */
  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  // ── OneBot 11 Standard API Methods ──

  /** 获取收到的文件信息（file_id → URL）— napcat 扩展 */
  async getFile(fileId: string): Promise<Ob11FileResult> {
    return this.callApiWithResponse("get_file", { file_id: fileId }) as Promise<Ob11FileResult>;
  }

  /** 获取图片信息（file → URL/路径） */
  async getImage(file: string): Promise<Ob11FileResult> {
    return this.callApiWithResponse("get_image", { file }) as Promise<Ob11FileResult>;
  }

  /** 获取语音转码（file → 目标格式文件路径） */
  async getRecord(file: string, outFormat: string = "mp3"): Promise<Ob11FileResult> {
    return this.callApiWithResponse("get_record", { file, out_format: outFormat }) as Promise<Ob11FileResult>;
  }

  /** 撤回消息 */
  async deleteMsg(messageId: string | number): Promise<void> {
    await this.callApiWithResponse("delete_msg", { message_id: Number(messageId) });
  }

  /** 获取消息详情 */
  async getMsg(messageId: string | number): Promise<Ob11GetMsgResult> {
    return this.callApiWithResponse("get_msg", { message_id: Number(messageId) }) as Promise<Ob11GetMsgResult>;
  }

  /** 获取合并转发消息内容 */
  async getForwardMsg(resId: string): Promise<Ob11GetForwardMsgResult> {
    return this.callApiWithResponse("get_forward_msg", { id: resId }) as Promise<Ob11GetForwardMsgResult>;
  }

  /** 获取登录号信息 */
  async getLoginInfo(): Promise<Ob11LoginInfo> {
    return this.callApiWithResponse("get_login_info", {}) as Promise<Ob11LoginInfo>;
  }

  /** 标记消息已读 (go-cqhttp 扩展) */
  async markMsgAsRead(messageId: string | number): Promise<void> {
    await this.callApiWithResponse("mark_msg_as_read", { message_id: Number(messageId) });
  }

  /** 将消息组件转换为 OneBot 11 消息段 */
  private componentsToOB11(components: MessageComponent[]): OB11MessageSegment[] {
    const segments: OB11MessageSegment[] = [];
    for (const comp of components) {
      switch (comp.type) {
        case ComponentType.Plain:
          segments.push({ type: "text", data: { text: (comp as PlainComponent).text ?? "" } });
          break;
        case ComponentType.Image: {
          const img = comp as ImageComponent;
          segments.push({ type: "image", data: { file: img.url ?? "", url: img.url ?? "" } });
          break;
        }
        case ComponentType.At: {
          const atComp = comp as AtComponent;
          segments.push({ type: "at", data: { qq: atComp.qq ?? "all" } });
          break;
        }
        default:
          segments.push({ type: "text", data: { text: (comp as PlainComponent).text ?? JSON.stringify(comp.toDict()) } });
      }
    }
    return segments;
  }

  // ── Forward WS (本地启动 WS 服务器) ──

  private async startForwardWs(): Promise<void> {
    this.httpServer = createServer();
    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: this.config.path ?? "/onebot/v11/ws",
      maxPayload: 10 * 1024 * 1024,
    });

    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      // 鉴权
      if (this.config.accessToken) {
        const auth = req.headers.authorization;
        const token = auth?.replace("Bearer ", "") ?? req.headers["access-token"] as string;
        if (token !== this.config.accessToken) {
          console.warn("[OneBot11] Forward WS: auth failed, closing connection.");
          ws.close(4001, "Unauthorized");
          return;
        }
      }

      const clientIp = req.socket.remoteAddress ?? "unknown";
      console.info(`[OneBot11] Forward WS: client connected from ${clientIp}`);
      this.setupWsHandler(ws);
    });

    const port = this.config.port ?? 8080;
    const host = this.config.host ?? "0.0.0.0";

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(port, host, () => {
        console.info(`[OneBot11] Forward WS server listening on ${host}:${port}`);
        resolve();
      });
      this.httpServer!.on("error", reject);
    });
  }

  // ── Reverse WS (主动连接到 OneBot 实现) ──

  private async startReverseWs(): Promise<void> {
    await this.connectReverseWs();
  }

  private connectReverseWs(): Promise<void> {
    return new Promise((resolve) => {
      const url = this.config.reverseUrl!;
      const headers: Record<string, string> = {};
      if (this.config.accessToken) {
        headers["Authorization"] = `Bearer ${this.config.accessToken}`;
      }

      console.info(`[OneBot11] Reverse WS: connecting to ${url}...`);
      const ws = new WebSocket(url, { headers });

      ws.on("open", () => {
        console.info(`[OneBot11] Reverse WS: connected to ${url}`);
        this.reverseWs = ws;
        this.setupWsHandler(ws);
        resolve();
      });

      ws.on("close", (code: number, reason: Buffer) => {
        console.warn(`[OneBot11] Reverse WS: disconnected (code=${code}, reason=${reason})`);
        this.reverseWs = null;
        this.scheduleReconnect();
      });

      ws.on("error", (err: Error) => {
        console.error(`[OneBot11] Reverse WS: connection error:`, err.message);
        this.reverseWs = null;
        // Don't reject - we want to retry
        resolve();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this._status !== "running") return;
    const delay = this.config.reconnectInterval ?? 5000;
    console.info(`[OneBot11] Reverse WS: reconnecting in ${delay}ms...`);
    this.reverseReconnectTimer = setTimeout(() => {
      if (this._status === "running") {
        this.connectReverseWs();
      }
    }, delay);
  }

  // ── WS Message Handler (shared by forward & reverse) ──

  private setupWsHandler(ws: WebSocket): void {
    ws.on("message", (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString());
        this.handleOb11Data(data, ws);
      } catch (e: unknown) {
        console.error("[OneBot11] Failed to parse WS message:", e);
      }
    });

    ws.on("close", () => {
      console.info("[OneBot11] WS client disconnected");
    });

    ws.on("error", (err: Error) => {
      console.error("[OneBot11] WS error:", err.message);
    });
  }

  private handleOb11Data(data: Record<string, unknown>, ws: WebSocket): void {
    // Handle API responses (echo) — resolve pending requests
    if (data.echo && data.retcode !== undefined) {
      const echo = data.echo as string;
      const pending = this.pendingRequests.get(echo);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(echo);
        if (data.retcode === 0) {
          pending.resolve(data.data);
        } else {
          pending.reject(new Error(
            `API call failed: ${data.msg ?? "unknown error"} (retcode=${data.retcode})`,
          ));
        }
      }
      return;
    }

    const postType = data.post_type as string;

    // Handle message events
    if (postType === "message") {
      const msgEvent = data as unknown as OB11MessageEvent;
      this.processMessageEvent(msgEvent, ws);
      return;
    }

    // Handle request events (friend/group join requests)
    if (postType === "request") {
      this.processRequestEvent(data as unknown as Ob11FriendRequestEvent | Ob11GroupRequestEvent);
      return;
    }

    // Handle notice events
    if (postType === "notice") {
      this.processNoticeEvent(data as unknown as Ob11NoticeEvent, ws);
      return;
    }

    // Handle meta events
    if (postType === "meta_event") {
      const metaEventType = data.meta_event_type as string;
      if (metaEventType === "lifecycle") {
        console.info(`[OneBot11] Lifecycle event: ${data.sub_type ?? "unknown"}`);
      }
      // heartbeat is handled by OneBot implementations
      return;
    }
  }

  private processMessageEvent(msg: OB11MessageEvent, ws: WebSocket): void {
    const isGroup = msg.message_type === "group";
    const messageType = isGroup ? MessageType.GROUP_MESSAGE : MessageType.FRIEND_MESSAGE;
    const sessionId = isGroup
      ? `group_${msg.group_id}`
      : `private_${msg.user_id}`;

    // Parse message segments
    const rawMsg = typeof msg.message === "string"
      ? [{ type: "text", data: { text: msg.message } }] as OB11MessageSegment[]
      : msg.message as OB11MessageSegment[];

    const components = this.ob11ToComponents(rawMsg);
    const messageStr = rawMsg
      .filter(s => s.type === "text")
      .map(s => s.data.text ?? "")
      .join("");

    // Create PlatformMessage
    const platformMsg = new PlatformMessage();
    platformMsg.type = messageType;
    platformMsg.selfId = String(msg.self_id);
    platformMsg.sessionId = sessionId;
    platformMsg.messageId = String(msg.message_id);
    platformMsg.sender = {
      userId: String(msg.user_id),
      nickname: msg.sender.card || msg.sender.nickname || String(msg.user_id),
    };
    platformMsg.components = components;
    platformMsg.messageStr = messageStr || msg.raw_message;
    platformMsg.timestamp = msg.time * 1000;

    // Create event
    const event = new OneBot11Event(
      platformMsg.messageStr,
      platformMsg,
      sessionId,
      this.meta(),
    );
    event.setWebSocket(ws);
    event.setAdapter(this);

    // Store group_id for reply
    if (isGroup && msg.group_id) {
      event.setExtra("group_id", msg.group_id);
    }
    event.setExtra("user_id", msg.user_id);
    event.setExtra("message_id", msg.message_id);

    this.commitEvent(event);
  }

  // ── Request Event Processing (Phase 3) ──

  private async processRequestEvent(
    event: Ob11FriendRequestEvent | Ob11GroupRequestEvent,
  ): Promise<void> {
    if (event.request_type === "friend") {
      const friendReq = event as Ob11FriendRequestEvent;
      console.info(`[OneBot11] Friend request from ${friendReq.user_id}: ${friendReq.comment || "(no comment)"}`);

      const shouldApprove = this.config.autoApproveFriend ?? false;
      try {
        await this.setFriendAddRequest(friendReq.flag, shouldApprove);
        console.info(`[OneBot11] Friend request ${shouldApprove ? "approved" : "rejected"}: ${friendReq.user_id}`);
      } catch (e) {
        console.error(`[OneBot11] Failed to handle friend request:`, e);
      }
      return;
    }

    if (event.request_type === "group") {
      const groupReq = event as Ob11GroupRequestEvent;
      const action = groupReq.sub_type === "add" ? "加群请求" : "加群邀请";
      console.info(`[OneBot11] ${action} from ${groupReq.user_id} for group ${groupReq.group_id}: ${groupReq.comment || "(no comment)"}`);

      const shouldApprove = this.config.autoApproveGroup ?? false;
      const reason = shouldApprove ? "" : (this.config.autoRejectReason ?? "");
      try {
        await this.setGroupAddRequest(groupReq.flag, groupReq.sub_type, shouldApprove, reason);
        console.info(`[OneBot11] Group request ${shouldApprove ? "approved" : "rejected"}: group=${groupReq.group_id}`);
      } catch (e) {
        console.error(`[OneBot11] Failed to handle group request:`, e);
      }
      return;
    }
  }

  /** 处理好友请求 */
  async setFriendAddRequest(flag: string, approve: boolean, remark?: string): Promise<void> {
    const params: Record<string, unknown> = { flag, approve };
    if (remark) params.remark = remark;
    await this.callApiWithResponse("set_friend_add_request", params);
  }

  /** 处理加群请求/邀请 */
  async setGroupAddRequest(flag: string, subType: string, approve: boolean, reason?: string): Promise<void> {
    const params: Record<string, unknown> = { flag, sub_type: subType, approve };
    if (reason) params.reason = reason;
    await this.callApiWithResponse("set_group_add_request", params);
  }

  // ── Notice Event Processing (Phase 4) ──

  private processNoticeEvent(event: Ob11NoticeEvent, ws: WebSocket): void {
    switch (event.notice_type) {
      case "group_recall": {
        console.info(`[OneBot11] Group recall: group=${event.group_id}, msg=${event.message_id}, operator=${event.operator_id}`);
        break;
      }
      case "friend_recall": {
        console.info(`[OneBot11] Friend recall: user=${event.user_id}, msg=${event.message_id}`);
        break;
      }
      case "poke": {
        // Both group and private pokes
        if (event.user_id === event.self_id) return; // self poke, ignore
        const pokeToMessage = this.config.pokeToMessage ?? true;
        if (pokeToMessage) {
          const isGroup = !!event.group_id;
          const sessionId = isGroup ? `group_${event.group_id}` : `private_${event.user_id}`;
          const pokerName = `用户${event.user_id}`;
          const targetName = event.target_id === event.self_id ? "我" : `用户${event.target_id}`;
          const text = `[戳一戳] ${pokerName} 戳了 ${targetName}`;
          this.createSyntheticMessageEvent(text, sessionId, isGroup, event.user_id!, pokerName, ws);
        }
        break;
      }
      case "group_increase": {
        const subType = event.sub_type ?? "approve";
        console.info(`[OneBot11] Group member joined: group=${event.group_id}, user=${event.user_id}, sub_type=${subType}`);
        const memberJoinToMessage = this.config.memberJoinToMessage ?? false;
        if (memberJoinToMessage) {
          const sessionId = `group_${event.group_id}`;
          const text = `[群成员变动] 用户${event.user_id} 加入了群聊`;
          this.createSyntheticMessageEvent(text, sessionId, true, event.user_id!, `用户${event.user_id}`, ws);
        }
        break;
      }
      case "group_decrease": {
        const subType = event.sub_type ?? "leave";
        const action = subType === "kick" ? "被踢出" : "离开";
        console.info(`[OneBot11] Group member left: group=${event.group_id}, user=${event.user_id}, ${action}, operator=${event.operator_id}`);
        break;
      }
      case "group_upload": {
        const fileName = event.file?.name ?? "unknown";
        const fileSize = event.file?.size ?? 0;
        console.info(`[OneBot11] Group file upload: group=${event.group_id}, user=${event.user_id}, file=${fileName} (${fileSize} bytes)`);
        const groupUploadToMessage = this.config.groupUploadToMessage ?? true;
        if (groupUploadToMessage && event.group_id) {
          const sessionId = `group_${event.group_id}`;
          const text = `[群文件上传] 用户${event.user_id} 上传了文件: ${fileName} (${this.formatFileSize(fileSize)})`;
          this.createSyntheticMessageEvent(text, sessionId, true, event.user_id!, `用户${event.user_id}`, ws, {
            type: ComponentType.File,
            file: event.file?.id,
            name: fileName,
            url: undefined,
            toDict() { return { type: "file", data: { file_id: event.file?.id, name: fileName } }; },
          } as FileComponent);
        }
        break;
      }
      case "group_admin": {
        const action = event.set ? "成为管理员" : "被取消管理员";
        console.info(`[OneBot11] Group admin change: group=${event.group_id}, user=${event.user_id}, ${action}`);
        break;
      }
      case "group_mute": {
        const action = event.duration === 0 ? "被解除禁言" : `被禁言 ${event.duration}秒`;
        console.info(`[OneBot11] Group mute: group=${event.group_id}, user=${event.user_id}, ${action}, operator=${event.operator_id}`);
        break;
      }
      case "notify": {
        // Sub-types: poke (already handled above for standard poke), lucky_king, honor, etc.
        if (event.sub_type === "poke") {
          // Some implementations send poke as notice_type=notify, sub_type=poke
          // Re-dispatch as poke
          this.processNoticeEvent({ ...event, notice_type: "poke" }, ws);
        }
        break;
      }
      default:
        // Unknown notice type, log and ignore
        console.info(`[OneBot11] Unhandled notice: ${event.notice_type} sub_type=${event.sub_type ?? "none"}`);
        break;
    }
  }

  /** 创建合成消息事件 (用于将 notice 转为 pipeline 可处理的消息) */
  private createSyntheticMessageEvent(
    text: string,
    sessionId: string,
    isGroup: boolean,
    userId: number,
    nickname: string,
    ws: WebSocket,
    extraComponent?: MessageComponent,
  ): void {
    const platformMsg = new PlatformMessage();
    platformMsg.type = isGroup ? MessageType.GROUP_MESSAGE : MessageType.FRIEND_MESSAGE;
    platformMsg.selfId = this.meta().id;
    platformMsg.sessionId = sessionId;
    platformMsg.messageId = `synthetic_${Date.now()}`;
    platformMsg.sender = { userId: String(userId), nickname };
    platformMsg.messageStr = text;

    const components: MessageComponent[] = [{
      type: ComponentType.Plain,
      text,
      toDict() { return { type: "text", data: { text } }; },
    } as PlainComponent];
    if (extraComponent) {
      components.push(extraComponent);
    }
    platformMsg.components = components;
    platformMsg.timestamp = Date.now();

    const event = new OneBot11Event(text, platformMsg, sessionId, this.meta());
    event.setWebSocket(ws);
    event.setAdapter(this);

    if (isGroup) {
      const groupId = Number(sessionId.replace("group_", ""));
      event.setExtra("group_id", groupId);
    }
    event.setExtra("user_id", userId);

    this.commitEvent(event);
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  // ── Group Management APIs (Phase 5) ──

  /** 踢出群成员 */
  async setGroupKick(groupId: number, userId: number, rejectAddRequest: boolean = false): Promise<void> {
    await this.callApiWithResponse("set_group_kick", { group_id: groupId, user_id: userId, reject_add_request: rejectAddRequest });
  }

  /** 禁言群成员 (duration 秒, 0 表示解除禁言) */
  async setGroupBan(groupId: number, userId: number, duration: number = 1800): Promise<void> {
    await this.callApiWithResponse("set_group_ban", { group_id: groupId, user_id: userId, duration });
  }

  /** 全员禁言 */
  async setGroupWholeBan(groupId: number, enable: boolean = true): Promise<void> {
    await this.callApiWithResponse("set_group_whole_ban", { group_id: groupId, enable });
  }

  /** 设置群名片 */
  async setGroupCard(groupId: number, userId: number, card: string): Promise<void> {
    await this.callApiWithResponse("set_group_card", { group_id: groupId, user_id: userId, card });
  }

  /** 设置群名 */
  async setGroupName(groupId: number, name: string): Promise<void> {
    await this.callApiWithResponse("set_group_name", { group_id: groupId, group_name: name });
  }

  /** 退出群聊 (isDismiss=true 时解散群) */
  async setGroupLeave(groupId: number, isDismiss: boolean = false): Promise<void> {
    await this.callApiWithResponse("set_group_leave", { group_id: groupId, is_dismiss: isDismiss });
  }

  /** 设置群管理员 */
  async setGroupAdmin(groupId: number, userId: number, enable: boolean = true): Promise<void> {
    await this.callApiWithResponse("set_group_admin", { group_id: groupId, user_id: userId, enable });
  }

  /** 设置群专属头衔 */
  async setGroupSpecialTitle(groupId: number, userId: number, specialTitle: string): Promise<void> {
    await this.callApiWithResponse("set_group_special_title", { group_id: groupId, user_id: userId, special_title: specialTitle });
  }

  // ── Info Query APIs (Phase 6) ──

  /** 获取好友列表 */
  async getFriendList(): Promise<Array<{ user_id: number; nickname: string; remark: string }>> {
    return this.callApiWithResponse("get_friend_list", {}) as Promise<Array<{ user_id: number; nickname: string; remark: string }>>;
  }

  /** 获取群列表 */
  async getGroupList(): Promise<Ob11GroupInfo[]> {
    return this.callApiWithResponse("get_group_list", {}) as Promise<Ob11GroupInfo[]>;
  }

  /** 获取群信息 */
  async getGroupInfo(groupId: number): Promise<Ob11GroupInfo> {
    return this.callApiWithResponse("get_group_info", { group_id: groupId }) as Promise<Ob11GroupInfo>;
  }

  /** 获取群成员信息 */
  async getGroupMemberInfo(groupId: number, userId: number): Promise<Ob11GroupMemberInfo> {
    return this.callApiWithResponse("get_group_member_info", { group_id: groupId, user_id: userId }) as Promise<Ob11GroupMemberInfo>;
  }

  /** 获取群成员列表 */
  async getGroupMemberList(groupId: number): Promise<Ob11GroupMemberInfo[]> {
    return this.callApiWithResponse("get_group_member_list", { group_id: groupId }) as Promise<Ob11GroupMemberInfo[]>;
  }

  /** 获取陌生人信息 */
  async getStrangerInfo(userId: number): Promise<{ user_id: number; nickname: string; sex: string; age: number }> {
    return this.callApiWithResponse("get_stranger_info", { user_id: userId }) as Promise<{ user_id: number; nickname: string; sex: string; age: number }>;
  }

  private ob11ToComponents(segments: OB11MessageSegment[]): MessageComponent[] {
    const components: MessageComponent[] = [];

    for (const seg of segments) {
      const data = seg.data as Record<string, unknown>;
      switch (seg.type) {
        case "text":
          components.push({
            type: ComponentType.Plain,
            text: (data.text as string) ?? "",
            toDict() { return { type: "text", data: { text: data.text ?? "" } }; },
          } as PlainComponent);
          break;

        case "image": {
          // 解码 URL 中的 HTML 实体（如 &amp; → &）
          const rawUrl = (data.url as string) ?? "";
          const url = decodeHtmlEntities(rawUrl);
          const file = (data.file as string) ?? "";
          components.push({
            type: ComponentType.Image,
            url: url || file,
            file: file || undefined,
            toDict() { return { type: "image", data: seg.data }; },
          } as ImageComponent);
          break;
        }

        case "at":
          components.push({
            type: ComponentType.At,
            qq: (data.qq as string | number) ?? "all",
            toDict() { return { type: "at", data: seg.data }; },
          } as AtComponent);
          break;

        case "reply":
          components.push({
            type: ComponentType.Reply,
            messageId: String(data.id ?? ""),
            toDict() { return { type: "reply", data: seg.data }; },
          } as unknown as MessageComponent);
          break;

        case "face":
          components.push({
            type: ComponentType.Face,
            faceId: String(data.id ?? ""),
            toDict() { return { type: "face", data: seg.data }; },
          } as unknown as MessageComponent);
          break;

        case "record":
          components.push({
            type: ComponentType.Record,
            url: (data.url as string) ?? (data.file as string) ?? "",
            toDict() { return { type: "record", data: seg.data }; },
          } as unknown as MessageComponent);
          break;

        case "file": {
          const rawFileUrl = (data.url as string) ?? "";
          const fileUrl = rawFileUrl ? decodeHtmlEntities(rawFileUrl) : "";
          const fileId = (data.file as string) ?? (data.file_id as string) ?? "";
          const fileName = (data.name as string) ?? (data.filename as string) ?? fileId;
          components.push({
            type: ComponentType.File,
            url: fileUrl || undefined,
            file: fileId || undefined,
            name: fileName || undefined,
            toDict() { return { type: "file", data: seg.data }; },
          } as FileComponent);
          break;
        }

        case "video": {
          const rawVideoUrl = (data.url as string) ?? "";
          const videoUrl = rawVideoUrl ? decodeHtmlEntities(rawVideoUrl) : "";
          const videoFile = (data.file as string) ?? "";
          components.push({
            type: ComponentType.Video,
            file: videoFile || videoUrl,
            toDict() { return { type: "video", data: seg.data }; },
          } as unknown as MessageComponent);
          break;
        }

        default:
          components.push({
            type: ComponentType.Unknown,
            toDict() { return { type: seg.type, data: seg.data }; },
          } as unknown as MessageComponent);
          break;
      }
    }

    return components;
  }
}
