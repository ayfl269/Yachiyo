# 消息处理系统设计文档

> 基于 AstrBot 消息处理架构，适配当前 TypeScript Agent 代码库的完整设计方案。
> 本文档覆盖从平台消息接收到响应发送的全链路设计与实现细节。

> [!NOTE]
> **关于项目结构的说明**：
> 当前项目采用 **PNPM Workspaces 多包工作区 (Monorepo)** 架构进行开发与模块化解耦。
> 1. 本文档中所引用的以 `src/` 开头的代码文件路径（如 `src/message/types.ts`），在实际工程开发中对应的是 `packages/<package-name>/src/`（如 `packages/message/src/types.ts`）。
> 2. 根目录下的 `src/` 文件夹仅包含少量代理重导出文件（如 `export * from "@yachiyo/message/index.js"`），目的是向后兼容和统一导出。实际业务代码与测试更新应在 `packages/` 目录下完成。

---

## 目录

1. [设计总览与映射关系](#1-设计总览与映射关系)
2. [消息模型体系](#2-消息模型体系)
3. [平台适配器接口](#3-平台适配器接口)
4. [事件总线 EventBus](#4-事件总线-eventbus)
5. [Pipeline 调度器](#5-pipeline-调度器)
6. [管线阶段详解](#6-管线阶段详解)
7. [Agent 调用核心流程](#7-agent-调用核心流程)
8. [Follow-up 追问机制](#8-follow-up-追问机制)
9. [响应发送阶段](#9-响应发送阶段)
10. [会话/对话管理](#10-会话对话管理)
11. [完整数据流图](#11-完整数据流图)
12. [目录结构与模块划分](#12-目录结构与模块划分)
13. [实现优先级与路线图](#13-实现优先级与路线图)
14. [与现有代码的集成方案](#14-与现有代码的集成方案)
15. [遗漏补充](#15-遗漏补充)

---

## 1. 设计总览与映射关系

### 1.1 架构总览

消息处理系统采用 **事件驱动 + 洋葱模型管线** 架构：

```
平台适配器 → AsyncQueue → EventBus → PipelineScheduler → N个Stage → 响应回平台
```

核心设计模式：
- **洋葱模型**：Stage 通过 AsyncGenerator + yield 实现前置/后置处理
- **事件驱动**：平台适配器与管线完全解耦，通过异步队列通信
- **多配置隔离**：每个配置有独立的 PipelineScheduler 实例
- **插件优先 + LLM 兜底**：先执行匹配的插件 Handler，未处理时再调用 LLM

### 1.2 AstrBot → 当前 Agent 映射表

| AstrBot 概念 | 当前 Agent 对应 | 说明 |
|---|---|---|
| `AstrBotMessage` | **新增** `PlatformMessage` | 平台原始消息统一表示 |
| `AstrMessageEvent` | **新增** `MessageEvent` | 管线核心事件对象 |
| `MessageChain` | 已有 `MessageChain`（types.ts） | 扩展现有类型，增加组件链 |
| `MessageEventResult` | **新增** `EventResult` | 事件处理结果 |
| `BaseMessageComponent` | **新增** `MessageComponent` | 富文本消息组件 |
| `Platform` | **新增** `PlatformAdapter` | 平台适配器基类 |
| `EventBus` | **新增** `EventBus` | 事件分发器 |
| `PipelineScheduler` | **新增** `PipelineScheduler` | 管线调度器 |
| `Stage` | **新增** `PipelineStage` | 管线阶段基类 |
| `AgentRunner` | 已有 `ToolLoopAgentRunner` | 直接复用 |
| `Provider` | 已有 `Provider`（types.ts） | 直接复用 |
| `ProviderRequest` | 已有 `ProviderRequest`（types.ts） | 直接复用 |
| `LLMResponse` | 已有 `LLMResponse`（types.ts） | 直接复用 |
| `ContextWrapper` | 已有 `ContextWrapper`（types.ts） | 直接复用 |
| `BaseAgentRunHooks` | 已有 `BaseAgentRunHooks`（hooks.ts） | 直接复用 |
| `ToolSet` / `FunctionTool` | 已有（tool.ts） | 直接复用 |
| `FunctionToolManager` | 已有（func-tool-manager.ts） | 直接复用 |
| `buildMainAgent` | 已有（agent-builder.ts） | 直接复用 |
| `runAgent` / `runLiveAgent` | 已有（agent-runner.ts） | 直接复用 |
| `ContextManager` | 已有（context/manager.ts） | 直接复用 |
| `Conversation` | 已有（types.ts） | 扩展字段 |
| `Message` | 已有（message.ts） | 直接复用 |

**设计原则**：最大化复用现有代码，仅新增消息处理层（平台适配 → 管线调度），不修改已有 Agent 核心模块。

---

## 2. 消息模型体系

### 2.1 MessageType 枚举

```typescript
// src/message/types.ts

export enum MessageType {
  GROUP_MESSAGE = "GroupMessage",
  FRIEND_MESSAGE = "FriendMessage",
  OTHER_MESSAGE = "OtherMessage",
}
```

### 2.2 MessageMember

```typescript
export interface MessageMember {
  userId: string;
  nickname: string | null;
}
```

### 2.3 Group

```typescript
export interface Group {
  groupId: string;
  groupName: string | null;
  groupAvatar: string | null;
  groupOwner: string | null;
  groupAdmins: string[] | null;
  members: MessageMember[] | null;
}
```

### 2.4 PlatformMessage

平台原始消息的统一表示，由平台适配器将原生消息转换为此格式：

```typescript
export class PlatformMessage {
  type: MessageType;
  selfId: string;                              // 机器人自身 ID
  sessionId: string;                           // 会话 ID
  messageId: string;                           // 消息 ID
  group: Group | null = null;                  // 群组信息
  sender: MessageMember;                       // 发送者
  components: MessageComponent[] = [];         // 消息组件链（富文本）
  messageStr: string = "";                     // 纯文本消息字符串
  rawMessage: unknown = null;                  // 原始消息对象（平台特有）
  timestamp: number;                           // 消息时间戳

  get groupId(): string {
    return this.group?.groupId ?? "";
  }
}
```

### 2.5 ComponentType 枚举与消息组件

```typescript
export enum ComponentType {
  Plain = "Plain",
  Image = "Image",
  Record = "Record",
  Video = "Video",
  File = "File",
  Face = "Face",
  At = "At",
  AtAll = "AtAll",
  Node = "Node",
  Nodes = "Nodes",
  Poke = "Poke",
  Reply = "Reply",
  Forward = "Forward",
  Json = "Json",
  Share = "Share",
  Music = "Music",
  Location = "Location",
  Contact = "Contact",
  Unknown = "Unknown",
}

// 消息组件基类
export interface MessageComponent {
  type: ComponentType;
  toDict(): Record<string, unknown>;
}

// 各组件定义
export interface PlainComponent extends MessageComponent {
  type: ComponentType.Plain;
  text: string;
}

export interface ImageComponent extends MessageComponent {
  type: ComponentType.Image;
  file?: string;
  url?: string;
  path?: string;
}

export interface RecordComponent extends MessageComponent {
  type: ComponentType.Record;
  file?: string;
  url?: string;
  path?: string;
  text?: string;  // 语音转文本结果
}

export interface VideoComponent extends MessageComponent {
  type: ComponentType.Video;
  file: string;
  cover?: string;
  path?: string;
}

export interface FileComponent extends MessageComponent {
  type: ComponentType.File;
  name?: string;
  file?: string;
  url?: string;
}

export interface AtComponent extends MessageComponent {
  type: ComponentType.At;
  qq: string | number;
  name?: string;
}

export interface AtAllComponent extends MessageComponent {
  type: ComponentType.AtAll;
  qq: "all";
}

export interface ReplyComponent extends MessageComponent {
  type: ComponentType.Reply;
  id: string | number;
  chain?: MessageComponent[];
  senderId?: string;
  senderNickname?: string;
  time?: number;
  messageStr?: string;
}

export interface FaceComponent extends MessageComponent {
  type: ComponentType.Face;
  id: number;
}

export interface JsonComponent extends MessageComponent {
  type: ComponentType.Json;
  data: Record<string, unknown>;
}

export interface NodeComponent extends MessageComponent {
  type: ComponentType.Node;
  id?: number;
  name?: string;
  uin?: string;
  content: MessageComponent[];
}

export interface NodesComponent extends MessageComponent {
  type: ComponentType.Nodes;
  nodes: NodeComponent[];
}

export interface ShareComponent extends MessageComponent {
  type: ComponentType.Share;
  url: string;
  title: string;
  content?: string;
  image?: string;
}

export interface LocationComponent extends MessageComponent {
  type: ComponentType.Location;
  lat: number;
  lon: number;
  title?: string;
  content?: string;
}

export interface ForwardComponent extends MessageComponent {
  type: ComponentType.Forward;
  id: string;
}
```

> 注意：`toDict()` 为平台适配器提供的简单序列化，统一序列化协议见 15.19 节 `serializeComponent()`

### 2.6 MessageSession

会话标识，用于跨阶段唯一标识一个会话：

```typescript
export class MessageSession {
  platformId: string;       // 平台唯一标识符
  messageType: MessageType;
  sessionId: string;

  toString(): string {
    return `${this.platformId}:${this.messageType}:${this.sessionId}`;
  }

  static fromStr(s: string): MessageSession {
    const [platformId, messageType, sessionId] = s.split(":");
    return Object.assign(new MessageSession(), {
      platformId,
      messageType: messageType as MessageType,
      sessionId,
    });
  }
}
```

### 2.7 PlatformMetadata

平台元信息，描述平台适配器的能力：

```typescript
export interface PlatformMetadata {
  name: string;                               // 平台类型名（如 "telegram"）
  description: string;
  id: string;                                 // 唯一标识符
  supportStreamingMessage: boolean;           // 默认 true
  supportProactiveMessage: boolean;           // 默认 true
}
```

### 2.8 EventResult

事件处理结果，继承并扩展现有 `MessageChain`：

```typescript
// src/message/event-result.ts

export enum EventResultType {
  CONTINUE = "CONTINUE",
  STOP = "STOP",
}

export enum ResultContentType {
  LLM_RESULT = "LLM_RESULT",
  GENERAL_RESULT = "GENERAL_RESULT",
  STREAMING_RESULT = "STREAMING_RESULT",
  STREAMING_FINISH = "STREAMING_FINISH",
  AGENT_RUNNER_ERROR = "AGENT_RUNNER_ERROR",
}

export class EventResult {
  resultType: EventResultType = EventResultType.CONTINUE;
  resultContentType: ResultContentType = ResultContentType.GENERAL_RESULT;
  components: MessageComponent[] = [];
  asyncStream: AsyncGenerator<MessageChain, void> | null = null;

  // 链式构建方法
  plain(text: string): this {
    this.components.push({ type: ComponentType.Plain, text, toDict() { return { type: "text", data: { text } }; } });
    return this;
  }

  image(url: string): this {
    this.components.push({ type: ComponentType.Image, url, toDict() { return { type: "Image", data: { url } }; } });
    return this;
  }

  stopEvent(): this {
    this.resultType = EventResultType.STOP;
    return this;
  }

  continueEvent(): this {
    this.resultType = EventResultType.CONTINUE;
    return this;
  }

  isStopped(): boolean {
    return this.resultType === EventResultType.STOP;
  }

  setAsyncStream(stream: AsyncGenerator<MessageChain, void>): this {
    this.asyncStream = stream;
    this.resultContentType = ResultContentType.STREAMING_RESULT;
    return this;
  }

  setResultContentType(type: ResultContentType): this {
    this.resultContentType = type;
    return this;
  }

  isLlmResult(): boolean {
    return this.resultContentType === ResultContentType.LLM_RESULT;
  }

  getPlainText(): string {
    return this.components
      .filter((c): c is PlainComponent => c.type === ComponentType.Plain)
      .map(c => c.text)
      .join("");
  }
}
```

---

## 3. 平台适配器接口

### 3.1 PlatformAdapter 基类

```typescript
// src/platform/adapter.ts

export abstract class PlatformAdapter {
  protected eventQueue: AsyncQueue<MessageEvent>;
  protected errors: unknown[] = [];

  constructor(config: Record<string, unknown>, eventQueue: AsyncQueue<MessageEvent>) {
    this.eventQueue = eventQueue;
  }

  abstract run(): Promise<void>;               // 启动平台连接
  abstract meta(): PlatformMetadata;           // 返回平台元信息

  commitEvent(event: MessageEvent): void {
    this.eventQueue.put(event);
  }

  async sendBySession(session: MessageSession, components: MessageComponent[]): Promise<void> {
    // 默认实现：通过 session 查找对应平台并发送
    throw new Error("sendBySession not implemented");
  }
}
```

### 3.2 MessageEvent 核心事件类

这是管线的核心事件对象，贯穿所有 Stage。它包装了 `PlatformMessage`，提供跨阶段的数据传递和结果控制：

```typescript
// src/message/event.ts

export abstract class MessageEvent {
  // === 核心属性 ===
  messageStr: string;                          // 纯文本消息
  messageObj: PlatformMessage;                 // 完整消息对象
  platformMeta: PlatformMetadata;              // 平台元信息
  session: MessageSession;                     // 会话标识
  role: "member" | "admin" = "member";
  isWake: boolean = false;                     // 是否通过唤醒阶段
  isAtOrWakeCommand: boolean = false;          // 是否 @/唤醒词/私聊
  createdAt: number;                           // 事件创建时间

  // === 跨阶段数据传递 ===
  private extras: Map<string, unknown> = new Map();
  private forceStopped: boolean = false;
  private result: EventResult | null = null;
  skipLlm: boolean = false;                   // 是否跳过默认 LLM 请求
  private temporaryLocalFiles: string[] = [];

  constructor(
    messageStr: string,
    messageObj: PlatformMessage,
    platformMeta: PlatformMetadata,
    sessionId: string,
  ) {
    this.messageStr = messageStr;
    this.messageObj = messageObj;
    this.platformMeta = platformMeta;
    this.session = new MessageSession(
      platformMeta.id,
      messageObj.type,
      sessionId,
    );
    this.createdAt = Date.now();
  }

  // === 统一消息来源标识 ===
  get unifiedMsgOrigin(): string {
    return this.session.toString();
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  // === 信息获取 ===
  getPlatformName(): string { return this.platformMeta.name; }
  getPlatformId(): string { return this.platformMeta.id; }
  getMessageStr(): string { return this.messageStr; }
  getMessageType(): MessageType { return this.messageObj.type; }
  getGroupId(): string { return this.messageObj.groupId; }
  getSelfId(): string { return this.messageObj.selfId; }
  getSenderId(): string { return this.messageObj.sender.userId; }
  getSenderName(): string { return this.messageObj.sender.nickname ?? ""; }
  isPrivateChat(): boolean { return this.messageObj.type === MessageType.FRIEND_MESSAGE; }
  isWakeUp(): boolean { return this.isWake; }
  isAdmin(): boolean { return this.role === "admin"; }

  // === 结果控制 ===
  setResult(result: EventResult | string): void {
    if (typeof result === "string") {
      this.result = new EventResult().plain(result);
    } else {
      this.result = result;
    }
  }

  getResult(): EventResult | null { return this.result; }
  clearResult(): void { this.result = null; }

  stopEvent(): void { this.forceStopped = true; }
  continueEvent(): void { this.forceStopped = false; }
  isStopped(): boolean {
    return this.forceStopped || (this.result?.isStopped() ?? false);
  }

  setSkipLlm(skip: boolean): void { this.skipLlm = skip; }

  // === 快捷结果创建 ===
  plainResult(text: string): EventResult {
    return new EventResult().plain(text);
  }

  // === 额外数据 ===
  setExtra(key: string, value: unknown): void { this.extras.set(key, value); }
  getExtra<T = unknown>(key: string, defaultValue?: T): T | undefined {
    return (this.extras.get(key) as T) ?? defaultValue;
  }
  clearExtra(): void { this.extras.clear(); }

  // === 临时文件 ===
  trackTemporaryLocalFile(path: string): void { this.temporaryLocalFiles.push(path); }
  cleanupTemporaryLocalFiles(): void {
    // 清理临时文件（异步删除）
    for (const filePath of this.temporaryLocalFiles) {
      try {
        const fs = require("fs");
        fs.unlinkSync(filePath);
      } catch { /* ignore */ }
    }
    this.temporaryLocalFiles = [];
  }

  // === 抽象方法（由平台子类实现）===
  abstract send(components: MessageComponent[]): Promise<void>;
  abstract sendStreaming(
    generator: AsyncGenerator<MessageChain, void>,
    useFallback?: boolean,
  ): Promise<void>;

  // === 可选方法（默认空实现）===
  async sendTyping(): Promise<void> {}
  async stopTyping(): Promise<void> {}
  async react(emoji: string): Promise<void> {
    await this.send([{ type: ComponentType.Plain, text: emoji, toDict() { return { type: "text", data: { text: emoji } }; } }]);
  }

  // === LLM 请求快捷方法 ===
  requestLlm(prompt: string, options?: {
    funcToolManager?: FunctionToolManager;
    toolSet?: ToolSet;
    sessionId?: string;
    imageUrls?: string[];
    audioUrls?: string[];
    contexts?: Message[];
    systemPrompt?: string;
    conversation?: Conversation;
  }): ProviderRequest {
    return {
      prompt,
      imageUrls: options?.imageUrls ?? [],
      audioUrls: options?.audioUrls ?? [],
      contexts: options?.contexts ?? [],
      systemPrompt: options?.systemPrompt,
      funcTool: options?.toolSet,
      sessionId: options?.sessionId,
      conversation: options?.conversation,
      extraUserContentParts: [],
    };
  }
}
```

### 3.3 AsyncQueue 实现

TypeScript 中替代 Python `asyncio.Queue` 的异步队列：

```typescript
// src/common/async-queue.ts

export class AsyncQueue<T> {
  private queue: T[] = [];
  private waiters: ((value: T) => void)[] = [];

  async get(): Promise<T> {
    if (this.queue.length > 0) return this.queue.shift()!;
    return new Promise<T>(resolve => this.waiters.push(resolve));
  }

  put(item: T): void {
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift()!;
      resolve(item);
    } else {
      this.queue.push(item);
    }
  }

  get size(): number {
    return this.queue.length;
  }
}
```

---

## 4. 事件总线 EventBus

### 4.1 完整实现

```typescript
// src/pipeline/event-bus.ts

export class EventBus {
  private eventQueue: AsyncQueue<MessageEvent>;
  private schedulerMapping: Map<string, PipelineScheduler>;  // configId -> scheduler
  private configManager: ConfigManager;

  constructor(
    eventQueue: AsyncQueue<MessageEvent>,
    schedulerMapping: Map<string, PipelineScheduler>,
    configManager: ConfigManager,
  ) {
    this.eventQueue = eventQueue;
    this.schedulerMapping = schedulerMapping;
    this.configManager = configManager;
  }

  async dispatch(): Promise<void> {
    while (true) {
      const event = await this.eventQueue.get();
      const confInfo = this.configManager.getConfInfo(event.unifiedMsgOrigin);
      const confId = confInfo.id;
      const scheduler = this.schedulerMapping.get(confId);

      if (!scheduler) {
        console.error(`PipelineScheduler not found for config: ${confId}, event ignored.`);
        continue;
      }

      // 为每个事件创建独立的异步任务
      setTimeout(() => scheduler.execute(event), 0);
    }
  }
}
```

**关键设计**：
- 无限循环从队列取事件
- 根据事件的 `unifiedMsgOrigin` 查找对应的配置 ID
- 每个配置 ID 对应一个独立的 `PipelineScheduler` 实例
- 为每个事件创建独立的异步任务执行管线

---

## 5. Pipeline 调度器

### 5.1 PipelineStage 基类

```typescript
// src/pipeline/stage.ts

export abstract class PipelineStage {
  abstract initialize(ctx: PipelineContext): Promise<void>;

  // 返回 Promise 表示普通协程，返回 AsyncGenerator 实现洋葱模型
  abstract process(event: MessageEvent): Promise<void> | AsyncGenerator<void, void>;
}
```

### 5.2 Stage 注册机制

```typescript
const registeredStages: (typeof PipelineStage)[] = [];

export function registerStage(cls: typeof PipelineStage): typeof PipelineStage {
  registeredStages.push(cls);
  return cls;
}

export function getRegisteredStages(): (typeof PipelineStage)[] {
  return [...registeredStages];
}
```

### 5.3 PipelineContext

管线上下文，在 Stage 初始化时注入依赖：

```typescript
export interface PipelineContext {
  config: AgentConfig;
  configId: string;
  pluginManager: PluginManager;
  providerManager: ProviderManager;
  conversationManager: ConversationManager;
  personaManager: PersonaManager;
  knowledgeBaseManager: KnowledgeBaseManager;
  sessionLockManager: SessionLockManager;
  callHandler: typeof callHandler;
  callEventHook: typeof callEventHook;
}
```

### 5.4 PipelineScheduler 完整实现

```typescript
// src/pipeline/scheduler.ts

export class PipelineScheduler {
  private ctx: PipelineContext;
  private stages: PipelineStage[] = [];

  constructor(context: PipelineContext) {
    this.ctx = context;
  }

  async initialize(): Promise<void> {
    // 按 STAGES_ORDER 排序
    const stages = getRegisteredStages();
    stages.sort((a, b) =>
      STAGES_ORDER.indexOf(a.name) - STAGES_ORDER.indexOf(b.name)
    );

    for (const stageCls of stages) {
      const instance = new stageCls();
      await instance.initialize(this.ctx);
      this.stages.push(instance);
    }
  }

  /**
   * 洋葱模型核心：递归执行管线阶段
   * - AsyncGenerator: yield 前是前置处理，yield 后是后置处理
   * - 普通协程: 顺序执行
   */
  private async processStages(event: MessageEvent, fromStage: number = 0): Promise<void> {
    for (let i = fromStage; i < this.stages.length; i++) {
      const stage = this.stages[i];
      const result = stage.process(event);

      if (isAsyncGenerator(result)) {
        // 洋葱模型
        for await (const _ of result) {
          // yield 点 = 前置处理完成
          if (event.isStopped()) break;

          // 递归执行后续所有阶段
          await this.processStages(event, i + 1);

          // 后置处理
          if (event.isStopped()) break;
        }
      } else {
        // 普通协程，直接等待
        await result;
        if (event.isStopped()) break;
      }
    }
  }

  async execute(event: MessageEvent): Promise<void> {
    activeEventRegistry.register(event);
    try {
      await this.processStages(event);
    } finally {
      event.cleanupTemporaryLocalFiles();
      activeEventRegistry.unregister(event);
    }
  }
}

function isAsyncGenerator(obj: unknown): obj is AsyncGenerator<void, void> {
  return obj != null &&
    typeof obj === "object" &&
    typeof (obj as any)[Symbol.asyncIterator] === "function" &&
    typeof (obj as any).next === "function";
}
```

### 5.5 阶段执行顺序

```typescript
export const STAGES_ORDER = [
  "WakingCheckStage",         // 1. 唤醒检查
  "SessionStatusCheckStage",  // 2. 会话状态检查
  "RateLimitStage",           // 3. 限流检查
  "ContentSafetyCheckStage",  // 4. 内容安全检查
  "PreProcessStage",          // 5. 预处理
  "ProcessStage",             // 6. 核心处理（插件 + LLM）
  "ResultDecorateStage",      // 7. 结果装饰
  "RespondStage",             // 8. 发送响应
];
```

---

## 6. 管线阶段详解

### 阶段 1: WakingCheckStage

**职责**：判断消息是否需要机器人处理。

唤醒条件（满足任一）：
1. 消息以 `wakePrefix` 配置的前缀开头
2. 消息中 @了机器人
3. 消息中 @了全体成员（可配置忽略）
4. 引用了机器人发送的消息
5. 私聊消息（且未配置 `friendMessageNeedsWakePrefix`）
6. 插件 Handler 的 filter 匹配通过

额外处理：
- 应用 `uniqueSession` 配置（群聊中用 `senderId_groupId` 作为会话 ID）
- 忽略机器人自身消息
- 识别管理员身份
- 将匹配到的 Handler 列表存入 `event.setExtra("activated_handlers", handlers)`
- 未唤醒则 `event.stopEvent()`

```typescript
@registerStage
export class WakingCheckStage extends PipelineStage {
  private wakePrefix: string = "";
  private friendMessageNeedsWakePrefix: boolean = false;
  private uniqueSession: boolean = false;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.wakePrefix = ctx.config.wakePrefix ?? "";
    this.friendMessageNeedsWakePrefix = ctx.config.friendMessageNeedsWakePrefix ?? false;
    this.uniqueSession = ctx.config.uniqueSession ?? false;
  }

  async process(event: MessageEvent): Promise<void> {
    // 1. 忽略自身消息
    if (event.getSenderId() === event.getSelfId()) {
      event.stopEvent();
      return;
    }

    // 2. 检查唤醒条件
    let isWake = false;
    const messageStr = event.getMessageStr();

    // 前缀唤醒
    if (this.wakePrefix && messageStr.startsWith(this.wakePrefix)) {
      isWake = true;
      event.messageStr = messageStr.slice(this.wakePrefix.length).trim();
    }

    // @唤醒
    const hasAtBot = event.messageObj.components.some(
      c => c.type === ComponentType.At && String(c.qq) === event.getSelfId()
    );
    if (hasAtBot) isWake = true;

    // @全体唤醒
    const hasAtAll = event.messageObj.components.some(
      c => c.type === ComponentType.AtAll
    );
    if (hasAtAll) isWake = true;

    // 私聊唤醒
    if (event.isPrivateChat() && !this.friendMessageNeedsWakePrefix) {
      isWake = true;
    }

    // 3. 插件 Handler 匹配
    const activatedHandlers = this.matchHandlers(event);
    if (activatedHandlers.length > 0) {
      isWake = true;
      event.setExtra("activated_handlers", activatedHandlers);
    }

    // 4. 设置状态
    event.isWake = isWake;
    event.isAtOrWakeCommand = isWake;

    // 5. uniqueSession 处理
    if (this.uniqueSession && !event.isPrivateChat()) {
      event.session.sessionId = `${event.getSenderId()}_${event.getGroupId()}`;
    }

    // 6. 未唤醒则停止
    if (!isWake) {
      event.stopEvent();
    }
  }

  private matchHandlers(event: MessageEvent): StarHandlerMetadata[] {
    // 从 PluginManager 获取匹配的 handler 列表
    // 实现 CommandFilter / RegexFilter / PermissionFilter 等过滤逻辑
    return [];
  }
}
```

### 阶段 2: SessionStatusCheckStage

**职责**：检查会话是否被整体禁用。

```typescript
@registerStage
export class SessionStatusCheckStage extends PipelineStage {
  private sessionServiceManager: SessionServiceManager;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.sessionServiceManager = new SessionServiceManager();
  }

  async process(event: MessageEvent): Promise<void> {
    const isEnabled = await this.sessionServiceManager.isSessionEnabled(
      event.unifiedMsgOrigin
    );
    if (!isEnabled) {
      event.stopEvent();
    }
  }
}
```

### 阶段 4: RateLimitStage

**职责**：基于 Fixed Window 算法的限流器。

```typescript
@registerStage
export class RateLimitStage extends PipelineStage {
  private rateLimitEnabled: boolean = false;
  private maxRequests: number = 10;
  private windowSeconds: number = 60;
  private strategy: "STALL" | "DISCARD" = "DISCARD";
  private counters: Map<string, { count: number; windowStart: number }> = new Map();

  async initialize(ctx: PipelineContext): Promise<void> {
    this.rateLimitEnabled = ctx.config.rateLimitEnabled ?? false;
    this.maxRequests = ctx.config.rateLimitMaxRequests ?? 10;
    this.windowSeconds = ctx.config.rateLimitWindowSeconds ?? 60;
    this.strategy = ctx.config.rateLimitStrategy ?? "DISCARD";
  }

  async process(event: MessageEvent): Promise<void> {
    if (!this.rateLimitEnabled) return;

    const key = event.unifiedMsgOrigin;
    const now = Date.now();
    let counter = this.counters.get(key);

    if (!counter || now - counter.windowStart > this.windowSeconds * 1000) {
      counter = { count: 0, windowStart: now };
      this.counters.set(key, counter);
    }

    counter.count++;

    if (counter.count > this.maxRequests) {
      if (this.strategy === "DISCARD") {
        event.stopEvent();
      } else {
        // STALL: 等待下一个时间窗口
        const waitMs = this.windowSeconds * 1000 - (now - counter.windowStart);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
  }
}
```

### 阶段 5: ContentSafetyCheckStage

**职责**：检查消息文本内容是否安全。使用 AsyncGenerator 实现洋葱模型，前置检查输入，后置检查输出。

```typescript
@registerStage
export class ContentSafetyCheckStage extends PipelineStage {
  private strategySelector: ContentSafetyStrategySelector;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.strategySelector = new ContentSafetyStrategySelector(ctx.config);
  }

  async *process(event: MessageEvent): AsyncGenerator<void, void> {
    // === 前置：检查输入消息安全性 ===
    const inputCheck = this.strategySelector.check(event.getMessageStr());
    if (!inputCheck.passed) {
      if (event.isWakeUp()) {
        await event.send([
          { type: ComponentType.Plain, text: `消息内容不安全: ${inputCheck.reason}`, toDict() { return {}; } }
        ]);
      }
      event.stopEvent();
      return;
    }

    yield; // 让后续阶段执行

    // === 后置：检查回复内容安全性 ===
    const result = event.getResult();
    if (result && this.strategySelector.checkResponse) {
      const outputCheck = this.strategySelector.check(result.getPlainText());
      if (!outputCheck.passed) {
        event.setResult(new EventResult().plain("回复内容未通过安全检查"));
      }
    }
  }
}

// 策略模式
export interface ContentSafetyCheckResult {
  passed: boolean;
  reason: string;
}

export abstract class ContentSafetyStrategy {
  abstract check(content: string): ContentSafetyCheckResult;
}

export class KeywordsStrategy extends ContentSafetyStrategy {
  private keywords: RegExp[];
  constructor(keywords: string[]) {
    super();
    this.keywords = keywords.map(kw => new RegExp(kw, "i"));
  }
  check(content: string): ContentSafetyCheckResult {
    for (const regex of this.keywords) {
      if (regex.test(content)) {
        return { passed: false, reason: "内容包含敏感关键词" };
      }
    }
    return { passed: true, reason: "" };
  }
}

export class ContentSafetyStrategySelector {
  private strategies: ContentSafetyStrategy[] = [];
  checkResponse: boolean = false;

  constructor(config: Record<string, unknown>) {
    // 根据配置加载策略
    if (config.safetyKeywords) {
      this.strategies.push(new KeywordsStrategy(config.safetyKeywords as string[]));
    }
    this.checkResponse = config.safetyCheckResponse as boolean ?? false;
  }

  check(content: string): ContentSafetyCheckResult {
    for (const strategy of this.strategies) {
      const result = strategy.check(content);
      if (!result.passed) return result;
    }
    return { passed: true, reason: "" };
  }
}
```

### 阶段 6: PreProcessStage

**职责**：消息发送前的预处理工作。

```typescript
@registerStage
export class PreProcessStage extends PipelineStage {
  private enableEmojiReact: boolean = false;
  private pathMappings: [string, string][] = [];
  private sttEnabled: boolean = false;
  private sttProvider: STTProvider | null = null;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.enableEmojiReact = ctx.config.emojiReact ?? false;
    this.pathMappings = ctx.config.pathMappings ?? [];
    this.sttEnabled = ctx.config.sttEnabled ?? false;
  }

  async process(event: MessageEvent): Promise<void> {
    // 1. 预回应表情
    if (this.enableEmojiReact) {
      try { await event.react("👀"); } catch { /* ignore */ }
    }

    // 2. 路径映射
    for (const comp of event.messageObj.components) {
      if (comp.type === ComponentType.File && "file" in comp && comp.file) {
        comp.file = this.applyPathMapping(comp.file);
      }
    }

    // 3. 语音转文本
    if (this.sttEnabled) {
      for (const comp of event.messageObj.components) {
        if (comp.type === ComponentType.Record && "url" in comp && comp.url) {
          try {
            const text = await this.sttProvider?.getText(comp.url) ?? "";
            if (text) {
              event.messageStr = `${event.messageStr} ${text}`.trim();
              if ("text" in comp) comp.text = text;
            }
          } catch (e) {
            console.error("STT failed:", e);
          }
        }
      }
    }
  }

  private applyPathMapping(path: string): string {
    for (const [from, to] of this.pathMappings) {
      if (path.startsWith(from)) {
        return path.replace(from, to);
      }
    }
    return path;
  }
}
```

### 阶段 7: ProcessStage（最复杂）

**职责**：调用插件和/或 LLM 处理消息。

```typescript
@registerStage
export class ProcessStage extends PipelineStage {
  private starRequestSubStage: StarRequestSubStage;
  private agentSubStage: AgentRequestSubStage;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.starRequestSubStage = new StarRequestSubStage(ctx);
    this.agentSubStage = new AgentRequestSubStage(ctx);
  }

  async *process(event: MessageEvent): AsyncGenerator<void, void> {
    const activatedHandlers = event.getExtra<StarHandlerMetadata[]>("activated_handlers");

    // 1. 如果有插件 Handler 被激活
    if (activatedHandlers && activatedHandlers.length > 0) {
      for await (const resp of this.starRequestSubStage.process(event)) {
        if (resp instanceof Object && "prompt" in resp) {
          // Handler 返回了 ProviderRequest，继续调用 Agent
          event.setExtra("provider_request", resp);
          for await (const _ of this.agentSubStage.process(event)) {
            yield;
          }
        } else {
          yield;
        }
      }
    }

    // 2. 如果没有发送过消息 且 被唤醒 且 未禁止 LLM
    const hasSendOper = event.getExtra<boolean>("has_send_oper") ?? false;
    if (!hasSendOper && event.isAtOrWakeCommand && !event.skipLlm) {
      const result = event.getResult();
      if ((result && !event.isStopped()) || !result) {
        for await (const _ of this.agentSubStage.process(event)) {
          yield;
        }
      }
    }
  }
}
```

#### 7a. StarRequestSubStage（插件处理）

```typescript
export class StarRequestSubStage {
  private ctx: PipelineContext;

  constructor(ctx: PipelineContext) {
    this.ctx = ctx;
  }

  async *process(event: MessageEvent): AsyncGenerator<unknown, void> {
    const handlers = event.getExtra<StarHandlerMetadata[]>("activated_handlers") ?? [];

    for (const handler of handlers) {
      try {
        for await (const val of this.ctx.callHandler(event, handler)) {
          if (val instanceof EventResult) {
            event.setResult(val);
          }
          yield val;
        }
      } catch (e) {
        // 调用 OnPluginErrorEvent 钩子
        await this.ctx.callEventHook(event, EventType.OnPluginErrorEvent, e);
      }

      // 每个处理器执行后清除结果
      event.clearResult();
    }
  }
}
```

#### 7b. AgentRequestSubStage（Agent 请求）

```typescript
export class AgentRequestSubStage {
  private ctx: PipelineContext;
  private streamingResponse: boolean = true;
  private maxStep: number = 30;

  constructor(ctx: PipelineContext) {
    this.ctx = ctx;
    this.streamingResponse = ctx.config.streamingResponse ?? true;
    this.maxStep = ctx.config.maxStep ?? 30;
  }

  async *process(event: MessageEvent): AsyncGenerator<void, void> {
    try {
      // 1. 前置检查
      const hasProviderRequest = event.getExtra("provider_request") !== undefined;
      const hasValidMessage = Boolean(event.messageStr?.trim());
      const hasMediaContent = event.messageObj.components.some(
        c => [ComponentType.Image, ComponentType.File, ComponentType.Record, ComponentType.Video].includes(c.type)
      );
      if (!hasProviderRequest && !hasValidMessage && !hasMediaContent) return;

      // 2. Follow-up 捕获
      const followUpCapture = tryCaptureFollowUp(event);
      if (followUpCapture) {
        const [consumedMarked, activated] = await prepareFollowUpCapture(followUpCapture);
        if (consumedMarked) return;
        if (activated) {
          event.setExtra("follow_up_activated", true);
        }
      }

      // 3. 发送 typing 状态
      try { await event.sendTyping(); } catch { /* ignore */ }

      // 4. 触发事件钩子
      await this.ctx.callEventHook(event, EventType.OnWaitingLLMRequestEvent);

      // 5. 获取会话锁
      const releaseLock = await sessionLockManager.acquireLock(event.unifiedMsgOrigin);

      try {
        // 6. 构建 Agent
        const buildResult = await this.buildAgent(event);
        if (!buildResult) return;

        const { agentRunner, providerRequest, provider } = buildResult;

        // 7. 触发 LLM 请求钩子
        const hookStopped = await this.ctx.callEventHook(event, EventType.OnLLMRequestEvent, providerRequest);
        if (hookStopped) return;

        // 8. 注册活跃运行器
        registerActiveRunner(event.unifiedMsgOrigin, agentRunner);

        // 9. 根据模式执行 Agent
        const enableStreaming = event.getExtra<boolean>("enable_streaming") ?? this.streamingResponse;
        const platformSupportsStreaming = event.platformMeta.supportStreamingMessage;

        if (enableStreaming && platformSupportsStreaming) {
          // 流式响应
          const streamGenerator = this.runAgentStreaming(agentRunner, event);
          event.setResult(
            new EventResult()
              .setResultContentType(ResultContentType.STREAMING_RESULT)
              .setAsyncStream(streamGenerator)
          );
          yield; // 让 pipeline 继续到 RespondStage
        } else {
          // 非流式响应
          const runResult = await runAgent(agentRunner, {
            maxStep: this.maxStep,
            shouldStop: () => event.isStopped(),
            onLlmResult: (chain) => {
              event.setResult(
                new EventResult()
                  .setResultContentType(ResultContentType.LLM_RESULT)
                  .plain(chain.message ?? "")
              );
            },
          });

          if (runResult.finalResponse) {
            event.setResult(
              new EventResult()
                .setResultContentType(ResultContentType.LLM_RESULT)
                .plain(runResult.finalResponse.completionText ?? "")
            );
          }
          yield;
        }

        // 10. 保存历史
        await this.saveToHistory(event, providerRequest, agentRunner);

      } finally {
        unregisterActiveRunner(event.unifiedMsgOrigin, agentRunner);
        releaseLock();
      }

    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await event.send([
        { type: ComponentType.Plain, text: `Error: ${errMsg}`, toDict() { return {}; } }
      ]);
    } finally {
      try { await event.stopTyping(); } catch { /* ignore */ }
    }
  }

  private async buildAgent(event: MessageEvent): Promise<AgentBuildResult | null> {
    // 使用现有的 buildMainAgent 函数
    const providerRequest = event.getExtra<ProviderRequest>("provider_request") ?? this.createProviderRequest(event);
    const provider = this.selectProvider(event);

    if (!provider) return null;

    const result = await buildMainAgent({
      provider,
      request: providerRequest,
      config: this.createBuildConfig(event),
      toolManager: this.toolManager,
      context: event,
    });

    return result;
  }

  private async *runAgentStreaming(
    agentRunner: ToolLoopAgentRunner,
    event: MessageEvent,
  ): AsyncGenerator<MessageChain, void> {
    for await (const resp of agentRunner.step()) {
      if (event.isStopped()) {
        agentRunner.requestStop();
      }

      if (resp.type === "streaming_delta") {
        yield resp.data.chain;
      } else if (resp.type === "llm_result") {
        yield resp.data.chain;
      } else if (resp.type === "aborted") {
        return;
      }
    }
  }
}
```

### 阶段 8: ResultDecorateStage

**职责**：对处理结果进行装饰和转换。

```typescript
@registerStage
export class ResultDecorateStage extends PipelineStage {
  private replyPrefix: string = "";
  private enableSegmentedReply: boolean = false;
  private enableTts: boolean = false;
  private enableT2i: boolean = false;
  private t2iThreshold: number = 1000;
  private displayReasoningText: boolean = false;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.replyPrefix = ctx.config.replyPrefix ?? "";
    this.enableSegmentedReply = ctx.config.segmentedReply ?? false;
    this.enableTts = ctx.config.ttsEnabled ?? false;
    this.enableT2i = ctx.config.t2iEnabled ?? false;
    this.t2iThreshold = ctx.config.t2iThreshold ?? 1000;
    this.displayReasoningText = ctx.config.displayReasoningText ?? false;
  }

  async process(event: MessageEvent): Promise<void> {
    const result = event.getResult();
    if (!result) return;

    // 1. 流式输出跳过装饰
    if (result.resultContentType === ResultContentType.STREAMING_RESULT) return;

    // 2. 触发 OnDecoratingResultEvent 钩子
    await callEventHook(event, EventType.OnDecoratingResultEvent);

    // 3. 回复前缀
    if (this.replyPrefix) {
      const firstPlain = result.components.find(
        c => c.type === ComponentType.Plain
      ) as PlainComponent | undefined;
      if (firstPlain) {
        firstPlain.text = `${this.replyPrefix}${firstPlain.text}`;
      }
    }

    // 4. 推理内容注入
    if (this.displayReasoningText) {
      const reasoningContent = event.getExtra<string>("reasoning_content");
      if (reasoningContent) {
        result.components.unshift({
          type: ComponentType.Plain,
          text: `[思考过程]\n${reasoningContent}\n\n[回复]`,
          toDict() { return { type: "text", data: { text: this.text } }; },
        });
      }
    }

    // 5. 文本转图片（超过阈值）
    if (this.enableT2i) {
      const plainText = result.getPlainText();
      if (plainText.length > this.t2iThreshold) {
        // 将文本渲染为图片，替换组件链
        // result.components = [await this.renderTextToImage(plainText)];
      }
    }

    // 6. TTS（文本转语音）
    if (this.enableTts) {
      const plainText = result.getPlainText();
      if (plainText) {
        // 将文本转为语音组件
        // result.components.push(await this.textToSpeech(plainText));
      }
    }
  }
}
```

### 阶段 9: RespondStage

详见 [第9章 响应发送阶段](#9-响应发送阶段)。

---

## 7. Agent 调用核心流程

### 7.1 与现有 Agent 系统的集成

当前 Agent 系统已具备完整的 Agent 运行能力（`ToolLoopAgentRunner`、`buildMainAgent`、`runAgent`），消息处理层通过以下方式与之集成：

```
MessageEvent → AgentRequestSubStage → buildMainAgent() → runAgent() → EventResult
```

**关键桥接点**：

1. **ProviderRequest 构建**：从 `MessageEvent` 提取消息内容、图片 URL、音频 URL 等构建 `ProviderRequest`
2. **Context 传递**：将 `MessageEvent` 作为 `TContext` 传入 `buildMainAgent`
3. **结果回写**：`runAgent` 的回调将 `LLMResponse` 转换为 `EventResult` 写回 `MessageEvent`
4. **流式输出**：`ToolLoopAgentRunner.step()` 的 AsyncGenerator 直接桥接到 `EventResult.asyncStream`

### 7.2 Agent 构建流程

```typescript
private async buildAgent(event: MessageEvent): Promise<AgentBuildResult | null> {
  // 1. 选择 Provider
  const provider = this.selectProvider(event);
  if (!provider) return null;

  // 2. 构建 ProviderRequest
  const request = this.createProviderRequest(event);

  // 3. 注入 Persona（角色设定）
  const persona = await this.resolvePersona(event);
  if (persona) {
    request.systemPrompt = persona.prompt;
    // 注入前置对话
    if (persona.beginDialogs) {
      request.contexts = [...persona.beginDialogs, ...request.contexts];
    }
  }

  // 4. 注入知识库
  const kbResult = await this.applyKnowledgeBase(event, request);
  if (kbResult) {
    request.systemPrompt = `${request.systemPrompt ?? ""}\n${kbResult}`;
  }

  // 5. 注入工具
  if (this.toolManager) {
    if (!request.funcTool) request.funcTool = new ToolSet();
    request.funcTool.merge(this.toolManager.getFullToolSet());
  }

  // 6. 调用 buildMainAgent
  return buildMainAgent({
    provider,
    request,
    config: this.createBuildConfig(event),
    toolManager: this.toolManager,
    context: event,
  });
}
```

### 7.3 历史保存

```typescript
private async saveToHistory(
  event: MessageEvent,
  request: ProviderRequest,
  agentRunner: ToolLoopAgentRunner,
): Promise<void> {
  if (!request.conversation) return;

  const finalResp = agentRunner.getFinalLlmResp();
  if (!finalResp) return;

  // 过滤消息：跳过初始 system 消息和标记 _noSave 的消息
  const messagesToSave = agentRunner.runContext.messages.filter(msg => {
    if (msg._noSave) return false;
    return true;
  });

  // 序列化并保存
  const serialized = dumpMessagesWithCheckpoints(messagesToSave);

  await this.conversationManager.updateConversation(
    event.unifiedMsgOrigin,
    request.conversation.id,
    { history: JSON.stringify(serialized) },
  );
}
```

---

## 8. Follow-up 追问机制

### 8.1 全局状态

```typescript
// src/pipeline/follow-up.ts

const ACTIVE_AGENT_RUNNERS = new Map<string, ToolLoopAgentRunner>();  // umo -> runner

interface FollowUpOrderState {
  condition: Condition;
  statuses: Map<number, "pending" | "active" | "consumed" | "finished">;
  nextOrder: number;
  nextTurn: number;
}

const FOLLOW_UP_ORDER_STATE = new Map<string, FollowUpOrderState>();

interface FollowUpCapture {
  umo: string;
  ticket: FollowUpTicket;
  orderSeq: number;
  monitorTask: Promise<void>;
}
```

### 8.2 Condition 实现

TypeScript 中替代 Python `asyncio.Condition`：

```typescript
export class Condition {
  private waiters: (() => void)[] = [];

  async wait(): Promise<void> {
    return new Promise<void>(resolve => {
      this.waiters.push(resolve);
    });
  }

  notifyAll(): void {
    const waiters = this.waiters.splice(0);
    waiters.forEach(resolve => resolve());
  }
}
```

### 8.3 核心函数

```typescript
export function registerActiveRunner(umo: string, runner: ToolLoopAgentRunner): void {
  ACTIVE_AGENT_RUNNERS.set(umo, runner);
}

export function unregisterActiveRunner(umo: string, runner: ToolLoopAgentRunner): void {
  if (ACTIVE_AGENT_RUNNERS.get(umo) === runner) {
    ACTIVE_AGENT_RUNNERS.delete(umo);
  }
}

export function tryCaptureFollowUp(event: MessageEvent): FollowUpCapture | null {
  const senderId = event.getSenderId();
  if (!senderId) return null;

  const runner = ACTIVE_AGENT_RUNNERS.get(event.unifiedMsgOrigin);
  if (!runner) return null;

  // 检查是否是同一发送者
  const runnerEvent = (runner.runContext?.context as MessageEvent | undefined);
  if (!runnerEvent) return null;
  if (runnerEvent.getSenderId() !== senderId) return null;

  // 检查是否被请求停止
  if (runnerEvent.getExtra("agent_stop_requested")) return null;

  // 尝试获取 follow-up ticket
  const ticket = runner.followUp({
    messageText: (event.getMessageStr() ?? "").trim(),
  });
  if (!ticket) return null;

  // 分配严格到达序号
  const orderSeq = allocateFollowUpOrder(event.unifiedMsgOrigin);

  return { umo: event.unifiedMsgOrigin, ticket, orderSeq, monitorTask: Promise.resolve() };
}

export async function prepareFollowUpCapture(capture: FollowUpCapture): Promise<[boolean, boolean]> {
  // 等待 ticket 解析
  await capture.ticket.resolved;
  if (capture.ticket.consumed) {
    await markFollowUpConsumed(capture.umo, capture.orderSeq);
    return [true, false];
  }
  await activateAndWaitFollowUpTurn(capture.umo, capture.orderSeq);
  return [false, true];
}

// 严格排序机制
function allocateFollowUpOrder(umo: string): number {
  let state = FOLLOW_UP_ORDER_STATE.get(umo);
  if (!state) {
    state = { condition: new Condition(), statuses: new Map(), nextOrder: 0, nextTurn: 0 };
    FOLLOW_UP_ORDER_STATE.set(umo, state);
  }
  const seq = state.nextOrder++;
  state.statuses.set(seq, "pending");
  return seq;
}

async function activateAndWaitFollowUpTurn(umo: string, seq: number): Promise<void> {
  const state = FOLLOW_UP_ORDER_STATE.get(umo);
  if (!state) return;
  state.statuses.set(seq, "active");

  while (state.nextTurn !== seq) {
    await state.condition.wait();
  }
}

async function markFollowUpConsumed(umo: string, seq: number): Promise<void> {
  const state = FOLLOW_UP_ORDER_STATE.get(umo);
  if (!state) return;
  state.statuses.set(seq, "consumed");
  advanceFollowUpTurn(state);
  state.condition.notifyAll();
}

export async function finishFollowUpTurn(umo: string, seq: number): Promise<void> {
  const state = FOLLOW_UP_ORDER_STATE.get(umo);
  if (!state) return;
  state.statuses.set(seq, "finished");
  advanceFollowUpTurn(state);
  state.condition.notifyAll();

  if (state.statuses.size === 0 && !ACTIVE_AGENT_RUNNERS.has(umo)) {
    FOLLOW_UP_ORDER_STATE.delete(umo);
  }
}

function advanceFollowUpTurn(state: FollowUpOrderState): void {
  while (true) {
    const curr = state.statuses.get(state.nextTurn);
    if (curr === "consumed" || curr === "finished") {
      state.statuses.delete(state.nextTurn);
      state.nextTurn++;
      continue;
    }
    break;
  }
}
```

**状态流转**：`pending → active → finished` 或 `pending → consumed`

---

## 9. 响应发送阶段

### 9.1 RespondStage 完整实现

```typescript
// src/pipeline/stages/respond.ts

@registerStage
export class RespondStage extends PipelineStage {
  private replyWithMention: boolean = false;
  private replyWithQuote: boolean = false;
  private enableSegmentedReply: boolean = false;
  private onlyLlmResult: boolean = false;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.replyWithMention = ctx.config.replyWithMention ?? false;
    this.replyWithQuote = ctx.config.replyWithQuote ?? false;
    this.enableSegmentedReply = ctx.config.segmentedReply ?? false;
    this.onlyLlmResult = ctx.config.onlyLlmResultSegmented ?? false;
  }

  async process(event: MessageEvent): Promise<void> {
    const result = event.getResult();
    if (!result) return;

    // 防止流式后重复发送
    if (event.getExtra("_streaming_finished", false)) return;
    if (result.resultContentType === ResultContentType.STREAMING_FINISH) {
      event.setExtra("_streaming_finished", true);
      return;
    }

    // === 流式结果 ===
    if (result.resultContentType === ResultContentType.STREAMING_RESULT) {
      if (!result.asyncStream) return;
      await event.sendStreaming(result.asyncStream);
      return;
    }

    // === 非流式结果 ===
    if (result.components.length > 0) {
      // 空消息链检查
      if (this.isEmptyMessageChain(result.components)) return;

      // 移除空 Plain 段
      result.components = result.components.filter(
        c => !(c.type === ComponentType.Plain && !(c as PlainComponent).text?.trim())
      );

      // @回复
      if (this.replyWithMention && !event.isPrivateChat()) {
        result.components.unshift({
          type: ComponentType.At,
          qq: event.getSenderId(),
          toDict() { return { type: "at", data: { qq: this.qq } }; },
        });
      }

      // 引用回复
      if (this.replyWithQuote) {
        result.components.unshift({
          type: ComponentType.Reply,
          id: event.messageObj.messageId,
          toDict() { return { type: "reply", data: { id: this.id } }; },
        });
      }

      // 分段回复
      if (this.isSegReplyRequired(event, result)) {
        const headerComps = this.extractComps(result.components, new Set([ComponentType.Reply, ComponentType.At]));
        for (const comp of result.components) {
          const interval = this.calcCompInterval(comp);
          await new Promise(resolve => setTimeout(resolve, interval));
          try {
            await event.send([...headerComps, comp]);
            headerComps.length = 0;
          } catch (e) {
            console.error(`发送消息失败: ${e}`);
          }
        }
      } else {
        // 普通回复
        if (result.components.every(
          c => c.type === ComponentType.Reply || c.type === ComponentType.At
        )) return;

        // Record 强制单独发送
        const recordComps = this.extractComps(result.components, new Set([ComponentType.Record]));
        for (const comp of recordComps) {
          try { await event.send([comp]); } catch (e) { console.error(`发送消息失败: ${e}`); }
        }

        // 剩余组件作为一条消息发送
        if (result.components.length > 0) {
          try { await event.send(result.components); } catch (e) { console.error(`发送消息失败: ${e}`); }
        }
      }
    }

    // 触发钩子
    await callEventHook(event, EventType.OnAfterMessageSentEvent);

    event.clearResult();
  }

  private isSegReplyRequired(event: MessageEvent, result: EventResult): boolean {
    if (!this.enableSegmentedReply) return false;
    if (this.onlyLlmResult && !result.isLlmResult()) return false;
    return true;
  }

  private isEmptyMessageChain(components: MessageComponent[]): boolean {
    if (!components.length) return true;
    return !components.some(c => {
      if (c.type === ComponentType.Plain) return Boolean((c as PlainComponent).text?.trim());
      return true;
    });
  }

  private extractComps(
    rawChain: MessageComponent[],
    extractTypes: Set<ComponentType>,
  ): MessageComponent[] {
    const extracted: MessageComponent[] = [];
    const remaining: MessageComponent[] = [];
    for (const comp of rawChain) {
      if (extractTypes.has(comp.type)) extracted.push(comp);
      else remaining.push(comp);
    }
    rawChain.splice(0, rawChain.length, ...remaining);
    return extracted;
  }

  private calcCompInterval(comp: MessageComponent): number {
    // 模拟人类回复间隔
    if (comp.type === ComponentType.Plain) {
      const text = (comp as PlainComponent).text;
      const wordCount = text.length;
      return Math.random() * 500 + Math.min(wordCount * 20, 2000);
    }
    return Math.random() * 750 + 1000;
  }
}
```

---

## 10. 会话/对话管理

### 10.1 ConversationManager

```typescript
// src/conversation/manager.ts

export class ConversationManager {
  private sessionConversations: Map<string, string> = new Map();  // umo -> conversationId
  private db: ConversationStore;

  constructor(db: ConversationStore) {
    this.db = db;
  }

  async newConversation(umo: string, options?: {
    platformId?: string;
    content?: string;
    title?: string;
    personaId?: string;
  }): Promise<string> {
    const conversationId = generateId();
    const conversation: Conversation = {
      id: conversationId,
      unifiedMsgOrigin: umo,
      personaId: options?.personaId,
      history: "[]",
      platformId: options?.platformId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await this.db.createConversation(conversation);
    this.sessionConversations.set(umo, conversationId);
    return conversationId;
  }

  async switchConversation(umo: string, conversationId: string): Promise<void> {
    const conv = await this.db.getConversationById(conversationId);
    if (!conv) throw new Error(`Conversation ${conversationId} not found`);
    this.sessionConversations.set(umo, conversationId);
  }

  async deleteConversation(umo: string, conversationId?: string): Promise<void> {
    const cid = conversationId ?? this.sessionConversations.get(umo);
    if (!cid) return;
    await this.db.deleteConversation(cid);
    if (this.sessionConversations.get(umo) === cid) {
      this.sessionConversations.delete(umo);
    }
  }

  getCurrConversationId(umo: string): string | null {
    return this.sessionConversations.get(umo) ?? null;
  }

  async getConversation(umo: string, conversationId: string): Promise<Conversation | null> {
    return this.db.getConversationById(conversationId);
  }

  async updateConversation(umo: string, conversationId: string, options: {
    history?: string;
    title?: string;
    personaId?: string;
    tokenUsage?: number;
  }): Promise<void> {
    await this.db.updateConversation(conversationId, {
      ...options,
      updatedAt: new Date(),
    });
  }

  async addMessagePair(cid: string, userMessage: string, assistantMessage: string): Promise<void> {
    const conv = await this.db.getConversationById(cid);
    if (!conv) return;
    const history = JSON.parse(conv.history);
    history.push({ role: "user", content: userMessage });
    history.push({ role: "assistant", content: assistantMessage });
    await this.db.updateConversation(cid, { history: JSON.stringify(history) });
  }
}
```

### 10.2 ConversationStore 接口

> 见 15.17 节完整定义。以下为对话相关的 6 个方法签名快速参考：

```typescript
// 对话相关方法（完整定义见 15.17 节）
abstract createConversation(conversation: Conversation): Promise<void>;
abstract getConversationById(id: string): Promise<Conversation | null>;
abstract getAllConversations(): Promise<Conversation[]>;
abstract getFilteredConversations(options: {
  page?: number;
  pageSize?: number;
  platformIds?: string[];
  searchQuery?: string;
}): Promise<[Conversation[], number]>;
abstract updateConversation(id: string, updates: Partial<Conversation>): Promise<void>;
abstract deleteConversation(id: string): Promise<void>;
```

### 10.3 SessionLockManager

```typescript
// src/pipeline/session-lock.ts

export class SessionLockManager {
  private locks: Map<string, Promise<void>> = new Map();

  async acquireLock(umo: string): Promise<() => void> {
    while (this.locks.has(umo)) {
      await this.locks.get(umo);
    }
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(umo, promise);
    return () => {
      this.locks.delete(umo);
      release();
    };
  }
}
```

### 10.4 ActiveEventRegistry

```typescript
// src/pipeline/active-event-registry.ts

export class ActiveEventRegistry {
  private events: Map<string, Set<MessageEvent>> = new Map();

  register(event: MessageEvent): void {
    const key = event.unifiedMsgOrigin;
    if (!this.events.has(key)) this.events.set(key, new Set());
    this.events.get(key)!.add(event);
  }

  unregister(event: MessageEvent): void {
    const key = event.unifiedMsgOrigin;
    this.events.get(key)?.delete(event);
  }

  stopAll(umo: string, exclude?: MessageEvent): number {
    let count = 0;
    for (const event of this.events.get(umo) ?? []) {
      if (event !== exclude) {
        event.stopEvent();
        count++;
      }
    }
    return count;
  }

  requestAgentStopAll(umo: string, exclude?: MessageEvent): number {
    let count = 0;
    for (const event of this.events.get(umo) ?? []) {
      if (event !== exclude) {
        event.setExtra("agent_stop_requested", true);
        count++;
      }
    }
    return count;
  }
}

export const activeEventRegistry = new ActiveEventRegistry();
```

---

## 11. 完整数据流图

```
┌──────────────────────────────────────────────────────────────────────┐
│                     平台适配器 (PlatformAdapter)                      │
│  Telegram / QQ / Discord / 飞书 / 微信 / WebChat / ...              │
│                                                                      │
│  1. 收到平台原生消息                                                   │
│  2. 转换为 PlatformMessage (type, sender, components, messageStr)    │
│  3. 创建 MessageEvent 子类 (TelegramEvent 等)                         │
│  4. 调用 this.commitEvent(event) → 放入 AsyncQueue                   │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     EventBus.dispatch()                               │
│                                                                      │
│  while (true) {                                                      │
│    event = await eventQueue.get();                                   │
│    confId = configManager.getConfInfo(event.unifiedMsgOrigin).id;    │
│    scheduler = schedulerMapping[confId];                             │
│    setTimeout(() => scheduler.execute(event), 0);                    │
│  }                                                                   │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│                PipelineScheduler.execute(event)                       │
│                                                                      │
│  activeEventRegistry.register(event);                                │
│  try {                                                               │
│    await processStages(event);  ← 洋葱模型递归执行                    │
│  } finally {                                                         │
│    event.cleanupTemporaryLocalFiles();                               │
│    activeEventRegistry.unregister(event);                            │
│  }                                                                   │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              │    9 个 Stage 顺序执行        │
              └──────────────┬──────────────┘
                             │
  ┌────────┬────────┬────────┬────────┬────────┐
  ▼        ▼        ▼        ▼        ▼        ▼
Stage1   Stage2   Stage3   Stage4   Stage5   Stage6
唤醒检查  白名单   会话状态  限流检查  内容安全  预处理
  │        │        │        │        │        │
  └────────┴────────┴────────┴────────┴────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │   Stage 7:          │
                  │   ProcessStage      │
                  │                     │
                  │  ┌───────────────┐  │
                  │  │ StarRequest   │  │  ← 插件处理
                  │  │ SubStage      │  │
                  │  └───────┬───────┘  │
                  │          │          │
                  │  ┌───────▼───────┐  │
                  │  │ AgentRequest  │  │  ← LLM/Agent 调用
                  │  │ SubStage      │  │
                  │  │               │  │
                  │  │ ┌───────────┐ │  │
                  │  │ │buildMain  │ │  │  ← 复用现有 builder
                  │  │ │Agent()    │ │  │
                  │  │ └─────┬─────┘ │  │
                  │  │ ┌─────▼─────┐ │  │
                  │  │ │runAgent() │ │  │  ← 复用现有 runner
                  │  │ └───────────┘ │  │
                  │  └───────────────┘  │
                  └─────────┬───────────┘
                            │
                            ▼
                  ┌─────────────────────┐
                  │  Stage 8:           │
                  │  ResultDecorate     │  ← 前缀/TTS/T2I/分段
                  └─────────┬───────────┘
                            │
                            ▼
                  ┌─────────────────────┐
                  │  Stage 9:           │
                  │  RespondStage       │  ← 实际发送消息
                  │                     │
                  │  流式 → sendStreaming│
                  │  非流式 → send      │
                  └─────────┬───────────┘
                            │
                            ▼
             ┌──────────────────────────────┐
             │  平台适配器 event.send()      │
             │  将 MessageComponent[] 转换为 │
             │  平台协议格式发送              │
             └──────────────────────────────┘
```

### Agent 内部详细流程

```
AgentRequestSubStage.process(event)
  │
  ├── tryCaptureFollowUp(event)     ← 检查是否有活跃 Agent 可接收追问
  ├── event.sendTyping()            ← 发送输入中状态
  ├── callEventHook(OnWaitingLLMRequestEvent)
  ├── sessionLockManager.acquireLock(umo)  ← 获取会话锁
  │
  ├── buildMainAgent(event, ctx, config)   ← 构建主 Agent（复用现有）
  │   ├── 选择 Provider
  │   ├── 构建 ProviderRequest
  │   ├── 注入 persona / skills / prompt_prefix
  │   ├── 应用知识库
  │   ├── 注入工具（ToolManager）
  │   └── 创建 ToolLoopAgentRunner + reset()
  │
  ├── callEventHook(OnLLMRequestEvent)     ← LLM 请求钩子
  ├── registerActiveRunner(umo, runner)     ← 注册活跃运行器
  │
  ├── [Streaming Mode]
  │   └── ToolLoopAgentRunner.step()       ← 复用现有 step()
  │       ├── ContextManager.process()     ← 上下文压缩/截断
  │       ├── Provider.textChatStream()    ← LLM 调用（含 fallback）
  │       ├── 产出 streaming_delta         ← 增量文本
  │       └── 产出 tool_call / tool_call_result
  │
  ├── [Non-Streaming Mode]
  │   └── runAgent(runner, options)        ← 复用现有 runAgent()
  │
  ├── saveToHistory()                       ← 保存对话历史
  └── unregisterActiveRunner(umo, runner)   ← 注销运行器
```

---

## 12. 目录结构与模块划分

```
src/
├── agent/                          # 现有 Agent 核心（不修改）
│   ├── agent.ts                    # Agent 定义
│   ├── agent-builder.ts            # Agent 构建器
│   ├── agent-runner.ts             # 高层运行器
│   ├── context/                    # 上下文管理
│   ├── runners/                    # Runner 实现
│   ├── hooks.ts                    # 生命周期钩子
│   ├── tool.ts                     # 工具定义
│   ├── func-tool-manager.ts        # 工具管理器
│   ├── message.ts                  # 消息模型
│   ├── types.ts                    # 核心类型
│   └── ...
│
├── message/                        # 新增：消息处理模型
│   ├── types.ts                    # MessageType, ComponentType, MessageMember, Group
│   ├── components.ts               # MessageComponent 各子类型
│   ├── platform-message.ts         # PlatformMessage 类
│   ├── message-session.ts          # MessageSession 类
│   ├── event.ts                    # MessageEvent 抽象类
│   └── event-result.ts             # EventResult 类
│
├── platform/                       # 新增：平台适配器
│   ├── adapter.ts                  # PlatformAdapter 基类
│   ├── metadata.ts                 # PlatformMetadata 接口
│   └── implementations/            # 各平台实现
│       ├── telegram.ts
│       ├── discord.ts
│       ├── webchat.ts
│       └── ...
│
├── pipeline/                       # 新增：管线调度
│   ├── scheduler.ts                # PipelineScheduler
│   ├── stage.ts                    # PipelineStage 基类 + registerStage
│   ├── context.ts                  # PipelineContext
│   ├── event-bus.ts                # EventBus
│   ├── active-event-registry.ts    # ActiveEventRegistry
│   ├── follow-up.ts                # Follow-up 追问机制
│   ├── session-lock.ts             # SessionLockManager
│   └── stages/                     # 各阶段实现
│       ├── waking-check.ts
│       ├── whitelist-check.ts
│       ├── session-status-check.ts
│       ├── rate-limit.ts
│       ├── content-safety-check.ts
│       ├── preprocess.ts
│       ├── process.ts              # ProcessStage + SubStages
│       ├── result-decorate.ts
│       └── respond.ts
│
├── conversation/                   # 新增：对话管理
│   ├── manager.ts                  # ConversationManager
│   └── store.ts                    # ConversationStore 接口
│
├── common/                         # 新增：通用工具
│   ├── async-queue.ts              # AsyncQueue
│   ├── condition.ts                # Condition
│   └── id-generator.ts             # ID 生成器
│
└── index.ts                        # 主入口（扩展导出）
```

---

## 13. 实现优先级与路线图

### P0 - 最小可用（核心链路）

必须实现，用于测试 Agent 可用性：

1. **AsyncQueue** - 异步队列基础设施
2. **PlatformMessage** - 平台消息模型
3. **MessageEvent** - 核心事件类（含 send 抽象方法）
4. **EventResult** - 事件结果模型
5. **MessageComponent** - 基础消息组件（Plain, Image, At, Reply）
6. **PipelineScheduler** - 管线调度器（含洋葱模型）
7. **WakingCheckStage** - 唤醒检查（简化版）
8. **ProcessStage** - 核心处理（Agent 调用）
9. **RespondStage** - 响应发送
10. **EventBus** - 事件分发

### P1 - 基本功能

1. **PlatformAdapter** - 平台适配器基类 + 至少一个实现（如 WebChat）
2. **PreProcessStage** - 预处理
3. **buildAgent 桥接** - 将 MessageEvent 与 buildMainAgent 连接
4. **Follow-up 机制** - 追问支持
5. **SessionLockManager** - 会话锁
6. **ConversationManager** - 对话持久化（基础版）

### P2 - 完整功能

1. **SessionStatusCheckStage** - 会话状态检查
2. **RateLimitStage** - 限流检查
3. **ContentSafetyCheckStage** - 内容安全检查
5. **ResultDecorateStage** - 结果装饰（TTS/T2I/分段）
6. **完整 MessageComponent** - 所有组件类型
7. **更多平台适配器** - Telegram/Discord 等
8. **Live Mode** - runLiveAgent + TTS 集成

### 最小可测试管线

```typescript
// 最小可测试管线：只包含核心 3 个阶段
const MINIMAL_STAGES = [
  WakingCheckStage,      // 唤醒检查（简化版：总是唤醒）
  ProcessStage,          // 核心：Agent 调用
  RespondStage,          // 响应发送
];

// 测试流程：
// 1. 创建 MessageEvent（模拟平台消息）
// 2. 创建 PipelineScheduler（使用最小阶段集）
// 3. scheduler.execute(event)
// 4. 验证 event.getResult() 包含预期的 LLM 响应
```

---

## 14. 与现有代码的集成方案

### 14.1 不修改现有模块

所有新增代码位于 `src/message/`、`src/platform/`、`src/pipeline/`、`src/conversation/`、`src/common/` 目录下，不修改 `src/agent/` 下的任何现有文件。

### 14.2 通过接口桥接

消息处理层通过以下方式与现有 Agent 系统交互：

| 桥接点 | 方向 | 方式 |
|--------|------|------|
| `ProviderRequest` | MessageEvent → Agent | 从 event 提取数据构建 request |
| `buildMainAgent()` | Pipeline → Agent | 直接调用现有函数 |
| `runAgent()` | Pipeline → Agent | 直接调用现有函数 |
| `ToolLoopAgentRunner` | Pipeline → Agent | 由 buildMainAgent 创建 |
| `MessageEvent as TContext` | Pipeline → Agent | 作为泛型上下文传入 |
| `EventResult` | Agent → Pipeline | 将 LLMResponse 转换为 EventResult |
| `MessageChain` | Agent → Pipeline | runAgent 产出 → EventResult.asyncStream |

### 14.3 类型扩展

仅对现有 `types.ts` 中的 `MessageChain` 进行扩展，增加 `components` 字段：

```typescript
// 在 src/agent/types.ts 中扩展（或通过声明合并）
export interface MessageChain {
  type: string;
  chain?: unknown[];
  message?: string;
  components?: MessageComponent[];  // 新增：富文本组件链
}
```

### 14.4 导出扩展

在 `src/index.ts` 中增加新模块的导出：

```typescript
// 现有导出
export * from "./agent/index.js";

// 新增导出
export * from "./message/index.js";
export * from "./platform/index.js";
export * from "./pipeline/index.js";
export * from "./conversation/index.js";
export * from "./common/index.js";
```

### 14.5 初始化流程

```typescript
// 应用启动时的初始化流程
async function initializeMessageProcessing() {
  // 1. 创建共享事件队列
  const eventQueue = new AsyncQueue<MessageEvent>();

  // 2. 创建配置管理器
  const configManager = new ConfigManager();

  // 3. 为每个配置创建 PipelineScheduler
  const schedulerMapping = new Map<string, PipelineScheduler>();
  for (const config of configManager.getAllConfigs()) {
    const scheduler = new PipelineScheduler({
      config,
      configId: config.id,
      pluginManager: new PluginManager(),
      providerManager: new ProviderManager(),
      conversationManager: new ConversationManager(db),
      personaManager: new PersonaManager(db),
      knowledgeBaseManager: new KnowledgeBaseManager(providerManager),
      sessionLockManager: new SessionLockManager(),
      callHandler,
      callEventHook,
    });
    await scheduler.initialize();
    schedulerMapping.set(config.id, scheduler);
  }

  // 4. 创建并启动 EventBus
  const eventBus = new EventBus(eventQueue, schedulerMapping, configManager);
  eventBus.dispatch(); // 非阻塞

  // 5. 创建并启动平台适配器
  const platforms = createPlatforms(configManager, eventQueue);
  for (const platform of platforms) {
    platform.run(); // 非阻塞
  }
}
```

---

## 附录：关键设计决策

### A. 为什么选择洋葱模型？

洋葱模型允许每个 Stage 在 yield 前执行前置逻辑，yield 后执行后置逻辑。这对于以下场景至关重要：
- **ContentSafetyCheckStage**：前置检查输入，后置检查输出
- **ProcessStage**：前置构建 Agent，后置保存历史
- **ResultDecorateStage**：在 ProcessStage 完成后装饰结果

### B. 为什么 MessageEvent 是抽象类？

不同平台的消息发送方式不同（Telegram API vs QQ HTTP vs WebSocket），因此 `send()` 和 `sendStreaming()` 必须由平台子类实现。同时，MessageEvent 作为 `TContext` 传入 Agent 系统，使工具可以访问事件上下文。

### C. 为什么使用 AsyncGenerator 而非回调？

1. 与现有 `ToolLoopAgentRunner.step()` 的 AsyncGenerator 模式一致
2. 天然支持流式输出
3. 洋葱模型需要 yield 点来分割前置/后置处理
4. 代码可读性优于回调嵌套

### D. 为什么不修改现有 Agent 模块？

1. 现有 Agent 模块是通用的、框架无关的，不应依赖消息处理逻辑
2. 消息处理层是应用层，Agent 是基础设施层，依赖方向应为应用层 → 基础设施层
3. 保持 Agent 模块的独立可测试性
4. 遵循开闭原则：对扩展开放，对修改关闭

### E. 工具调用类型：为什么复用现有 Message + ToolCall 而非参考文档的 Segment 子类型？

参考文档使用 `AssistantMessageSegment` / `ToolCallMessageSegment` 独立子类型，当前代码库使用统一 `Message` + `role` 区分。选择复用现有方案的原因：

| 维度 | 参考文档 Segment 方案 | 当前 Message + role 方案 | 优势方 |
|------|----------------------|-------------------------|--------|
| 消息类型 | 每种角色一个独立接口 | 统一 `Message` + `role` 枚举 | **当前** — 减少类型膨胀 |
| 工具调用格式 | 自定义 `tools_call_name/args/ids` 数组 | `ToolCall` 直接对齐 OpenAI function calling | **当前** — 与 LLM API 原生格式一致 |
| 工具执行结果 | 自定义格式 | `CallToolResult` 遵循 MCP 协议 | **当前** — 标准化，支持多模态结果 |
| 序列化 | `toOpenaiMessages()` 手动转换 | `Message` 天然兼容 OpenAI 格式 | **当前** — 零转换成本 |

**结论**：`ToolCallsResult`、`ToolCall`、`CallToolResult`、`Message` 等工具调用相关类型直接复用现有定义，不采用参考文档的 Segment 子类型方案。

---

## 15. 遗漏补充

以下内容在初版文档中遗漏，经与参考文档 15.1-15.26 节全面对比后补充。

### 15.1 Provider 体系（完整类层次）

文档第 1.2 节映射表仅标注"直接复用"，缺少完整的 Provider 类型体系定义。

```typescript
// src/provider/types.ts

// Provider 类型枚举
export enum ProviderType {
  CHAT_COMPLETION = "chat_completion",
  SPEECH_TO_TEXT = "speech_to_text",
  TEXT_TO_SPEECH = "text_to_speech",
  EMBEDDING = "embedding",
  RERANK = "rerank",
}

// Provider 元信息
export interface ProviderMeta {
  id: string;
  model: string | null;
  type: string;                    // 适配器名称（如 "openai", "ollama"）
  providerType: ProviderType;
}

export interface ProviderMetaData extends ProviderMeta {
  desc: string;
  clsType: any;
  defaultConfigTemplate: Record<string, unknown> | null;
  providerDisplayName: string | null;
}

// 联合类型
export type AnyProvider = Provider | STTProvider | TTSProvider | EmbeddingProvider | RerankProvider;
```

#### STTProvider（语音转文本）

```typescript
// src/provider/stt-provider.ts

export abstract class STTProvider {
  providerConfig: Record<string, unknown>;

  abstract getText(audioUrl: string): Promise<string>;

  async test(): Promise<void> {
    // 使用样例音频测试
  }
}
```

#### TTSProvider（文本转语音）

```typescript
// src/provider/tts-provider.ts

export abstract class TTSProvider {
  providerConfig: Record<string, unknown>;

  supportStream(): boolean { return false; }

  abstract getAudio(text: string): Promise<string>;  // 返回音频文件路径

  async getAudioStream?(textQueue: AsyncQueue<string>, audioQueue: AsyncQueue<string>): Promise<void>;
}
```

#### EmbeddingProvider（向量嵌入）

```typescript
// src/provider/embedding-provider.ts

export abstract class EmbeddingProvider {
  providerConfig: Record<string, unknown>;

  abstract getEmbedding(text: string): Promise<number[]>;
  abstract getEmbeddings(texts: string[]): Promise<number[][]>;
  abstract getDim(): number;

  async getEmbeddingsBatch(
    texts: string[],
    batchSize?: number,
    tasksLimit?: number,
    maxRetries?: number,
    progressCallback?: (done: number, total: number) => void,
  ): Promise<number[][]> {
    // 分批并发获取向量，带信号量限制、指数退避重试、进度回调
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize ?? 16) {
      const batch = texts.slice(i, i + batchSize ?? 16);
      const batchResults = await Promise.all(batch.map(t => this.getEmbedding(t)));
      results.push(...batchResults);
      progressCallback?.(Math.min(i + batchSize ?? 16, texts.length), texts.length);
    }
    return results;
  }
}
```

#### RerankProvider（重排序）

```typescript
// src/provider/rerank-provider.ts

export interface RerankResult {
  index: number;
  relevanceScore: number;
  document: { text: string };
}

export abstract class RerankProvider {
  providerConfig: Record<string, unknown>;

  abstract rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]>;
}
```

### 15.2 ProviderManager 完整接口

```typescript
// src/provider/manager.ts

export class ProviderManager {
  providerInsts: Provider[] = [];
  sttInsts: STTProvider[] = [];
  ttsInsts: TTSProvider[] = [];
  embeddingInsts: EmbeddingProvider[] = [];
  rerankInsts: RerankProvider[] = [];
  instMap: Map<string, AnyProvider> = new Map();  // providerId -> 实例

  setProviderChangeCallback(cb: (providerId: string, providerType: ProviderType, umo: string) => void): void;
  registerProviderChangeHook(hook: Function): void;

  async setProvider(providerId: string, providerType: ProviderType, umo: string): Promise<void>;
  async getProviderById(providerId: string): Promise<AnyProvider | null>;

  /** 获取当前使用的 Provider，按优先级：会话绑定 > 默认配置 > 第一个实例 */
  getUsingProvider(providerType: ProviderType, umo?: string): AnyProvider | null;

  async initialize(): Promise<void>;             // 初始化所有 Provider + 启动 MCP
  dynamicImportProvider(type: string): any;       // 动态导入适配器
  getMergedProviderConfig(providerConfig: Record<string, unknown>): Record<string, unknown>;
  getProviderConfigById(providerId: string, merged?: boolean): Record<string, unknown> | null;

  async loadProvider(providerConfig: Record<string, unknown>): Promise<void>;
  async reloadProvider(providerConfig: Record<string, unknown>): Promise<void>;
  async terminateProvider(providerId: string): Promise<void>;
  async deleteProvider(providerId: string, providerSourceId: string): Promise<void>;
  async updateProvider(originProviderId: string, newConfig: Record<string, unknown>): Promise<void>;
  async createProvider(newConfig: Record<string, unknown>): Promise<void>;
  async terminate(): Promise<void>;              // 终止所有 Provider 和 MCP
}
```

**Provider 选择流程**（`getUsingProvider`）：
1. 如果传入 `umo`，先从 session storage 查找该会话绑定的 provider
2. 否则从配置中读取 `defaultProviderId`
3. 找不到则回退到 `providerInsts[0]`

### 15.3 插件/Star 系统

文档第 6 章阶段代码中引用了 `PluginManager`、`StarHandlerMetadata`、`EventType` 等类型，但未独立定义。

#### EventType 枚举

```typescript
// src/plugin/event-type.ts

export enum EventType {
  OnLoadedEvent,               // 系统加载完成
  OnPlatformLoadedEvent,       // 平台加载完成
  AdapterMessageEvent,         // 适配器消息事件
  OnWaitingLLMRequestEvent,    // 等待 LLM 请求
  OnLLMRequestEvent,           // LLM 请求即将发出
  OnLLMResponseEvent,          // LLM 响应返回
  OnAgentBeginEvent,           // Agent 开始运行
  OnAgentDoneEvent,            // Agent 运行完成
  OnDecoratingResultEvent,     // 结果装饰阶段
  OnCallingFuncToolEvent,      // 调用函数工具
  OnUsingLLMToolEvent,         // 使用 LLM 工具
  OnLLMToolRespondEvent,       // LLM 工具返回结果
  OnAfterMessageSentEvent,     // 消息发送后
  OnPluginErrorEvent,          // 插件错误
  OnPluginLoadedEvent,         // 插件加载完成
  OnPluginUnloadedEvent,       // 插件卸载完成
}
```

#### StarHandlerMetadata

```typescript
// src/plugin/handler.ts

export interface StarHandlerMetadata {
  eventType: EventType;
  handlerFullName: string;       // "module_path.handler_name"
  handlerName: string;
  handlerModulePath: string;
  handler: (event: MessageEvent, ...args: any[]) => any;
  eventFilters: HandlerFilter[];
  desc: string;
  extrasConfigs: Record<string, unknown>;
  enabled: boolean;
}
```

#### StarHandlerRegistry

```typescript
// src/plugin/registry.ts

export class StarHandlerRegistry {
  private handlers: StarHandlerMetadata[] = [];

  /** 按 eventType 获取处理器，支持仅激活过滤和插件名过滤 */
  getHandlersByEventType(
    eventType: EventType,
    onlyActivated?: boolean,
    pluginsName?: string[],
  ): StarHandlerMetadata[];

  getHandlerByFullName(fullName: string): StarHandlerMetadata | null;
  getHandlersByModuleName(moduleName: string): StarHandlerMetadata[];

  /** 追加处理器（按优先级排序插入） */
  append(handler: StarHandlerMetadata): void;
}
```

#### Handler Filter 体系

```typescript
// src/plugin/filter.ts

export abstract class HandlerFilter {
  abstract filter(event: MessageEvent, cfg: Record<string, unknown>): boolean;
}

// 指令过滤器（支持 GreedyStr、参数类型校验、别名、自定义过滤器链）
export class CommandFilter extends HandlerFilter { /* ... */ }

// 指令组过滤器（支持嵌套子指令/子指令组）
export class CommandGroupFilter extends HandlerFilter { /* ... */ }

// 正则过滤器（不受 wakePrefix 制约）
export class RegexFilter extends HandlerFilter { /* ... */ }

// 消息类型过滤器
export enum EventMessageType { GROUP_MESSAGE, PRIVATE_MESSAGE, OTHER_MESSAGE, ALL }
export class EventMessageTypeFilter extends HandlerFilter { /* ... */ }

// 平台适配器过滤器
export class PlatformAdapterTypeFilter extends HandlerFilter { /* ... */ }

// 自定义过滤器（支持 & | 组合）
export class CustomFilter extends HandlerFilter { /* ... */ }
export class CustomFilterOr extends CustomFilter { /* ... */ }
export class CustomFilterAnd extends CustomFilter { /* ... */ }
```

#### PluginManager

```typescript
// src/plugin/manager.ts

export interface StarMetadata {
  name: string;
  author: string;
  desc: string;
  shortDesc: string;
  version: string;
  repo: string;
  modulePath: string;
  activated: boolean;
  config: Record<string, unknown>;
  handlerFullNames: string[];
  displayName: string;
  logoPath: string;
  supportPlatforms: string[];
}

export class PluginManager {
  private starRegistry: StarMetadata[] = [];
  private starMap: Map<string, StarMetadata> = new Map();
  private handlerRegistry: StarHandlerRegistry;

  getHandlerRegistry(): StarHandlerRegistry;
  getStarByModulePath(modulePath: string): StarMetadata | null;
  getAllStars(): StarMetadata[];

  async activateStar(modulePath: string): Promise<void>;
  async deactivateStar(modulePath: string): Promise<void>;
  async reloadStar(modulePath: string): Promise<void>;
}
```

#### Context（暴露给插件的接口）

```typescript
// src/plugin/context.ts

export class PluginContext {
  private providerManager: ProviderManager;
  private toolManager: FunctionToolManager;
  private conversationManager: ConversationManager;
  private eventQueue: AsyncQueue<MessageEvent>;

  // LLM 调用
  async llmGenerate(options: {
    chatProviderId?: string;
    prompt: string;
    imageUrls?: string[];
    audioUrls?: string[];
    tools?: ToolSet;
    systemPrompt?: string;
    contexts?: Message[];
  }): Promise<LLMResponse>;   // 不自动执行工具调用

  async toolLoopAgent(options: {
    event: MessageEvent;
    chatProviderId?: string;
    prompt: string;
    imageUrls?: string[];
    audioUrls?: string[];
    tools?: ToolSet;
    systemPrompt?: string;
    contexts?: Message[];
    maxSteps?: number;
    toolCallTimeout?: number;
  }): Promise<LLMResponse>;   // 运行 Agent 循环（允许 LLM 迭代调用工具）

  // Provider 获取
  getUsingProvider(umo: string): Provider | null;
  getUsingTtsProvider(umo: string): TTSProvider | null;
  getUsingSttProvider(umo: string): STTProvider | null;
  getProviderById(providerId: string): AnyProvider | null;
  getAllProviders(): Provider[];
  getAllTtsProviders(): TTSProvider[];
  getAllSttProviders(): STTProvider[];
  getAllEmbeddingProviders(): EmbeddingProvider[];

  // 工具管理
  getLlmToolManager(): FunctionToolManager;
  activateLlmTool(name: string): void;
  deactivateLlmTool(name: string): void;
  addLlmTools(...tools: FunctionTool[]): void;

  // 消息发送
  async sendMessage(session: MessageSession, components: MessageComponent[]): Promise<void>;

  // 配置
  getConfig(umo: string): Record<string, unknown>;
  getEventQueue(): AsyncQueue<MessageEvent>;
}
```

### 15.4 callHandler / callEventHook 工具函数

文档第 6 章阶段代码中引用了这两个函数，但未给出实现。

```typescript
// src/pipeline/handler-utils.ts

/** 执行插件 handler 并处理返回值 */
export async function* callHandler(
  event: MessageEvent,
  handler: StarHandlerMetadata,
  ...args: any[]
): AsyncGenerator<any> {
  try {
    const result = handler.handler(event, ...args);
    if (isAsyncGenerator(result)) {
      let yielded = false;
      for await (const val of result) {
        yielded = true;
        if (val instanceof EventResult) {
          event.setResult(val);
        }
        yield val;
      }
      if (!yielded) yield undefined;  // 确保管道继续
    } else {
      const val = await result;
      if (val instanceof EventResult) {
        event.setResult(val);
      }
      yield val;
    }
  } catch (e) {
    if (e instanceof TypeError) {
      console.error(`Handler ${handler.handlerFullName} TypeError: ${e}`);
    }
    throw e;
  }
}

/** 调用指定类型的所有事件钩子 handler，返回是否终止了事件 */
export async function callEventHook(
  event: MessageEvent,
  hookType: EventType,
  ...args: any[]
): Promise<boolean> {
  const handlers = starHandlerRegistry.getHandlersByEventType(hookType, true);
  for (const handler of handlers) {
    for await (const _ of callHandler(event, handler, ...args)) {
      if (event.isStopped()) return true;
    }
  }
  return false;
}
```

### 15.5 MainAgentHooks（Agent 生命周期钩子实现）

文档第 7 章仅描述了 Agent 调用流程，缺少将 Agent 钩子桥接到管线事件系统的实现。

```typescript
// src/pipeline/agent-hooks.ts

import { BaseAgentRunHooks, ContextWrapper, LLMResponse } from "../agent/index.js";
import { callEventHook } from "./handler-utils.js";
import { EventType } from "../plugin/event-type.js";

export class MainAgentHooks extends BaseAgentRunHooks<MessageEvent> {
  async onAgentBegin(runContext: ContextWrapper<MessageEvent>): Promise<void> {
    await callEventHook(runContext.context, EventType.OnAgentBeginEvent);
  }

  async onAgentDone(
    runContext: ContextWrapper<MessageEvent>,
    llmResponse: LLMResponse,
  ): Promise<void> {
    // 保存 reasoning_content 到 event extras
    if (llmResponse.reasoningContent) {
      runContext.context.setExtra("reasoning_content", llmResponse.reasoningContent);
    }
    // 触发 OnLLMResponseEvent + OnAgentDoneEvent
    await callEventHook(runContext.context, EventType.OnLLMResponseEvent, llmResponse);
    await callEventHook(runContext.context, EventType.OnAgentDoneEvent, llmResponse);
  }

  async onToolStart(
    runContext: ContextWrapper<MessageEvent>,
    tool: FunctionTool,
    toolArgs: Record<string, unknown>,
  ): Promise<void> {
    await callEventHook(runContext.context, EventType.OnUsingLLMToolEvent, tool, toolArgs);
  }

  async onToolEnd(
    runContext: ContextWrapper<MessageEvent>,
    tool: FunctionTool,
    toolArgs: Record<string, unknown>,
    toolResult: any,
  ): Promise<void> {
    runContext.context.clearResult();
    await callEventHook(runContext.context, EventType.OnLLMToolRespondEvent, tool, toolArgs, toolResult);
  }
}

export const MAIN_AGENT_HOOKS = new MainAgentHooks();
```

### 15.6 PersonaManager 完整接口

文档第 7.2 节提到"注入 Persona"但未定义 PersonaManager。

```typescript
// src/persona/manager.ts

export interface Personality {
  prompt: string;
  name: string;
  beginDialogs: Message[];                    // 前置对话（user/assistant 交替）
  moodImitationDialogs: Message[];            // 情绪模仿对话
  tools: string[] | null;                     // null = 全部工具, [] = 无工具
  skills: string[] | null;
  customErrorMessage: string | null;
}

export interface PersonaFolder {
  id: string;
  name: string;
  parentId: string | null;
  description: string;
  sortOrder: number;
}

export class PersonaManager {
  private db: ConversationStore;
  private personas: Map<string, Personality> = new Map();
  private defaultPersona: Personality | null = null;

  async initialize(): Promise<void>;

  async getPersona(personaId: string): Promise<Personality | null>;

  /** 获取会话默认 Persona，考虑会话绑定和平台覆盖 */
  async getDefaultPersona(umo: string): Promise<Personality | null>;

  /** 解析最终使用的 Persona */
  async resolveSelectedPersona(options: {
    umo: string;
    conversationPersonaId?: string;
    platformName: string;
    providerSettings: Record<string, unknown>;
  }): Promise<{
    personaId: string | null;
    persona: Personality | null;
    prompt: string | null;
    useWebchatSpecialDefault: boolean;
  }>;

  async createPersona(options: {
    personaId: string;
    systemPrompt?: string;
    beginDialogs?: Message[];
    tools?: string[] | null;
    skills?: string[] | null;
    customErrorMessage?: string | null;
    folderId?: string;
    sortOrder?: number;
  }): Promise<Personality>;

  async updatePersona(personaId: string, updates: Partial<Personality>): Promise<Personality | null>;
  async deletePersona(personaId: string): Promise<void>;
  async getAllPersonas(): Promise<Personality[]>;

  // 文件夹管理
  async createFolder(name: string, parentId?: string, description?: string): Promise<PersonaFolder>;
  async getFolders(parentId?: string): Promise<PersonaFolder[]>;
  async deleteFolder(folderId: string): Promise<void>;
  async movePersonaToFolder(personaId: string, folderId: string): Promise<void>;
}
```

### 15.7 ConfigManager 完整接口

文档第 4 章和第 14.5 节引用了 `ConfigManager` 但未定义。

```typescript
// src/config/manager.ts

export interface AgentConfig {
  id: string;
  name: string;

  // 唤醒配置
  wakePrefix: string;
  friendMessageNeedsWakePrefix: boolean;
  uniqueSession: boolean;

  // 白名单
  whitelistEnabled: boolean;
  whitelist: string[];
  whitelistAdminExempt: boolean;

  // 限流
  rateLimitEnabled: boolean;
  rateLimitMaxRequests: number;
  rateLimitWindowSeconds: number;
  rateLimitStrategy: "STALL" | "DISCARD";

  // 内容安全
  safetyKeywords: string[];
  safetyCheckResponse: boolean;

  // 预处理
  emojiReact: boolean;
  pathMappings: [string, string][];
  sttEnabled: boolean;

  // Agent
  streamingResponse: boolean;
  maxStep: number;
  maxContextLength: number;
  toolCallTimeout: number;
  toolSchemaMode: "full" | "skills_like";

  // 结果装饰
  replyPrefix: string;
  replyWithMention: boolean;
  replyWithQuote: boolean;
  segmentedReply: boolean;
  onlyLlmResultSegmented: boolean;
  ttsEnabled: boolean;
  t2iEnabled: boolean;
  t2iThreshold: number;
  displayReasoningText: boolean;

  // Provider
  defaultProviderId: string;
  fallbackProviderIds: string[];

  // Persona
  defaultPersonaId: string;

  // 上下文压缩
  llmCompressInstruction: string;
  llmCompressKeepRecent: number;
  enforceMaxTurns: number;
  truncateTurns: number;
}

export interface ConfigInfo {
  id: string;
  config: AgentConfig;
}

export class ConfigManager {
  private configs: Map<string, AgentConfig> = new Map();
  private sessionConfigMap: Map<string, string> = new Map();  // umo -> configId

  /** 根据消息来源获取对应配置 */
  getConfInfo(umo: string): ConfigInfo;

  getAllConfigs(): AgentConfig[];
  getConfigById(id: string): AgentConfig | null;

  /** 绑定会话到配置 */
  bindSession(umo: string, configId: string): void;
  unbindSession(umo: string): void;
}
```

### 15.8 异常体系

```typescript
// src/common/errors.ts

export class AgentSystemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSystemError";
  }
}

export class ProviderNotFoundError extends AgentSystemError {
  constructor(providerId?: string) {
    super(`Provider not found${providerId ? `: ${providerId}` : ""}`);
    this.name = "ProviderNotFoundError";
  }
}

export class EmptyModelOutputError extends AgentSystemError {
  constructor() {
    super("Model returned empty output");
    this.name = "EmptyModelOutputError";
  }
}

export class KnowledgeBaseUploadError extends AgentSystemError {
  stage: string;
  userMessage: string;
  details: Record<string, unknown>;

  constructor(options: { stage: string; userMessage: string; details?: Record<string, unknown> }) {
    super(`Knowledge base upload error at stage '${options.stage}': ${options.userMessage}`);
    this.name = "KnowledgeBaseUploadError";
    this.stage = options.stage;
    this.userMessage = options.userMessage;
    this.details = options.details ?? {};
  }
}
```

### 15.9 哨兵值 NOT_GIVEN

```typescript
// src/common/sentinel.ts

/** 用于区分"未提供参数"和"显式传 null" */
export const NOT_GIVEN: unique symbol = Symbol("NOT_GIVEN");
export type NotGiven = typeof NOT_GIVEN;
```

在 `PersonaManager.updatePersona` 等接口中，`tools`/`skills`/`customErrorMessage` 使用此值区分：
- `NOT_GIVEN`：未提供，不修改
- `null`：显式清空
- 具体值：更新为新值

### 15.10 TraceSpan（追踪系统）

```typescript
// src/common/trace.ts

export class TraceSpan {
  spanId: string;
  name: string;
  umo: string | null;
  senderName: string | null;
  messageOutline: string | null;
  startedAt: number;

  constructor(name: string, umo?: string, senderName?: string, messageOutline?: string) {
    this.spanId = generateId();
    this.name = name;
    this.umo = umo ?? null;
    this.senderName = senderName ?? null;
    this.messageOutline = messageOutline ?? null;
    this.startedAt = Date.now();
  }

  /** 记录追踪事件，受 traceEnable 配置控制 */
  record(action: string, fields?: Record<string, unknown>): void {
    if (!traceEnabled) return;
    console.debug(`[Trace:${this.spanId}] ${action}`, {
      span: this.name,
      umo: this.umo,
      sender: this.senderName,
      outline: this.messageOutline,
      ...fields,
      elapsed: Date.now() - this.startedAt,
    });
  }
}
```

### 15.11 KnowledgeBaseManager（知识库管理器）

文档第 7.2 节提到"注入知识库"但未定义 KnowledgeBaseManager。

```typescript
// src/knowledge-base/manager.ts

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  emoji: string;
  embeddingProviderId: string;
  rerankProviderId: string | null;
  chunkSize: number;
  chunkOverlap: number;
  topKDense: number;
  topKSparse: number;
  topMFinal: number;
}

export interface KBDocument {
  id: string;
  kbId: string;
  name: string;
  url: string;
  type: string;
}

export class KnowledgeBaseManager {
  private providerManager: ProviderManager;
  private kbInsts: Map<string, KBHelper> = new Map();

  async initialize(): Promise<void>;
  async loadKbs(): Promise<void>;

  async createKb(options: {
    kbName: string;
    description?: string;
    emoji?: string;
    embeddingProviderId: string;
    rerankProviderId?: string;
    chunkSize?: number;
    chunkOverlap?: number;
    topKDense?: number;
    topKSparse?: number;
    topMFinal?: number;
  }): Promise<KBHelper>;

  async getKb(kbId: string): KBHelper | null;
  async getKbByName(kbName: string): KBHelper | null;
  async deleteKb(kbId: string): Promise<boolean>;
  async listKbs(): Promise<KnowledgeBase[]>;

  /** 检索知识库，返回相关文本片段 */
  async retrieve(
    query: string,
    kbNames: string[],
    topKFusion?: number,
    topMFinal?: number,
  ): Promise<string | null>;

  async uploadFromUrl(kbId: string, url: string, options?: Record<string, unknown>): Promise<KBDocument>;
  async terminate(): Promise<void>;
}

/** 内部辅助类，封装单个知识库的检索逻辑 */
export class KBHelper {
  kb: KnowledgeBase;
  embeddingProvider: EmbeddingProvider;
  rerankProvider: RerankProvider | null;

  async search(query: string, topK?: number): Promise<string[]>;
}
```

### 15.12 第三方 Agent（暂不实现）

当前主 Agent + 子 Agent（SubAgent）配合已足够覆盖需求，第三方 Agent（Dify/Coze/DashScope/DeerFlow 等）暂不构建。如后续需要，可参考参考文档 15.21 节的 `ThirdPartyAgentSubStage` + `RunnerResultAggregator` + `startStreamWatchdog` 方案实现。

### 15.14 WakingCheckStage 补充：UNIQUE_SESSION_ID_BUILDERS

文档第 6 章阶段 1 的 uniqueSession 处理过于简化，缺少平台特定的会话 ID 构建逻辑。

```typescript
// src/pipeline/stages/waking-check.ts（补充）

/** 各平台的唯一会话 ID 构建函数 */
const UNIQUE_SESSION_ID_BUILDERS: Map<string, (event: MessageEvent) => string> = new Map([
  ["aiocqhttp", (e) => `${e.getSenderId()}_${e.getGroupId()}`],
  ["slack", (e) => `${e.getSenderId()}_${e.getGroupId()}`],
  ["dingtalk", (e) => `${e.getSenderId()}_${e.getGroupId()}`],
  ["qq_official", (e) => `${e.getSenderId()}_${e.getGroupId()}`],
  ["lark", (e) => `${e.getSenderId()}_${e.getGroupId()}`],
  ["telegram", (e) => `${e.getSenderId()}_${e.getGroupId()}`],
  ["webchat", (e) => e.getSenderId()],
  // 更多平台按需添加
]);

function buildUniqueSessionId(event: MessageEvent): string {
  const builder = UNIQUE_SESSION_ID_BUILDERS.get(event.getPlatformName());
  if (builder) return builder(event);
  // 默认：senderId_groupId
  return `${event.getSenderId()}_${event.getGroupId()}`;
}
```

### 15.15 Pipeline Bootstrap

文档第 5 章定义了 `registerStage` 但缺少内置 Stage 的自动注册机制。

```typescript
// src/pipeline/bootstrap.ts

/** 内置 Stage 模块路径 */
const BUILTIN_STAGE_MODULES: string[] = [
  "./stages/waking-check.js",
  "./stages/whitelist-check.js",
  "./stages/session-status-check.js",
  "./stages/rate-limit.js",
  "./stages/content-safety-check.js",
  "./stages/preprocess.js",
  "./stages/process.js",
  "./stages/result-decorate.js",
  "./stages/respond.js",
];

let builtinStagesRegistered = false;

/** 幂等函数，确保所有内置 Stage 模块被导入（触发 @registerStage 装饰器） */
export function ensureBuiltinStagesRegistered(): void {
  if (builtinStagesRegistered) return;
  for (const mod of BUILTIN_STAGE_MODULES) {
    try {
      require(mod);
    } catch (e) {
      console.error(`Failed to load builtin stage: ${mod}`, e);
    }
  }
  builtinStagesRegistered = true;
}
```

### 15.16 MediaUtils（媒体工具函数）

```typescript
// src/common/media.ts

/** 图片压缩默认参数 */
export const IMAGE_COMPRESS_DEFAULT_MAX_SIZE = 1280;
export const IMAGE_COMPRESS_DEFAULT_QUALITY = 95;
export const IMAGE_COMPRESS_DEFAULT_OPTIMIZE = true;
export const IMAGE_COMPRESS_DEFAULT_MIN_FILE_SIZE_MB = 1.0;

/** 获取媒体文件时长（毫秒） */
export async function getMediaDuration(filePath: string): Promise<number | null>;

/** 音频格式转换 */
export async function convertAudioToWav(audioPath: string, outputPath?: string): Promise<string>;
export async function convertAudioToOpus(audioPath: string, outputPath?: string): Promise<string>;
export async function convertAudioFormat(audioPath: string, outputFormat: string, outputPath?: string): Promise<string>;

/** 视频格式转换 */
export async function convertVideoFormat(videoPath: string, outputFormat: string, outputPath?: string): Promise<string>;

/** 智能检测格式并转 wav（含 silk 格式特殊处理） */
export async function ensureWav(audioPath: string, outputPath?: string): Promise<string>;

/** 提取视频封面 */
export async function extractVideoCover(videoPath: string, outputPath?: string): Promise<string>;

/** 压缩图片（跳过远程 URL，仅处理 base64/本地文件） */
export async function compressImage(
  urlOrPath: string,
  maxSize?: number,
  quality?: number,
): Promise<string>;
```

### 15.17 数据库层（ConversationStore 完整接口）

文档第 10.2 节仅定义了 Conversation 相关的 6 个方法，参考文档的 BaseDatabase 有约 60 个抽象方法。以下是按分类的完整接口：

```typescript
// src/conversation/store.ts

export abstract class ConversationStore {
  abstract initialize(): Promise<void>;

  // === 对话 ===
  abstract createConversation(conversation: Conversation): Promise<void>;
  abstract getConversationById(id: string): Promise<Conversation | null>;
  abstract getAllConversations(): Promise<Conversation[]>;
  abstract getFilteredConversations(options: {
    page?: number;
    pageSize?: number;
    platformIds?: string[];
    searchQuery?: string;
  }): Promise<[Conversation[], number]>;
  abstract updateConversation(id: string, updates: Partial<Conversation>): Promise<void>;
  abstract deleteConversation(id: string): Promise<void>;
  abstract deleteConversationsByUserId(userId: string): Promise<void>;

  // === 平台消息历史 ===
  abstract insertPlatformMessageHistory(record: PlatformMessageHistory): Promise<void>;
  abstract updatePlatformMessageHistory(id: string, updates: Partial<PlatformMessageHistory>): Promise<void>;
  abstract deletePlatformMessageHistory(id: string): Promise<void>;
  abstract getPlatformMessageHistory(options: {
    platformId: string;
    userId: string;
    limit?: number;
  }): Promise<PlatformMessageHistory[]>;

  // === WebChat 线程 ===
  abstract createWebchatThread(thread: WebchatThread): Promise<void>;
  abstract getWebchatThread(threadId: string): Promise<WebchatThread | null>;
  abstract deleteWebchatThread(threadId: string): Promise<void>;

  // === 附件 ===
  abstract insertAttachment(attachment: Attachment): Promise<void>;
  abstract getAttachment(id: string): Promise<Attachment | null>;
  abstract deleteAttachment(id: string): Promise<void>;

  // === API Key ===
  abstract createApiKey(key: ApiKey): Promise<void>;
  abstract listApiKeys(): Promise<ApiKey[]>;
  abstract getApiKey(key: string): Promise<ApiKey | null>;
  abstract touchApiKey(key: string): Promise<void>;
  abstract revokeApiKey(key: string): Promise<void>;
  abstract deleteApiKey(key: string): Promise<void>;

  // === Persona ===
  abstract insertPersona(persona: Personality): Promise<void>;
  abstract getPersona(personaId: string): Promise<Personality | null>;
  abstract updatePersona(personaId: string, updates: Partial<Personality>): Promise<void>;
  abstract deletePersona(personaId: string): Promise<void>;

  // === Persona 文件夹 ===
  abstract insertPersonaFolder(folder: PersonaFolder): Promise<void>;
  abstract getPersonaFolder(folderId: string): Promise<PersonaFolder | null>;
  abstract updatePersonaFolder(folderId: string, updates: Partial<PersonaFolder>): Promise<void>;
  abstract deletePersonaFolder(folderId: string): Promise<void>;
  abstract movePersonaToFolder(personaId: string, folderId: string): Promise<void>;
  abstract batchUpdateSortOrder(items: { id: string; sortOrder: number }[]): Promise<void>;

  // === 偏好 ===
  abstract insertOrUpdatePreference(preference: Preference): Promise<void>;
  abstract getPreference(key: string): Promise<Preference | null>;
  abstract removePreference(key: string): Promise<void>;
  abstract clearPreferences(namespace?: string): Promise<void>;

  // === 命令配置 ===
  abstract getCommandConfig(commandName: string): Promise<CommandConfig | null>;
  abstract upsertCommandConfig(config: CommandConfig): Promise<void>;
  abstract deleteCommandConfig(commandName: string): Promise<void>;

  // === 平台会话 ===
  abstract createPlatformSession(session: PlatformSession): Promise<void>;
  abstract getPlatformSession(sessionId: string): Promise<PlatformSession | null>;
  abstract updatePlatformSession(sessionId: string, updates: Partial<PlatformSession>): Promise<void>;
  abstract deletePlatformSession(sessionId: string): Promise<void>;

  // === 平台统计 ===
  abstract insertPlatformStats(stats: PlatformStats): Promise<void>;
  abstract countPlatformStats(options: Record<string, unknown>): Promise<number>;
  abstract getPlatformStats(options: Record<string, unknown>): Promise<PlatformStats[]>;

  // === Provider 统计 ===
  abstract insertProviderStat(stat: ProviderStat): Promise<void>;
}

// SQLite 实现
export class SQLiteDatabase extends ConversationStore {
  constructor(dbPath: string);
  async initialize(): Promise<void>;  // 创建所有表
}
```

### 15.18 内置工具注册机制

```typescript
// src/agent/builtin-tool-registry.ts

/** 内置工具配置条件规则 */
export interface BuiltinToolConfigCondition {
  key: string;                    // 配置键路径（点分隔）
  operator: "equals" | "in" | "truthy" | "custom";
  expected?: unknown;
  message: string;                // 不可用时的提示
  evaluate(config: Record<string, unknown>): boolean;
}

export interface BuiltinToolConfigRule {
  conditions: BuiltinToolConfigCondition[];
  evaluator?: (config: Record<string, unknown>) => boolean;
  evaluate(config: Record<string, unknown>): boolean;
}

/** @builtinTool 装饰器，标记内置工具类并注册配置规则 */
export function builtinTool(
  toolCls: typeof FunctionTool,
  config?: { [toolName: string]: BuiltinToolConfigRule },
): typeof FunctionTool;

/** 幂等，确保所有内置工具模块已导入 */
export function ensureBuiltinToolsLoaded(): void;
export function getBuiltinToolClass(name: string): typeof FunctionTool | null;
export function getBuiltinToolName(toolCls: typeof FunctionTool): string | null;
export function iterBuiltinToolClasses(): Iterable<typeof FunctionTool>;
export function getBuiltinToolConfigRule(name: string): BuiltinToolConfigRule | null;
export function getBuiltinToolConfigStatuses(
  toolName: string,
  configEntries: Record<string, unknown>[],
): Record<string, boolean>;
```

### 15.19 消息组件序列化协议

文档第 2.5 节定义了 `MessageComponent.toDict()` 但未统一序列化格式。

```typescript
// src/message/serialize.ts

/** 统一序列化格式：{ type: string, data: Record<string, unknown> } */
export interface SerializedComponent {
  type: string;
  data: Record<string, unknown>;
}

/** 类型名映射：ComponentType 枚举值 → 序列化 type 字符串 */
const COMPONENT_TYPE_TO_SERIAL: Record<ComponentType, string> = {
  [ComponentType.Plain]: "text",
  [ComponentType.Image]: "image",
  [ComponentType.Record]: "record",
  [ComponentType.Video]: "video",
  [ComponentType.File]: "file",
  [ComponentType.Face]: "face",
  [ComponentType.At]: "at",
  [ComponentType.AtAll]: "at_all",
  [ComponentType.Node]: "node",
  [ComponentType.Nodes]: "nodes",
  [ComponentType.Poke]: "poke",
  [ComponentType.Reply]: "reply",
  [ComponentType.Forward]: "forward",
  [ComponentType.Json]: "json",
  [ComponentType.Share]: "share",
  [ComponentType.Music]: "music",
  [ComponentType.Location]: "location",
  [ComponentType.Contact]: "contact",
  [ComponentType.Unknown]: "unknown",
};

/** 序列化注册表 */
const SERIAL_TO_COMPONENT: Map<string, (data: Record<string, unknown>) => MessageComponent> = new Map();

export function registerComponentSerializer(
  type: string,
  deserializer: (data: Record<string, unknown>) => MessageComponent,
): void;

export function serializeComponent(comp: MessageComponent): SerializedComponent;
export function deserializeComponent(serial: SerializedComponent): MessageComponent;
export function serializeComponents(comps: MessageComponent[]): SerializedComponent[];
export function deserializeComponents(serials: SerializedComponent[]): MessageComponent[];
```

### 15.20 平台消息转换规范

文档第 3 章定义了 `PlatformAdapter` 基类但未说明各平台原生消息如何映射到统一模型。

```typescript
// src/platform/conversion.ts

/**
 * 平台消息转换规范
 *
 * 各平台适配器在 commitEvent() 前必须将原生消息转换为 PlatformMessage。
 * 转换规则如下：
 *
 * 1. 文本消息 → PlainComponent
 *    平台纯文本 → { type: ComponentType.Plain, text: "..." }
 *
 * 2. 图片消息 → ImageComponent
 *    平台图片 URL → { type: ComponentType.Image, url: "..." }
 *    平台图片 base64 → { type: ComponentType.Image, file: "data:image/..." }
 *
 * 3. 语音消息 → RecordComponent
 *    平台语音 URL → { type: ComponentType.Record, url: "..." }
 *
 * 4. @消息 → AtComponent
 *    平台 @用户 → { type: ComponentType.At, qq: "userId" }
 *    平台 @全体 → { type: ComponentType.AtAll, qq: "all" }
 *
 * 5. 引用消息 → ReplyComponent
 *    平台引用 → { type: ComponentType.Reply, id: "messageId" }
 *
 * 6. 文件消息 → FileComponent
 *    平台文件 → { type: ComponentType.File, url: "...", name: "..." }
 *
 * 7. 不支持的消息类型 → PlainComponent（文本描述）
 *    → { type: ComponentType.Plain, text: "[不支持的消息类型: xxx]" }
 *
 * messageStr 提取规则：
 * - 拼接所有 PlainComponent.text，用空格分隔
 * - 去除 wakePrefix 前缀（由 WakingCheckStage 处理）
 * - AtComponent 转为 "@userId" 文本
 */

export abstract class MessageConverter<TPlatformMessage> {
  /** 将平台原生消息转换为 PlatformMessage */
  abstract convert(raw: TPlatformMessage, selfId: string): PlatformMessage;

  /** 从 PlatformMessage 提取纯文本消息字符串 */
  extractMessageStr(msg: PlatformMessage): string {
    const parts: string[] = [];
    for (const comp of msg.components) {
      switch (comp.type) {
        case ComponentType.Plain:
          parts.push((comp as PlainComponent).text);
          break;
        case ComponentType.At:
          parts.push(`@${(comp as AtComponent).qq}`);
          break;
        case ComponentType.AtAll:
          parts.push("@全体");
          break;
        default:
          break;
      }
    }
    return parts.join(" ").trim();
  }
}
```

### 15.21 SkillManager（技能管理器）

```typescript
// src/skill/manager.ts

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  active: boolean;
  sourceType: string;
  sourceLabel: string;
  localExists: boolean;
  sandboxExists: boolean;
  pluginName: string;
  readonly: boolean;
}

export class SkillManager {
  skillsRoot: string;
  pluginsRoot: string;

  listSkills(options: {
    activeOnly?: boolean;
    runtime?: string;
    showSandboxPath?: boolean;
  }): SkillInfo[];

  setSkillActive(name: string, active: boolean): void;
  deleteSkill(name: string): void;
  installSkillFromZip(zipPath: string, options?: {
    overwrite?: boolean;
    skillNameHint?: string;
  }): string;
}

/** 构建 LLM 系统提示中的技能部分 */
export function buildSkillsPrompt(skills: SkillInfo[]): string;
```

### 15.22 补充目录结构

在原文档第 12 章目录结构基础上，新增以下目录：

```
src/
├── ...（现有目录不变）
│
├── provider/                       # 新增：Provider 体系
│   ├── types.ts                    # ProviderType, ProviderMeta, ProviderMetaData
│   ├── stt-provider.ts             # STTProvider 抽象类
│   ├── tts-provider.ts             # TTSProvider 抽象类
│   ├── embedding-provider.ts       # EmbeddingProvider 抽象类
│   ├── rerank-provider.ts          # RerankProvider 抽象类
│   ├── manager.ts                  # ProviderManager
│   └── implementations/            # 各 Provider 实现
│       ├── openai.ts
│       ├── anthropic.ts
│       ├── ollama.ts
│       └── ...
│
├── plugin/                         # 新增：插件系统
│   ├── event-type.ts               # EventType 枚举
│   ├── handler.ts                  # StarHandlerMetadata
│   ├── registry.ts                 # StarHandlerRegistry
│   ├── filter.ts                   # HandlerFilter 体系
│   ├── manager.ts                  # PluginManager
│   └── context.ts                  # PluginContext
│
├── persona/                        # 新增：角色管理
│   └── manager.ts                  # PersonaManager
│
├── knowledge-base/                 # 新增：知识库
│   └── manager.ts                  # KnowledgeBaseManager
│
├── skill/                          # 新增：技能管理
│   └── manager.ts                  # SkillManager
│
├── config/                         # 新增：配置管理
│   └── manager.ts                  # ConfigManager + AgentConfig
│
├── common/                         # 扩展：通用工具
│   ├── async-queue.ts
│   ├── condition.ts
│   ├── id-generator.ts
│   ├── errors.ts                   # 异常体系
│   ├── sentinel.ts                 # NOT_GIVEN 哨兵值
│   ├── trace.ts                    # TraceSpan
│   └── media.ts                    # MediaUtils
│
├── message/                        # 扩展：消息模型
│   ├── types.ts
│   ├── components.ts
│   ├── platform-message.ts
│   ├── message-session.ts
│   ├── event.ts
│   ├── event-result.ts
│   └── serialize.ts                # 新增：序列化协议
│
├── platform/                       # 扩展：平台适配器
│   ├── adapter.ts
│   ├── metadata.ts
│   ├── conversion.ts               # 新增：消息转换规范
│   └── implementations/
│
├── pipeline/                       # 扩展：管线调度
│   ├── scheduler.ts
│   ├── stage.ts
│   ├── context.ts
│   ├── event-bus.ts
│   ├── active-event-registry.ts
│   ├── follow-up.ts
│   ├── session-lock.ts
│   ├── handler-utils.ts            # 新增：callHandler / callEventHook
│   ├── agent-hooks.ts              # 新增：MainAgentHooks
│   ├── bootstrap.ts                # 新增：Pipeline Bootstrap
│   └── stages/
│       ├── ...（现有阶段不变）
│
└── conversation/                   # 扩展：对话管理
    ├── manager.ts
    └── store.ts                    # 扩展：完整 ConversationStore 接口
```

### 15.23 补充类型定义

以下类型在文档中被引用但未独立定义，在此统一补充。

```typescript
// === Conversation 完整定义 ===
export interface Conversation {
  id: string;
  unifiedMsgOrigin: string;
  personaId: string | null;
  history: string;                    // JSON 序列化的 Message[]
  platformId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  tokenUsage: number | null;
}

// === AgentBuildResult ===
export interface AgentBuildResult {
  agentRunner: ToolLoopAgentRunner;
  providerRequest: ProviderRequest;
  provider: Provider;
}

// === FollowUpTicket ===
export interface FollowUpTicket {
  resolved: Promise<void>;
  consumed: boolean;
}

// === SessionServiceManager ===
export class SessionServiceManager {
  private disabledSessions: Set<string> = new Set();

  async isSessionEnabled(umo: string): Promise<boolean> {
    return !this.disabledSessions.has(umo);
  }

  disableSession(umo: string): void {
    this.disabledSessions.add(umo);
  }

  enableSession(umo: string): void {
    this.disabledSessions.delete(umo);
  }
}

// === Missing Component Types ===
export interface PokeComponent extends MessageComponent {
  type: ComponentType.Poke;
  id: number;
}

export interface MusicComponent extends MessageComponent {
  type: ComponentType.Music;
  url?: string;
  title?: string;
  content?: string;
  image?: string;
}

export interface ContactComponent extends MessageComponent {
  type: ComponentType.Contact;
  userId: string;
  nickname?: string;
}

// === ConversationStore referenced data types ===
export interface PlatformMessageHistory {
  id: string;
  platformId: string;
  userId: string;
  senderId: string;
  senderName: string;
  content: string;
  llmCheckpointId: string | null;
  createdAt: Date;
}

export interface WebchatThread {
  id: string;
  sessionId: string;
  title: string;
  createdAt: Date;
}

export interface Attachment {
  id: string;
  url: string;
  name: string;
  size: number;
  type: string;
  createdAt: Date;
}

export interface ApiKey {
  id: string;
  key: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revoked: boolean;
}

export interface Preference {
  key: string;
  value: string;
  namespace: string;
}

export interface CommandConfig {
  commandName: string;
  config: Record<string, unknown>;
}

export interface PlatformSession {
  id: string;
  platformId: string;
  sessionId: string;
  providerId: string | null;
  personaId: string | null;
  config: Record<string, unknown>;
}

export interface PlatformStats {
  id: string;
  platformId: string;
  eventType: string;
  timestamp: Date;
  metadata: Record<string, unknown>;
}

export interface ProviderStat {
  id: string;
  providerId: string;
  model: string;
  tokenUsage: number;
  timestamp: Date;
}
```
