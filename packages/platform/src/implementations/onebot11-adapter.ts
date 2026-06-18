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
import type { MessageComponent, PlainComponent, ImageComponent, AtComponent } from "@yachiyo/message/components.js";
import { ComponentType } from "@yachiyo/message/components.js";
import { PlatformMessage } from "@yachiyo/message/platform-message.js";
import { MessageType } from "@yachiyo/message/types.js";
import { generateId } from "@yachiyo/common/id-generator.js";
import type { MessageChain } from "@yachiyo/agent/types.js";
import type { OneBot11AdapterConfig } from "../config.js";

import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server, type IncomingMessage } from "http";

/** 解码常见的 HTML 实体（CQ 码中 &amp; 等） */
function decodeHtmlEntities(str: string): string {
  if (!str) return str;
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ── OneBot 11 Protocol Types ──

interface OB11MessageSegment {
  type: string;
  data: Record<string, any>;
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

interface OB11MetaEvent {
  post_type: "meta_event";
  meta_event_type: string;
  [key: string]: any;
}

interface OB11ApiResponse {
  status: string;
  retcode: number;
  data: any;
  message: string;
  echo?: string;
}

// ── OneBot11Event ──

class OneBot11Event extends MessageEvent {
  private ws: WebSocket | null = null;
  private adapter: OneBot11Adapter | null = null;
  private apiResponseResolve: ((data: any) => void) | null = null;
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

    const params: Record<string, any> = {};
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

    this.callApi(action, params, ws);
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

  private callApi(action: string, params: Record<string, any>, ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) {
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
          segments.push({ type: "reply", data: { id: (comp as any).messageId ?? "" } });
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

  private handleOb11Data(data: any, ws: WebSocket): void {
    // Handle API responses (echo)
    if (data.echo && data.retcode !== undefined) {
      // This is an API response, ignore for now
      return;
    }

    // Only handle message events
    if (data.post_type !== "message") {
      // Meta events, notice events etc. - log but don't process
      if (data.post_type === "meta_event") {
        // Respond to heartbeat if needed
        if (data.meta_event_type === "heartbeat") {
          // OneBot implementations handle their own heartbeat
        }
      }
      return;
    }

    const msgEvent = data as OB11MessageEvent;
    this.processMessageEvent(msgEvent, ws);
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

  private ob11ToComponents(segments: OB11MessageSegment[]): MessageComponent[] {
    const components: MessageComponent[] = [];

    for (const seg of segments) {
      switch (seg.type) {
        case "text":
          components.push({
            type: ComponentType.Plain,
            text: seg.data.text ?? "",
            toDict() { return { type: "text", data: { text: seg.data.text ?? "" } }; },
          } as PlainComponent);
          break;

        case "image": {
          // 解码 URL 中的 HTML 实体（如 &amp; → &）
          const rawUrl = seg.data.url ?? "";
          const url = decodeHtmlEntities(rawUrl);
          const file = seg.data.file ?? "";
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
            qq: seg.data.qq ?? "all",
            toDict() { return { type: "at", data: seg.data }; },
          } as AtComponent);
          break;

        case "reply":
          components.push({
            type: ComponentType.Reply,
            messageId: String(seg.data.id ?? ""),
            toDict() { return { type: "reply", data: seg.data }; },
          } as any);
          break;

        case "face":
          components.push({
            type: ComponentType.Face,
            faceId: String(seg.data.id ?? ""),
            toDict() { return { type: "face", data: seg.data }; },
          } as any);
          break;

        case "record":
          components.push({
            type: ComponentType.Record,
            url: seg.data.url ?? seg.data.file ?? "",
            toDict() { return { type: "record", data: seg.data }; },
          } as any);
          break;

        default:
          components.push({
            type: ComponentType.Unknown,
            toDict() { return { type: seg.type, data: seg.data }; },
          } as any);
          break;
      }
    }

    return components;
  }
}
