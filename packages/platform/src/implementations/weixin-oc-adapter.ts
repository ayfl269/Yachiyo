/**
 * Weixin OC (个人微信) Adapter — iLink Bot 协议适配器
 *
 * 通过 iLink Bot 官方协议接入个人微信。
 * 支持: 扫码登录、文本消息收发、媒体消息收发、输入状态管理
 *
 * 协议端点: ilinkai.weixin.qq.com
 */

import { PlatformAdapter } from "../adapter.js";
import type { PlatformMetadata } from "../metadata.js";
import type { AsyncQueue } from "@yachiyo/common/async-queue.js";
import { MessageEvent } from "@yachiyo/message/event.js";
import type { MessageComponent, PlainComponent, ImageComponent, RecordComponent, FileComponent, VideoComponent } from "@yachiyo/message/components.js";
import { ComponentType } from "@yachiyo/message/components.js";
import { PlatformMessage } from "@yachiyo/message/platform-message.js";
import { MessageType } from "@yachiyo/message/types.js";
import { generateId } from "@yachiyo/common/id-generator.js";
import type { MessageChain } from "@yachiyo/agent/types.js";

import { createCipheriv, createDecipheriv } from "crypto";

// ── Config ──

interface AdapterConfigBase {
  type: string;
  id: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface WeixinOCAdapterConfig extends AdapterConfigBase {
  type: "weixin_oc";
  /** iLink API 基础 URL */
  baseUrl?: string;
  /** CDN 基础 URL */
  cdnBaseUrl?: string;
  /** 已有的 bot_token (可选, 不填则走扫码登录) */
  token?: string;
  /** 已有的 account_id (可选) */
  accountId?: string;
  /** 已有的 sync_buf (可选) */
  syncBuf?: string;
  /** 二维码轮询间隔 (毫秒, 默认 1000) */
  qrPollInterval?: number;
  /** 长轮询超时 (毫秒, 默认 35000) */
  longPollTimeout?: number;
  /** API 请求超时 (毫秒, 默认 120000) */
  apiTimeout?: number;
  /** bot_type 参数 (默认 "3") */
  botType?: string;
}

// ── iLink API Constants ──

const ITEM_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

const SESSION_TIMEOUT_ERRCODE = -14;

/** Channel version sent in `base_info` for every iLink Bot API call. */
const WECHAT_CHANNEL_VERSION = "yachiyo-agent";

/**
 * Generate the per-request `X-WECHAT-UIN` header value. The official client
 * sends a random 32-bit UIN encoded as base64; we mimic that shape. The value
 * has no auth significance but is required by the gateway.
 */
function generateWechatUinHeader(): string {
  return Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString("base64");
}

// ── AES-ECB Helpers ──
//
// SECURITY NOTE: AES-128-ECB is required by the WeChat iLink Bot media-download
// protocol. The iLink gateway derives a per-bot media AES key and decrypts
// uploaded media using AES-128-ECB with PKCS#7 padding, and there is no
// negotiation of mode/IV on the wire. We cannot unilaterally switch to a
// stronger mode (e.g. AES-GCM or AES-CBC) without breaking interop with the
// official gateway. ECB here is acceptable because:
//   1. It is used only for individual media-file encryption at rest on the
//      WeChat CDN, not for general-purpose transport encryption (transport
//      uses HTTPS).
//   2. Plaintexts are high-entropy media bytes (already-compressed image/audio
//      data), not structured data with low-entropy block patterns, so ECB's
//      classic pattern-leakage weakness has minimal practical impact.
//   3. Each media file uses the bot's single derived key; we never encrypt
//      multiple distinct messages with ECB under the same key in a way that
//      would enable known-plaintext attacks across files.
// Do not "fix" this by changing the cipher mode without a protocol upgrade
// from WeChat.

function pkcs7Pad(data: Buffer, blockSize: number = 16): Buffer {
  const padLen = blockSize - (data.length % blockSize);
  return Buffer.concat([data, Buffer.alloc(padLen, padLen)]);
}

function pkcs7Unpad(data: Buffer): Buffer {
  if (data.length === 0) return data;
  const padLen = data[data.length - 1];
  if (padLen <= 0 || padLen > 16) return data;
  for (let i = data.length - padLen; i < data.length; i++) {
    if (data[i] !== padLen) return data;
  }
  return data.subarray(0, data.length - padLen);
}

function aesEcbEncrypt(plain: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(pkcs7Pad(plain)), cipher.final()]);
}

function aesEcbDecrypt(cipher: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return pkcs7Unpad(Buffer.concat([decipher.update(cipher), decipher.final()]));
}

