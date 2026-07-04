/**
 * QQ Official Bot Adapter — QQ 官方机器人 API 适配器
 *
 * 通过 WebSocket 接收事件，通过 REST API 发送消息。
 * 支持: 群@消息、C2C私聊消息、频道@消息、私信消息
 *
 * 协议参考: https://bot.q.qq.com/wiki/
 */

import { PlatformAdapter } from "../adapter.js";
import type { PlatformMetadata } from "../metadata.js";
import type { AsyncQueue } from "@yachiyo/common/async-queue.js";
import { MessageEvent } from "@yachiyo/message/event.js";
import type { MessageComponent, PlainComponent, ImageComponent } from "@yachiyo/message/components.js";
import { ComponentType } from "@yachiyo/message/components.js";
import { PlatformMessage } from "@yachiyo/message/platform-message.js";
import { MessageType } from "@yachiyo/message/types.js";
import type { MessageChain } from "@yachiyo/agent/types.js";

import { WebSocket } from "ws";

// ── Config ──

interface AdapterConfigBase {
  type: string;
  id: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface QQOfficialAdapterConfig extends AdapterConfigBase {
  type: "qqofficial";
  appId: string;
  appSecret: string;
  intents?: number;
}

// ── QQ Official API Types ──

/** WebSocket gateway opcodes */
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** Dispatch event types */
const DISPATCH_TYPE = {
  READY: "READY",
  GROUP_AT_MESSAGE_CREATE: "GROUP_AT_MESSAGE_CREATE",
  C2C_MESSAGE_CREATE: "C2C_MESSAGE_CREATE",
  AT_MESSAGE_CREATE: "AT_MESSAGE_CREATE",
  DIRECT_MESSAGE_CREATE: "DIRECT_MESSAGE_CREATE",
} as const;

/** Intents bitfield */
const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  PUBLIC_GUILD_MESSAGES: 1 << 12,
  GROUP_AT_MESSAGE_CREATE: 1 << 25,
  C2C_MESSAGE_CREATE: 1 << 26,
} as const;

interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
}

interface QQOfficialAuthor {
  user_openid?: string;
  member_openid?: string;
  id?: string;
  username?: string;
}

interface QQOfficialAttachment {
  content_type?: string;
  url?: string;
  filename?: string;
  height?: number;
  width?: number;
  size?: number;
}

interface QQOfficialDispatchPayload {
  op?: number;
  t?: string;
  s?: number;
  d?: unknown;
}

interface GroupAtMessageData {
  id: string;
  group_openid: string;
  content: string;
  author: QQOfficialAuthor;
  attachments?: QQOfficialAttachment[];
  timestamp?: string;
}

interface C2CMessageData {
  id: string;
  content: string;
  author: QQOfficialAuthor;
  attachments?: QQOfficialAttachment[];
  timestamp?: string;
}

interface AtMessageData {
  id: string;
  channel_id: string;
  guild_id: string;
  content: string;
  author: QQOfficialAuthor;
  mentions?: Array<{ id: string }>;
  attachments?: QQOfficialAttachment[];
  timestamp?: string;
}

interface DirectMessageData {
  id: string;
  channel_id: string;
  content: string;
  author: QQOfficialAuthor;
  attachments?: QQOfficialAttachment[];
  timestamp?: string;
}

interface HelloData {
  heartbeat_interval: number;
}

interface ReadyData {
  user: { id: string; username: string };
  session_id: string;
  shard?: [number, number];
}

// ── QQOfficialEvent ──

type QQOfficialEventType = "group" | "c2c" | "guild" | "direct";

class QQOfficialEvent extends MessageEvent {
  private adapter: QQOfficialAdapter;
  private eventType: QQOfficialEventType;
  private _umo: string;

  /** Target identifiers for replying */
  private targetId: string;
  private eventId: string;

