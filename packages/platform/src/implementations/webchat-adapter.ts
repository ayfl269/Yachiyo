import { PlatformAdapter } from "../adapter.js";
import type { PlatformMetadata } from "../metadata.js";
import type { AsyncQueue } from "@yachiyo/common/async-queue.js";
import { MessageEvent } from "@yachiyo/message/event.js";
import type { MessageChain } from "@yachiyo/agent/types.js";
import type { MessageComponent } from "@yachiyo/message/components.js";
import { ComponentType } from "@yachiyo/message/components.js";
import { PlatformMessage } from "@yachiyo/message/platform-message.js";
import { MessageType } from "@yachiyo/message/types.js";
import { generateId } from "@yachiyo/common/id-generator.js";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "http";
import { timingSafeEqual, createHash, randomUUID } from "crypto";

export interface WebChatConfig {
  id: string;
  name?: string;
  port?: number;
  host?: string;
  /**
   * Bearer token required for all WebChat requests. When unset, auth is
   * DISABLED (dev mode) and a warning is logged. Set a strong secret in
   * production so that reaching the port does not allow sending messages
   * or reading streams.
   */
  authToken?: string;
  /** Allowed CORS origins. Leave unset for same-origin only. */
  allowedOrigins?: string[];
}

interface SSEConnection {
  res: ServerResponse;
  sessionId: string;
  createdAt: number;
  lastActiveAt: number;
}

function writeSSE(conn: SSEConnection, event: string, data: string): void {
  if (conn.res.writableEnded) return;
  try {
    conn.res.write(`event: ${event}\ndata: ${data}\n\n`);
    conn.lastActiveAt = Date.now();
  } catch { /* connection already closed */ }
}

function establishSSE(res: ServerResponse, sessionId: string): SSEConnection {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("\n");

  const conn: SSEConnection = {
    res,
    sessionId,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };

  const heartbeat = setInterval(() => {
    // Stop the timer once the response is finished or the underlying socket
    // has been destroyed. Checking `destroyed` covers the case where the
    // client disconnected abruptly (TCP RST, network drop) and the `close`
    // event is delayed or never fires — without this guard the interval
    // would keep writing to a dead socket indefinitely, leaking memory and
    // CPU per abandoned session.
    if (res.writableEnded || res.destroyed) {
      clearInterval(heartbeat);
      return;
    }
    try {
      res.write(": heartbeat\n\n");
      conn.lastActiveAt = Date.now();
    } catch {
      // Write failed — connection is gone. Clear the timer so we don't
      // keep retrying on a dead response.
      clearInterval(heartbeat);
    }
  }, 15000);
  // Allow the process to exit even if a heartbeat is still pending.
  heartbeat.unref();

  // Clear on both `close` (normal end) and `error` (socket error) to avoid
  // leaving the interval running when the connection tears down abnormally.
  const stopHeartbeat = (): void => clearInterval(heartbeat);
  res.on("close", stopHeartbeat);
  res.on("error", stopHeartbeat);

  return conn;
}

class WebChatEvent extends MessageEvent {
  private sendCallback: ((components: MessageComponent[]) => Promise<void>) | null = null;
  private ssePushCallback: ((event: string, data: string) => void) | null = null;
  private isTyping: boolean = false;

  constructor(
    messageStr: string,
    messageObj: PlatformMessage,
    sendCallback?: (components: MessageComponent[]) => Promise<void>,
  ) {
    super(
      messageStr,
      messageObj,
      { name: "webchat", description: "WebChat Platform", id: "webchat", supportStreamingMessage: true, supportProactiveMessage: true },
      messageObj.sessionId,
    );
    this.sendCallback = sendCallback ?? null;
  }

  setSendCallback(cb: (components: MessageComponent[]) => Promise<void>): void {
    this.sendCallback = cb;
  }

  setSSEPushCallback(cb: (event: string, data: string) => void): void {
    this.ssePushCallback = cb;
  }

  async send(components: MessageComponent[]): Promise<void> {
    if (this.sendCallback) {
      await this.sendCallback(components);
    }
    if (this.ssePushCallback) {
      this.ssePushCallback("message", JSON.stringify({
        type: "message",
        content: components.map(c => c.toDict()),
      }));
    }
  }