function parseMediaAesKey(aesKeyValue: string): Buffer {
  const normalized = aesKeyValue.trim();
  if (!normalized) throw new Error("empty media aes key");

  // Try base64 decode — (4 - len % 4) % 4 yields 0/1/2/3, never negative.
  // The old `-len % 4` produced -1/-2/-3 for non-multiple lengths, causing
  // String.prototype.repeat() to throw RangeError on every non-aligned input.
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const decoded = Buffer.from(padded, "base64");

  if (decoded.length === 16) return decoded;

  // Try hex string
  const decodedText = decoded.toString("ascii");
  if (decoded.length === 32 && /^[0-9a-fA-F]+$/.test(decodedText)) {
    return Buffer.from(decodedText, "hex");
  }

  throw new Error("unsupported media aes key format");
}

// ── iLink HTTP Client ──

class ILinkClient {
  private baseUrl: string;
  private cdnBaseUrl: string;
  private apiTimeout: number;
  private token: string | null;

  constructor(baseUrl: string, cdnBaseUrl: string, apiTimeout: number, token: string | null) {
    this.baseUrl = baseUrl;
    this.cdnBaseUrl = cdnBaseUrl;
    this.apiTimeout = apiTimeout;
    this.token = token;
  }

  updateToken(token: string | null): void {
    this.token = token;
  }

  updateBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  private buildHeaders(tokenRequired: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "AuthorizationType": "ilink_bot_token",
      "X-WECHAT-UIN": generateWechatUinHeader(),
    };
    if (tokenRequired && this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    return headers;
  }

  private resolveUrl(endpoint: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
  }

  async requestJson(
    method: string,
    endpoint: string,
    options?: {
      params?: Record<string, string>;
      payload?: Record<string, unknown>;
      tokenRequired?: boolean;
      timeoutMs?: number;
      headers?: Record<string, string>;
    },
  ): Promise<Record<string, unknown>> {
    const { params, payload, tokenRequired = false, timeoutMs, headers: extraHeaders } = options ?? {};

    const url = new URL(this.resolveUrl(endpoint));
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const mergedHeaders = { ...this.buildHeaders(tokenRequired), ...extraHeaders };
    const timeout = timeoutMs ?? this.apiTimeout;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers: mergedHeaders,
        body: payload ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${method} ${endpoint} failed: ${response.status} ${text}`);
      }
      if (!text) return {};
      return JSON.parse(text) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── CDN Operations ──

  private buildCdnUploadUrl(uploadParam: string, fileKey: string): string {
    return `${this.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(fileKey)}`;
  }

  private buildCdnDownloadUrl(encryptedQueryParam: string): string {
    return `${this.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
  }

  async uploadToCdn(
    uploadFullUrl: string | undefined,
    uploadParam: string,
    fileKey: string,
    aesKeyHex: string,
    data: Buffer,
  ): Promise<string> {
    const cdnUrl = uploadFullUrl || this.buildCdnUploadUrl(uploadParam, fileKey);
    if (!cdnUrl) throw new Error("CDN upload URL missing");

    const key = Buffer.from(aesKeyHex, "hex");
    const encrypted = aesEcbEncrypt(data, key);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.apiTimeout);

    try {
      const response = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: encrypted,
        signal: controller.signal,
      });

      const body = await response.text();
      if (response.status >= 400) {
        throw new Error(`upload media to cdn failed: ${response.status} ${body}`);
      }

      const downloadParam = response.headers.get("x-encrypted-param");
      if (!downloadParam) {
        throw new Error("upload media to cdn failed: missing x-encrypted-param");
      }
      return downloadParam;
    } finally {
      clearTimeout(timer);
    }
  }

  async downloadCdnBytes(encryptedQueryParam: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.apiTimeout);

    try {
      const response = await fetch(this.buildCdnDownloadUrl(encryptedQueryParam), {
        signal: controller.signal,
      });
      if (response.status >= 400) {
        const text = await response.text();
        throw new Error(`download media from cdn failed: ${response.status} ${text}`);
      }
      const arrayBuf = await response.arrayBuffer();
      return Buffer.from(arrayBuf);
    } finally {
      clearTimeout(timer);
    }
  }

  async downloadAndDecryptMedia(
    encryptedQueryParam: string,
    aesKeyValue: string,
  ): Promise<Buffer> {
    const encrypted = await this.downloadCdnBytes(encryptedQueryParam);
    const key = parseMediaAesKey(aesKeyValue);
    return aesEcbDecrypt(encrypted, key);
  }
}

// ── Login Session ──

interface LoginSession {
  qrcode: string;
  qrcodeImgContent: string;
  startedAt: number;
  status: string;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
  error?: string;
}

// ── Typing State ──

