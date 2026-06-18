# Agent System API Reference

> Version: 1.1.0 | TypeScript Implementation

> [!NOTE]
> **关于项目结构的说明**：
> 当前项目采用 **PNPM Workspaces 多包工作区 (Monorepo)** 架构进行开发与模块化解耦。
> 1. 本文档中所有以 `src/` 开头的源代码路径，在实际开发时均对应为 `packages/<package-name>/src/`（例如 `src/agent/index.ts` 对应 `packages/agent/src/index.ts`）。根目录 `src/` 仅为重导出代理。
> 2. 所有实际的业务逻辑、接口修改和功能迭代，均应在 `packages/` 下对应的子包目录中进行。

---

## 目录

- [1. Agent 核心](#1-agent-核心)
- [2. 消息模型](#2-消息模型)
- [3. 类型定义](#3-类型定义)
- [4. 工具系统](#4-工具系统)
- [5. 工具执行器](#5-工具执行器)
- [6. Handoff 交接](#6-handoff-交接)
- [7. MCP 协议](#7-mcp-协议)
- [8. 工具管理器](#8-工具管理器)
- [9. 子代理编排](#9-子代理编排)
- [10. 生命周期钩子](#10-生命周期钩子)
- [11. Agent Runner](#11-agent-runner)
- [12. Agent Builder](#12-agent-builder)
- [13. 上下文管理](#13-上下文管理)
- [14. Computer Tools](#14-computer-tools)
- [15. Web Tools](#15-web-tools)
- [16. Memory Tool](#16-memory-tool)
- [17. Code Search Tool](#17-code-search-tool)
- [18. 图片/音频工具](#18-图片音频工具)
- [19. 模态处理](#19-模态处理)
- [20. 动态子代理创建](#20-动态子代理创建)
- [21. 沙箱策略](#21-沙箱策略)
- [22. 协调层](#22-协调层)
- [23. ProviderManager](#23-providermanager)

---

## 1. Agent 核心

### `Agent<TContext>`

Agent 实例接口。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | `string` | 是 | Agent 名称标识 |
| `instructions` | `string` | 否 | 系统指令/提示词 |
| `tools` | `(string \| FunctionTool<TContext>)[]` | 否 | 可用工具列表 |
| `runHooks` | `BaseAgentRunHooks<TContext>` | 否 | 运行生命周期钩子 |
| `beginDialogs` | `unknown[]` | 否 | 初始对话上下文 |

### `createAgent<TContext>(options)`

创建 Agent 实例。

```typescript
function createAgent<TContext = unknown>(options: {
  name: string;
  instructions?: string;
  tools?: (string | FunctionTool<TContext>)[];
  runHooks?: BaseAgentRunHooks<TContext>;
  beginDialogs?: unknown[];
}): Agent<TContext>;
```

**示例：**

```typescript
const agent = createAgent({
  name: "weather-agent",
  instructions: "You are a weather assistant.",
  tools: ["get_weather"],
});
```

---

## 2. 消息模型

### `Message`

核心消息类型。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `role` | `"system" \| "user" \| "assistant" \| "tool" \| "_checkpoint"` | 是 | 消息角色 |
| `content` | `string \| ContentPart[] \| CheckpointData` | 否 | 消息内容 |
| `tool_calls` | `ToolCall[] \| Record<string, unknown>[]` | 否 | 工具调用列表 |
| `tool_call_id` | `string` | 否 | 工具调用 ID（role=tool 时） |
| `_noSave` | `boolean` | 否 | 标记不持久化 |
| `_checkpointAfter` | `CheckpointData` | 否 | 绑定检查点 |

### ContentPart 类型

| 类型 | 接口 | 关键字段 |
|---|---|---|
| 文本 | `TextPart` | `type: "text"`, `text: string` |
| 推理 | `ThinkPart` | `type: "think"`, `think: string`, `encrypted?: string` |
| 图片 | `ImageURLPart` | `type: "image_url"`, `image_url: { url: string; id?: string }` |
| 音频 | `AudioURLPart` | `type: "audio_url"`, `audio_url: { url: string; id?: string }` |

### `ToolCall`

| 字段 | 类型 | 必填 |
|---|---|---|
| `type` | `"function"` | 是 |
| `id` | `string` | 是 |
| `function` | `{ name: string; arguments?: string }` | 是 |
| `extraContent` | `Record<string, unknown>` | 否 |

### 消息工具函数

```typescript
// 验证消息对象
function validateMessage(data: Record<string, unknown>): Message;

// 序列化/反序列化
function serializeMessage(message: Message): Record<string, unknown>;
function serializeContentPart(part: ContentPart): Record<string, unknown>;
function deserializeContentPart(data: Record<string, unknown>): ContentPart;
function serializeToolCall(tc: ToolCall): Record<string, unknown>;

// ThinkPart 合并（流式拼接用）
function mergeThinkPartInPlace(target: ThinkPart, other: ThinkPart): boolean;

// 标记为临时（不持久化）
function markContentPartAsTemp<T extends ContentPart>(part: T): T;

// 检查点操作
function isCheckpointMessage(message: Message | Record<string, unknown>): boolean;
function getCheckpointId(message: Message | Record<string, unknown>): string | null;
function stripCheckpointMessages(history: Record<string, unknown>[]): Record<string, unknown>[];
function bindCheckpointMessages(history: Record<string, unknown>[]): Message[];
function dumpMessagesWithCheckpoints(messages: Message[]): Record<string, unknown>[];
```

### 类型守卫

```typescript
function isTextPart(part: ContentPart): part is TextPart;
function isThinkPart(part: ContentPart): part is ThinkPart;
function isImageURLPart(part: ContentPart): part is ImageURLPart;
function isAudioURLPart(part: ContentPart): part is AudioURLPart;
```

---

## 3. 类型定义

### `AgentState` 枚举

```typescript
enum AgentState {
  IDLE = "IDLE",
  RUNNING = "RUNNING",
  DONE = "DONE",
  ERROR = "ERROR",
}
```

### `ContextWrapper<TContext>`

运行时上下文包装器。

| 字段 | 类型 | 默认值 |
|---|---|---|
| `context` | `TContext` | - |
| `messages` | `Message[]` | `[]` |
| `toolCallTimeout` | `number` | `120` |

```typescript
function createContextWrapper<TContext = unknown>(
  context: TContext,
  options?: Partial<Pick<ContextWrapper<TContext>, "messages" | "toolCallTimeout">>
): ContextWrapper<TContext>;
```

### `LLMResponse`

| 字段 | 类型 | 必填 |
|---|---|---|
| `role` | `"assistant" \| "err"` | 是 |
| `completionText` | `string` | 否 |
| `reasoningContent` | `string` | 否 |
| `reasoningSignature` | `string` | 否 |
| `isChunk` | `boolean` | 是 |
| `usage` | `TokenUsage` | 否 |
| `toolsCallName` | `string[]` | 否 |
| `toolsCallArgs` | `Record<string, unknown>[]` | 否 |
| `toolsCallIds` | `string[]` | 否 |

### `Provider` 接口

```typescript
interface Provider {
  providerConfig: ProviderConfig;
  textChat(params: ProviderChatParams): Promise<LLMResponse>;
  textChatStream?(params: ProviderChatParams): AsyncGenerator<LLMResponse, void, unknown>;
}
```

### `CallToolResult`

```typescript
interface CallToolResult {
  content: (TextContent | ImageContent | EmbeddedResource)[];
  isError?: boolean;
}
```

### 其他工具函数

```typescript
function createAgentStats(): AgentStats;
function getStatsDuration(stats: AgentStats): number;
function createMessageChain(type: string, message?: string): MessageChain;
```

---

## 4. 工具系统

### `createFunctionTool<TContext>(options)`

创建函数工具。

```typescript
function createFunctionTool<TContext = unknown>(options: {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  handler?: ToolHandler<TContext>;
  handlerModulePath?: string;
  active?: boolean;           // 默认 true
  isBackgroundTask?: boolean; // 默认 false
  call?: (context: ContextWrapper<TContext>, ...kwargs: unknown[]) => Promise<ToolExecResult>;
}): FunctionTool<TContext>;
```

**类型：**

```typescript
type ToolHandler<TContext = unknown> = (
  event: unknown,
  ...args: unknown[]
) => Promise<ToolExecResult | null> | AsyncGenerator<ToolExecResult | string | null, void, unknown>;

type ToolExecResult = string | CallToolResult;
```

**示例：**

```typescript
const weatherTool = createFunctionTool({
  name: "get_weather",
  description: "Get the current weather for a location",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "City name" },
    },
    required: ["location"],
  },
  async handler(_event, location) {
    return `Weather in ${location}: Sunny, 25°C`;
  },
});
```

### `ToolSet`

工具集合类。

```typescript
class ToolSet {
  constructor(tools?: FunctionTool[]);

  empty(): boolean;
  addTool(tool: FunctionTool): void;
  removeTool(name: string): void;
  getTool(name: string): FunctionTool | undefined;
  names(): string[];
  merge(other: ToolSet): void;
  getLightToolSet(): ToolSet;       // 仅 name+description
  getParamOnlyToolSet(): ToolSet;   // 仅 name+parameters
  openaiSchema(omitEmptyParameterField?: boolean): Record<string, unknown>[];
  anthropicSchema(): Record<string, unknown>[];
  googleSchema(): Record<string, unknown>;

  get length(): number;
  [Symbol.iterator](): Iterator<FunctionTool>;
}
```

---

## 5. 工具执行器

### `FunctionToolExecutor<TContext>`

根据工具类型分发执行。

```typescript
class FunctionToolExecutor<TContext = unknown> extends BaseFunctionToolExecutor<TContext> {
  execute(
    tool: FunctionTool<TContext>,
    runContext: ContextWrapper<TContext>,
    toolArgs: Record<string, unknown>
  ): AsyncGenerator<CallToolResult | null, void, unknown>;
}
```

**执行逻辑：**
- HandoffTool → 子代理委托
- MCPTool → MCP 协议调用
- 后台任务 → 立即返回 task_id
- 本地工具 → 执行 handler

### `backgroundTaskBus`

后台任务事件总线单例。

```typescript
const backgroundTaskBus: BackgroundTaskEventBus;
```

---

## 6. Handoff 交接

### `createHandoffTool<TContext>(agent, toolDescription?)`

创建子代理交接工具。

```typescript
function createHandoffTool<TContext = unknown>(
  agent: Agent<TContext>,
  toolDescription?: string
): FunctionTool<TContext> & { agent: Agent<TContext>; providerId: string | undefined };
```

**工具名：** `transfer_to_{agent.name}`

**参数：**

| 参数 | 类型 | 说明 |
|---|---|---|
| `input` | `string` | 输入文本 |
| `image_urls` | `string[]` | 可选图片引用 |
| `background_task` | `boolean` | 是否后台执行 |

**示例：**

```typescript
const handoff = createHandoffTool(agent, "Transfer to weather agent for weather queries");
// handoff.name → "transfer_to_weather-agent"
```

---

## 7. MCP 协议

### `MCPClient`

MCP 协议客户端。

```typescript
class MCPClient {
  session: MCPClientSession | null;
  name: string | null;
  active: boolean;        // 默认 true
  tools: MCPToolDefinition[];
  serverErrLogs: string[];

  async connectToServer(config: Record<string, unknown>, name: string): Promise<void>;
  async listToolsAndSave(): Promise<{ tools: MCPToolDefinition[] }>;
  async callToolWithReconnect(
    toolName: string,
    args: Record<string, unknown>,
    readTimeoutSeconds: number
  ): Promise<CallToolResult>;
  async close(): Promise<void>;
}
```

### `validateMcpStdioConfig(config)`

验证 Stdio MCP 配置安全性。

```typescript
function validateMcpStdioConfig(config: Record<string, unknown>): void;
```

**安全检查：** 命令白名单、危险命令拦截、内联代码标志拦截、Docker 参数安全检查。

### `createMCPTool<TContext>(mcpTool, mcpClient, mcpServerName)`

创建 MCP 工具实例。

```typescript
function createMCPTool<TContext = unknown>(
  mcpTool: MCPToolDefinition,
  mcpClient: MCPClient,
  mcpServerName: string
): MCPToolInstance<TContext>;
```

### `normalizeMcpInputSchema(schema)`

规范化非标准 MCP JSON Schema。

```typescript
function normalizeMcpInputSchema(schema: Record<string, unknown>): Record<string, unknown>;
```

---

## 8. 工具管理器

### `FunctionToolManager`

```typescript
class FunctionToolManager {
  constructor(options?: { initTimeout?: number; enableTimeout?: number });
  // 默认: initTimeout=180000, enableTimeout=180000

  // 属性
  funcList: FunctionTool[];
  builtinFuncList: Map<string, FunctionTool>;

  // 基础操作
  empty(): boolean;
  addFunc(name: string, funcArgs: Array<{ name: string; type: string; description?: string; [key: string]: unknown }>, desc: string, handler: ToolHandler): void;
  removeFunc(name: string): void;
  getFunc(name: string): FunctionTool | undefined;

  // 内置工具
  registerBuiltinTool(tool: FunctionTool): void;
  getBuiltinTool(nameOrClass: string | FunctionTool): FunctionTool;
  isBuiltinTool(name: string): boolean;
  iterBuiltinTools(): FunctionTool[];

  // 工具集
  getFullToolSet(): ToolSet;
  deactivateTool(name: string): boolean;
  activateTool(name: string): boolean;

  // MCP 管理
  get mcpClientDict(): ReadonlyMap<string, MCPClient>;
  async initMcpClients(mcpServerConfig: Record<string, Record<string, unknown>>, raiseOnAllFailed?: boolean): Promise<MCPInitSummary>;
  async startMcpServer(name: string, cfg: Record<string, unknown>): Promise<void>;
  async enableMcpServer(name: string, cfg: Record<string, unknown>): Promise<void>;
  async disableMcpServer(name?: string | null): Promise<void>;

  // Schema 生成
  getFuncDescOpenaiStyle(omitEmptyParameterField?: boolean): Record<string, unknown>[];
  getFuncDescAnthropicStyle(): Record<string, unknown>[];
  getFuncDescGoogleGenaiStyle(): Record<string, unknown>;
}
```

---

## 9. 子代理编排

### `SubAgentOrchestrator`

```typescript
class SubAgentOrchestrator {
  constructor(personaMgr?: PersonaManager);

  handoffs: HandoffTool[];
  setPersonaManager(mgr: PersonaManager): void;
  async reloadFromConfig(cfg: SubAgentOrchestratorConfig): Promise<void>;
}
```

### `SubAgentConfig`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | `string` | 是 | 子代理名称 |
| `enabled` | `boolean` | 否 | 是否启用 |
| `system_prompt` | `string` | 否 | 系统提示 |
| `public_description` | `string` | 否 | 公开描述 |
| `persona_id` | `string` | 否 | Persona ID |
| `provider_id` | `string` | 否 | Provider ID |
| `tools` | `string[] \| null` | 否 | 工具列表（null=全部） |

### `SubAgentOrchestratorConfig`

| 字段 | 类型 | 必填 |
|---|---|---|
| `main_enable` | `boolean` | 否 |
| `remove_main_duplicate_tools` | `boolean` | 否 |
| `router_system_prompt` | `string` | 否 |
| `agents` | `SubAgentConfig[]` | 否 |

---

## 10. 生命周期钩子

### `BaseAgentRunHooks<TContext>`

```typescript
interface BaseAgentRunHooks<TContext = unknown> {
  onAgentBegin(runContext: ContextWrapper<TContext>): Promise<void>;
  onToolStart(runContext: ContextWrapper<TContext>, tool: FunctionTool, toolArgs: Record<string, unknown> | null): Promise<void>;
  onToolEnd(runContext: ContextWrapper<TContext>, tool: FunctionTool, toolArgs: Record<string, unknown> | null, toolResult: CallToolResult | null): Promise<void>;
  onAgentDone(runContext: ContextWrapper<TContext>, llmResponse: LLMResponse): Promise<void>;
}
```

### `EmptyAgentHooks<TContext>`

所有方法为空实现的默认钩子。

```typescript
class EmptyAgentHooks<TContext = unknown> implements BaseAgentRunHooks<TContext> { }
```

---

## 11. Agent Runner

### `ToolLoopAgentRunner<TContext>`

核心 ReAct 循环运行器。

```typescript
class ToolLoopAgentRunner<TContext = unknown> extends BaseAgentRunner<TContext> {
  async reset(
    runContext: ContextWrapper<TContext>,
    agentHooks: BaseAgentRunHooks<TContext>,
    ...args: unknown[]
  ): Promise<void>;

  async *step(): AsyncGenerator<AgentResponse, void, unknown>;
  async *stepUntilDone(maxStep: number): AsyncGenerator<AgentResponse, void, unknown>;
  done(): boolean;
  getFinalLlmResp(): LLMResponse | null;
  requestStop(): void;
  wasAborted(): boolean;
  followUp(messageText: string): FollowUpTicket | null;
}
```

### `runAgent<TContext>(agentRunner, options?)`

高层 Agent 运行函数。

```typescript
function runAgent<TContext = unknown>(
  agentRunner: ToolLoopAgentRunner<TContext>,
  options?: RunAgentOptions
): Promise<RunAgentResult>;
```

**`RunAgentOptions`：**

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `maxStep` | `number` | `30` | 最大步数 |
| `showToolUse` | `boolean` | `true` | 显示工具使用 |
| `showToolCallResult` | `boolean` | `false` | 显示工具调用结果 |
| `streamToGeneral` | `boolean` | `false` | 流式输出 |
| `showReasoning` | `boolean` | `false` | 显示推理过程 |
| `shouldStop` | `() => boolean` | - | 停止信号回调 |
| `onToolCall` | `(info: { id: string; name: string; args: Record<string, unknown> }) => void` | - | 工具调用回调 |
| `onToolResult` | `(info: { id: string; name: string; result: string }) => void` | - | 工具结果回调 |
| `onStreamingDelta` | `(chain: MessageChain) => void` | - | 流式增量回调 |
| `onLlmResult` | `(chain: MessageChain) => void` | - | LLM 结果回调 |
| `onError` | `(error: string) => void` | - | 错误回调 |

**`RunAgentResult`：**

| 字段 | 类型 |
|---|---|
| `finalResponse` | `LLMResponse \| null` |
| `steps` | `number` |
| `wasAborted` | `boolean` |
| `chains` | `MessageChain[]` |

### `runLiveAgent<TContext>(agentRunner, options?)`

实时模式运行器（支持 TTS）。

```typescript
function runLiveAgent<TContext = unknown>(
  agentRunner: ToolLoopAgentRunner<TContext>,
  options?: RunAgentOptions
): AsyncGenerator<{ type: "text" | "audio"; text: string; audio?: Buffer }, void, unknown>;
```

---

## 12. Agent Builder

### `buildMainAgent<TContext>(options)`

构建主 Agent，一站式初始化。

```typescript
function buildMainAgent<TContext = unknown>(options: {
  provider: Provider;
  request: ProviderRequest;
  config?: MainAgentBuildConfig;
  toolManager?: FunctionToolManager;
  subagentOrchestrator?: SubAgentOrchestrator;
  agentHooks?: BaseAgentRunHooks<TContext>;
  toolExecutor?: FunctionToolExecutor;
  fallbackProviders?: Provider[];
  context?: TContext;
}): Promise<MainAgentBuildResult<TContext>>;
```

**`MainAgentBuildConfig`：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `toolCallTimeout` | `number` | 工具调用超时（秒） |
| `toolSchemaMode` | `"full" \| "skills_like"` | 工具 Schema 模式 |
| `streamingResponse` | `boolean` | 是否流式响应 |
| `sanitizeContextByModalities` | `boolean` | 按模态清理上下文 |
| `contextLimitReachedStrategy` | `"truncate_by_turns" \| "llm_compress"` | 上下文超限策略 |
| `llmCompressInstruction` | `string` | LLM 压缩指令 |
| `llmCompressKeepRecent` | `number` | 压缩保留最近消息数 |
| `llmCompressProviderId` | `string` | 压缩用 Provider ID |
| `maxContextLength` | `number` | 最大上下文长度 |
| `fallbackMaxContextTokens` | `number` | 回退最大上下文 Token 数 |
| `llmSafetyMode` | `boolean` | 安全模式开关 |
| `safetyModeStrategy` | `"system_prompt"` | 安全模式策略 |
| `subagentOrchestrator` | `Record<string, unknown>` | 子代理编排配置 |
| `fallbackProviderIds` | `string[]` | 回退 Provider ID 列表 |
| `toolResultOverflowDir` | `string` | 工具结果溢出目录 |
| `readTool` | `FunctionTool` | 自定义读取工具 |

**`MainAgentBuildResult`：**

| 字段 | 类型 |
|---|---|
| `agentRunner` | `ToolLoopAgentRunner<TContext>` |
| `providerRequest` | `ProviderRequest` |
| `provider` | `Provider` |

---

## 13. 上下文管理

### `ContextManager`

```typescript
class ContextManager {
  constructor(config: ContextConfig);
  async process(messages: Message[], trustedTokenUsage?: number): Promise<Message[]>;
}
```

### `ContextTruncator`

```typescript
class ContextTruncator {
  fixMessages(messages: Message[]): Message[];
  truncateByTurns(messages: Message[], keepMostRecentTurns: number, dropTurns?: number): Message[];
  truncateByDroppingOldestTurns(messages: Message[], dropTurns?: number): Message[];
  truncateByHalving(messages: Message[]): Message[];
}
```

### `EstimateTokenCounter`

```typescript
class EstimateTokenCounter implements TokenCounter {
  countTokens(messages: Message[], trustedTokenUsage?: number): number;
}
// 估算规则: 中文 0.6 token/字, 英文 0.3 token/字, 图片 765, 音频 500
```

### `TruncateByTurnsCompressor`

```typescript
class TruncateByTurnsCompressor implements ContextCompressor {
  constructor(truncateTurns?: number, compressionThreshold?: number);
  // 默认: truncateTurns=1, compressionThreshold=0.82
  shouldCompress(_messages: Message[], currentTokens: number, maxTokens: number): boolean;
  async compress(messages: Message[]): Promise<Message[]>;
}
```

### `LLMSummaryCompressor`

```typescript
class LLMSummaryCompressor implements ContextCompressor {
  constructor(provider: Provider, keepRecent?: number, instructionText?: string, compressionThreshold?: number);
  // 默认: keepRecent=4, compressionThreshold=0.82
  shouldCompress(_messages: Message[], currentTokens: number, maxTokens: number): boolean;
  async compress(messages: Message[]): Promise<Message[]>;
}
```

### `createContextConfig(overrides?)`

```typescript
function createContextConfig(overrides?: Partial<ContextConfig>): ContextConfig;
// 默认值: maxContextTokens=0, enforceMaxTurns=-1, truncateTurns=1, llmCompressKeepRecent=0
```

### `splitHistory(messages, keepRecent)`

```typescript
function splitHistory(messages: Message[], keepRecent: number): [Message[], Message[], Message[]];
// 返回: [systemMessages, messagesToSummarize, recentMessages]
```

---

## 14. Computer Tools

### `ComputerToolContext`

```typescript
interface ComputerToolContext {
  event?: { unifiedMsgOrigin?: string };
  providerSettings?: {
    computer_use_runtime?: "local" | "sandbox";
  };
}
```

### `ComputerRuntime`

```typescript
type ComputerRuntime = "local" | "sandbox";
```

### 工具创建函数

| 函数 | 工具名 | 说明 | 适用运行时 |
|---|---|---|---|
| `createFileReadTool(workspaceRoot?)` | `file_read_tool` | 读取文件，支持 offset/limit | local + sandbox |
| `createFileWriteTool(workspaceRoot?)` | `file_write_tool` | 写入文件，自动创建父目录 | local + sandbox |
| `createFileEditTool(workspaceRoot?)` | `file_edit_tool` | 编辑文件（替换字符串），支持 replace_all | local + sandbox |
| `createListDirTool(workspaceRoot?)` | `list_dir_tool` | 列出目录内容，支持递归和深度限制 | local + sandbox |
| `createFileDeleteTool(workspaceRoot?)` | `file_delete_tool` | 删除文件（不允许删目录） | local + sandbox |
| `createFileMoveTool(workspaceRoot?)` | `file_move_tool` | 移动/重命名文件或目录 | local + sandbox |
| `createGrepTool(workspaceRoot?)` | `grep_tool` | 正则搜索文件内容，支持 glob/上下文行 | local + sandbox |
| `createShellTool(workspaceRoot?)` | `execute_shell` | 执行 Shell 命令，支持后台/超时/环境变量 | local + sandbox |
| `createLocalPythonTool(workspaceRoot?)` | `execute_python` | 执行 Python 代码 | 仅 local |
| `createLocalNodeTool(workspaceRoot?)` | `execute_node` | 执行 JavaScript 代码 | 仅 local |

### `getRuntimeComputerTools(runtime, workspaceRoot?)`

获取指定运行时的完整工具集。

```typescript
function getRuntimeComputerTools(
  runtime: ComputerRuntime,
  workspaceRoot?: string
): FunctionTool<ComputerToolContext>[];
```

**local 运行时返回：** file_read, file_write, file_edit, list_dir, file_delete, file_move, grep, shell, python, node

**sandbox 运行时返回：** file_read, file_write, file_edit, list_dir, file_delete, file_move, grep, shell

### 各工具参数详情

#### `file_read_tool`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | `string` | 是 | 文件路径 |
| `offset` | `integer` | 否 | 行偏移（0-based） |
| `limit` | `integer` | 否 | 最大行数 |

#### `file_write_tool`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | `string` | 是 | 文件路径 |
| `content` | `string` | 是 | 写入内容 |

#### `file_edit_tool`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | `string` | 是 | 文件路径 |
| `old_string` | `string` | 是 | 要替换的文本 |
| `new_string` | `string` | 是 | 替换后的文本 |
| `replace_all` | `boolean` | 否 | 全局替换，默认 false |

#### `list_dir_tool`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | `string` | 否 | 目录路径，默认工作区根目录 |
| `recursive` | `boolean` | 否 | 递归列出，默认 false |
| `max_depth` | `integer` | 否 | 最大递归深度，默认 3 |

#### `file_delete_tool`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | `string` | 是 | 要删除的文件路径 |

#### `file_move_tool`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `source` | `string` | 是 | 源路径 |
| `destination` | `string` | 是 | 目标路径 |

#### `grep_tool`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pattern` | `string` | 是 | 正则表达式 |
| `path` | `string` | 否 | 搜索路径，默认工作区根目录 |
| `glob` | `string` | 否 | 文件过滤（如 `*.ts`） |
| `context_lines` | `integer` | 否 | 上下文行数，默认 2 |
| `result_limit` | `integer` | 否 | 最大结果数，默认 50 |

#### `execute_shell`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `command` | `string` | 是 | Shell 命令 |
| `background` | `boolean` | 否 | 后台运行，默认 false |
| `timeout` | `integer` | 否 | 超时秒数，默认 300 |
| `env` | `object` | 否 | 环境变量 |

#### `execute_python`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `code` | `string` | 是 | Python 代码 |
| `silent` | `boolean` | 否 | 静默模式，默认 false |
| `timeout` | `integer` | 否 | 超时秒数，默认 30 |

#### `execute_node`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `code` | `string` | 是 | JavaScript 代码 |
| `silent` | `boolean` | 否 | 静默模式，默认 false |
| `timeout` | `integer` | 否 | 超时秒数，默认 30 |

---

## 15. Web Tools

### `WebToolContext`

```typescript
interface WebToolContext {
  event?: { unifiedMsgOrigin?: string };
  providerSettings?: {
    web_search_api_url?: string;
    web_search_api_key?: string;
  };
}
```

### `SearchEngine`

```typescript
type SearchEngine = "bing" | "google" | "duckduckgo";
```

### `WebSearchProvider`

```typescript
interface WebSearchProvider {
  search(query: string, maxResults: number): Promise<{ title: string; url: string; snippet: string }[]>;
}
```

### 工具创建函数

#### `createWebFetchTool()`

工具名: `web_fetch_tool`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `url` | `string` | 是 | - | URL |
| `method` | `string` | 否 | `"GET"` | HTTP 方法 |
| `headers` | `object` | 否 | `{}` | HTTP 头 |
| `body` | `string` | 否 | - | 请求体 |
| `timeout` | `integer` | 否 | `30` | 超时秒数 |
| `max_length` | `integer` | 否 | `50000` | 最大响应长度（字符） |

#### `createWebSearchTool(customProvider?, engine?)`

工具名: `web_search_tool`，默认引擎 `bing`。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `query` | `string` | 是 | - | 搜索关键词 |
| `max_results` | `integer` | 否 | `5` | 最大结果数（1-20） |

#### `createHttpRequestTool()`

工具名: `http_request_tool`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `url` | `string` | 是 | - | URL |
| `method` | `string` | 否 | `"GET"` | HTTP 方法 |
| `headers` | `object` | 否 | `{}` | HTTP 头 |
| `body` | `string` | 否 | - | 请求体 |
| `content_type` | `string` | 否 | `"application/json"` | Content-Type |
| `timeout` | `integer` | 否 | `30` | 超时秒数 |
| `follow_redirects` | `boolean` | 否 | `true` | 跟随重定向 |

### 辅助函数

```typescript
function getSearchProvider(engine: SearchEngine): WebSearchProvider;
function getWebTools(engine?: SearchEngine, customSearchProvider?: WebSearchProvider): FunctionTool<WebToolContext>[];
// 默认: engine="bing"
```

---

## 16. Memory Tool

### `createMemoryTool(workspaceRoot?)`

工具名: `memory_tool`，持久化存储在 `.agent/memory.json`。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | `string` | 是 | 操作：`save` / `recall` / `search` / `delete` / `list` / `clear` |
| `key` | `string` | 否 | 记忆键（save/recall/delete） |
| `value` | `string` | 否 | 记忆值（save） |
| `tags` | `string[]` | 否 | 标签（save/search） |
| `query` | `string` | 否 | 搜索查询（search） |
| `limit` | `integer` | 否 | 结果限制（search/list），默认 20 |

**操作说明：**

| 操作 | 必填参数 | 说明 |
|---|---|---|
| `save` | key, value | 保存记忆，可选 tags |
| `recall` | key | 按 key 精确获取 |
| `search` | query | 模糊搜索 key/value/tags |
| `delete` | key | 删除指定记忆 |
| `list` | - | 列出所有记忆（按更新时间排序） |
| `clear` | - | 清空所有记忆 |

---

## 17. Code Search Tool

### `createCodeSearchTool(workspaceRoot?)`

工具名: `code_search_tool`，AST 感知的符号搜索。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `symbol_name` | `string` | 否 | 符号名（部分匹配） |
| `symbol_type` | `string` | 否 | 符号类型 |
| `language` | `string` | 否 | 语言提示：`typescript` / `python` / `generic` |
| `path` | `string` | 否 | 搜索目录，默认工作区根目录 |
| `glob` | `string` | 否 | 文件过滤（如 `*.ts`） |
| `result_limit` | `integer` | 否 | 最大结果数，默认 20 |

**symbol_type 可选值：** `function`, `class`, `method`, `variable`, `interface`, `type`, `constant`, `import`

> 至少需要提供 `symbol_name` 或 `symbol_type` 之一。

---

## 18. 图片/音频工具

### `ToolImageCache`

```typescript
class ToolImageCache {
  static getInstance(): ToolImageCache;
  async ensureDir(): Promise<void>;
  async saveImage(base64Data: string, toolCallId: string, toolName: string, index?: number, mimeType?: string): Promise<CachedImage>;
  async getImageBase64ByPath(filePath: string, mimeType?: string): Promise<{ base64Data: string; mimeType: string } | null>;
  async cleanupExpired(): Promise<number>; // 清理 1 小时前的缓存
}

const toolImageCache: ToolImageCache; // 全局单例
```

### 下载工具

```typescript
function downloadBytes(url: string): Promise<Uint8Array>;              // 下载为字节数组（60s 超时）
function downloadImageByUrl(url: string, targetPath?: string): Promise<string>; // 下载图片到临时文件
function downloadFile(url: string, targetPath: string): Promise<void>; // 下载文件到指定路径
```

### 编码工具

```typescript
function encodeImageToBase64(imageRef: string): Promise<string>;       // 本地图片 → base64 data URL
function encodeAudioToBase64(audioRef: string, mimeType?: string): Promise<string>; // 本地音频 → base64 data URL
function resolveImageToDataUrl(imageRef: string): Promise<string | null>;  // 统一解析远程/本地图片
function resolveAudioToDataUrl(audioRef: string): Promise<string | null>;  // 统一解析远程/本地音频
```

### 图片引用工具

```typescript
function normalizeAndDedupeStrings(items: Iterable<unknown> | null | undefined): string[];
function resolveFileUrlPath(imageRef: string): string;
function isSupportedImageRef(imageRef: string, options?: { allowExtensionlessExistingLocalFile?: boolean; extensionlessLocalRoots?: readonly string[] }): boolean;
function collectAndValidateImageUrls(fromArgs: unknown, fromMessage: string[], tempDir?: string): string[];
function collectImageUrlsFromArgs(imageUrlsRaw: unknown): string[];
```

---

## 19. 模态处理

### `sanitizeContextsByModalities(contexts, modalities)`

根据 Provider 支持的模态清理消息上下文。

```typescript
function sanitizeContextsByModalities(
  contexts: (Message | Record<string, unknown>)[],
  modalities: string[] | undefined | null
): [Record<string, unknown>[], ContextSanitizeStats];
```

**行为：**
- 不支持的 `image` → 替换为 `[Image]` 占位符
- 不支持的 `audio` → 替换为 `[Audio]` 占位符
- 不支持的 `tool_use` → tool 消息转为 user 消息，移除 tool_calls

### `ContextSanitizeStats`

| 字段 | 类型 |
|---|---|
| `fixedImageBlocks` | `number` |
| `fixedAudioBlocks` | `number` |
| `fixedToolMessages` | `number` |
| `removedToolCalls` | `number` |

```typescript
function createContextSanitizeStats(): ContextSanitizeStats;
function isSanitizeStatsChanged(stats: ContextSanitizeStats): boolean;
function logContextSanitizeStats(stats: ContextSanitizeStats): void;
```

---

## 20. 动态子代理创建

### `createSubAgentCreateTool(workspaceRoot?)`

工具名: `create_subagent`，允许 LLM 在运行时动态创建子代理。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | `string` | 是 | 子代理名称（仅字母数字、连字符、下划线） |
| `instructions` | `string` | 是 | 系统指令/提示词 |
| `description` | `string` | 否 | 交接工具描述（默认取 instructions 前 120 字符） |
| `tools` | `string[]` | 否 | 可用工具名列表（省略则继承全部工具） |

**创建后自动：**
- 生成 `transfer_to_{name}` 交接工具
- 注册到 `dynamicSubAgentRegistry`
- 标记为动态子代理（`_dynamic = true`），自动应用限制性沙箱策略

### `createListSubAgentsTool()`

工具名: `list_subagents`，列出所有动态创建的子代理。

无参数。返回子代理名称、交接工具名、指令摘要、工具列表。

### `createDeleteSubAgentTool()`

工具名: `delete_subagent`，删除动态创建的子代理。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | `string` | 是 | 要删除的子代理名称 |

### `DynamicSubAgentRegistry`

动态子代理注册表，跟踪所有动态创建的子代理及其交接工具。

```typescript
class DynamicSubAgentRegistry {
  register(agent: Agent, handoff: HandoffTool): void;
  unregister(name: string): boolean;
  get(name: string): { agent: Agent; handoff: HandoffTool } | undefined;
  getAll(): { agent: Agent; handoff: HandoffTool }[];
  getHandoffTools(): HandoffTool[];
  has(name: string): boolean;
  names(): string[];
  clear(): void;
}

const dynamicSubAgentRegistry: DynamicSubAgentRegistry; // 全局单例
```

### `getSubAgentManagementTools(workspaceRoot?)`

一站式获取 3 个管理工具。

```typescript
function getSubAgentManagementTools(workspaceRoot?: string): FunctionTool<SubAgentCreateToolContext>[];
// 返回: [create_subagent, list_subagents, delete_subagent]
```

### `SubAgentCreateToolContext`

```typescript
interface SubAgentCreateToolContext {
  event?: { unifiedMsgOrigin?: string };
}
```

---

## 21. 沙箱策略

### 方案 A：工具级沙箱

#### `SandboxPolicy`

定义子代理在工具层面的权限。

| 字段 | 类型 | 说明 |
|---|---|---|
| `allowedTools` | `string[]` | 允许的工具名列表（undefined=全部） |
| `deniedTools` | `string[]` | 禁止的工具名列表（优先于 allowedTools） |
| `allowedPaths` | `string[]` | 允许的路径前缀列表（undefined=全部） |
| `deniedPaths` | `string[]` | 禁止的路径前缀列表（优先于 allowedPaths） |
| `allowedDomains` | `string[]` | 允许的网络域名列表（undefined=全部） |
| `allowShell` | `boolean` | 是否允许执行 Shell 命令 |
| `allowCodeExecution` | `boolean` | 是否允许执行代码（python/node） |
| `allowFileDeletion` | `boolean` | 是否允许删除文件 |
| `maxToolCalls` | `number` | 最大工具调用次数（默认 30） |
| `maxExecutionTimeSeconds` | `number` | 最大执行时间秒数（默认 120） |

#### 预定义策略

```typescript
// 动态子代理默认策略（限制性）
const DEFAULT_DYNAMIC_SUBAGENT_POLICY: SandboxPolicy = {
  deniedTools: ["execute_shell", "execute_python", "execute_node", "file_delete_tool"],
  allowShell: false,
  allowCodeExecution: false,
  allowFileDeletion: false,
  maxToolCalls: 30,
  maxExecutionTimeSeconds: 120,
};

// 预配置子代理默认策略（宽松）
const DEFAULT_PRECONFIGURED_SUBAGENT_POLICY: SandboxPolicy = {
  maxToolCalls: 50,
  maxExecutionTimeSeconds: 300,
};
```

#### 工具函数

```typescript
// 根据策略过滤工具集
function applySandboxPolicyToToolSet(
  tools: FunctionTool[],
  policy: SandboxPolicy
): FunctionTool[];

// 检查路径是否被策略允许
function isPathAllowed(path: string, policy: SandboxPolicy): boolean;

// 检查域名是否被策略允许
function isDomainAllowed(url: string, policy: SandboxPolicy): boolean;
```

### 方案 B：进程级沙箱（Linux）

#### `ProcessSandboxConfig`

Linux cgroup + namespace 进程级隔离配置。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `cpuQuotaPercent` | `number` | `20` | CPU 配额百分比 |
| `memoryLimitBytes` | `number` | `268435456` | 内存限制（256MB） |
| `maxPids` | `number` | `20` | 最大进程数 |
| `networkIsolated` | `boolean` | `true` | 是否隔离网络 |
| `mountIsolated` | `boolean` | `true` | 是否隔离文件系统挂载 |
| `readOnlyPaths` | `string[]` | `["/usr","/lib","/lib64","/bin"]` | 只读挂载路径 |
| `readWritePaths` | `string[]` | `["/workspace","/tmp"]` | 读写挂载路径 |
| `workingDir` | `string` | `"/workspace"` | 工作目录 |

#### Linux 沙箱函数

```typescript
// 构建 unshare + cgexec 命令（仅 Linux 可用，其他平台返回 null）
function buildLinuxSandboxCommand(
  command: string,
  config: ProcessSandboxConfig,
  cgroupPath: string
): string | null;

// 创建 cgroup v2 并写入资源限制
async function setupLinuxCgroup(
  agentName: string,
  config: ProcessSandboxConfig
): Promise<string | null>;

// 清理 cgroup
async function teardownLinuxCgroup(agentName: string): Promise<void>;
```

### 方案 B：进程级沙箱（Windows）

#### `WindowsProcessSandboxConfig`

Windows Job Object 进程级隔离配置。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `cpuRateWeight` | `number` | `2000` | CPU 速率控制权重（1-10000，10000=100%） |
| `memoryLimitBytes` | `number` | `268435456` | 内存限制（256MB） |
| `maxProcesses` | `number` | `20` | 最大活跃进程数 |
| `denyNetwork` | `boolean` | `false` | 是否拒绝网络访问 |
| `killOnClose` | `boolean` | `true` | 关闭 Job Handle 时是否终止所有进程 |
| `workingDir` | `string` | `process.cwd()` | 工作目录 |

#### Windows 沙箱函数

```typescript
// 生成 PowerShell 脚本，创建 Job Object 并在其中运行命令
function buildWindowsSandboxScript(
  command: string,
  args: string[],
  config: WindowsProcessSandboxConfig
): string | null;

// 构建可直接执行的 powershell.exe -EncodedCommand 命令
function buildWindowsSandboxCommand(
  command: string,
  config: WindowsProcessSandboxConfig
): string | null;

// 创建 PowerShell 辅助脚本到临时目录
async function setupWindowsJobObject(
  agentName: string,
  config: WindowsProcessSandboxConfig
): Promise<string | null>;

// 清理临时辅助脚本
async function teardownWindowsJobObject(agentName: string): Promise<void>;
```

> **实现说明**：使用 PowerShell + .NET P/Invoke 调用 Win32 API（`CreateJobObjectW`、`SetInformationJobObject`、`AssignProcessToJobObject`），无需额外 native addon 依赖。支持 Windows 10/11 + Server 2016+。

---

## 22. 协调层

### `FileLockManager`

跨并行子代理的文件锁管理器。读锁共享，写锁独占。

```typescript
class FileLockManager {
  // 获取文件锁（超时返回 false）
  async acquire(
    path: string,
    mode: "read" | "write",
    holderId: string,
    timeoutMs?: number  // 默认 30000
  ): Promise<boolean>;

  // 释放指定路径的锁
  release(path: string, holderId: string): void;

  // 释放指定持有者的所有锁（子代理结束时调用）
  releaseAll(holderId: string): void;

  // 检查路径是否被锁定
  isLocked(path: string, holderId?: string): boolean;

  // 获取所有锁
  getLocks(): ReadonlyArray<Readonly<FileLockEntry>>;

  // 获取指定持有者的所有锁
  getLocksByHolder(holderId: string): ReadonlyArray<Readonly<FileLockEntry>>;
}

const fileLockManager: FileLockManager; // 全局单例
```

**锁规则：**

| 模式 | 已有读锁 | 已有写锁 |
|---|---|---|
| 请求读锁 | ✅ 允许（共享） | ❌ 等待 |
| 请求写锁 | ❌ 等待 | ❌ 等待 |

同一持有者可重入（已持有锁时再次请求同路径允许）。

### `SubAgentTaskManager`

并行子代理任务管理器，提供并发控制、超时管理和结果收集。

```typescript
class SubAgentTaskManager extends EventEmitter {
  constructor(options?: SubAgentTaskOptions);

  // 提交任务
  submit(agentName: string, input: string): string;

  // 启动任务（受并发限制）
  startTask(taskId: string): boolean;

  // 标记完成
  completeTask(taskId: string, result: string): void;

  // 标记失败
  failTask(taskId: string, error: string): void;

  // 取消任务
  cancelTask(taskId: string): boolean;

  // 查询
  getTask(taskId: string): SubAgentTask | undefined;
  getAllTasks(): SubAgentTask[];
  getTasksByStatus(status: "pending" | "running" | "completed" | "failed" | "cancelled"): SubAgentTask[];

  // 并发控制
  get hasCapacity(): boolean;
  get runningTaskCount(): number;

  // 等待所有任务完成
  async waitForAll(timeoutMs?: number): Promise<SubAgentTask[]>;

  // 合并结果
  mergeResults(tasks?: SubAgentTask[]): string;

  // 清理
  clear(): void;
}
```

### `SubAgentTaskOptions`

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `maxConcurrency` | `number` | `3` | 最大并发子代理数 |
| `defaultTimeoutSeconds` | `number` | `120` | 默认超时秒数 |
| `onTaskComplete` | `(task: SubAgentTask) => void` | - | 任务完成回调 |
| `onTaskFailed` | `(task: SubAgentTask) => void` | - | 任务失败回调 |
| `onBatchComplete` | `(tasks: SubAgentTask[]) => void` | - | 批次完成回调 |

### `SubAgentTask`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 任务 ID（UUID） |
| `agentName` | `string` | 子代理名称 |
| `status` | `"pending" \| "running" \| "completed" \| "failed" \| "cancelled"` | 任务状态 |
| `input` | `string` | 输入文本 |
| `result` | `string` | 完成结果 |
| `error` | `string` | 失败原因 |
| `startedAt` | `number` | 开始时间戳 |
| `completedAt` | `number` | 完成时间戳 |

### `executeParallelSubAgents(tasks, executor, options?)`

便捷函数：并行执行多个子代理任务，自动控制并发和释放文件锁。

```typescript
async function executeParallelSubAgents(
  tasks: Array<{ agentName: string; input: string }>,
  executor: (agentName: string, input: string) => Promise<string>,
  options?: SubAgentTaskOptions
): Promise<SubAgentTask[]>;
```

**示例：**

```typescript
const results = await executeParallelSubAgents(
  [
    { agentName: "code-reviewer", input: "Review src/index.ts" },
    { agentName: "test-runner", input: "Run tests for auth module" },
    { agentName: "doc-writer", input: "Generate API docs" },
  ],
  async (agentName, input) => {
    // 执行子代理任务
    return await runSubAgent(agentName, input);
  },
  { maxConcurrency: 2, defaultTimeoutSeconds: 60 }
);

// 合并结果
const summary = new SubAgentTaskManager().mergeResults(results);
```

---

## 23. ProviderManager

### `ProviderManager`

Provider 统一管理器，负责 Provider 注册、查找、动态加载、生命周期管理及 MCP 配置集成。

```typescript
class ProviderManager {
  providerInsts: Provider[];
  sttInsts: STTProvider[];
  ttsInsts: TTSProvider[];
  t2iInsts: T2IProvider[];
  embeddingInsts: EmbeddingProvider[];
  rerankInsts: RerankProvider[];
  instMap: Map<string, AnyProvider>;           // ID → 实例映射
  providerConfigs: Map<string, Record<string, unknown>>; // ID → 配置
}
```

### 注册方法

```typescript
registerProvider(provider: Provider): void;
registerEmbeddingProvider(provider: EmbeddingProvider): void;
registerRerankProvider(provider: RerankProvider): void;
registerT2iProvider(provider: T2IProvider): void;
registerSttProvider(provider: STTProvider): void;
registerTtsProvider(provider: TTSProvider): void;
```

所有 `register*` 方法同时将实例加入对应数组和 `instMap`。

### 查找方法

```typescript
getProviderById(id: string): AnyProvider | null;           // 按 ID 查找任意类型
getEmbeddingProviderById(id: string): EmbeddingProvider | null;
getRerankProviderById(id: string): RerankProvider | null;
getUsingProvider(providerType: ProviderType, umo?: string): Provider | null;
getUsingTtsProvider(umo: string): TTSProvider | null;
getUsingSttProvider(umo: string): STTProvider | null;
getUsingT2iProvider(umo?: string): T2IProvider | null;
getUsingEmbeddingProvider(umo?: string): EmbeddingProvider | null;
getUsingRerankProvider(umo?: string): RerankProvider | null;
```

### 生命周期管理

```typescript
// 初始化（可选传入 MCP 服务器配置）
async initialize(mcpServerConfig?: MCPServerConfigMap): Promise<void>;

// 终止所有 Provider 并清理资源
async terminate(): Promise<void>;

// 获取 MCP 服务器配置（供 FunctionToolManager 使用）
getMcpServerConfig(): MCPServerConfigMap | null;
```

### 动态 Provider 管理

```typescript
// 动态导入 Provider 类
async dynamicImportProvider(type: string): Promise<(new (config: any) => any) | null>;

// 从配置加载 Provider
async loadProvider(config: ProviderLoadConfig): Promise<void>;

// 热重载 Provider
async reloadProvider(config: ProviderLoadConfig): Promise<void>;

// 终止指定 Provider
async terminateProvider(providerId: string): Promise<void>;

// 删除 Provider（终止 + 移除配置）
async deleteProvider(providerId: string, providerSourceId?: string): Promise<void>;

// 更新 Provider 配置并重建
async updateProvider(originProviderId: string, newConfig: ProviderLoadConfig): Promise<void>;

// 运行时创建新 Provider
async createProvider(config: ProviderLoadConfig): Promise<void>;
```

### `ProviderLoadConfig`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | `string` | 是 | Provider 类型（如 `"openai"`, `"gemini"`） |
| `id` | `string` | 是 | 唯一标识符 |
| `[key]` | `unknown` | 否 | Provider 特定配置（apiKey, baseUrl, model 等） |

### 变更回调

```typescript
setProviderChangeCallback(cb: ProviderChangeCallback): void;
registerProviderChangeHook(hook: ProviderChangeCallback): void;

type ProviderChangeCallback = (
  providerId: string,
  providerType: ProviderType,
  changeType: "load" | "reload" | "terminate" | "update" | "delete"
) => void;
```

### 配置查询

```typescript
getMergedProviderConfig(providerConfig: Record<string, unknown>): Record<string, unknown>;
getProviderConfigById(providerId: string, merged?: boolean): Record<string, unknown> | null;
```

### 默认/回退 Provider

```typescript
setDefaultProvider(providerId: string): void;
setFallbackProviders(providerIds: string[]): void;
getFallbackProviders(): Provider[];
```

### 动态导入工厂函数

```typescript
// 统一入口：根据 type 字符串动态 import() Provider 模块
async function dynamicImportProviderModule(
  type: string
): Promise<(new (config: any) => any) | null>;

// 各类型动态创建函数（优先使用静态工厂，回退动态导入）
async function dynamicCreateChatProvider(type: string, config: ChatProviderConfig): Promise<Provider | null>;
async function dynamicCreateEmbeddingProvider(type: string, config: EmbeddingProviderConfig): Promise<EmbeddingProvider | null>;
async function dynamicCreateRerankProvider(type: string, config: RerankProviderConfig): Promise<RerankProvider | null>;
async function dynamicCreateTtsProvider(type: string, config: TTSProviderConfigMap): Promise<TTSProvider | null>;
async function dynamicCreateSttProvider(type: string, config: STTProviderConfigMap): Promise<STTProvider | null>;
async function dynamicCreateT2iProvider(type: string, config: T2IProviderConfigMap): Promise<T2IProvider | null>;
```

### 支持的 Provider 类型

| 类型字符串 | 类别 | 对应类 |
|---|---|---|
| `openai` | Chat | `OpenAIProvider` |
| `openai_responses` | Chat | `OpenAIResponsesProvider` |
| `gemini` | Chat | `GeminiProvider` |
| `anthropic` | Chat | `AnthropicProvider` |
| `openai_embedding` | Embedding | `OpenAIEmbeddingProvider` |
| `gemini_embedding` | Embedding | `GeminiEmbeddingProvider` |
| `cohere` / `jina` / `voyage` / `generic` | Rerank | `GenericRerankProvider` |
| `openai_tts` | TTS | `OpenAITTSProvider` |
| `openai_stt` | STT | `OpenAISttProvider` |
| `openai_t2i` | T2I | `OpenAIT2IProvider` |
