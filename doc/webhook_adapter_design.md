# 平台适配器系统设计文档

> 本文档设计平台适配器系统的整体架构，当前以 Webhook 适配器作为首个实现和集成测试入口。
> 设计预留多适配器并行、适配器注册中心、统一生命周期管理、配置 schema 等扩展机制，便于后续添加 QQ/Discord/Telegram/Slack 等适配器。

> [!WARNING]
> **关于适配器实现的特别说明**：
> 1. **设计草案说明**：本文档中设计的 `WebhookAdapter` 和 `WebhookEvent` （基于 HTTP/SSE 触发）仅作为最初的设计草案，在**当前代码库中并未实际实现**。
> 2. **当前实际实现的平台**：在实际开发中，系统实现了以下四个平台适配器（详见 `packages/platform/src/registry.ts`）：
>    - `onebot11` (OneBot 11 协议 WebSocket 适配器)
>    - `qqofficial` (QQ 官方 Bot 适配器)
>    - `weixin_oc` (微信公众号/企业微信适配器)
>    - `webchat` (网页/内置 Chat 适配器)
> 3. **目录结构**：由于项目采用了 **PNPM Workspaces Monorepo** 架构，本设计文档中提及的 `src/platform/` 在开发时实际对应为 `packages/platform/src/`。

---

## 目录