interface TypingState {
  ticket: string | null;
  contextToken: string | null;
  refreshAfter: number;
  keepaliveTimer: ReturnType<typeof setInterval> | null;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  owners: Set<string>;
}

// ── WeixinOCEvent ──

class WeixinOCEvent extends MessageEvent {
  private adapter: WeixinOCAdapter;
  private targetUserId: string;

  constructor(
    messageStr: string,
    messageObj: PlatformMessage,
    platformMeta: PlatformMetadata,
    sessionId: string,
    adapter: WeixinOCAdapter,
    targetUserId: string,
  ) {
    super(messageStr, messageObj, platformMeta, sessionId);
    this.adapter = adapter;
    this.targetUserId = targetUserId;
  }

  get unifiedMsgOrigin(): string {
    return `weixin_oc:private:${this.targetUserId}`;
  }

  async send(components: MessageComponent[]): Promise<void> {
    const plainText = this.extractPlainText(components);
    if (!plainText) return;

    try {
      await this.adapter.sendTextMessage(this.targetUserId, plainText);
    } catch (e: unknown) {
      console.error("[WeixinOC] Failed to send message:", e);
    }
  }

  async sendStreaming(generator: AsyncGenerator<MessageChain, void>): Promise<void> {
    const parts: string[] = [];
    for await (const chunk of generator) {
      if (chunk.type === "reasoning") continue;
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
    try {
      await this.adapter.startTyping(this.targetUserId, "event");
    } catch (e) { console.warn(`[WeixinOC] startTyping failed:`, e); }
  }

  async stopTyping(): Promise<void> {
    try {
      await this.adapter.stopTyping(this.targetUserId, "event");
    } catch (e) { console.warn(`[WeixinOC] stopTyping failed:`, e); }
  }

  private extractPlainText(components: MessageComponent[]): string {
    return components
      .filter((c): c is PlainComponent => c.type === ComponentType.Plain)
      .map(c => c.text ?? "")
      .join("");
  }
}

// ── WeixinOCAdapter ──

export class WeixinOCAdapter extends PlatformAdapter {
  private config: WeixinOCAdapterConfig;

  // Connection state
  private baseUrl: string;
  private cdnBaseUrl: string;
  private botType: string;
  private qrPollInterval: number;
  private longPollTimeout: number;
  private apiTimeout: number;

  // Auth state
  private token: string | null = null;
  private accountId: string | null = null;
  private syncBuf: string = "";
  private contextTokens: Map<string, string> = new Map();
  private contextTokensDirty: boolean = false;

  // Login state
  private loginSession: LoginSession | null = null;
  private qrExpiredCount: number = 0;
  private lastInboundError: string = "";

  // Typing state
  private typingStates: Map<string, TypingState> = new Map();
  private typingKeepaliveInterval: number = 5000; // ms
  private typingTicketTtl: number = 60000; // ms

  // Shutdown
  private shutdownRequested: boolean = false;

  // Client
  private client: ILinkClient;

  constructor(config: WeixinOCAdapterConfig, eventQueue: AsyncQueue<MessageEvent>) {
    super(config as unknown as Record<string, unknown>, eventQueue);
    this.config = config;

    this.baseUrl = (config.baseUrl ?? "https://ilinkai.weixin.qq.com").replace(/\/+$/, "");
    this.cdnBaseUrl = (config.cdnBaseUrl ?? "https://novac2c.cdn.weixin.qq.com/c2c").replace(/\/+$/, "");
    this.botType = config.botType ?? "3";
    this.qrPollInterval = config.qrPollInterval ?? 1000;
    this.longPollTimeout = config.longPollTimeout ?? 35000;
    this.apiTimeout = config.apiTimeout ?? 120000;

    // Load saved state
    this.token = config.token?.trim() || null;
    this.accountId = config.accountId?.trim() || null;
    this.syncBuf = config.syncBuf?.trim() || "";

    this.client = new ILinkClient(this.baseUrl, this.cdnBaseUrl, this.apiTimeout, this.token);

    if (this.token) {
      console.info(`[WeixinOC] Adapter ${this.config.id} loaded with existing token`);
    }
  }

  async initialize(): Promise<void> {
    await super.initialize();
  }