  constructor(
    messageStr: string,
    messageObj: PlatformMessage,
    platformMeta: PlatformMetadata,
    sessionId: string,
    adapter: QQOfficialAdapter,
    eventType: QQOfficialEventType,
    targetId: string,
    eventId: string,
  ) {
    super(messageStr, messageObj, platformMeta, sessionId);
    this.adapter = adapter;
    this.eventType = eventType;
    this.targetId = targetId;
    this.eventId = eventId;

    // Build unified message origin
    switch (eventType) {
      case "group":
        this._umo = `qqofficial:group:${targetId}`;
        break;
      case "c2c":
        this._umo = `qqofficial:private:${targetId}`;
        break;
      case "guild":
        this._umo = `qqofficial:guild:${targetId}`;
        break;
      case "direct":
        this._umo = `qqofficial:private:${targetId}`;
        break;
    }
  }

  get unifiedMsgOrigin(): string {
    return this._umo;
  }

  async send(components: MessageComponent[]): Promise<void> {
    const plainText = this.extractPlainText(components);
    if (!plainText) return;

    try {
      switch (this.eventType) {
        case "group":
          await this.adapter.sendGroupMessage(this.targetId, plainText, this.eventId);
          break;
        case "c2c":
          await this.adapter.sendC2CMessage(this.targetId, plainText, this.eventId);
          break;
        case "guild":
          await this.adapter.sendGuildMessage(this.targetId, plainText);
          break;
        case "direct":
          await this.adapter.sendDirectMessage(this.targetId, plainText);
          break;
      }
    } catch (e: unknown) {
      console.error("[QQOfficial] Failed to send message:", e);
    }
  }

  async sendStreaming(generator: AsyncGenerator<MessageChain, void>): Promise<void> {
    // Send chunks progressively instead of buffering the entire response.
    // QQ Official API does not support message editing, so we flush the
    // accumulated text periodically (every 500ms or 500 chars) to give the
    // user a streaming feel without flooding the chat with tiny messages.
    const FLUSH_INTERVAL_MS = 500;
    const FLUSH_CHAR_THRESHOLD = 500;

    let buffer = "";
    let lastFlush = Date.now();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = async (): Promise<void> => {
      if (buffer.length === 0) return;
      const text = buffer;
      buffer = "";
      lastFlush = Date.now();
      await this.send([{
        type: ComponentType.Plain,
        text,
        toDict() { return { type: "text", data: { text } }; },
      } as MessageComponent]);
    };

    // Periodic flush timer ensures partial output is sent even if the
    // generator stalls between chunks.
    flushTimer = setInterval(() => {
      if (buffer.length > 0 && Date.now() - lastFlush >= FLUSH_INTERVAL_MS) {
        flush().catch((e: unknown) => console.error("[QQOfficial] Streaming flush failed:", e));
      }
    }, FLUSH_INTERVAL_MS);

    try {
      for await (const chunk of generator) {
        if (chunk.message) {
          buffer += chunk.message;
          if (buffer.length >= FLUSH_CHAR_THRESHOLD) {
            await flush();
          }
        }
      }
      // Final flush for any remaining buffered text.
      await flush();
    } finally {
      if (flushTimer) clearInterval(flushTimer);
    }
  }

  private extractPlainText(components: MessageComponent[]): string {
    return components
      .filter((c): c is PlainComponent => c.type === ComponentType.Plain)
      .map(c => c.text ?? "")
      .join("");
  }
}

// ── QQOfficialAdapter ──

export class QQOfficialAdapter extends PlatformAdapter {
  private config: QQOfficialAdapterConfig;

  // Authentication
  private accessToken: string = "";
  private tokenExpiresAt: number = 0;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  // WebSocket
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private msgSeqCounter: number = 0;