1. [设计目标](#1-设计目标)
2. [系统架构](#2-系统架构)
3. [适配器抽象层](#3-适配器抽象层)
4. [适配器注册中心](#4-适配器注册中心)
5. [适配器生命周期](#5-适配器生命周期)
6. [适配器配置 Schema](#6-适配器配置-schema)
7. [Webhook 适配器实现](#7-webhook-适配器实现)
8. [WebhookEvent 实现](#8-webhookevent-实现)
9. [HTTP 服务器设计](#9-http-服务器设计)
10. [会话管理](#10-会话管理)
11. [流式响应 (SSE)](#11-流式响应-sse)
12. [启动引导流程](#12-启动引导流程)
13. [API 接口定义](#13-api-接口定义)
14. [错误处理](#14-错误处理)
15. [未来适配器扩展指南](#15-未来适配器扩展指南)
16. [目录结构](#16-目录结构)

---

## 1. 设计目标

- **端到端验证**：通过 Webhook 触发完整管线（适配器 → AsyncQueue → EventBus → Pipeline → Provider → 响应），验证所有子系统可协同工作
- **多适配器并行**：支持同时运行多个适配器实例（如 Webhook + QQ），共享同一管线
- **统一生命周期**：所有适配器遵循 `initialize → run → stop` 生命周期，由 `AdapterRegistry` 统一管理
- **配置驱动**：适配器类型和参数通过配置声明，`AdapterRegistry` 自动实例化和启动
- **最小依赖**：Webhook 适配器仅依赖 Node.js 内置 `http` 模块
- **流式支持**：通过 SSE 将 LLM 流式输出实时推送给客户端
- **可观测性**：提供状态查询和事件日志接口
- **与现有架构完全兼容**：继承 `PlatformAdapter`，产出 `MessageEvent`，走标准管线流程

---

## 2. 系统架构

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AdapterRegistry                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ WebhookAdapter│  │  QQAdapter   │  │ DiscordAdapter│  ...         │
│  │   (HTTP)      │  │  (WebSocket) │  │  (Gateway)    │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │                  │                  │                      │
│         └──────────────────┼──────────────────┘                      │
│                            │ commitEvent()                          │
│                            ▼                                        │
│                    ┌───────────────┐                                │
│                    │   AsyncQueue   │  ← 共享事件队列               │
│                    └───────┬───────┘                                │
│                            │                                        │
│                    ┌───────▼───────┐                                │
│                    │    EventBus    │                                │
│                    └───────┬───────┘                                │
│                            │                                        │
│                    ┌───────▼───────┐                                │
│                    │  Pipeline     │                                │
│                    │  Scheduler    │                                │
│                    └───────┬───────┘                                │
│                            │                                        │
│                    ┌───────▼───────┐                                │
│                    │ Process →      │                                │
│                    │ Respond        │                                │
│                    └───────┬───────┘                                │
│                            │ event.send() / event.sendStreaming()  │
│                            ▼                                        │
│                  各适配器自行处理响应发送                              │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 多适配器并行示意

```
用户 A (QQ)  ──→ QQAdapter      ──→ AsyncQueue ──→ Pipeline ──→ QQAdapter.send()
用户 B (Web) ──→ WebhookAdapter ──→ AsyncQueue ──→ Pipeline ──→ WebhookAdapter SSE
用户 C (Discord) → DiscordAdapter ──→ AsyncQueue ──→ Pipeline ──→ DiscordAdapter.send()
```

所有适配器共享同一个 `AsyncQueue<MessageEvent>` 和 `EventBus`，事件按 `unifiedMsgOrigin` 路由到对应的 `PipelineScheduler`。

---

## 3. 适配器抽象层

### 3.1 PlatformAdapter 扩展

当前 `PlatformAdapter` 只有 `run()` 和 `meta()` 两个抽象方法。为支持统一生命周期管理，扩展如下：

```typescript
// src/platform/adapter.ts — 扩展
export abstract class PlatformAdapter {
  protected eventQueue: AsyncQueue<MessageEvent>;
  protected errors: unknown[] = [];
  protected _status: AdapterStatus = "idle";  // 新增：适配器状态

  constructor(config: Record<string, unknown>, eventQueue: AsyncQueue<MessageEvent>) {
    this.eventQueue = eventQueue;
  }

  // --- 生命周期方法 ---

  /** 初始化适配器（如建立连接、加载资源），在 run() 之前调用 */
  async initialize(): Promise<void> {
    this._status = "initialized";
  }

  /** 启动适配器主循环（监听消息、轮询等） */
  abstract run(): Promise<void>;

  /** 优雅停止适配器 */
  async stop(): Promise<void> {
    this._status = "stopped";
  }

  /** 适配器元信息 */
  abstract meta(): PlatformMetadata;

  // --- 状态查询 ---

  /** 获取适配器当前状态 */
  get status(): AdapterStatus {
    return this._status;
  }

  /** 适配器是否正在运行 */
  get isRunning(): boolean {
    return this._status === "running";
  }

  // --- 事件提交 ---

  /** 将事件提交到共享事件队列 */
  commitEvent(event: MessageEvent): void {
    this.eventQueue.put(event);
  }

  /** 通过会话主动发送消息（如定时任务触发） */
  async sendBySession(session: MessageSession, components: MessageComponent[]): Promise<void> {
    throw new Error("sendBySession not implemented");
  }

  // --- 健康检查 ---

  /** 适配器健康检查，返回 null 表示健康，否则返回错误描述 */
  async healthCheck(): Promise<string | null> {
    return this.isRunning ? null : "Adapter not running";
  }
}

export type AdapterStatus = "idle" | "initialized" | "running" | "stopping" | "stopped" | "error";
```

### 3.2 适配器继承体系

```
PlatformAdapter (抽象基类)
  │
  ├── initialize()        ← 新增：初始化
  ├── run()               ← 抽象：启动
  ├── stop()              ← 新增：停止
  ├── meta()              ← 抽象：元信息
  ├── status              ← 新增：状态
  ├── healthCheck()       ← 新增：健康检查
  │
  ├── WebChatAdapter (已有)
  │     └── createEvent() → 手动创建事件
  │
  ├── WebhookAdapter (新增)
  │     ├── HTTP 服务器生命周期
  │     ├── 请求解析 → WebhookEvent → 入队
  │     └── 响应收集 → HTTP Response / SSE
  │
  ├── QQAdapter (未来)
  │     ├── OneBot/v11 WebSocket 连接
  │     ├── 消息解析 → QQEvent → 入队
  │     └── 响应发送 → OneBot API
  │
  ├── DiscordAdapter (未来)
  │     ├── Discord Gateway WebSocket
  │     ├── 消息解析 → DiscordEvent → 入队
  │     └── 响应发送 → Discord REST API
  │
  └── TelegramAdapter (未来)
        ├── Telegram Bot API 长轮询
        ├── 消息解析 → TelegramEvent → 入队
        └── 响应发送 → Telegram Bot API
```

---

## 4. 适配器注册中心

### 4.1 AdapterRegistry 设计

`AdapterRegistry` 是所有适配器的管理中心，负责：
- 适配器工厂注册
- 根据配置实例化适配器
- 统一生命周期管理（初始化、启动、停止）
- 健康检查和状态查询

```typescript
// src/platform/registry.ts
export type AdapterFactory = (
  config: Record<string, unknown>,
  eventQueue: AsyncQueue<MessageEvent>,
) => PlatformAdapter;

export class AdapterRegistry {
  /** 已注册的适配器工厂 */
  private factories: Map<string, AdapterFactory> = new Map();

  /** 已实例化的适配器 */
  private adapters: Map<string, PlatformAdapter> = new Map();

  /** 注册适配器工厂 */
  registerFactory(type: string, factory: AdapterFactory): void {
    this.factories.set(type, factory);
  }

  /** 根据配置创建适配器实例 */
  createAdapter(
    type: string,
    config: Record<string, unknown>,
    eventQueue: AsyncQueue<MessageEvent>,
  ): PlatformAdapter {
    const factory = this.factories.get(type);
    if (!factory) throw new Error(`Unknown adapter type: ${type}`);
    const adapter = factory(config, eventQueue);
    this.adapters.set(adapter.meta().id, adapter);
    return adapter;
  }

  /** 获取适配器实例 */
  getAdapter(id: string): PlatformAdapter | undefined {
    return this.adapters.get(id);
  }

  /** 获取所有适配器 */
  getAllAdapters(): PlatformAdapter[] {
    return [...this.adapters.values()];
  }

  /** 初始化所有适配器 */
  async initializeAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.initialize();
      } catch (e) {
        console.error(`Failed to initialize adapter ${adapter.meta().id}:`, e);
        adapter["_status"] = "error";
      }
    }
  }

  /** 启动所有适配器 */
  async startAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        adapter["_status"] = "running";
        await adapter.run();
      } catch (e) {
        console.error(`Failed to start adapter ${adapter.meta().id}:`, e);
        adapter["_status"] = "error";
      }
    }
  }

  /** 停止所有适配器 */
  async stopAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        adapter["_status"] = "stopping";
        await adapter.stop();
      } catch (e) {
        console.error(`Failed to stop adapter ${adapter.meta().id}:`, e);
        adapter["_status"] = "error";
      }
    }
  }

  /** 健康检查所有适配器 */
  async healthCheckAll(): Promise<Record<string, string | null>> {
    const results: Record<string, string | null> = {};
    for (const [id, adapter] of this.adapters) {
      results[id] = await adapter.healthCheck();
    }
    return results;
  }

  /** 移除适配器 */
  async removeAdapter(id: string): Promise<boolean> {
    const adapter = this.adapters.get(id);
    if (!adapter) return false;
    if (adapter.isRunning) await adapter.stop();
    this.adapters.delete(id);
    return true;
  }

  /** 热添加适配器（运行时动态添加） */
  async addAndStart(
    type: string,
    config: Record<string, unknown>,
    eventQueue: AsyncQueue<MessageEvent>,
  ): Promise<PlatformAdapter> {
    const adapter = this.createAdapter(type, config, eventQueue);
    await adapter.initialize();
    adapter["_status"] = "running";
    // 注意：run() 可能是阻塞的（如 HTTP 服务器），需在后台启动
    adapter.run().catch(e => {
      console.error(`Adapter ${adapter.meta().id} crashed:`, e);
      adapter["_status"] = "error";
    });
    return adapter;
  }
}
```

### 4.2 内置工厂注册

```typescript
// src/platform/registry.ts — 模块底部
import { WebhookAdapter } from "./implementations/webhook-adapter.js";
import { WebChatAdapter } from "./implementations/webchat-adapter.js";

// 注册内置适配器工厂
export function registerBuiltinAdapterFactories(registry: AdapterRegistry): void {
  registry.registerFactory("webhook", (config, eq) => {
    return new WebhookAdapter(config as any, eq);
  });
  registry.registerFactory("webchat", (config, eq) => {
    return new WebChatAdapter(config as any, eq);
  });

  // 未来适配器在此注册：
  // registry.registerFactory("qq", (config, eq) => new QQAdapter(config, eq));
  // registry.registerFactory("discord", (config, eq) => new DiscordAdapter(config, eq));
  // registry.registerFactory("telegram", (config, eq) => new TelegramAdapter(config, eq));
  // registry.registerFactory("slack", (config, eq) => new SlackAdapter(config, eq));
}
```

---

## 5. 适配器生命周期

### 5.1 状态机

```
          initialize()           run()
  idle ────────────→ initialized ───────────→ running
                                              │    │
                                    stop()    │    │ error
                                      │       │    │
                                      ▼       │    ▼
                                   stopping ←──┘   error
                                      │
                                      ▼
                                   stopped
```

### 5.2 生命周期保证

- `initialize()` 在 `run()` 之前调用，用于加载资源、建立连接
- `run()` 启动适配器主循环，可能阻塞（如 HTTP 服务器）或非阻塞（如 WebSocket 监听）
- `stop()` 优雅关闭，释放资源，关闭连接
- `healthCheck()` 在任何状态都可调用，返回健康状态

### 5.3 多适配器启动顺序

```
1. AdapterRegistry.initializeAll()    ← 所有适配器初始化
2. AdapterRegistry.startAll()         ← 所有适配器启动
3. EventBus.dispatch()                ← 事件总线开始分发
4. (运行中...)
5. AdapterRegistry.stopAll()          ← 优雅停止所有适配器
6. EventBus.stop()                    ← 停止事件总线
```

---

## 6. 适配器配置 Schema

### 6.1 统一配置格式

所有适配器配置遵循统一格式，便于从配置文件/环境变量加载：

```typescript
// src/platform/config.ts
export interface AdapterConfigBase {
  /** 适配器类型标识，用于匹配工厂 */
  type: string;
  /** 适配器实例 ID，必须全局唯一 */
  id: string;
  /** 是否启用此适配器，默认 true */
  enabled?: boolean;
  /** 适配器专属配置 */
  [key: string]: unknown;
}

// Webhook 适配器配置
export interface WebhookAdapterConfig extends AdapterConfigBase {
  type: "webhook";
  port: number;
  host: string;
  path: string;
  authToken?: string;
  maxBodySize: number;
  corsEnabled: boolean;
  timeoutMs: number;
}

// WebChat 适配器配置
export interface WebChatAdapterConfig extends AdapterConfigBase {
  type: "webchat";
  id: string;
  name?: string;
}

// 未来适配器配置示例
export interface QQAdapterConfig extends AdapterConfigBase {
  type: "qq";
  protocol: "onebot_v11" | "onebot_v12";
  wsUrl: string;
  accessToken?: string;
  reconnection?: boolean;
  reconnectionInterval?: number;
}

export interface DiscordAdapterConfig extends AdapterConfigBase {
  type: "discord";
  botToken: string;
  applicationId: string;
  intents?: number[];
}

export interface TelegramAdapterConfig extends AdapterConfigBase {
  type: "telegram";
  botToken: string;
  apiServer?: string;
  polling?: boolean;
  webhookUrl?: string;
}
```

### 6.2 配置验证

```typescript
// src/platform/config.ts
export function validateAdapterConfig(config: unknown): AdapterConfigBase {
  if (!config || typeof config !== "object") {
    throw new Error("Adapter config must be an object");
  }
  const cfg = config as Record<string, unknown>;
  if (!cfg.type || typeof cfg.type !== "string") {
    throw new Error("Adapter config must have a 'type' field");
  }
  if (!cfg.id || typeof cfg.id !== "string") {
    throw new Error("Adapter config must have an 'id' field");
  }
  return cfg as AdapterConfigBase;
}
```

### 6.3 从配置文件加载

```typescript
// 示例配置文件 adapters.json
[
  {
    "type": "webhook",
    "id": "webhook-main",
    "port": 8080,
    "host": "0.0.0.0",
    "path": "/webhook",
    "maxBodySize": 1048576,
    "corsEnabled": true,
    "timeoutMs": 120000
  },
  {
    "type": "qq",
    "id": "qq-main",
    "protocol": "onebot_v11",
    "wsUrl": "ws://localhost:6700",
    "accessToken": "xxx",
    "enabled": false
  }
]
```

---

## 7. Webhook 适配器实现

### 7.1 配置

```typescript
export interface WebhookAdapterConfig extends AdapterConfigBase {
  type: "webhook";
  id: string;
  port: number;                  // HTTP 监听端口，默认 8080
  host: string;                  // 监听地址，默认 "0.0.0.0"
  path: string;                  // Webhook 路径，默认 "/webhook"
  authToken?: string;            // 可选的 Bearer Token 验证
  maxBodySize: number;           // 请求体最大字节数，默认 1MB
  corsEnabled: boolean;          // 是否启用 CORS，默认 true
  timeoutMs: number;             // 管线处理超时毫秒数，默认 120000
}
```

### 7.2 WebhookAdapter 类

```typescript
export class WebhookAdapter extends PlatformAdapter {
  private config: WebhookAdapterConfig;
  private server: Server | null = null;
  private activeStreams: Map<string, SSEConnection> = new Map();
  private pendingEvents: Map<string, WebhookEvent> = new Map();
  private startTime: number = 0;

  constructor(config: WebhookAdapterConfig, eventQueue: AsyncQueue<MessageEvent>) {
    super(config as unknown as Record<string, unknown>, eventQueue);
    this.config = config;
  }

  async initialize(): Promise<void> {
    await super.initialize();
    // 预创建 HTTP 服务器（不启动监听）
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  async run(): Promise<void> {
    this._status = "running";
    this.startTime = Date.now();

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        console.log(`Webhook adapter listening on ${this.config.host}:${this.config.port}`);
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    this._status = "stopping";
    // 关闭所有 SSE 连接
    for (const [sessionId, conn] of this.activeStreams) {
      if (!conn.res.writableEnded) conn.res.end();
    }
    this.activeStreams.clear();

    // 关闭 HTTP 服务器
    if (this.server) {
      await new Promise<void>(resolve => this.server!.close(() => resolve()));
      this.server = null;
    }

    await super.stop();
  }

  meta(): PlatformMetadata {
    return {
      name: "webhook",
      description: "Webhook Platform Adapter",
      id: this.config.id,
      supportStreamingMessage: true,
      supportProactiveMessage: true,
    };
  }

  async healthCheck(): Promise<string | null> {
    if (!this.isRunning) return "Adapter not running";
    if (!this.server?.listening) return "HTTP server not listening";
    return null;
  }
}
```

---

## 8. WebhookEvent 实现

### 8.1 类设计

```typescript
class WebhookEvent extends MessageEvent {
  private responseComponents: MessageComponent[] = [];
  private responseText: string = "";
  private resolveResponse!: (result: WebhookResponse) => void;
  private responsePromise: Promise<WebhookResponse>;
  private streamingChunks: string[] = [];
  private ssePushCallback: ((event: string, data: string) => void) | null = null;
  private timeoutMs: number;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private completed: boolean = false;

  constructor(
    messageStr: string,
    messageObj: PlatformMessage,
    sessionId: string,
    timeoutMs: number = 120000,
  ) {
    super(
      messageStr,
      messageObj,
      {
        name: "webhook",
        description: "Webhook Platform Adapter",
        id: "webhook",
        supportStreamingMessage: true,
        supportProactiveMessage: true,
      },
      sessionId,
    );
    this.timeoutMs = timeoutMs;
    this.responsePromise = new Promise<WebhookResponse>((resolve) => {
      this.resolveResponse = resolve;
    });

    this.timeoutHandle = setTimeout(() => {
      if (!this.completed) {
        this.completed = true;
        this.resolveResponse({
          request_id: this.messageObj.messageId,
          result: this.responseText || "[timeout]",
          is_timeout: true,
        });
      }
    }, this.timeoutMs);
  }

  async send(components: MessageComponent[]): Promise<void> {
    for (const comp of components) {
      if (comp.type === ComponentType.Plain) {
        this.responseText += (comp as PlainComponent).text ?? "";
      }
    }
    this.responseComponents.push(...components);

    if (this.ssePushCallback) {
      this.ssePushCallback("message", JSON.stringify({
        type: "message",
        content: components.map(c => c.toDict()),
      }));
    }
  }

  async sendStreaming(generator: AsyncGenerator<MessageChain, void>): Promise<void> {
    for await (const chunk of generator) {
      if (chunk.message) {
        this.streamingChunks.push(chunk.message);
        this.responseText += chunk.message;

        if (this.ssePushCallback) {
          this.ssePushCallback("delta", JSON.stringify({
            type: "delta",
            content: chunk.message,
          }));
        }
      }
    }

    if (this.ssePushCallback) {
      this.ssePushCallback("done", JSON.stringify({
        type: "done",
        full_text: this.responseText,
      }));
    }
  }

  async sendTyping(): Promise<void> {
    if (this.ssePushCallback) {
      this.ssePushCallback("typing", JSON.stringify({ type: "typing" }));
    }
  }

  async stopTyping(): Promise<void> {
    if (this.ssePushCallback) {
      this.ssePushCallback("stop_typing", JSON.stringify({ type: "stop_typing" }));
    }
  }

  setSSEPushCallback(cb: (event: string, data: string) => void): void {
    this.ssePushCallback = cb;
  }

  waitForResponse(): Promise<WebhookResponse> {
    return this.responsePromise;
  }

  complete(): void {
    if (this.completed) return;
    this.completed = true;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.resolveResponse({
      request_id: this.messageObj.messageId,
      result: this.responseText,
      is_timeout: false,
    });
  }
}
```

### 8.2 WebhookResponse 类型

```typescript
export interface WebhookResponse {
  request_id: string;
  result: string;
  is_timeout: boolean;
}
```

---

## 9. HTTP 服务器设计

### 9.1 路由表

| 方法 | 路径 | 功能 | 请求体 | 响应 |
|------|------|------|--------|------|
| POST | `/webhook` | 发送消息触发管线 | `{ message, session_id, user_id, user_name, stream }` | 非流式：`{ request_id, result }` / 流式：SSE |
| GET | `/stream/:sessionId` | 建立 SSE 连接接收流式输出 | - | SSE 事件流 |
| GET | `/status` | 查询适配器状态 | - | `{ status, active_sessions, uptime }` |
| GET | `/health` | 健康检查 | - | `{ ok: true }` |

### 9.2 请求处理流程

```
POST /webhook
  │
  ├── 1. 验证 Auth Token (如果配置了)
  │
  ├── 2. 解析 JSON Body
  │     { message, session_id, user_id, user_name, stream? }
  │
  ├── 3. 创建 WebhookEvent
  │     └── new WebhookEvent(messageStr, platformMsg, ...)
  │
  ├── 4. 入队 eventQueue.put(event)
  │
  └── 5. 等待响应
        │
        ├── stream=false: 等待 event.waitForResponse() → 返回 JSON
        └── stream=true:  返回 SSE 流，引导客户端连接 /stream/:sessionId
```

### 9.3 路由分发实现

```typescript
private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    this.setCORSHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (this.config.corsEnabled) this.setCORSHeaders(res);

  if (url.pathname === this.config.path && req.method === "POST") {
    await this.handleWebhook(req, res);
  } else if (url.pathname.startsWith("/stream/") && req.method === "GET") {
    await this.handleStream(req, res, url);
  } else if (url.pathname === "/status" && req.method === "GET") {
    this.handleStatus(res);
  } else if (url.pathname === "/health" && req.method === "GET") {
    this.handleHealth(res);
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
}
```

---

## 10. 会话管理

### 10.1 会话标识

Webhook 请求通过 `session_id` 字段标识会话。同一 `session_id` 的消息共享：
- 管线配置绑定（`ConfigManager.bindSession`）
- 会话锁（`SessionLockManager`）
- 对话历史（`ConversationManager`）

### 10.2 默认会话

如果请求未提供 `session_id`，则使用默认值 `webhook_default`。

### 10.3 SSE 连接与会话绑定

```
客户端 A (session_id: "user-123")
  │
  ├── POST /webhook { message: "你好", session_id: "user-123", stream: true }
  │     └── 返回 { request_id: "req-1", stream_url: "/stream/user-123" }
  │
  └── GET /stream/user-123 (SSE 连接)
        ├── event: typing
        ├── event: delta  { content: "你" }
        ├── event: delta  { content: "好" }
        ├── event: delta  { content: "！" }
        └── event: done   { full_text: "你好！" }
```

---

## 11. 流式响应 (SSE)

### 11.1 SSE 事件类型

| 事件 | 数据格式 | 说明 |
|------|---------|------|
| `typing` | `{ type: "typing" }` | 正在输入 |
| `stop_typing` | `{ type: "stop_typing" }` | 停止输入 |
| `delta` | `{ type: "delta", content: "..." }` | 流式文本增量 |
| `message` | `{ type: "message", content: [...] }` | 完整消息（非流式） |
| `done` | `{ type: "done", full_text: "..." }` | 流式输出完成 |
| `error` | `{ type: "error", message: "..." }` | 错误 |

### 11.2 SSE 连接管理

```typescript
interface SSEConnection {
  res: ServerResponse;
  sessionId: string;
  createdAt: number;
  lastActiveAt: number;
}

function writeSSE(conn: SSEConnection, event: string, data: string): void {
  if (conn.res.writableEnded) return;
  conn.res.write(`event: ${event}\ndata: ${data}\n\n`);
  conn.lastActiveAt = Date.now();
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
```

### 11.3 两种流式模式

**模式 A：同步等待（stream=false）**

```
Client → POST /webhook { stream: false }
         ← 等待管线处理完成
         ← 200 { request_id, result }
```

**模式 B：SSE 流式（stream=true）**

```
Client → POST /webhook { stream: true }
         ← 200 { request_id, session_id, stream_url }

Client → GET /stream/:sessionId
         ← SSE: typing
         ← SSE: delta { content: "你" }
         ← SSE: delta { content: "好" }
         ← SSE: done  { full_text: "你好！" }
```

---

## 12. 启动引导流程

### 12.1 完整启动序列

```typescript
// src/bootstrap.ts — 系统启动引导
export async function bootstrap(options: BootstrapOptions): Promise<BootstrapContext> {
  // 1. 创建核心组件
  const eventQueue = new AsyncQueue<MessageEvent>();
  const providerManager = new ProviderManager();
  const conversationManager = new ConversationManager();
  const personaManager = new PersonaService();
  const knowledgeBaseManager = new KnowledgeBaseManager(providerManager);
  const sessionLockManager = new SessionLockManager();
  const pluginManager = new PluginManager();
  const configManager = new ConfigManager();
  const adapterRegistry = new AdapterRegistry();

  // 2. 注册 Provider
  if (options.provider) {
    const provider = createChatProvider(options.provider.type, options.provider.config);
    providerManager.registerProvider(provider);
  }
  if (options.embedding) {
    const emb = createEmbeddingProvider(options.embedding.type, options.embedding.config);
    providerManager.registerEmbeddingProvider(emb);
  }
  if (options.rerank) {
    const rerank = createRerankProvider(options.rerank.type, options.rerank.config);
    providerManager.registerRerankProvider(rerank);
  }

  // 3. 初始化知识库
  await knowledgeBaseManager.initialize();

  // 4. 创建默认配置
  const defaultConfig = configManager.createDefaultConfig("default");
  if (options.provider) {
    defaultConfig.defaultProviderId = options.provider.config.id ?? "default";
  }
  configManager.addConfig(defaultConfig);

  // 5. 注册管线阶段
  ensureBuiltinStagesRegistered();

  // 6. 创建管线调度器
  const pipelineContext: PipelineContext = {
    config: defaultConfig,
    configId: "default",
    pluginManager,
    providerManager,
    conversationManager,
    personaManager,
    knowledgeBaseManager,
    sessionLockManager,
    callHandler: async function*() {},
    callEventHook: async () => false,
  };
  const scheduler = new PipelineScheduler(pipelineContext);
  await scheduler.initialize();

  // 7. 创建 EventBus
  const schedulerMapping = new Map<string, PipelineScheduler>();
  schedulerMapping.set("default", scheduler);
  const eventBus = new EventBus(eventQueue, schedulerMapping, configManager);

  // 8. 注册适配器工厂并创建适配器
  registerBuiltinAdapterFactories(adapterRegistry);

  for (const adapterConfig of options.adapters ?? []) {
    const validated = validateAdapterConfig(adapterConfig);
    if (validated.enabled === false) continue;
    adapterRegistry.createAdapter(validated.type, validated, eventQueue);
  }

  // 如果没有配置适配器，默认创建 Webhook 适配器
  if (adapterRegistry.getAllAdapters().length === 0) {
    adapterRegistry.createAdapter("webhook", {
      type: "webhook",
      id: "webhook",
      port: options.webhook?.port ?? 8080,
      host: options.webhook?.host ?? "0.0.0.0",
      path: options.webhook?.path ?? "/webhook",
      maxBodySize: options.webhook?.maxBodySize ?? 1048576,
      corsEnabled: options.webhook?.corsEnabled ?? true,
      timeoutMs: options.webhook?.timeoutMs ?? 120000,
      ...options.webhook,
    }, eventQueue);
  }

  // 9. 初始化并启动所有适配器
  await adapterRegistry.initializeAll();
  await adapterRegistry.startAll();

  // 10. 启动事件总线
  eventBus.dispatch(); // 非阻塞

  return {
    eventQueue,
    eventBus,
    adapterRegistry,
    providerManager,
    configManager,
    conversationManager,
    knowledgeBaseManager,
    sessionLockManager,
    pluginManager,
    scheduler,
    async shutdown() {
      await adapterRegistry.stopAll();
      eventBus.stop();
      await knowledgeBaseManager.terminate();
    },
  };
}
```

### 12.2 BootstrapOptions

```typescript
export interface BootstrapOptions {
  /** 适配器配置列表，支持同时配置多个适配器 */
  adapters?: AdapterConfigBase[];

  /** 快捷配置：Webhook 适配器参数（当 adapters 未指定时使用） */
  webhook?: Partial<WebhookAdapterConfig>;

  provider?: {
    type: "openai" | "openai_responses" | "gemini" | "anthropic";
    config: Record<string, unknown>;
  };
  embedding?: {
    type: "openai_embedding" | "gemini_embedding";
    config: Record<string, unknown>;
  };
  rerank?: {
    type: "cohere" | "jina" | "voyage" | "generic";
    config: Record<string, unknown>;
  };
  knowledgeBases?: Array<{
    name: string;
    description?: string;
    embeddingProviderId: string;
    rerankProviderId?: string;
  }>;
}
```

### 12.3 使用示例

```typescript
// 最小启动 — 仅 Webhook + LLM
const ctx = await bootstrap({
  provider: {
    type: "openai",
    config: { id: "openai-main", apiKey: process.env.OPENAI_API_KEY!, model: "gpt-4o-mini" },
  },
});

// 多适配器启动 — Webhook + QQ（QQ 暂未实现，仅示意）
const ctx = await bootstrap({
  adapters: [
    { type: "webhook", id: "webhook", port: 8080, host: "0.0.0.0", path: "/webhook", maxBodySize: 1048576, corsEnabled: true, timeoutMs: 120000 },
    // { type: "qq", id: "qq-main", protocol: "onebot_v11", wsUrl: "ws://localhost:6700", enabled: false },
  ],
  provider: {
    type: "openai",
    config: { id: "openai-main", apiKey: "...", model: "gpt-4o-mini" },
  },
});

// 完整启动 — LLM + 知识库
const ctx = await bootstrap({
  provider: { type: "openai", config: { id: "openai-main", apiKey: "...", model: "gpt-4o-mini" } },
  embedding: { type: "openai_embedding", config: { id: "emb-openai", apiKey: "...", model: "text-embedding-3-small" } },
  rerank: { type: "cohere", config: { id: "rerank-cohere", apiKey: "...", model: "rerank-v3.5" } },
  knowledgeBases: [
    { name: "docs", embeddingProviderId: "emb-openai", rerankProviderId: "rerank-cohere" },
  ],
});

// 运行时热添加适配器
const newAdapter = await ctx.adapterRegistry.addAndStart("webhook", {
  type: "webhook",
  id: "webhook-admin",
  port: 9090,
  host: "127.0.0.1",
  path: "/admin/webhook",
  maxBodySize: 1048576,
  corsEnabled: false,
  timeoutMs: 60000,
}, ctx.eventQueue);

// 测试请求
// curl -X POST http://localhost:8080/webhook \
//   -H "Content-Type: application/json" \
//   -d '{"message": "你好", "session_id": "test-1"}'
```

---

## 13. API 接口定义

### 13.1 POST /webhook

**请求体：**

```typescript
interface WebhookRequest {
  message: string;                // 必填，用户消息文本
  session_id?: string;            // 可选，会话 ID，默认 "webhook_default"
  user_id?: string;               // 可选，用户 ID，默认 "webhook_user"
  user_name?: string;             // 可选，用户名，默认 "WebhookUser"
  stream?: boolean;               // 可选，是否流式响应，默认 false
  image_urls?: string[];          // 可选，图片 URL 列表
  extra?: Record<string, unknown>; // 可选，额外数据，存入 event.extras
}
```

**响应（stream=false）：**

```typescript
interface WebhookSyncResponse {
  request_id: string;
  session_id: string;
  result: string;
  is_timeout: boolean;
}
```

**响应（stream=true）：**

```typescript
interface WebhookStreamAck {
  request_id: string;
  session_id: string;
  stream_url: string;
}
```

### 13.2 GET /stream/:sessionId

SSE 事件流，见第11节。

### 13.3 GET /status

```typescript
interface StatusResponse {
  status: "running" | "stopped";
  adapter_id: string;
  active_sessions: number;
  active_events: number;
  uptime_ms: number;
  provider_count: number;
  kb_count: number;
}
```

### 13.4 GET /health

```typescript
interface HealthResponse {
  ok: boolean;
}
```

---

## 14. 错误处理

### 14.1 HTTP 错误响应

| 状态码 | 场景 | 响应体 |
|--------|------|--------|
| 400 | 请求体格式错误 / 缺少 message 字段 | `{ error: "Missing required field: message" }` |
| 401 | Auth Token 验证失败 | `{ error: "Unauthorized" }` |
| 404 | 路由不存在 | `{ error: "Not found" }` |
| 413 | 请求体超过 maxBodySize | `{ error: "Request body too large" }` |
| 408 | 管线处理超时 | `{ request_id, result: "[timeout]", is_timeout: true }` |
| 500 | 内部错误 | `{ error: "Internal server error" }` |

### 14.2 管线错误处理

- `ProcessStage` 中的 Agent 调用失败 → 错误消息通过 `event.send()` 发送
- Provider API 错误 → 错误消息通过 `event.send()` 发送
- 知识库检索失败 → 降级为无知识库上下文，继续 LLM 调用
- 超时 → `WebhookEvent` 自动完成，返回 `[timeout]`

### 14.3 SSE 连接异常

- 客户端断开 → 清理 SSE 连接，管线继续执行（结果丢弃）
- 心跳超时（60s 无活动）→ 服务端关闭 SSE 连接
- 管线内部错误 → 通过 SSE `error` 事件推送

---

## 15. 未来适配器扩展指南

### 15.1 添加新适配器的步骤

1. **创建配置接口**：在 `src/platform/config.ts` 中添加 `XxxAdapterConfig extends AdapterConfigBase`
2. **创建适配器类**：在 `src/platform/implementations/xxx-adapter.ts` 中实现 `PlatformAdapter`
3. **创建事件类**：在同文件中实现 `XxxEvent extends MessageEvent`（`send`/`sendStreaming`）
4. **注册工厂**：在 `src/platform/registry.ts` 的 `registerBuiltinAdapterFactories` 中添加
5. **配置使用**：在 `adapters` 配置数组中添加 `{ type: "xxx", ... }`

### 15.2 适配器实现模板

```typescript
// src/platform/implementations/xxx-adapter.ts
import { PlatformAdapter } from "../adapter.js";
import type { PlatformMetadata } from "../metadata.js";
import type { AsyncQueue } from "../../common/async-queue.js";
import { MessageEvent } from "../../message/event.js";
// ... 其他导入

export interface XxxAdapterConfig extends AdapterConfigBase {
  type: "xxx";
  // 适配器专属配置字段
}

class XxxEvent extends MessageEvent {
  constructor(messageStr: string, messageObj: PlatformMessage, sessionId: string) {
    super(messageStr, messageObj, {
      name: "xxx",
      description: "XXX Platform Adapter",
      id: "xxx",
      supportStreamingMessage: true,  // 根据实际情况
      supportProactiveMessage: true,  // 根据实际情况
    }, sessionId);
  }

  async send(components: MessageComponent[]): Promise<void> {
    // 将 components 转换为平台格式并发送
  }

  async sendStreaming(generator: AsyncGenerator<MessageChain, void>): Promise<void> {
    // 流式发送（如果平台支持）
  }
}

export class XxxAdapter extends PlatformAdapter {
  private config: XxxAdapterConfig;

  constructor(config: XxxAdapterConfig, eventQueue: AsyncQueue<MessageEvent>) {
    super(config as unknown as Record<string, unknown>, eventQueue);
    this.config = config;
  }

  async initialize(): Promise<void> {
    await super.initialize();
    // 建立连接、加载资源
  }

  async run(): Promise<void> {
    this._status = "running";
    // 启动消息监听
  }

  async stop(): Promise<void> {
    // 关闭连接
    await super.stop();
  }

  meta(): PlatformMetadata {
    return {
      name: "xxx",
      description: "XXX Platform Adapter",
      id: this.config.id,
      supportStreamingMessage: true,
      supportProactiveMessage: true,
    };
  }
}
```

### 15.3 预留的适配器类型

| 类型 | 平台 | 协议 | 流式支持 | 主动消息 |
|------|------|------|---------|---------|
| `webhook` | HTTP Webhook | HTTP + SSE | ✅ | ✅ |
| `webchat` | Web Chat | WebSocket | ✅ | ✅ |
| `qq` | QQ (OneBot) | WebSocket/HTTP | ✅ | ✅ |
| `discord` | Discord | Gateway WebSocket | ✅ | ✅ |
| `telegram` | Telegram | Bot API (长轮询/Webhook) | ✅ | ✅ |
| `slack` | Slack | Socket Mode/Events API | ✅ | ✅ |
| `wechat` | 微信 | HTTP Callback | ❌ | ❌ |
| `dingtalk` | 钉钉 | HTTP Callback | ❌ | ✅ |
| `feishu` | 飞书 | HTTP Callback + WebSocket | ✅ | ✅ |

---

## 16. 目录结构

```
src/
├── platform/
│   ├── adapter.ts                          # 已有，扩展生命周期方法
│   ├── metadata.ts                         # 已有
│   ├── conversion.ts                       # 已有
│   ├── config.ts                           # 新增 — 适配器配置 Schema + 验证
│   ├── registry.ts                         # 新增 — AdapterRegistry 适配器注册中心
│   ├── index.ts                            # 更新导出
│   └── implementations/
│       ├── webchat-adapter.ts              # 已有
│       ├── webhook-adapter.ts              # 新增 — WebhookAdapter + WebhookEvent
│       └── index.ts                        # 更新导出
│
├── bootstrap.ts                            # 新增 — 系统启动引导
└── server.ts                               # 新增 — 便捷启动入口
```

### 新增/修改文件说明

| 文件 | 变更 | 职责 |
|------|------|------|
| `src/platform/adapter.ts` | 修改 | 扩展 `initialize()`/`stop()`/`status`/`healthCheck()` |
| `src/platform/config.ts` | 新增 | 适配器配置 Schema、类型定义、验证函数 |
| `src/platform/registry.ts` | 新增 | AdapterRegistry 注册中心、工厂注册、生命周期管理 |
| `src/platform/implementations/webhook-adapter.ts` | 新增 | WebhookAdapter + WebhookEvent + HTTP 服务器 + SSE |
| `src/bootstrap.ts` | 新增 | 系统启动引导：组装所有组件、启动适配器和事件总线 |
| `src/server.ts` | 新增 | 便捷启动入口：读取环境变量配置、调用 bootstrap() |