  async run(): Promise<void> {
    this._status = "running";
    this.shutdownRequested = false;

    // Run the main loop in the background (non-blocking, like QQOfficial adapter).
    // An outer recovery loop ensures the adapter does not die silently if an
    // unexpected error escapes the inner try/catch blocks — it logs, waits,
    // and re-enters the loop instead of leaving _status = "error" forever.
    (async () => {
    while (!this.shutdownRequested) {
      try {
        while (!this.shutdownRequested) {
        if (!this.token) {
          // Need to login via QR code
          if (!this.isLoginSessionValid(this.loginSession)) {
            try {
              this.loginSession = await this.startLoginSession();
              this.qrExpiredCount = 0;
            } catch (e: unknown) {
              console.error(`[WeixinOC] Start login failed:`, e);
              await this.sleep(5000);
              continue;
            }
          }

          const currentLogin = this.loginSession;
          if (!currentLogin) continue;

          try {
            await this.pollQrStatus(currentLogin);
          } catch (e: unknown) {
            if (e instanceof Error && e.name === "AbortError") {
              // Timeout, just retry
            } else {
              console.error(`[WeixinOC] Poll QR status failed:`, e);
              currentLogin.error = String(e);
              await this.sleep(2000);
            }
          }

          if (this.token) {
            console.info(`[WeixinOC] Login confirmed, account=${this.accountId ?? ""}`);
            continue;
          }

          if (currentLogin.error) {
            await this.sleep(2000);
          } else {
            await this.sleep(this.qrPollInterval);
          }
          continue;
        }

        // Logged in — poll for messages
        try {
          await this.pollInboundUpdates();
        } catch (e: unknown) {
          if (e instanceof Error && e.name === "AbortError") {
            // Long poll timeout, normal
          } else {
            console.error(`[WeixinOC] Poll inbound updates failed, retrying in 5s:`, e);
            await this.sleep(5000);
          }
        }
      }
    } catch (e: unknown) {
      console.error(`[WeixinOC] Run loop crashed:`, e);
      if (this.shutdownRequested) break;
      console.info(`[WeixinOC] Attempting recovery in 10s...`);
      await this.sleep(10000);
    }
    }
    if (this._status === "running") this._status = "stopped";
    })();
  }

  async stop(): Promise<void> {
    this.shutdownRequested = true;
    this.cleanupTypingStates();

    try {
      await super.stop();
    } catch (e) { console.warn(`[WeixinOC] super.stop() failed:`, e); }
  }

  meta(): PlatformMetadata {
    return {
      name: "weixin_oc",
      description: "个人微信 (iLink Bot)",
      id: this.config.id,
      supportStreamingMessage: false,
      supportProactiveMessage: true,
    };
  }

  async healthCheck(): Promise<string | null> {
    if (!this.isRunning) return "Adapter not running";
    if (!this.token) return "Not logged in (no token)";
    return null;
  }

  // ── Login Flow ──

  private isLoginSessionValid(session: LoginSession | null): boolean {
    if (!session) return false;
    return (Date.now() - session.startedAt) < 5 * 60 * 1000; // 5 minutes
  }

  private async startLoginSession(): Promise<LoginSession> {
    const data = await this.client.requestJson("GET", "ilink/bot/get_bot_qrcode", {
      params: { bot_type: this.botType },
      tokenRequired: false,
      timeoutMs: 15000,
    });

    const qrcode = String(data.qrcode ?? "").trim();
    const qrcodeImgContent = String(data.qrcode_img_content ?? "").trim();

    if (!qrcode || !qrcodeImgContent) {
      throw new Error("QR code response missing qrcode or qrcode_img_content");
    }

    console.info(`[WeixinOC] QR code generated. Please scan with WeChat to login.`);
    console.info(`[WeixinOC] QR link: ${qrcodeImgContent}`);

    return {
      qrcode,
      qrcodeImgContent,
      startedAt: Date.now(),
      status: "wait",
    };
  }

  private async pollQrStatus(session: LoginSession): Promise<void> {
    const data = await this.client.requestJson("GET", "ilink/bot/get_qrcode_status", {
      params: { qrcode: session.qrcode },
      tokenRequired: false,
      timeoutMs: this.longPollTimeout,
      headers: { "iLink-App-ClientVersion": "1" },
    });

    const status = String(data.status ?? "wait").trim();
    session.status = status;

    if (status === "expired") {
      this.qrExpiredCount++;
      if (this.qrExpiredCount > 3) {
        session.error = "QR code expired, max retries exceeded";
        this.loginSession = null;
        return;
      }
      console.warn(`[WeixinOC] QR expired, refreshing (${this.qrExpiredCount}/3)`);
      this.loginSession = await this.startLoginSession();
      return;
    }

    if (status === "confirmed") {
      const botToken = data.bot_token;
      const accountId = data.ilink_bot_id;
      const baseUrl = data.baseurl;
      const userId = data.ilink_user_id;

      if (!botToken) {
        session.error = "Login confirmed but no bot_token returned";
        return;
      }

      session.botToken = String(botToken);
      session.accountId = accountId ? String(accountId) : undefined;
      session.baseUrl = baseUrl ? String(baseUrl) : undefined;
      session.userId = userId ? String(userId) : undefined;

      this.token = session.botToken;
      this.accountId = session.accountId ?? null;
      if (session.baseUrl) {
        this.baseUrl = session.baseUrl.replace(/\/+$/, "");
        this.client.updateBaseUrl(this.baseUrl);
      }
      this.client.updateToken(this.token);

      console.info(`[WeixinOC] Login successful, account_id=${this.accountId ?? "unknown"}`);
      this.persistConfig();
    }
  }