  async sendStreaming(generator: AsyncGenerator<MessageChain, void>): Promise<void> {
    const fullText: string[] = [];
    for await (const chunk of generator) {
      if (chunk.message) {
        fullText.push(chunk.message);
        if (this.ssePushCallback) {
          this.ssePushCallback("delta", JSON.stringify({
            type: "delta",
            content: chunk.message,
          }));
        }
      }
    }

    if (this.ssePushCallback) {
      this.ssePushCallback("done", JSON.stringify({ type: "done" }));
    }

    if (this.sendCallback && fullText.length > 0) {
      const text = fullText.join("");
      await this.sendCallback([{
        type: ComponentType.Plain,
        text,
        toDict() { return { type: "text", data: { text } }; },
      } as any]);
    }
  }

  async sendTyping(): Promise<void> {
    this.isTyping = true;
    if (this.ssePushCallback) {
      this.ssePushCallback("typing", JSON.stringify({ type: "typing" }));
    }
  }

  async stopTyping(): Promise<void> {
    this.isTyping = false;
    if (this.ssePushCallback) {
      this.ssePushCallback("stop_typing", JSON.stringify({ type: "stop_typing" }));
    }
  }
}

export class WebChatAdapter extends PlatformAdapter {
  private config: WebChatConfig;
  private server: Server | null = null;
  private activeStreams: Map<string, SSEConnection> = new Map();
  /** sessionId → { hash, createdAt } for ownership check + TTL cleanup. */
  private sessionOwners: Map<string, { hash: Buffer; createdAt: number }> = new Map();
  /** Per-caller sliding-window rate limit: tokenHash → { count, windowStart }. */
  private rateBuckets: Map<string, { count: number; windowStart: number }> = new Map();
  private metadata: PlatformMetadata = {
    name: "webchat",
    description: "WebChat Platform",
    id: "webchat",
    supportStreamingMessage: true,
    supportProactiveMessage: true,
  };

