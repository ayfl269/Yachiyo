import { PlatformAdapter } from "../adapter.js";
import type { PlatformMetadata } from "../metadata.js";
import type { AsyncQueue } from "@yachiyo/common/async-queue.js";
import { MessageEvent } from "@yachiyo/message/event.js";
import type { MessageChain } from "@yachiyo/agent/types.js";
import type { MessageComponent } from "@yachiyo/message/components.js";
import { ComponentType, type PlainComponent } from "@yachiyo/message/components.js";
import { PlatformMessage } from "@yachiyo/message/platform-message.js";
import { MessageType } from "@yachiyo/message/types.js";
import { MessageSession } from "@yachiyo/message/message-session.js";
import { generateId } from "@yachiyo/common/id-generator.js";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "http";

export interface WebChatConfig {
  id: string;
  name?: string;
  port?: number;
  host?: string;
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
    if (res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    res.write(": heartbeat\n\n");
    conn.lastActiveAt = Date.now();
  }, 15000);

  res.on("close", () => clearInterval(heartbeat));

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
  private metadata: PlatformMetadata = {
    name: "webchat",
    description: "WebChat Platform",
    id: "webchat",
    supportStreamingMessage: true,
    supportProactiveMessage: true,
  };

  constructor(config: WebChatConfig, eventQueue: AsyncQueue<MessageEvent>) {
    super(config as unknown as Record<string, unknown>, eventQueue);
    this.config = config;
  }

  async initialize(): Promise<void> {
    await super.initialize();
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  async run(): Promise<void> {
    this._status = "running";
    const port = this.config.port ?? 8080;
    const host = this.config.host ?? "0.0.0.0";

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => {
        console.log(`[WebChatAdapter] Listening on ${host}:${port}`);
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    this._status = "stopping";

    for (const [, conn] of this.activeStreams) {
      if (!conn.res.writableEnded) {
        try { conn.res.end(); } catch { /* ignore */ }
      }
    }
    this.activeStreams.clear();

    if (this.server) {
      await new Promise<void>(resolve => this.server!.close(() => resolve()));
      this.server = null;
    }

    await super.stop();
  }

  meta(): PlatformMetadata {
    return this.metadata;
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

    this.setCORSHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
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

    const sessionId = parsed.session_id ?? `webchat_${Date.now()}`;
    const userId = parsed.user_id ?? "webchat_user";
    const userName = parsed.user_name ?? "WebChatUser";

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

    const conn = establishSSE(res, sessionId);
    this.activeStreams.set(sessionId, conn);

    req.on("close", () => {
      this.activeStreams.delete(sessionId);
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

  private setCORSHeaders(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
}