  // ── Message Polling ──

  private async pollInboundUpdates(): Promise<void> {
    const data = await this.client.requestJson("POST", "ilink/bot/getupdates", {
      payload: {
        base_info: { channel_version: WECHAT_CHANNEL_VERSION },
        get_updates_buf: this.syncBuf,
      },
      tokenRequired: true,
      timeoutMs: this.longPollTimeout,
    });

    if (!this.isSuccessfulPayload(data)) {
      this.lastInboundError = this.formatApiError(data);
      console.warn(`[WeixinOC] getupdates error: ${this.lastInboundError}`);

      if (this.getApiErrcode(data) === SESSION_TIMEOUT_ERRCODE) {
        await this.handleInboundSessionTimeout();
        return;
      }
      await this.sleep(5000);
      return;
    }

    let shouldSaveState = this.contextTokensDirty;

    const newSyncBuf = data.get_updates_buf;
    if (newSyncBuf && typeof newSyncBuf === "string") {
      this.syncBuf = newSyncBuf;
      shouldSaveState = true;
    }

    const msgs = data.msgs;
    if (Array.isArray(msgs)) {
      for (const msg of msgs) {
        if (this.shutdownRequested) return;
        if (typeof msg === "object" && msg !== null) {
          await this.handleInboundMessage(msg as Record<string, unknown>);
        }
      }
    }

    if (shouldSaveState) {
      this.persistConfig();
      this.contextTokensDirty = false;
    }
  }

  // ── Inbound Message Handling ──

  private async handleInboundMessage(msg: Record<string, unknown>): Promise<void> {
    const fromUserId = String(msg.from_user_id ?? "").trim();
    if (!fromUserId) return;

    // Update context token
    const contextToken = String(msg.context_token ?? "").trim();
    if (contextToken) {
      const prev = this.contextTokens.get(fromUserId);
      if (prev !== contextToken) {
        this.contextTokens.set(fromUserId, contextToken);
        this.contextTokensDirty = true;
      }
    }

    const itemList = msg.item_list;
    const items: Record<string, unknown>[] = Array.isArray(itemList) ? itemList : [];

    // Parse components from item_list
    const components: MessageComponent[] = [];
    let textParts: string[] = [];

    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const itemType = Number(item.type ?? 0);

      if (itemType === ITEM_TYPE.TEXT) {
        const textItem = item.text_item as Record<string, unknown> | undefined;
        const text = String(textItem?.text ?? "").trim();
        if (text) {
          textParts.push(text);
          components.push({
            type: ComponentType.Plain,
            text,
            toDict() { return { type: "text", data: { text } }; },
          } as PlainComponent);
        }
      } else if (itemType === ITEM_TYPE.IMAGE) {
        textParts.push("[图片]");
        const imageComp = await this.resolveInboundImage(item);
        if (imageComp) components.push(imageComp);
      } else if (itemType === ITEM_TYPE.VOICE) {
        const voiceItem = item.voice_item as Record<string, unknown> | undefined;
        const voiceText = String(voiceItem?.text ?? "").trim();
        textParts.push(voiceText || "[语音]");
        const voiceComp = await this.resolveInboundVoice(item);
        if (voiceComp) components.push(voiceComp);
      } else if (itemType === ITEM_TYPE.FILE) {
        textParts.push("[文件]");
        const fileComp = await this.resolveInboundFile(item);
        if (fileComp) components.push(fileComp);
      } else if (itemType === ITEM_TYPE.VIDEO) {
        textParts.push("[视频]");
        const videoComp = await this.resolveInboundVideo(item);
        if (videoComp) components.push(videoComp);
      }
    }

    const messageStr = textParts.join("\n").trim();
    if (!messageStr && components.length === 0) return;

    const messageId = String(msg.message_id ?? msg.msg_id ?? generateId());
    const createTime = msg.create_time_ms ?? msg.create_time;
    let timestamp: number;
    if (typeof createTime === "number" && createTime > 1_000_000_000_000) {
      timestamp = Math.floor(createTime / 1000);
    } else if (typeof createTime === "number") {
      timestamp = createTime;
    } else {
      timestamp = Math.floor(Date.now() / 1000);
    }