  private static readonly RATE_LIMIT_WINDOW_MS = 60_000;
  private static readonly RATE_LIMIT_MAX_REQUESTS = 30;
  /** Max age (ms) for a sessionOwners entry before it's purged by the periodic cleanup. */
  private static readonly SESSION_OWNER_TTL_MS = 60 * 60 * 1000; // 1 hour
  /** Interval (ms) between sessionOwners / rateBuckets purge sweeps. */
  private static readonly PURGE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  /** Handle for the periodic purge timer (sessionOwners + rateBuckets). */
  private purgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: WebChatConfig, eventQueue: AsyncQueue<MessageEvent>) {
    super(config as unknown as Record<string, unknown>, eventQueue);
    this.config = config;
  }

  async initialize(): Promise<void> {
    await super.initialize();
    this.server = createServer((req, res) => this.handleRequest(req, res));
    // Start periodic purge of stale sessionOwners and expired rateBuckets
    // to prevent unbounded Map growth over long-running processes.
    this.purgeTimer = setInterval(() => this.purgeStaleEntries(), WebChatAdapter.PURGE_INTERVAL_MS);
    this.purgeTimer.unref();
  }

  async run(): Promise<void> {
    this._status = "running";
    const port = this.config.port ?? 8080;
    const host = this.config.host ?? "127.0.0.1";

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => {
        console.log(`[WebChatAdapter] Listening on ${host}:${port}`);
        if (!this.config.authToken) {
          console.warn(
            `[WebChatAdapter] WARNING: authentication is DISABLED (no authToken configured). ` +
            `Anyone who can reach this port can send messages and read streams. ` +
            `Set authToken in production.`,
          );
        }
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    this._status = "stopping";

    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }

    for (const [, conn] of this.activeStreams) {
      if (!conn.res.writableEnded) {
        try { conn.res.end(); } catch { /* ignore */ }
      }
    }
    this.activeStreams.clear();
    this.sessionOwners.clear();
    this.rateBuckets.clear();

    if (this.server) {
      await new Promise<void>(resolve => this.server!.close(() => resolve()));
      this.server = null;
    }

    await super.stop();
  }

  /**
   * Periodic sweep that removes:
   * - sessionOwners entries older than SESSION_OWNER_TTL_MS (abandoned sessions
   *   whose caller never subscribed to a stream, or whose stream closed without
   *   triggering the close handler).
   * - rateBuckets entries whose window has fully elapsed (no longer needed for
   *   rate limiting; would otherwise accumulate one entry per tokenHash forever).
   */
  private purgeStaleEntries(): void {
    const now = Date.now();

    // Purge stale session owners
    for (const [sessionId, entry] of this.sessionOwners) {
      // Don't purge sessions that still have an active stream — they're live.
      if (this.activeStreams.has(sessionId)) continue;
      if (now - entry.createdAt > WebChatAdapter.SESSION_OWNER_TTL_MS) {
        this.sessionOwners.delete(sessionId);
      }
    }

    // Purge expired rate limit buckets
    for (const [key, bucket] of this.rateBuckets) {
      if (now - bucket.windowStart >= WebChatAdapter.RATE_LIMIT_WINDOW_MS) {
        this.rateBuckets.delete(key);
      }
    }
  }

  meta(): PlatformMetadata {
    return this.metadata;
  }

  /**
   * 主动推送消息到指定会话的 SSE 连接。
   * WebChat 的 sessionId 是 webchat_xxx，用于查找活跃的 SSE 连接。
   * 仅当该 session 有活跃的 SSE 连接时才能送达，否则消息丢弃。
   */
  override async sendProactiveMessage(
    target: { umo: string; sessionId: string; platformId: string },
    components: MessageComponent[],
  ): Promise<boolean> {
    const conn = this.activeStreams.get(target.sessionId);
    if (!conn) {
      console.warn(`[WebChatAdapter] No active SSE stream for session ${target.sessionId}, proactive message dropped.`);
      return false;
    }

    // 构建与正常消息一致的事件结构
    const payload = JSON.stringify({
      type: "message",
      content: components.map(c => c.toDict()),
    });
    writeSSE(conn, "message", payload);

    // 同时发送 typing 停止信号，让前端知道这是一条完整消息
    writeSSE(conn, "stop_typing", JSON.stringify({ type: "stop_typing" }));

    return true;
  }

  async healthCheck(): Promise<string | null> {
    if (!this.isRunning) return "Adapter not running";
    if (!this.server?.listening) return "HTTP server not listening";
    return null;
  }

  createEvent(options: {
    sessionId: string;
    userId: string;
    userName: string;
    message: string;
    sendCallback?: (components: MessageComponent[]) => Promise<void>;
  }): MessageEvent {
    const platformMsg = new PlatformMessage();
    platformMsg.type = MessageType.FRIEND_MESSAGE;
    platformMsg.selfId = this.config.id;
    platformMsg.sessionId = options.sessionId;
    platformMsg.messageId = generateId();
    platformMsg.sender = { userId: options.userId, nickname: options.userName };
    platformMsg.components = [{ type: ComponentType.Plain, text: options.message, toDict() { return { type: "text", data: { text: options.message } }; } } as any];
    platformMsg.messageStr = options.message;
    platformMsg.timestamp = Date.now();

    return new WebChatEvent(options.message, platformMsg, options.sendCallback);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    this.applyCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Authenticate all routes except /health (which only reports liveness).
    if (url.pathname !== "/health") {
      if (!this.isRequestAuthenticated(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      if (!this.checkRateLimit(req)) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Rate limit exceeded" }));
        return;
      }
    }

    if (url.pathname === "/message" && req.method === "POST") {
      await this.handleMessage(req, res);
    } else if (url.pathname.startsWith("/stream/") && req.method === "GET") {
      await this.handleStream(req, res, url);
    } else if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: this.isRunning }));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  }

  /**
   * Constant-time Bearer token check. Returns true when auth is disabled
   * (no authToken configured) so dev mode keeps working.
   */
  private isRequestAuthenticated(req: IncomingMessage): boolean {
    if (!this.config.authToken) return true; // auth disabled (dev mode)
    const header = req.headers["authorization"];
    if (typeof header !== "string") return false;
    const expected = `Bearer ${this.config.authToken}`;
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Hash the caller's Authorization header for ownership tracking / rate limiting. */
  private hashCaller(req: IncomingMessage): string {
    const header = req.headers["authorization"] ?? "";
    return createHash("sha256").update(header).digest("hex");
  }

  /**
   * Sliding-window rate limit per caller (identified by auth header hash).
   * Returns true when the request is allowed, false when over the limit.
   */
  private checkRateLimit(req: IncomingMessage): boolean {
    const key = this.hashCaller(req);
    const now = Date.now();
    const bucket = this.rateBuckets.get(key);
    if (!bucket || now - bucket.windowStart >= WebChatAdapter.RATE_LIMIT_WINDOW_MS) {
      this.rateBuckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    bucket.count++;
    return bucket.count <= WebChatAdapter.RATE_LIMIT_MAX_REQUESTS;
  }

  /** Apply CORS headers based on the configured allowlist. No allowlist => no ACAO (same-origin only). */
  private applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (this.config.allowedOrigins && this.config.allowedOrigins.length > 0) {
      const origin = req.headers["origin"];
      if (typeof origin === "string" && this.config.allowedOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
    }
    // When no allowlist is configured, we intentionally do NOT set
    // Access-Control-Allow-Origin — cross-origin callers get no CORS
    // permission (the previous "*" allowed any site).
  }

  private async handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    if (body === null) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to read request body" }));
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (!parsed.message || typeof parsed.message !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required field: message" }));
      return;
    }

    const sessionId = parsed.session_id ?? `webchat_${randomUUID()}`;
    const userId = parsed.user_id ?? "webchat_user";
    const userName = parsed.user_name ?? "WebChatUser";

    // Record session ownership so only the caller who created the session
    // can subscribe to its stream. When auth is disabled, all callers map
    // to the same hash and ownership is effectively skipped.
    this.sessionOwners.set(sessionId, {
      hash: Buffer.from(this.hashCaller(req), "hex"),
      createdAt: Date.now(),
    });

    const event = this.createEvent({
      sessionId,
      userId,
      userName,
      message: parsed.message,
    }) as WebChatEvent;

    const sseConn = this.activeStreams.get(sessionId);
    if (sseConn) {
      event.setSSEPushCallback((evt, data) => writeSSE(sseConn, evt, data));
    }

    this.commitEvent(event);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      request_id: event.messageObj.messageId,
      session_id: sessionId,
      stream_url: `/stream/${sessionId}`,
    }));
  }

  private async handleStream(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const sessionId = url.pathname.slice("/stream/".length);
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing session ID" }));
      return;
    }

    // Verify that the caller owns this session (i.e. created it via
    // POST /message with the same auth token). Prevents cross-session
    // eavesdropping when multiple callers share the adapter.
    const ownerEntry = this.sessionOwners.get(sessionId);
    if (ownerEntry) {
      const callerHash = Buffer.from(this.hashCaller(req), "hex");
      const ownerHash = ownerEntry.hash;
      if (callerHash.length !== ownerHash.length || !timingSafeEqual(callerHash, ownerHash)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden: session owned by another caller" }));
        return;
      }
    }

    const conn = establishSSE(res, sessionId);
    this.activeStreams.set(sessionId, conn);

    req.on("close", () => {
      this.activeStreams.delete(sessionId);
      // Clean up session ownership when the stream closes — the session
      // is no longer active. A subsequent POST /message for the same
      // sessionId will re-create the owner entry.
      this.sessionOwners.delete(sessionId);
    });
  }

  private async readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const maxBodySize = 10 * 1024 * 1024;
      let aborted = false;

      const onData = (chunk: Buffer) => {
        if (aborted) return;
        size += chunk.length;
        if (size > maxBodySize) {
          aborted = true;
          cleanup();
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      };

      const onEnd = () => {
        if (aborted) return;
        cleanup();
        resolve(Buffer.concat(chunks).toString("utf-8"));
      };

      const onError = () => {
        if (aborted) return;
        aborted = true;
        cleanup();
        resolve(null);
      };

      const cleanup = () => {
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
      };

      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
    });
  }
}