  constructor(config: QQOfficialAdapterConfig, eventQueue: AsyncQueue<MessageEvent>) {
    super(config as unknown as Record<string, unknown>, eventQueue);
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error("[QQOfficial] appId and appSecret are required");
    }
    await super.initialize();
  }

  async run(): Promise<void> {
    this._status = "running";
    this.reconnectAttempts = 0;
    await this.authenticate();
    this.connectWebSocket();
  }

  async stop(): Promise<void> {
    this._status = "stopping";

    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      try { this.ws.close(); } catch (e) { console.warn(`[QQOfficial] ws.close() failed:`, e); }
      this.ws = null;
    }

    try {
      await super.stop();
    } catch (e) { console.warn(`[QQOfficial] super.stop() failed:`, e); }
  }

  meta(): PlatformMetadata {
    return {
      name: "qqofficial",
      description: "QQ Official Bot Adapter",
      id: this.config.id,
      supportStreamingMessage: false,
      supportProactiveMessage: true,
    };
  }

  async healthCheck(): Promise<string | null> {
    if (!this.isRunning) return "Adapter not running";
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return "WebSocket not connected";
    }
    return null;
  }

  // ── Authentication ──

  private async authenticate(): Promise<void> {
    const body = JSON.stringify({
      appId: this.config.appId,
      clientSecret: this.config.appSecret,
    });

    const response = await fetch("https://bots.qq.com/app/getAppAccessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`[QQOfficial] Authentication failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as AccessTokenResponse;
    this.accessToken = data.access_token;
    // Refresh token 30 seconds before expiry
    const refreshDelay = Math.max((data.expires_in - 30) * 1000, 60000);
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;

    console.info(`[QQOfficial] Authenticated successfully, token expires in ${data.expires_in}s`);

    this.tokenRefreshTimer = setTimeout(() => {
      this.refreshToken().catch((e: unknown) => {
        console.error("[QQOfficial] Token refresh failed:", e);
      });
    }, refreshDelay);
  }

  private async refreshToken(): Promise<void> {
    try {
      await this.authenticate();
      console.info("[QQOfficial] Token refreshed successfully");
    } catch (e: unknown) {
      console.error("[QQOfficial] Token refresh failed:", e);
      // Clear any existing timer before scheduling a retry to prevent
      // overlapping timer chains on repeated failures.
      if (this.tokenRefreshTimer) {
        clearTimeout(this.tokenRefreshTimer);
        this.tokenRefreshTimer = null;
      }
      // Retry after 30 seconds
      this.tokenRefreshTimer = setTimeout(() => {
        this.refreshToken().catch(() => { /* will retry again */ });
      }, 30000);
    }
  }

  // ── WebSocket Connection ──

  private getIntents(): number {
    if (this.config.intents !== undefined) {
      return this.config.intents;
    }
    // Default: group + c2c + public guild messages
    return INTENTS.GUILDS
      | INTENTS.PUBLIC_GUILD_MESSAGES
      | INTENTS.GROUP_AT_MESSAGE_CREATE
      | INTENTS.C2C_MESSAGE_CREATE;
  }

  private connectWebSocket(): void {
    if (this._status !== "running") return;

    const url = "wss://api.sgroup.qq.com/websocket";
    console.info(`[QQOfficial] Connecting to WebSocket: ${url}`);

    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `QQBot ${this.accessToken}`,
      },
    });

    this.ws.on("open", () => {
      console.info("[QQOfficial] WebSocket connected");
      this.reconnectAttempts = 0;
    });

    this.ws.on("message", (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString()) as QQOfficialDispatchPayload;
        this.handleWsMessage(data);
      } catch (e: unknown) {
        console.error("[QQOfficial] Failed to parse WebSocket message:", e);
      }
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      console.warn(`[QQOfficial] WebSocket closed (code=${code}, reason=${reason})`);
      this.cleanupWs();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.error("[QQOfficial] WebSocket error:", err.message);
    });
  }

  private handleWsMessage(data: QQOfficialDispatchPayload): void {
    const op = data.op;

    switch (op) {
      case OP.HELLO: {
        const hello = data.d as HelloData;
        this.startHeartbeat(hello.heartbeat_interval);
        // After hello, send identify
        this.sendIdentify();
        break;
      }

      case OP.HEARTBEAT_ACK: {
        // Heartbeat acknowledged, connection is alive
        break;
      }

      case OP.RECONNECT: {
        console.info("[QQOfficial] Server requested reconnect");
        this.cleanupWs();
        this.scheduleReconnect();
        break;
      }

      case OP.DISPATCH: {
        this.handleDispatch(data.t, data.s, data.d);
        break;
      }

      default: {
        // Unknown opcode, ignore
        break;
      }
    }
  }

  private handleDispatch(eventType: string | undefined, seq: number | undefined, data: unknown): void {
    if (seq !== undefined) {
      this.lastSeq = seq;
    }

    if (!eventType) return;

    try {
      switch (eventType) {
        case DISPATCH_TYPE.READY: {
          const ready = data as ReadyData;
          this.sessionId = ready.session_id;
          console.info(`[QQOfficial] Session ready, session_id=${this.sessionId}`);
          break;
        }

        case DISPATCH_TYPE.GROUP_AT_MESSAGE_CREATE: {
          this.handleGroupAtMessage(data as GroupAtMessageData);
          break;
        }

        case DISPATCH_TYPE.C2C_MESSAGE_CREATE: {
          this.handleC2CMessage(data as C2CMessageData);
          break;
        }

        case DISPATCH_TYPE.AT_MESSAGE_CREATE: {
          this.handleAtMessage(data as AtMessageData);
          break;
        }

        case DISPATCH_TYPE.DIRECT_MESSAGE_CREATE: {
          this.handleDirectMessage(data as DirectMessageData);
          break;
        }

        default: {
          // Unhandled dispatch event, ignore
          break;
        }
      }
    } catch (e: unknown) {
      console.error(`[QQOfficial] Error handling dispatch event ${eventType}:`, e);
    }
  }

  // ── Message Handlers ──

  private handleGroupAtMessage(data: GroupAtMessageData): void {
    const content = this.stripMentionPrefix(data.content ?? "").trim();
    const senderId = data.author.member_openid ?? data.author.user_openid ?? "unknown";
    const groupOpenId = data.group_openid;

    const components = this.parseAttachments(data.attachments);
    components.unshift({
      type: ComponentType.Plain,
      text: content,
      toDict() { return { type: "text", data: { text: content } }; },
    } as PlainComponent);

    const platformMsg = new PlatformMessage();
    platformMsg.type = MessageType.GROUP_MESSAGE;
    platformMsg.selfId = this.config.appId;
    platformMsg.sessionId = groupOpenId;
    platformMsg.messageId = data.id;
    platformMsg.sender = { userId: senderId, nickname: null };
    platformMsg.components = components;
    platformMsg.messageStr = content;
    platformMsg.timestamp = data.timestamp ? Date.parse(data.timestamp) : Date.now();

    const event = new QQOfficialEvent(
      platformMsg.messageStr,
      platformMsg,
      this.meta(),
      groupOpenId,
      this,
      "group",
      groupOpenId,
      data.id,
    );

    this.commitEvent(event);
  }

  private handleC2CMessage(data: C2CMessageData): void {
    const content = (data.content ?? "").trim();
    const senderId = data.author.user_openid ?? "unknown";

    const components = this.parseAttachments(data.attachments);
    components.unshift({
      type: ComponentType.Plain,
      text: content,
      toDict() { return { type: "text", data: { text: content } }; },
    } as PlainComponent);

    const platformMsg = new PlatformMessage();
    platformMsg.type = MessageType.FRIEND_MESSAGE;
    platformMsg.selfId = this.config.appId;
    platformMsg.sessionId = senderId;
    platformMsg.messageId = data.id;
    platformMsg.sender = { userId: senderId, nickname: null };
    platformMsg.components = components;
    platformMsg.messageStr = content;
    platformMsg.timestamp = data.timestamp ? Date.parse(data.timestamp) : Date.now();

    const event = new QQOfficialEvent(
      platformMsg.messageStr,
      platformMsg,
      this.meta(),
      senderId,
      this,
      "c2c",
      senderId,
      data.id,
    );

    this.commitEvent(event);
  }

  private handleAtMessage(data: AtMessageData): void {
    // Guild channel @bot message
    const content = this.stripMentionPrefix(data.content ?? "").trim();
    const senderId = data.author.id ?? "unknown";
    const channelId = data.channel_id;

    const components = this.parseAttachments(data.attachments);
    components.unshift({
      type: ComponentType.Plain,
      text: content,
      toDict() { return { type: "text", data: { text: content } }; },
    } as PlainComponent);

    const platformMsg = new PlatformMessage();
    platformMsg.type = MessageType.GROUP_MESSAGE;
    platformMsg.selfId = this.config.appId;
    platformMsg.sessionId = channelId;
    platformMsg.messageId = data.id;
    platformMsg.sender = { userId: senderId, nickname: data.author.username ?? null };
    platformMsg.components = components;
    platformMsg.messageStr = content;
    platformMsg.timestamp = data.timestamp ? Date.parse(data.timestamp) : Date.now();

    const event = new QQOfficialEvent(
      platformMsg.messageStr,
      platformMsg,
      this.meta(),
      channelId,
      this,
      "guild",
      channelId,
      data.id,
    );

    this.commitEvent(event);
  }

  private handleDirectMessage(data: DirectMessageData): void {
    const content = (data.content ?? "").trim();
    const senderId = data.author.id ?? "unknown";
    const channelId = data.channel_id;

    const components = this.parseAttachments(data.attachments);
    components.unshift({
      type: ComponentType.Plain,
      text: content,
      toDict() { return { type: "text", data: { text: content } }; },
    } as PlainComponent);

    const platformMsg = new PlatformMessage();
    platformMsg.type = MessageType.FRIEND_MESSAGE;
    platformMsg.selfId = this.config.appId;
    platformMsg.sessionId = channelId;
    platformMsg.messageId = data.id;
    platformMsg.sender = { userId: senderId, nickname: null };
    platformMsg.components = components;
    platformMsg.messageStr = content;
    platformMsg.timestamp = data.timestamp ? Date.parse(data.timestamp) : Date.now();

    const event = new QQOfficialEvent(
      platformMsg.messageStr,
      platformMsg,
      this.meta(),
      channelId,
      this,
      "direct",
      channelId,
      data.id,
    );

    this.commitEvent(event);
  }

  // ── Message Parsing Helpers ──

  /** Strip @bot mention prefix like `<@!123456>` from content */
  private stripMentionPrefix(content: string): string {
    return content.replace(/<@!\d+>/g, "").trim();
  }

  private parseAttachments(attachments?: QQOfficialAttachment[]): MessageComponent[] {
    const components: MessageComponent[] = [];
    if (!attachments) return components;

    for (const att of attachments) {
      const contentType = (att.content_type ?? "").toLowerCase();
      const url = att.url
        ? (att.url.startsWith("http://") || att.url.startsWith("https://"))
          ? att.url
          : `https://${att.url}`
        : "";

      if (contentType.startsWith("image") || !contentType) {
        if (url) {
          components.push({
            type: ComponentType.Image,
            url,
            toDict() { return { type: "image", data: { url } }; },
          } as ImageComponent);
        }
      }
      // Other attachment types can be extended here
    }

    return components;
  }

  // ── WebSocket Protocol ──

  private sendIdentify(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const payload: QQOfficialDispatchPayload = {
      op: OP.IDENTIFY,
      d: {
        token: `QQBot ${this.accessToken}`,
        intents: this.getIntents(),
        shard: [0, 1],
      },
    };

    this.ws.send(JSON.stringify(payload));
    console.info("[QQOfficial] Identify sent");
  }

  private sendResume(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.sessionId || this.lastSeq === null) {
      // Cannot resume, re-identify
      this.sendIdentify();
      return;
    }

    const payload: QQOfficialDispatchPayload = {
      op: OP.RESUME,
      d: {
        token: `QQBot ${this.accessToken}`,
        session_id: this.sessionId,
        seq: this.lastSeq,
      },
    };

    this.ws.send(JSON.stringify(payload));
    console.info("[QQOfficial] Resume sent");
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const payload: QQOfficialDispatchPayload = {
          op: OP.HEARTBEAT,
          d: this.lastSeq,
        };
        try {
          this.ws.send(JSON.stringify(payload));
        } catch (e: unknown) {
          console.error("[QQOfficial] Failed to send heartbeat:", e);
        }
      }
    }, intervalMs);

    console.info(`[QQOfficial] Heartbeat started, interval=${intervalMs}ms`);
  }

  private cleanupWs(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this._status !== "running") return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[QQOfficial] Max reconnect attempts (${this.maxReconnectAttempts}) reached, giving up`);
      this._status = "error";
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, ... up to 60s
    const baseDelay = 1000;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;

    console.info(`[QQOfficial] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    this.reconnectTimer = setTimeout(async () => {
      if (this._status !== "running") return;

      try {
        await this.authenticate();
        this.connectWebSocket();
        // Try resume first, identify will be sent after HELLO
      } catch (e: unknown) {
        console.error("[QQOfficial] Reconnect authentication failed:", e);
        this.scheduleReconnect();
      }
    }, delay);
  }

  // ── REST API: Send Messages ──

  private getAuthHeaders(): Record<string, string> {
    return {
      "Authorization": `QQBot ${this.accessToken}`,
      "Content-Type": "application/json",
    };
  }

  /** Generate a monotonic msg_seq for idempotency tracking (QQ dedupes within 5s). */
  private nextMsgSeq(): number {
    this.msgSeqCounter = (this.msgSeqCounter + 1) % 1000000;
    return this.msgSeqCounter;
  }

  /** Send group message via REST API */
  async sendGroupMessage(groupOpenId: string, content: string, eventId: string): Promise<void> {
    const url = `https://api.sgroup.qq.com/v2/groups/${groupOpenId}/messages`;
    const body = JSON.stringify({
      content,
      msg_type: 0,
      msg_id: eventId,
      msg_seq: this.nextMsgSeq(),
    });

    const response = await fetch(url, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] Send group message failed: ${response.status} ${text}`);
    }
  }

  /** Send C2C message via REST API */
  async sendC2CMessage(openid: string, content: string, eventId: string): Promise<void> {
    const url = `https://api.sgroup.qq.com/v2/users/${openid}/messages`;
    const body = JSON.stringify({
      content,
      msg_type: 0,
      msg_id: eventId,
      msg_seq: this.nextMsgSeq(),
    });

    const response = await fetch(url, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] Send C2C message failed: ${response.status} ${text}`);
    }
  }

  /** Send guild channel message via REST API */
  async sendGuildMessage(channelId: string, content: string): Promise<void> {
    const url = `https://api.sgroup.qq.com/channels/${channelId}/messages`;
    const body = JSON.stringify({ content });

    const response = await fetch(url, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] Send guild message failed: ${response.status} ${text}`);
    }
  }

  /** Send direct message (guild DM) via REST API */
  async sendDirectMessage(channelId: string, content: string): Promise<void> {
    // For guild DMs, we post directly to the DM channel
    const url = `https://api.sgroup.qq.com/channels/${channelId}/messages`;
    const body = JSON.stringify({ content });

    const response = await fetch(url, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] Send direct message failed: ${response.status} ${text}`);
    }
  }

  /** Create a DM session for guild direct messages */
  async createDmSession(recipientId: string): Promise<string> {
    const url = "https://api.sgroup.qq.com/users/@me/dms";
    const body = JSON.stringify({ recipient_id: recipientId });

    const response = await fetch(url, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] Create DM session failed: ${response.status} ${text}`);
    }

    const data = await response.json() as { channel_id: string };
    return data.channel_id;
  }
}