    const platformMsg = new PlatformMessage();
    platformMsg.type = MessageType.FRIEND_MESSAGE;
    platformMsg.selfId = this.config.id;
    platformMsg.sessionId = fromUserId;
    platformMsg.messageId = messageId;
    platformMsg.sender = { userId: fromUserId, nickname: null };
    platformMsg.components = components;
    platformMsg.messageStr = messageStr;
    platformMsg.rawMessage = msg;
    platformMsg.timestamp = timestamp * 1000;

    const event = new WeixinOCEvent(
      messageStr,
      platformMsg,
      this.meta(),
      fromUserId,
      this,
      fromUserId,
    );

    this.commitEvent(event);
  }

  // ── Inbound Media Resolution ──

  private async resolveInboundImage(item: Record<string, unknown>): Promise<ImageComponent | null> {
    try {
      const imageItem = (item.image_item ?? {}) as Record<string, unknown>;
      const media = (imageItem.media ?? {}) as Record<string, unknown>;
      const encryptedQueryParam = String(media.encrypt_query_param ?? "").trim();
      if (!encryptedQueryParam) return null;

      const imageAesKey = String(imageItem.aeskey ?? "").trim();
      let aesKeyValue: string;

      if (imageAesKey) {
        // aeskey is hex, convert to base64 for parseMediaAesKey
        const keyBytes = Buffer.from(imageAesKey, "hex");
        aesKeyValue = keyBytes.toString("base64");
      } else {
        aesKeyValue = String(media.aes_key ?? "").trim();
      }

      if (aesKeyValue) {
        const content = await this.client.downloadAndDecryptMedia(encryptedQueryParam, aesKeyValue);
        // For now, we just note the media was received. Saving to disk could be added.
        console.debug(`[WeixinOC] Downloaded image, size=${content.length}`);
      }

      // Return image component with CDN URL placeholder
      const cdnUrl = `${this.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
      return {
        type: ComponentType.Image,
        url: cdnUrl,
        toDict() { return { type: "image", data: { url: cdnUrl } }; },
      } as ImageComponent;
    } catch (e: unknown) {
      console.warn("[WeixinOC] Failed to resolve inbound image:", e);
      return null;
    }
  }

  private async resolveInboundVoice(item: Record<string, unknown>): Promise<RecordComponent | null> {
    try {
      const voiceItem = (item.voice_item ?? {}) as Record<string, unknown>;
      const media = (voiceItem.media ?? {}) as Record<string, unknown>;
      const encryptedQueryParam = String(media.encrypt_query_param ?? "").trim();
      const aesKeyValue = String(media.aes_key ?? "").trim();
      if (!encryptedQueryParam) return null;

      if (aesKeyValue) {
        const content = await this.client.downloadAndDecryptMedia(encryptedQueryParam, aesKeyValue);
        console.debug(`[WeixinOC] Downloaded voice, size=${content.length}`);
      }

      const voiceText = String(voiceItem.text ?? "").trim();
      return {
        type: ComponentType.Record,
        text: voiceText || undefined,
        toDict() { return { type: "record", data: { text: voiceText } }; },
      } as RecordComponent;
    } catch (e: unknown) {
      console.warn("[WeixinOC] Failed to resolve inbound voice:", e);
      return null;
    }
  }

  private async resolveInboundFile(item: Record<string, unknown>): Promise<FileComponent | null> {
    try {
      const fileItem = (item.file_item ?? {}) as Record<string, unknown>;
      const media = (fileItem.media ?? {}) as Record<string, unknown>;
      const encryptedQueryParam = String(media.encrypt_query_param ?? "").trim();
      const aesKeyValue = String(media.aes_key ?? "").trim();
      if (!encryptedQueryParam) return null;

      if (aesKeyValue) {
        const content = await this.client.downloadAndDecryptMedia(encryptedQueryParam, aesKeyValue);
        console.debug(`[WeixinOC] Downloaded file, size=${content.length}`);
      }

      const fileName = String(fileItem.file_name ?? "file.bin").trim();
      return {
        type: ComponentType.File,
        name: fileName,
        toDict() { return { type: "file", data: { name: fileName } }; },
      } as FileComponent;
    } catch (e: unknown) {
      console.warn("[WeixinOC] Failed to resolve inbound file:", e);
      return null;
    }
  }

  private async resolveInboundVideo(item: Record<string, unknown>): Promise<VideoComponent | null> {
    try {
      const videoItem = (item.video_item ?? {}) as Record<string, unknown>;
      const media = (videoItem.media ?? {}) as Record<string, unknown>;
      const encryptedQueryParam = String(media.encrypt_query_param ?? "").trim();
      const aesKeyValue = String(media.aes_key ?? "").trim();
      if (!encryptedQueryParam) return null;

      if (aesKeyValue) {
        const content = await this.client.downloadAndDecryptMedia(encryptedQueryParam, aesKeyValue);
        console.debug(`[WeixinOC] Downloaded video, size=${content.length}`);
      }

      return {
        type: ComponentType.Video,
        file: "video.mp4",
        toDict() { return { type: "video", data: { file: "video.mp4" } }; },
      } as VideoComponent;
    } catch (e: unknown) {
      console.warn("[WeixinOC] Failed to resolve inbound video:", e);
      return null;
    }
  }

  // ── Message Sending ──

  async sendTextMessage(userId: string, text: string): Promise<boolean> {
    if (!this.token) {
      console.warn("[WeixinOC] Missing token, skip send");
      return false;
    }
    if (!text.trim()) return false;

    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) {
      console.warn(`[WeixinOC] Context token missing for ${userId}, skip send. User needs to send a message first.`);
      return false;
    }

    const itemList = [this.buildPlainTextItem(text)];

    const payload = await this.client.requestJson("POST", "ilink/bot/sendmessage", {
      payload: {
        base_info: { channel_version: WECHAT_CHANNEL_VERSION },
        msg: {
          from_user_id: "",
          to_user_id: userId,
          client_id: generateId(),
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: itemList,
        },
      },
      tokenRequired: true,
    });

    if (!this.isSuccessfulPayload(payload)) {
      console.warn(`[WeixinOC] sendmessage failed for ${userId}: ${this.formatApiError(payload)}`);
      return false;
    }

    return true;
  }

  private buildPlainTextItem(text: string): Record<string, unknown> {
    return {
      type: ITEM_TYPE.TEXT,
      text_item: { text },
    };
  }

  // ── Typing State ──

  async startTyping(userId: string, ownerId: string): Promise<void> {
    if (!this.token) return;
    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) return;

    let state = this.typingStates.get(userId);
    if (!state) {
      state = {
        ticket: null,
        contextToken: null,
        refreshAfter: 0,
        keepaliveTimer: null,
        cancelTimer: null,
        owners: new Set(),
      };
      this.typingStates.set(userId, state);
    }

    if (state.owners.has(ownerId)) return;

    // Cancel pending cancel timer
    if (state.cancelTimer) {
      clearTimeout(state.cancelTimer);
      state.cancelTimer = null;
    }

    // Ensure ticket
    const ticket = await this.ensureTypingTicket(userId, state);
    if (!ticket) return;

    state.owners.add(ownerId);

    // Send initial typing state
    try {
      await this.sendTypingState(userId, ticket, false);
    } catch {
      state.refreshAfter = 0;
    }

    // Start keepalive if not running
    if (!state.keepaliveTimer) {
      state.keepaliveTimer = setInterval(async () => {
        try {
          const t = await this.ensureTypingTicket(userId, state!);
          if (t) await this.sendTypingState(userId, t, false);
        } catch {
          if (state) state.refreshAfter = 0;
        }
      }, this.typingKeepaliveInterval);
      // Allow the Node.js process to exit even if this keepalive timer is active
      if (typeof state.keepaliveTimer === "object" && "unref" in state.keepaliveTimer) {
        state.keepaliveTimer.unref();
      }
    }
  }

  async stopTyping(userId: string, ownerId: string): Promise<void> {
    const state = this.typingStates.get(userId);
    if (!state) return;

    state.owners.delete(ownerId);
    if (state.owners.size > 0) return;

    // Stop keepalive
    if (state.keepaliveTimer) {
      clearInterval(state.keepaliveTimer);
      state.keepaliveTimer = null;
    }

    // Send cancel typing after a brief debounce. startTyping() clears this
    // timer, so a real delay (rather than 0ms) ensures that a rapid
    // stop→start cycle cancels the stop indicator instead of racing it.
    if (state.ticket) {
      const ticket = state.ticket;
      state.cancelTimer = setTimeout(async () => {
        try {
          await this.sendTypingState(userId, ticket, true);
        } catch (e) { console.warn(`[WeixinOC] cancel typing failed for ${userId}:`, e); }
      }, 300);
    }
  }

  private async ensureTypingTicket(userId: string, state: TypingState): Promise<string | null> {
    const now = Date.now();
    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) return null;

    if (state.ticket && state.contextToken === contextToken && state.refreshAfter > now) {
      return state.ticket;
    }

    try {
      const data = await this.client.requestJson("POST", "ilink/bot/getconfig", {
        payload: {
          ilink_user_id: userId,
          context_token: contextToken,
          base_info: { channel_version: WECHAT_CHANNEL_VERSION },
        },
        tokenRequired: true,
      });

      if (!this.isSuccessfulPayload(data)) return null;

      const ticket = String(data.typing_ticket ?? "").trim();
      if (!ticket) return null;

      state.ticket = ticket;
      state.contextToken = contextToken;
      state.refreshAfter = now + this.typingTicketTtl;
      return ticket;
    } catch {
      return null;
    }
  }

  private async sendTypingState(userId: string, ticket: string, cancel: boolean): Promise<void> {
    await this.client.requestJson("POST", "ilink/bot/sendtyping", {
      payload: {
        ilink_user_id: userId,
        typing_ticket: ticket,
        status: cancel ? 2 : 1,
        base_info: { channel_version: WECHAT_CHANNEL_VERSION },
      },
      tokenRequired: true,
    });
  }

  private cleanupTypingStates(): void {
    for (const [, state] of this.typingStates) {
      if (state.keepaliveTimer) clearInterval(state.keepaliveTimer);
      if (state.cancelTimer) clearTimeout(state.cancelTimer);
      state.owners.clear();
    }
    this.typingStates.clear();
  }

  // ── Session Timeout ──

  private async handleInboundSessionTimeout(): Promise<void> {
    console.warn("[WeixinOC] Session timed out, clearing login state. Waiting for QR login.");
    this.token = null;
    this.accountId = null;
    this.syncBuf = "";
    this.contextTokens.clear();
    this.contextTokensDirty = false;
    this.loginSession = null;
    this.client.updateToken(null);
    this.persistConfig();
  }

  // ── API Helpers ──

  private isSuccessfulPayload(payload: Record<string, unknown>): boolean {
    const ret = Number(payload.ret ?? 0);
    const errcode = Number(payload.errcode ?? 0);
    return ret === 0 && errcode === 0;
  }

  private formatApiError(payload: Record<string, unknown>): string {
    const ret = Number(payload.ret ?? 0);
    const errcode = Number(payload.errcode ?? 0);
    const errmsg = String(payload.errmsg ?? "");
    return `ret=${ret}, errcode=${errcode}, errmsg=${errmsg}`;
  }

  private getApiErrcode(payload: Record<string, unknown>): number {
    return Number(payload.errcode ?? 0);
  }

  // ── Utility ──

  /** Persist current auth state (token, accountId, syncBuf, baseUrl) back to the adapter store */
  private persistConfig(): void {
    if (!this.onConfigUpdate) return;
    try {
      this.onConfigUpdate({
        ...this.config,
        token: this.token ?? undefined,
        accountId: this.accountId ?? undefined,
        syncBuf: this.syncBuf || undefined,
        baseUrl: this.baseUrl,
      });
    } catch (e: unknown) {
      console.warn("[WeixinOC] Failed to persist config:", e);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Get adapter stats for dashboard */
  getStats(): Record<string, unknown> {
    return {
      weixin_oc: {
        configured: !!this.token,
        accountId: this.accountId,
        baseUrl: this.baseUrl,
        qrStatus: this.loginSession?.status ?? null,
        qrError: this.loginSession?.error ?? null,
        syncBufLen: this.syncBuf.length,
        lastError: this.lastInboundError,
      },
    };
  }

  /** Get QR code login status for frontend display */
  getLoginStatus(): {
    loggedIn: boolean;
    accountId: string | null;
    qrStatus: string | null;
    qrImgContent: string | null;
    qrError: string | null;
  } {
    return {
      loggedIn: !!this.token,
      accountId: this.accountId,
      qrStatus: this.loginSession?.status ?? null,
      qrImgContent: this.loginSession?.qrcodeImgContent ?? null,
      qrError: this.loginSession?.error ?? null,
    };
  }

  // ── Static: Preview QR Code (for modal, before adapter is created) ──

  /** Pre-generate a QR code without creating an adapter instance */
  static async previewQrCode(): Promise<{ qrcode: string; qrcodeImgContent: string }> {
    const client = new ILinkClient(
      "https://ilinkai.weixin.qq.com",
      "https://novac2c.cdn.weixin.qq.com/c2c",
      15000,
      null,
    );
    const data = await client.requestJson("GET", "ilink/bot/get_bot_qrcode", {
      params: { bot_type: "3" },
      tokenRequired: false,
      timeoutMs: 15000,
    });
    const qrcode = String(data.qrcode ?? "").trim();
    const qrcodeImgContent = String(data.qrcode_img_content ?? "").trim();
    if (!qrcode || !qrcodeImgContent) {
      throw new Error("QR code response missing data");
    }
    return { qrcode, qrcodeImgContent };
  }
}
