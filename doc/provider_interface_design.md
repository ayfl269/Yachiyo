# 模型 Provider 接口适配文档

> 本文档定义消息处理系统中模型 Provider 的统一接口规范，以及 OpenAI、OpenAI Responses、Gemini、Anthropic 四种 API 的适配实现方案。
> 所有 Provider 实现均遵循 `Provider` 接口，通过 `ProviderManager` 统一管理。

> [!NOTE]
> **关于项目结构的说明**：
> 当前项目采用 **PNPM Workspaces 多包工作区 (Monorepo)** 架构进行开发与模块化解耦。
> 1. 本文档中所有以 `src/` 开头的源代码路径（例如 `src/provider/types.ts`），在开发时实际对应为 `packages/<package-name>/src/`（例如 `packages/provider/src/types.ts`）。根目录 `src/` 仅为重导出层。
> 2. 所有实际的 Provider 开发与修改工作，应在 `packages/provider/src/` 目录下进行，而不是在根目录的 `src/` 中。

---

## 目录

1. [接口总览](#1-接口总览)
2. [核心类型定义](#2-核心类型定义)
3. [Provider 统一接口](#3-provider-统一接口)
4. [消息上下文转换](#4-消息上下文转换)
5. [OpenAI Chat Completions 适配](#5-openai-chat-completions-适配)
6. [OpenAI Responses API 适配](#6-openai-responses-api-适配)
7. [Google Gemini 适配](#7-google-gemini-适配)
8. [Anthropic 适配](#8-anthropic-适配)
9. [Provider 注册与发现](#9-provider-注册与发现)
10. [流式响应统一处理](#10-流式响应统一处理)
11. [工具调用跨 API 映射](#11-工具调用跨-api-映射)
12. [多模态内容适配](#12-多模态内容适配)
13. [错误处理与重试](#13-错误处理与重试)
14. [嵌入模型适配](#14-嵌入模型适配)
15. [重排序模型适配](#15-重排序模型适配)
16. [知识库检索集成](#16-知识库检索集成)
17. [目录结构](#17-目录结构)

---

## 1. 接口总览

### 1.1 架构层次

```
┌─────────────────────────────────────────────────────┐
│                  Pipeline ProcessStage               │
│              (通过 ProviderManager 获取 Provider)      │
├─────────────────────────────────────────────────────┤
│                   ProviderManager                     │
│         providerInsts / sttInsts / ttsInsts / ...     │
├──────────┬──────────┬──────────┬─────────────────────┤
│ OpenAI   │ OpenAI   │ Gemini   │ Anthropic           │
│ Chat     │ Responses│          │                     │
│ Compl.   │ API      │          │                     │
├──────────┴──────────┴──────────┴─────────────────────┤
│              Provider 统一接口                          │
│   textChat() / textChatStream() / providerConfig     │
├─────────────────────────────────────────────────────┤
│           内部消息格式转换层                            │
│   Message[] → 各 API 原生格式 → LLMResponse           │
└─────────────────────────────────────────────────────┘
```

### 1.2 四种 API 特性对比

| 特性 | OpenAI Chat Completions | OpenAI Responses API | Gemini | Anthropic |
|------|------------------------|---------------------|--------|-----------|
| 协议 | REST SSE | REST SSE | REST SSE | REST SSE |
| 认证 | `Authorization: Bearer <key>` | `Authorization: Bearer <key>` | `x-goog-api-key: <key>` | `x-api-key: <key>` |
| 流式方式 | `stream: true` + SSE | `stream: true` + SSE | `alt=sse` | `stream: true` + SSE |
| 工具调用 | `tools[].function` | `tools[].function` | `tools.functionDeclarations[]` | `tools[]` |
| 多轮格式 | `messages[]` | `input` (messages 或 response_id) | `contents[]` | `messages[]` + `system` |
| 系统提示 | `system` role message | `instructions` 字段 | `systemInstruction` 字段 | 顶层 `system` 字段 |
| 推理内容 | `reasoning_content` (o1/o3) | `reasoning` summary | `thoughtPart` | `thinking` block |
| 多模态 | `image_url` / `input_audio` | `image_url` / `input_audio` | `inlineData` / `fileData` | `image` / `document` |
| 最大输出 | `max_tokens` | `max_output_tokens` | `maxOutputTokens` | `max_tokens` |

---

## 2. 核心类型定义

### 2.1 Provider 类型枚举

```typescript
// src/provider/types.ts
export enum ProviderType {
  CHAT_COMPLETION = "chat_completion",
  SPEECH_TO_TEXT = "speech_to_text",
  TEXT_TO_SPEECH = "text_to_speech",
  EMBEDDING = "embedding",
  RERANK = "rerank",
}

export interface ProviderMeta {
  id: string;
  model: string | null;
  type: string;
  providerType: ProviderType;
}
```

### 2.2 LLM 响应类型

```typescript
// src/agent/types.ts (已有)
export interface LLMResponse {
  role: "assistant" | "err";
  completionText?: string;           // 文本内容（流式为增量 chunk）
  reasoningContent?: string;        // 推理/思考内容
  reasoningSignature?: string;       // 推理签名（加密思考）
  resultChain?: MessageChain;       // 结果链
  isChunk: boolean;                  // 是否为流式 chunk
  usage?: TokenUsage;               // Token 用量
  toolsCallName?: string[];         // 工具调用名称列表
  toolsCallArgs?: Record<string, unknown>[]; // 工具调用参数列表
  toolsCallIds?: string[];          // 工具调用 ID 列表
}
```

### 2.3 消息内容类型

```typescript
// src/agent/message.ts (已有)
export type ContentPart = TextPart | ThinkPart | ImageURLPart | AudioURLPart;

export interface TextPart {
  type: "text";
  text: string;
  _noSave?: boolean;
}

export interface ThinkPart {
  type: "think";
  think: string;
  encrypted?: string;
  _noSave?: boolean;
}

export interface ImageURLPart {
  type: "image_url";
  image_url: { url: string; id?: string };
  _noSave?: boolean;
}

export interface AudioURLPart {
  type: "audio_url";
  audio_url: { url: string; id?: string };
  _noSave?: boolean;
}

export interface ToolCall {
  type: "function";
  id: string;
  function: { name: string; arguments?: string };
  extraContent?: Record<string, unknown>;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool" | "_checkpoint";
  content?: string | ContentPart[] | CheckpointData;
  tool_calls?: ToolCall[] | Record<string, unknown>[];
  tool_call_id?: string;
  _noSave?: boolean;
  _checkpointAfter?: CheckpointData;
}
```

---

## 3. Provider 统一接口

### 3.1 Provider 接口定义

```typescript
// src/provider/provider.ts (已有)
export interface Provider {
  providerConfig: ProviderConfig;
  textChat(params: ProviderChatParams): Promise<LLMResponse>;
  textChatStream?(params: ProviderChatParams): AsyncGenerator<LLMResponse, void, unknown>;
}
```

### 3.2 调用参数

```typescript
// src/provider/provider.ts (已有)
export interface ProviderChatParams {
  contexts: Message[] | Record<string, unknown>[];
  funcTool?: ToolSet;
  model?: string;
  sessionId?: string;
  extraUserContentParts?: ContentPart[];
  abortSignal?: AbortSignal;
}
```

### 3.3 Provider 配置基类

```typescript
// src/agent/types.ts (已有)
export interface ProviderConfig {
  id?: string | number;
  maxContextTokens?: number;
  modalities?: string[];    // 支持的模态: ["text", "image", "audio", "tool_use"]
  [key: string]: unknown;
}
```

### 3.4 各 Provider 配置扩展

```typescript
// 通用配置接口
export interface BaseProviderConfig extends ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

// OpenAI Chat Completions
export interface OpenAIProviderConfig extends BaseProviderConfig {
  organization?: string;
}

// OpenAI Responses API
export interface OpenAIResponsesProviderConfig extends BaseProviderConfig {
  organization?: string;
  previousResponseId?: string;   // 用于多轮对话链
}

// Gemini
export interface GeminiProviderConfig extends BaseProviderConfig {
  projectId?: string;
  location?: string;              // us-central1 等
  safetySettings?: GeminiSafetySetting[];
}

// Anthropic
export interface AnthropicProviderConfig extends BaseProviderConfig {
  anthropicVersion?: string;     // 默认 2023-06-01
  betaFeatures?: string[];        // beta 功能标记
}
```

---

## 4. 消息上下文转换

### 4.1 转换流程

所有 Provider 的核心工作是：**将内部 `Message[]` 转换为各 API 原生请求格式**，再将原生响应转换为 `LLMResponse`。

```
Message[] ──→ sanitizeContextsByModalities() ──→ 干净的 Message[]
                                                      │
                    ┌─────────────────────────────────┤
                    │                                 │
            OpenAI 转换器                      其他 API 转换器
                    │                                 │
                    ▼                                 ▼
            OpenAI messages[]              Gemini contents[] / Anthropic messages[]
                    │                                 │
                    ▼                                 ▼
              HTTP 请求                           HTTP 请求
                    │                                 │
                    ▼                                 ▼
              原生 SSE 响应                      原生 SSE 响应
                    │                                 │
                    ▼                                 ▼
              解析为 LLMResponse              解析为 LLMResponse
```

### 4.2 模态净化

在发送到具体 API 之前，通过 `sanitizeContextsByModalities()` 根据各 Provider 声明的 `modalities` 过滤不支持的内容：

```typescript
// src/provider/modalities.ts (已有)
// modalities 可选值: "text" | "image" | "audio" | "tool_use"

// 示例：Anthropic 不支持 audio
const anthropicConfig: AnthropicProviderConfig = {
  modalities: ["text", "image", "tool_use"],
  // ...
};
// sanitize 时会自动将 audio_url 内容替换为 "[Audio]" 文本
```

---

## 5. OpenAI Chat Completions 适配

### 5.1 API 端点

```
POST {baseUrl}/chat/completions
```

### 5.2 请求格式

```typescript
interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: OpenAITool[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  n?: number;
  response_format?: { type: "text" | "json_object" | "json_schema" };
}

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

// OpenAI 多模态内容格式
type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
  | { type: "input_audio"; input_audio: { data: string; format: "wav" | "mp3" } };

// OpenAI 工具定义
interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

// OpenAI 工具调用
interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
```

### 5.3 Message → OpenAI 格式转换

```typescript
function messageToOpenAI(msg: Message): OpenAIChatMessage {
  const result: OpenAIChatMessage = { role: msg.role as any };

  // 处理 content
  if (typeof msg.content === "string") {
    result.content = msg.content;
  } else if (Array.isArray(msg.content)) {
    result.content = msg.content
      .filter(part => !part._noSave)
      .map(part => contentPartToOpenAI(part));
  }

  // 处理 tool_calls
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    result.tool_calls = (msg.tool_calls as ToolCall[]).map(tc => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.function.name, arguments: tc.function.arguments ?? "{}" },
    }));
  }

  // 处理 tool_call_id
  if (msg.tool_call_id) {
    result.tool_call_id = msg.tool_call_id;
  }

  return result;
}

function contentPartToOpenAI(part: ContentPart): OpenAIContentPart {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image_url":
      return { type: "image_url", image_url: { url: part.image_url.url } };
    case "audio_url":
      // OpenAI 需要 base64 编码的音频数据
      return { type: "input_audio", input_audio: { data: part.audio_url.url, format: "wav" } };
    case "think":
      // OpenAI 不支持 think 类型，转为文本标记
      return { type: "text", text: `[Thinking]\n${part.think}` };
  }
}
```

### 5.4 OpenAI 响应 → LLMResponse 转换

#### 非流式

```typescript
function openAIResponseToLLMResponse(resp: any): LLMResponse {
  const choice = resp.choices?.[0];
  if (!choice) {
    return { role: "err", isChunk: false, completionText: "Empty response from OpenAI" };
  }

  const message = choice.message;
  const result: LLMResponse = {
    role: "assistant",
    isChunk: false,
    completionText: message.content ?? undefined,
  };

  // 推理内容 (o1/o3 等模型)
  if (message.reasoning_content) {
    result.reasoningContent = message.reasoning_content;
  }

  // 工具调用
  if (message.tool_calls?.length) {
    result.toolsCallName = message.tool_calls.map((tc: any) => tc.function.name);
    result.toolsCallArgs = message.tool_calls.map((tc: any) => JSON.parse(tc.function.arguments));
    result.toolsCallIds = message.tool_calls.map((tc: any) => tc.id);
  }

  // Token 用量
  if (resp.usage) {
    result.usage = {
      promptTokens: resp.usage.prompt_tokens,
      completionTokens: resp.usage.completion_tokens,
      total: resp.usage.total_tokens,
    };
  }

  return result;
}
```

#### 流式

```typescript
async function* parseOpenAIStream(
  response: Response,
  abortSignal?: AbortSignal
): AsyncGenerator<LLMResponse, void, unknown> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // 流式工具调用累加器
  let toolCallsAccum: Map<number, { id: string; name: string; args: string }> = new Map();

  try {
    while (true) {
      if (abortSignal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;

        const parsed = JSON.parse(data);
        const choice = parsed.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        const chunk: LLMResponse = { role: "assistant", isChunk: true };

        // 文本增量
        if (delta.content) {
          chunk.completionText = delta.content;
        }

        // 推理增量
        if (delta.reasoning_content) {
          chunk.reasoningContent = delta.reasoning_content;
        }

        // 工具调用增量
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallsAccum.has(idx)) {
              toolCallsAccum.set(idx, {
                id: tc.id ?? "",
                name: tc.function?.name ?? "",
                args: "",
              });
            }
            const accum = toolCallsAccum.get(idx)!;
            if (tc.id) accum.id = tc.id;
            if (tc.function?.name) accum.name = tc.function.name;
            if (tc.function?.arguments) accum.args += tc.function.arguments;
          }
        }

        // 流式结束时输出完整的工具调用
        if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
          if (toolCallsAccum.size > 0 && choice.finish_reason === "tool_calls") {
            chunk.toolsCallName = [...toolCallsAccum.values()].map(a => a.name);
            chunk.toolsCallArgs = [...toolCallsAccum.values()].map(a => JSON.parse(a.args || "{}"));
            chunk.toolsCallIds = [...toolCallsAccum.values()].map(a => a.id);
            toolCallsAccum.clear();
          }
          if (parsed.usage) {
            chunk.usage = {
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens,
              total: parsed.usage.total_tokens,
            };
          }
        }

        yield chunk;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

### 5.5 完整 Provider 实现

```typescript
// src/provider/implementations/openai-provider.ts
export class OpenAIProvider implements Provider {
  providerConfig: ProviderConfig;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private organization?: string;

  constructor(config: OpenAIProviderConfig) {
    this.providerConfig = config;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    this.model = config.model;
    this.organization = config.organization;
  }

  async textChat(params: ProviderChatParams): Promise<LLMResponse> {
    const [sanitized] = sanitizeContextsByModalities(
      params.contexts, this.providerConfig.modalities
    );
    const messages = sanitized.map(msg => messageToOpenAI(msg as Message));
    const tools = params.funcTool?.openaiSchema();

    const body: Record<string, unknown> = {
      model: params.model ?? this.model,
      messages,
      stream: false,
    };
    if (tools?.length) body.tools = tools;

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: params.abortSignal,
    });

    if (!resp.ok) throw new Error(`OpenAI API error: ${resp.status} ${await resp.text()}`);
    const data = await resp.json();
    return openAIResponseToLLMResponse(data);
  }

  async *textChatStream(params: ProviderChatParams): AsyncGenerator<LLMResponse, void, unknown> {
    const [sanitized] = sanitizeContextsByModalities(
      params.contexts, this.providerConfig.modalities
    );
    const messages = sanitized.map(msg => messageToOpenAI(msg as Message));
    const tools = params.funcTool?.openaiSchema();

    const body: Record<string, unknown> = {
      model: params.model ?? this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools?.length) body.tools = tools;

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: params.abortSignal,
    });

    if (!resp.ok) throw new Error(`OpenAI API error: ${resp.status} ${await resp.text()}`);
    yield* parseOpenAIStream(resp, params.abortSignal);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
    };
    if (this.organization) headers["OpenAI-Organization"] = this.organization;
    return headers;
  }
}
```

---

## 6. OpenAI Responses API 适配

### 6.1 与 Chat Completions 的区别

OpenAI Responses API（`/v1/responses`）是 Chat Completions 的演进版本，主要差异：

| 维度 | Chat Completions | Responses API |
|------|-----------------|---------------|
| 端点 | `/v1/chat/completions` | `/v1/responses` |
| 输入 | `messages[]` | `input` (messages 或 response_id) |
| 系统提示 | system role message | `instructions` 字段 |
| 多轮 | 每次发送完整 messages | 可用 `previous_response_id` 链式引用 |
| 工具 | `tools[].function` | `tools[].function` + 内置工具 (web_search, file_search 等) |
| 推理 | `reasoning_content` | `reasoning` 对象 (effort/summary) |
| 输出 | `choices[].message` | `output[]` (多个 output item) |

### 6.2 请求格式

```typescript
interface OpenAIResponsesRequest {
  model: string;
  input: string | OpenAIResponsesInputItem[];
  instructions?: string;              // 系统提示
  tools?: OpenAIResponsesTool[];
  previous_response_id?: string;      // 多轮链式引用
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  reasoning?: {
    effort?: "low" | "medium" | "high";
    summary?: "auto" | "concise" | "detailed" | null;
  };
}

// 输入项
type OpenAIResponsesInputItem =
  | { role: "user"; content: string | OpenAIResponsesContentPart[] }
  | { role: "assistant"; content: string | OpenAIResponsesContentPart[] }
  | { type: "function_call"; id: string; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

type OpenAIResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "input_file"; file_id: string };

// 工具定义
type OpenAIResponsesTool =
  | { type: "function"; name: string; description?: string; parameters?: Record<string, unknown> }
  | { type: "web_search" }
  | { type: "file_search"; vector_store_ids: string[] };
```

### 6.3 Message → Responses API 格式转换

```typescript
function messageToResponsesInput(msg: Message): OpenAIResponsesInputItem | null {
  // 系统消息不放入 input，而是提取为 instructions
  if (msg.role === "system") return null;

  if (msg.role === "user") {
    const content = typeof msg.content === "string"
      ? msg.content
      : (msg.content as ContentPart[])
          ?.filter(p => !p._noSave)
          .map(p => contentPartToResponsesContent(p)) ?? [];

    return { role: "user", content };
  }

  if (msg.role === "assistant") {
    // 助手消息可能包含工具调用
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      // 工具调用作为独立的 input item
      // 注意：assistant 的文本内容和 function_call 需要分开
      // 这里返回 assistant 文本内容，工具调用在后续处理
      const textContent = typeof msg.content === "string"
        ? msg.content
        : undefined;
      if (textContent) {
        return { role: "assistant", content: textContent };
      }
      return null;
    }

    const content = typeof msg.content === "string"
      ? msg.content
      : (msg.content as ContentPart[])
          ?.filter(p => !p._noSave)
          .map(p => contentPartToResponsesContent(p)) ?? [];

    return { role: "assistant", content };
  }

  if (msg.role === "tool") {
    // 工具结果映射为 function_call_output
    const output = typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content);
    return {
      type: "function_call_output",
      call_id: msg.tool_call_id!,
      output,
    };
  }

  return null;
}

// 从 assistant 消息中提取 function_call items
function extractFunctionCalls(msg: Message): OpenAIResponsesInputItem[] {
  if (!msg.tool_calls || !Array.isArray(msg.tool_calls)) return [];
  return (msg.tool_calls as ToolCall[]).map(tc => ({
    type: "function_call" as const,
    id: tc.id,
    call_id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments ?? "{}",
  }));
}

function contentPartToResponsesContent(part: ContentPart): OpenAIResponsesContentPart {
  switch (part.type) {
    case "text":
      return { type: "input_text", text: part.text };
    case "image_url":
      return { type: "input_image", image_url: part.image_url.url };
    case "audio_url":
      // Responses API 暂不支持音频输入，降级为文本
      return { type: "input_text", text: "[Audio]" };
    case "think":
      return { type: "input_text", text: `[Thinking]\n${part.think}` };
  }
}
```

### 6.4 Responses API 响应 → LLMResponse 转换

```typescript
function responsesOutputToLLMResponse(resp: any): LLMResponse {
  const result: LLMResponse = { role: "assistant", isChunk: false };

  const textParts: string[] = [];
  const toolNames: string[] = [];
  const toolArgs: Record<string, unknown>[] = [];
  const toolIds: string[] = [];

  for (const item of resp.output ?? []) {
    if (item.type === "message" && item.role === "assistant") {
      for (const content of item.content ?? []) {
        if (content.type === "output_text") {
          textParts.push(content.text);
        }
      }
    } else if (item.type === "function_call") {
      toolNames.push(item.name);
      toolArgs.push(JSON.parse(item.arguments || "{}"));
      toolIds.push(item.call_id);
    } else if (item.type === "reasoning") {
      if (item.summary) {
        result.reasoningContent = item.summary
          .map((s: any) => s.text ?? "")
          .join("\n");
      }
    }
  }

  if (textParts.length) result.completionText = textParts.join("");
  if (toolNames.length) {
    result.toolsCallName = toolNames;
    result.toolsCallArgs = toolArgs;
    result.toolsCallIds = toolIds;
  }

  if (resp.usage) {
    result.usage = {
      promptTokens: resp.usage.input_tokens,
      completionTokens: resp.usage.output_tokens,
      total: resp.usage.input_tokens + resp.usage.output_tokens,
    };
  }

  return result;
}
```

### 6.5 流式解析

```typescript
async function* parseResponsesStream(
  response: Response,
  abortSignal?: AbortSignal
): AsyncGenerator<LLMResponse, void, unknown> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // 累加器
  let currentFunctionCall: { id: string; callId: string; name: string; args: string } | null = null;

  try {
    while (true) {
      if (abortSignal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;

        const event = JSON.parse(data);
        const chunk: LLMResponse = { role: "assistant", isChunk: true };

        if (event.type === "response.output_text.delta") {
          chunk.completionText = event.delta;
          yield chunk;
        } else if (event.type === "response.reasoning_summary_text.delta") {
          chunk.reasoningContent = event.delta;
          yield chunk;
        } else if (event.type === "response.function_call_arguments.delta") {
          if (currentFunctionCall) {
            currentFunctionCall.args += event.delta;
          }
        } else if (event.type === "response.output_item.added") {
          if (event.item?.type === "function_call") {
            currentFunctionCall = {
              id: event.item.id,
              callId: event.item.call_id,
              name: event.item.name,
              args: "",
            };
          }
        } else if (event.type === "response.output_item.done") {
          if (event.item?.type === "function_call" && currentFunctionCall) {
            chunk.toolsCallName = [currentFunctionCall.name];
            chunk.toolsCallArgs = [JSON.parse(currentFunctionCall.args || "{}")];
            chunk.toolsCallIds = [currentFunctionCall.callId];
            currentFunctionCall = null;
            yield chunk;
          }
        } else if (event.type === "response.completed") {
          if (event.response?.usage) {
            const usage = event.response.usage;
            chunk.usage = {
              promptTokens: usage.input_tokens,
              completionTokens: usage.output_tokens,
              total: usage.input_tokens + usage.output_tokens,
            };
            yield chunk;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

### 6.6 Provider 实现

```typescript
// src/provider/implementations/openai-responses-provider.ts
export class OpenAIResponsesProvider implements Provider {
  providerConfig: ProviderConfig;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private organization?: string;

  constructor(config: OpenAIResponsesProviderConfig) {
    this.providerConfig = config;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    this.model = config.model;
    this.organization = config.organization;
  }

  async textChat(params: ProviderChatParams): Promise<LLMResponse> {
    const { input, instructions } = this.buildInput(params);
    const tools = this.buildTools(params.funcTool);

    const body: Record<string, unknown> = {
      model: params.model ?? this.model,
      input,
      instructions,
      stream: false,
    };
    if (tools.length) body.tools = tools;

    const resp = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: params.abortSignal,
    });

    if (!resp.ok) throw new Error(`OpenAI Responses API error: ${resp.status}`);
    const data = await resp.json();
    return responsesOutputToLLMResponse(data);
  }

  async *textChatStream(params: ProviderChatParams): AsyncGenerator<LLMResponse, void, unknown> {
    const { input, instructions } = this.buildInput(params);
    const tools = this.buildTools(params.funcTool);

    const body: Record<string, unknown> = {
      model: params.model ?? this.model,
      input,
      instructions,
      stream: true,
    };
    if (tools.length) body.tools = tools;

    const resp = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: params.abortSignal,
    });

    if (!resp.ok) throw new Error(`OpenAI Responses API error: ${resp.status}`);
    yield* parseResponsesStream(resp, params.abortSignal);
  }

  private buildInput(params: ProviderChatParams): {
    input: OpenAIResponsesInputItem[];
    instructions: string | undefined;
  } {
    const [sanitized] = sanitizeContextsByModalities(
      params.contexts, this.providerConfig.modalities
    );

    let instructions: string | undefined;
    const input: OpenAIResponsesInputItem[] = [];

    for (const rawMsg of sanitized) {
      const msg = rawMsg as Message;

      // 提取系统提示
      if (msg.role === "system") {
        instructions = typeof msg.content === "string" ? msg.content : undefined;
        continue;
      }

      // 常规消息
      const item = messageToResponsesInput(msg);
      if (item) input.push(item);

      // assistant 消息中的 function_call
      const funcCalls = extractFunctionCalls(msg);
      if (funcCalls.length) input.push(...funcCalls);
    }

    return { input, instructions };
  }

  private buildTools(funcTool?: ToolSet): OpenAIResponsesTool[] {
    if (!funcTool) return [];
    return funcTool.openaiSchema().map(t => ({
      type: "function",
      name: (t.function as any).name,
      description: (t.function as any).description,
      parameters: (t.function as any).parameters,
    }));
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
    };
    if (this.organization) headers["OpenAI-Organization"] = this.organization;
    return headers;
  }
}
```

---

## 7. Google Gemini 适配

### 7.1 API 端点

```
POST {baseUrl}/models/{model}:generateContent       # 非流式
POST {baseUrl}/models/{model}:streamGenerateContent?alt=sse  # 流式
```

### 7.2 请求格式

```typescript
interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: GeminiContent;
  tools?: GeminiTool[];
  generationConfig?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    responseMimeType?: string;
  };
  safetySettings?: GeminiSafetySetting[];
}

interface GeminiContent {
  role?: "user" | "model";
  parts: GeminiPart[];
}

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }   // base64
  | { fileData: { mimeType: string; fileUri: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiTool {
  functionDeclarations: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }[];
}

interface GeminiSafetySetting {
  category: string;
  threshold: string;
}
```

### 7.3 Message → Gemini 格式转换

```typescript
function messageToGemini(msg: Message): GeminiContent | null {
  // Gemini 没有 system role，系统消息提取为 systemInstruction
  if (msg.role === "system") return null;

  // Gemini 用 "model" 而非 "assistant"
  const role = msg.role === "assistant" ? "model" :
               msg.role === "tool" ? "function" : "user";

  const parts: GeminiPart[] = [];

  // 处理内容
  if (typeof msg.content === "string") {
    parts.push({ text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const part of (msg.content as ContentPart[])) {
      if (part._noSave) continue;
      const geminiPart = contentPartToGemini(part);
      if (geminiPart) parts.push(geminiPart);
    }
  }

  // 处理工具调用
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of (msg.tool_calls as ToolCall[])) {
      parts.push({
        functionCall: {
          name: tc.function.name,
          args: tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
        },
      });
    }
  }

  // 处理工具结果
  if (msg.role === "tool" && msg.tool_call_id) {
    const responseText = typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content);
    // 需要从 tool_call_id 反查函数名（Gemini 的 functionResponse 需要 name）
    parts.push({
      functionResponse: {
        name: msg.tool_call_id, // 需要映射为实际函数名
        response: { result: responseText },
      },
    });
  }

  if (parts.length === 0) return null;
  return { role: role as any, parts };
}

function contentPartToGemini(part: ContentPart): GeminiPart | null {
  switch (part.type) {
    case "text":
      return { text: part.text };
    case "image_url": {
      const url = part.image_url.url;
      // 判断是 base64 还是 URL
      if (url.startsWith("data:")) {
        const match = url.match(/^data:(.*?);base64,(.*)$/);
        if (match) {
          return { inlineData: { mimeType: match[1], data: match[2] } };
        }
      }
      // URL 引用 → fileData (需要先上传到 Gemini File API)
      // 降级为文本描述
      return { text: `[Image: ${url}]` };
    }
    case "audio_url": {
      const url = part.audio_url.url;
      if (url.startsWith("data:")) {
        const match = url.match(/^data:(.*?);base64,(.*)$/);
        if (match) {
          return { inlineData: { mimeType: match[1], data: match[2] } };
        }
      }
      return { text: `[Audio: ${url}]` };
    }
    case "think":
      // Gemini 原生支持 thought，但通过特定字段传递
      // 此处降级为文本
      return { text: `[Thinking]\n${part.think}` };
  }
}
```

### 7.4 Gemini 响应 → LLMResponse 转换

```typescript
function geminiResponseToLLMResponse(resp: any): LLMResponse {
  const candidate = resp.candidates?.[0];
  if (!candidate) {
    return { role: "err", isChunk: false, completionText: "Empty response from Gemini" };
  }

  const result: LLMResponse = { role: "assistant", isChunk: false };
  const textParts: string[] = [];
  const toolNames: string[] = [];
  const toolArgs: Record<string, unknown>[] = [];
  const toolIds: string[] = [];

  for (const part of candidate.content?.parts ?? []) {
    if (part.text) {
      textParts.push(part.text);
    } else if (part.thought) {
      // Gemini 原生思考内容
      result.reasoningContent = (result.reasoningContent ?? "") + part.thought;
    } else if (part.functionCall) {
      toolNames.push(part.functionCall.name);
      toolArgs.push(part.functionCall.args ?? {});
      toolIds.push(`gemini_fc_${toolNames.length}`); // Gemini 不返回 call id，自行生成
    }
  }

  if (textParts.length) result.completionText = textParts.join("");
  if (toolNames.length) {
    result.toolsCallName = toolNames;
    result.toolsCallArgs = toolArgs;
    result.toolsCallIds = toolIds;
  }

  if (resp.usageMetadata) {
    result.usage = {
      promptTokens: resp.usageMetadata.promptTokenCount ?? 0,
      completionTokens: resp.usageMetadata.candidatesTokenCount ?? 0,
      total: resp.usageMetadata.totalTokenCount ?? 0,
    };
  }

  return result;
}
```

### 7.5 流式解析

```typescript
async function* parseGeminiStream(
  response: Response,
  abortSignal?: AbortSignal
): AsyncGenerator<LLMResponse, void, unknown> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (abortSignal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);

        const parsed = JSON.parse(data);
        const candidate = parsed.candidates?.[0];
        if (!candidate) continue;

        const chunk: LLMResponse = { role: "assistant", isChunk: true };

        for (const part of candidate.content?.parts ?? []) {
          if (part.text) {
            chunk.completionText = part.text;
          } else if (part.thought) {
            chunk.reasoningContent = part.thought;
          } else if (part.functionCall) {
            chunk.toolsCallName = [part.functionCall.name];
            chunk.toolsCallArgs = [part.functionCall.args ?? {}];
            chunk.toolsCallIds = [`gemini_fc_${Date.now()}`];
          }
        }

        if (parsed.usageMetadata) {
          chunk.usage = {
            promptTokens: parsed.usageMetadata.promptTokenCount ?? 0,
            completionTokens: parsed.usageMetadata.candidatesTokenCount ?? 0,
            total: parsed.usageMetadata.totalTokenCount ?? 0,
          };
        }

        yield chunk;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

### 7.6 Provider 实现

```typescript
// src/provider/implementations/gemini-provider.ts
export class GeminiProvider implements Provider {
  providerConfig: ProviderConfig;
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config: GeminiProviderConfig) {
    this.providerConfig = config;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.model = config.model;
  }

  async textChat(params: ProviderChatParams): Promise<LLMResponse> {
    const { contents, systemInstruction } = this.buildContents(params);
    const tools = this.buildTools(params.funcTool);

    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (tools.functionDeclarations?.length) body.tools = [tools];

    const url = `${this.baseUrl}/models/${params.model ?? this.model}:generateContent?key=${this.apiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: params.abortSignal,
    });

    if (!resp.ok) throw new Error(`Gemini API error: ${resp.status}`);
    const data = await resp.json();
    return geminiResponseToLLMResponse(data);
  }

  async *textChatStream(params: ProviderChatParams): AsyncGenerator<LLMResponse, void, unknown> {
    const { contents, systemInstruction } = this.buildContents(params);
    const tools = this.buildTools(params.funcTool);

    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (tools.functionDeclarations?.length) body.tools = [tools];

    const url = `${this.baseUrl}/models/${params.model ?? this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: params.abortSignal,
    });

    if (!resp.ok) throw new Error(`Gemini API error: ${resp.status}`);
    yield* parseGeminiStream(resp, params.abortSignal);
  }

  private buildContents(params: ProviderChatParams): {
    contents: GeminiContent[];
    systemInstruction?: GeminiContent;
  } {
    const [sanitized] = sanitizeContextsByModalities(
      params.contexts, this.providerConfig.modalities
    );

    let systemInstruction: GeminiContent | undefined;
    const contents: GeminiContent[] = [];

    for (const rawMsg of sanitized) {
      const msg = rawMsg as Message;
      if (msg.role === "system") {
        const text = typeof msg.content === "string" ? msg.content : undefined;
        if (text) systemInstruction = { parts: [{ text }] };
        continue;
      }
      const geminiContent = messageToGemini(msg);
      if (geminiContent) contents.push(geminiContent);
    }

    return { contents, systemInstruction };
  }

  private buildTools(funcTool?: ToolSet): GeminiTool {
    if (!funcTool) return { functionDeclarations: [] };
    const schema = funcTool.googleSchema();
    return schema as GeminiTool;
  }
}
```

---

## 8. Anthropic 适配

### 8.1 API 端点

```
POST {baseUrl}/messages
```

### 8.2 请求格式

```typescript
interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  tools?: AnthropicTool[];
  max_tokens: number;               // Anthropic 必填
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  metadata?: { user_id?: string };
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[] }
  | { type: "thinking"; thinking: string; signature?: string };  // 扩展思考

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}
```

### 8.3 Message → Anthropic 格式转换

```typescript
function messageToAnthropic(msg: Message): AnthropicMessage | null {
  // 系统消息不放入 messages，而是提取为顶层 system
  if (msg.role === "system") return null;

  // Anthropic 只支持 user 和 assistant
  if (msg.role === "tool") {
    // tool 消息需要合并到前一个 assistant 消息的 content 中
    // 或作为独立的 user 消息（包含 tool_result block）
    const content: string = typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content);
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: msg.tool_call_id!,
        content,
      }],
    };
  }

  const blocks: AnthropicContentBlock[] = [];

  // 处理文本/多模态内容
  if (typeof msg.content === "string") {
    blocks.push({ type: "text", text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const part of (msg.content as ContentPart[])) {
      if (part._noSave) continue;
      const block = contentPartToAnthropic(part);
      if (block) blocks.push(block);
    }
  }

  // 处理工具调用
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of (msg.tool_calls as ToolCall[])) {
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
      });
    }
  }

  if (blocks.length === 0) return null;
  return { role: msg.role as "user" | "assistant", content: blocks };
}

function contentPartToAnthropic(part: ContentPart): AnthropicContentBlock | null {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image_url": {
      const url = part.image_url.url;
      if (url.startsWith("data:")) {
        const match = url.match(/^data:(.*?);base64,(.*)$/);
        if (match) {
          return {
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          };
        }
      }
      // URL 图片需要先下载再 base64 编码
      return { type: "text", text: `[Image: ${url}]` };
    }
    case "audio_url":
      // Anthropic 不支持音频输入
      return { type: "text", text: "[Audio]" };
    case "think":
      return { type: "thinking", thinking: part.think };
  }
}
```

### 8.4 Anthropic 响应 → LLMResponse 转换

```typescript
function anthropicResponseToLLMResponse(resp: any): LLMResponse {
  const result: LLMResponse = { role: "assistant", isChunk: false };
  const textParts: string[] = [];
  const toolNames: string[] = [];
  const toolArgs: Record<string, unknown>[] = [];
  const toolIds: string[] = [];

  for (const block of resp.content ?? []) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "thinking") {
      result.reasoningContent = (result.reasoningContent ?? "") + block.thinking;
    } else if (block.type === "tool_use") {
      toolNames.push(block.name);
      toolArgs.push(block.input ?? {});
      toolIds.push(block.id);
    }
  }

  if (textParts.length) result.completionText = textParts.join("");
  if (toolNames.length) {
    result.toolsCallName = toolNames;
    result.toolsCallArgs = toolArgs;
    result.toolsCallIds = toolIds;
  }

  if (resp.usage) {
    result.usage = {
      promptTokens: resp.usage.input_tokens,
      completionTokens: resp.usage.output_tokens,
      total: resp.usage.input_tokens + resp.usage.output_tokens,
    };
  }

  return result;
}
```

### 8.5 流式解析

```typescript
async function* parseAnthropicStream(
  response: Response,
  abortSignal?: AbortSignal
): AsyncGenerator<LLMResponse, void, unknown> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // 工具调用累加器
  let currentToolCall: { index: number; id: string; name: string; input: string } | null = null;

  try {
    while (true) {
      if (abortSignal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);

        const event = JSON.parse(data);
        const chunk: LLMResponse = { role: "assistant", isChunk: true };

        switch (event.type) {
          case "content_block_delta":
            if (event.delta?.type === "text_delta") {
              chunk.completionText = event.delta.text;
            } else if (event.delta?.type === "thinking_delta") {
              chunk.reasoningContent = event.delta.thinking;
            } else if (event.delta?.type === "input_json_delta") {
              if (currentToolCall) {
                currentToolCall.input += event.delta.partial_json;
              }
            }
            break;

          case "content_block_start":
            if (event.content_block?.type === "tool_use") {
              currentToolCall = {
                index: event.index,
                id: event.content_block.id,
                name: event.content_block.name,
                input: "",
              };
            }
            break;

          case "content_block_stop":
            if (currentToolCall) {
              chunk.toolsCallName = [currentToolCall.name];
              chunk.toolsCallArgs = [JSON.parse(currentToolCall.input || "{}")];
              chunk.toolsCallIds = [currentToolCall.id];
              currentToolCall = null;
            }
            break;

          case "message_delta":
            if (event.usage) {
              chunk.usage = {
                promptTokens: 0, // Anthropic 在 message_start 中返回 input tokens
                completionTokens: event.usage.output_tokens,
                total: event.usage.output_tokens,
              };
            }
            break;

          case "message_start":
            // 包含 input_tokens
            if (event.message?.usage) {
              chunk.usage = {
                promptTokens: event.message.usage.input_tokens,
                completionTokens: 0,
                total: event.message.usage.input_tokens,
              };
            }
            break;
        }

        if (chunk.completionText || chunk.toolsCallName || chunk.usage || chunk.reasoningContent) {
          yield chunk;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

### 8.6 Provider 实现

```typescript
// src/provider/implementations/anthropic-provider.ts
export class AnthropicProvider implements Provider {
  providerConfig: ProviderConfig;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private anthropicVersion: string;

  constructor(config: AnthropicProviderConfig) {
    this.providerConfig = config;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.anthropic.com";
    this.model = config.model;
    this.anthropicVersion = config.anthropicVersion ?? "2023-06-01";
  }

  async textChat(params: ProviderChatParams): Promise<LLMResponse> {
    const { messages, system } = this.buildMessages(params);
    const tools = this.buildTools(params.funcTool);

    const body: Record<string, unknown> = {
      model: params.model ?? this.model,
      messages,
      max_tokens: this.providerConfig.maxContextTokens ?? 4096,
      stream: false,
    };
    if (system) body.system = system;
    if (tools.length) body.tools = tools;

    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: params.abortSignal,
    });

    if (!resp.ok) throw new Error(`Anthropic API error: ${resp.status}`);
    const data = await resp.json();
    return anthropicResponseToLLMResponse(data);
  }

  async *textChatStream(params: ProviderChatParams): AsyncGenerator<LLMResponse, void, unknown> {
    const { messages, system } = this.buildMessages(params);
    const tools = this.buildTools(params.funcTool);

    const body: Record<string, unknown> = {
      model: params.model ?? this.model,
      messages,
      max_tokens: this.providerConfig.maxContextTokens ?? 4096,
      stream: true,
    };
    if (system) body.system = system;
    if (tools.length) body.tools = tools;

    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: params.abortSignal,
    });

    if (!resp.ok) throw new Error(`Anthropic API error: ${resp.status}`);
    yield* parseAnthropicStream(resp, params.abortSignal);
  }

  private buildMessages(params: ProviderChatParams): {
    messages: AnthropicMessage[];
    system: string | AnthropicContentBlock[] | undefined;
  } {
    const [sanitized] = sanitizeContextsByModalities(
      params.contexts, this.providerConfig.modalities
    );

    let system: string | AnthropicContentBlock[] | undefined;
    const messages: AnthropicMessage[] = [];

    for (const rawMsg of sanitized) {
      const msg = rawMsg as Message;
      if (msg.role === "system") {
        if (typeof msg.content === "string") {
          system = msg.content;
        } else if (Array.isArray(msg.content)) {
          system = (msg.content as ContentPart[])
            .filter(p => !p._noSave && p.type === "text")
            .map(p => ({ type: "text" as const, text: (p as TextPart).text }));
        }
        continue;
      }
      const anthropicMsg = messageToAnthropic(msg);
      if (anthropicMsg) messages.push(anthropicMsg);
    }

    return { messages, system };
  }

  private buildTools(funcTool?: ToolSet): AnthropicTool[] {
    if (!funcTool) return [];
    return funcTool.anthropicSchema() as AnthropicTool[];
  }

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": this.anthropicVersion,
    };
  }
}
```

---

## 9. Provider 注册与发现

### 9.1 ProviderManager 扩展

当前 `ProviderManager` 需要扩展以支持按配置 ID 查找和回退逻辑：

```typescript
// src/provider/manager.ts 扩展
export class ProviderManager {
  providerInsts: Provider[] = [];
  sttInsts: STTProvider[] = [];
  ttsInsts: TTSProvider[] = [];
  embeddingInsts: EmbeddingProvider[] = [];
  rerankInsts: RerankProvider[] = [];

  private defaultProviderId: string | null = null;
  private fallbackProviderIds: string[] = [];

  /**
   * 注册 Provider 实例
   */
  registerProvider(provider: Provider): void {
    this.providerInsts.push(provider);
  }

  /**
   * 获取当前使用的 Provider
   * 优先级：会话绑定 > 默认 > 第一个
   */
  getUsingProvider(providerType: ProviderType, umo?: string): Provider | null {
    if (this.providerInsts.length === 0) return null;

    // 尝试默认 Provider
    if (this.defaultProviderId) {
      const found = this.providerInsts.find(
        p => (p.providerConfig as any).id === this.defaultProviderId
      );
      if (found) return found;
    }

    // 回退到第一个
    return this.providerInsts[0];
  }

  /**
   * 设置默认 Provider
   */
  setDefaultProvider(providerId: string): void {
    this.defaultProviderId = providerId;
  }

  /**
   * 设置回退 Provider 列表
   */
  setFallbackProviders(providerIds: string[]): void {
    this.fallbackProviderIds = providerIds;
  }

  /**
   * 获取回退 Provider
   */
  getFallbackProviders(): Provider[] {
    return this.fallbackProviderIds
      .map(id => this.providerInsts.find(p => (p.providerConfig as any).id === id))
      .filter((p): p is Provider => p != null);
  }
}
```

### 9.2 Provider 工厂

```typescript
// src/provider/factory.ts
export type ProviderTypeKey = "openai" | "openai_responses" | "gemini" | "anthropic";

const PROVIDER_FACTORIES: Map<ProviderTypeKey, (config: any) => Provider> = new Map();

export function registerProviderFactory(key: ProviderTypeKey, factory: (config: any) => Provider): void {
  PROVIDER_FACTORIES.set(key, factory);
}

export function createProvider(key: ProviderTypeKey, config: any): Provider {
  const factory = PROVIDER_FACTORIES.get(key);
  if (!factory) throw new Error(`Unknown provider type: ${key}`);
  return factory(config);
}

// 注册内置 Provider
registerProviderFactory("openai", (config) => new OpenAIProvider(config));
registerProviderFactory("openai_responses", (config) => new OpenAIResponsesProvider(config));
registerProviderFactory("gemini", (config) => new GeminiProvider(config));
registerProviderFactory("anthropic", (config) => new AnthropicProvider(config));
```

---

## 10. 流式响应统一处理

### 10.1 SSE 解析通用工具

所有四种 API 都使用 Server-Sent Events (SSE) 进行流式传输，但格式略有差异：

| API | SSE 格式 | 结束标记 |
|-----|---------|---------|
| OpenAI Chat | `data: {json}\n\n` | `data: [DONE]` |
| OpenAI Responses | `data: {json}\n\n` | `data: [DONE]` |
| Gemini | `data: {json}\n\n` | 无（连接关闭） |
| Anthropic | `event: {type}\ndata: {json}\n\n` | `event: message_stop` |

通用 SSE 解析器：

```typescript
// src/common/sse-parser.ts
export interface SSEEvent {
  event?: string;
  data: string;
}

export async function* parseSSEStream(
  response: Response,
  abortSignal?: AbortSignal
): AsyncGenerator<SSEEvent, void, unknown> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (abortSignal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 以双换行分隔事件
      const events = buffer.split("\n\n");
      buffer = events.pop()!;

      for (const eventText of events) {
        if (!eventText.trim()) continue;

        let eventType: string | undefined;
        let dataLines: string[] = [];

        for (const line of eventText.split("\n")) {
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }

        if (dataLines.length) {
          yield { event: eventType, data: dataLines.join("\n") };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

### 10.2 流式响应在管线中的使用

在 `ProcessStage` 中，流式响应通过 `MessageEvent.sendStreaming()` 发送到平台：

```typescript
// ProcessStage 中的流式处理
if (event.isStreamingResponse() && provider.textChatStream) {
  const generator = provider.textChatStream(params);
  await event.sendStreaming(generator);
} else {
  const response = await provider.textChat(params);
  event.setResult(new EventResult().plain(response.completionText ?? ""));
}
```

---

## 11. 工具调用跨 API 映射

### 11.1 工具定义格式映射

内部使用 `ToolSet` 统一管理工具定义，通过各 Provider 的 schema 方法转换为 API 原生格式：

```
ToolSet (内部)
  ├── openaiSchema()    → OpenAI tools[] 格式
  ├── anthropicSchema() → Anthropic tools[] 格式
  └── googleSchema()    → Gemini functionDeclarations 格式
```

### 11.2 工具调用响应映射

各 API 返回的工具调用需要统一为 `LLMResponse` 格式：

| API | 工具调用字段 | 映射到 LLMResponse |
|-----|------------|-------------------|
| OpenAI | `choices[0].message.tool_calls[]` | `toolsCallName/Args/Ids` |
| OpenAI Responses | `output[].function_call` | `toolsCallName/Args/Ids` |
| Gemini | `parts[].functionCall` | `toolsCallName/Args/Ids` (自生成 ID) |
| Anthropic | `content[].tool_use` | `toolsCallName/Args/Ids` |

### 11.3 工具结果回传映射

工具执行结果需要转换回各 API 的消息格式：

```
内部 Message (role: "tool", tool_call_id, content)
  │
  ├── OpenAI:       { role: "tool", tool_call_id, content }
  ├── OpenAI Resp:  { type: "function_call_output", call_id, output }
  ├── Gemini:       { functionResponse: { name, response } }
  └── Anthropic:    { role: "user", content: [{ type: "tool_result", tool_use_id, content }] }
```

### 11.4 Gemini 工具调用 ID 问题

Gemini API 不返回工具调用 ID，只有函数名和参数。需要自行生成 ID 并在后续的 `functionResponse` 中保持一致：

```typescript
// 生成稳定的工具调用 ID
function generateToolCallId(functionName: string, index: number): string {
  return `gemini_tc_${functionName}_${index}`;
}
```

### 11.5 Anthropic 工具结果消息合并

Anthropic 要求 `tool_result` 必须紧跟在 `tool_use` 后面，且 `tool_result` 必须作为 `user` 消息发送。当有多个工具调用时，所有 `tool_result` 应放在同一个 `user` 消息中：

```typescript
// 合并连续的 tool 消息为单个 user 消息
function mergeToolResults(messages: AnthropicMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  const pendingToolResults: AnthropicContentBlock[] = [];

  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const hasToolResult = (msg.content as any[]).some(b => b.type === "tool_result");
      if (hasToolResult) {
        pendingToolResults.push(...(msg.content as any[]).filter(b => b.type === "tool_result"));
        continue;
      }
    }

    if (pendingToolResults.length) {
      result.push({ role: "user", content: pendingToolResults.splice(0) });
    }
    result.push(msg);
  }

  if (pendingToolResults.length) {
    result.push({ role: "user", content: pendingToolResults });
  }

  return result;
}
```

---

## 12. 多模态内容适配

### 12.1 各 API 多模态支持矩阵

| 内容类型 | OpenAI | OpenAI Responses | Gemini | Anthropic |
|---------|--------|-----------------|--------|-----------|
| 文本 | `text` | `input_text` | `text` | `text` |
| 图片 (URL) | `image_url` | `input_image` | `fileData` | 需 base64 |
| 图片 (Base64) | `image_url` (data URI) | `input_image` (data URI) | `inlineData` | `image` (base64) |
| 音频 (URL) | `input_audio` | 暂不支持 | `fileData` | 不支持 |
| 音频 (Base64) | `input_audio` | 暂不支持 | `inlineData` | 不支持 |
| 推理/思考 | `reasoning_content` | `reasoning` | `thought` | `thinking` |

### 12.2 图片处理策略

```
内部 ImageURLPart.image_url.url
  │
  ├── data:image/png;base64,xxx
  │     ├── OpenAI:       直接使用 data URI
  │     ├── OpenAI Resp:  直接使用 data URI
  │     ├── Gemini:       拆分为 inlineData { mimeType, data }
  │     └── Anthropic:    拆分为 image.source { media_type, data }
  │
  └── https://example.com/image.png
        ├── OpenAI:       直接使用 URL
        ├── OpenAI Resp:  直接使用 URL
        ├── Gemini:       需先上传到 File API → fileData
        └── Anthropic:    需先下载 → base64 编码
```

### 12.3 URL 图片下载工具

```typescript
// src/common/media.ts 扩展
export async function downloadImageAsBase64(url: string): Promise<{
  mimeType: string;
  data: string;
}> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download image: ${resp.status}`);

  const contentType = resp.headers.get("content-type") ?? "image/png";
  const buffer = await resp.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");

  return { mimeType: contentType, data: base64 };
}

export function parseDataUri(dataUri: string): { mimeType: string; data: string } | null {
  const match = dataUri.match(/^data:(.*?);base64,(.*)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}
```

---

## 13. 错误处理与重试

### 13.1 错误类型

```typescript
// 通用 API 错误
export class ProviderAPIError extends Error {
  constructor(
    public provider: string,
    public statusCode: number,
    public errorCode?: string,
    message?: string,
  ) {
    super(message ?? `Provider ${provider} API error: ${statusCode}`);
    this.name = "ProviderAPIError";
  }
}

// 速率限制错误
export class RateLimitError extends ProviderAPIError {
  public retryAfterMs?: number;
  constructor(provider: string, retryAfter?: string) {
    super(provider, 429, "rate_limit_exceeded", "Rate limit exceeded");
    this.name = "RateLimitError";
    if (retryAfter) this.retryAfterMs = parseInt(retryAfter, 10) * 1000;
  }
}

// 上下文长度超限
export class ContextLengthExceededError extends ProviderAPIError {
  constructor(provider: string) {
    super(provider, 400, "context_length_exceeded", "Context length exceeded");
    this.name = "ContextLengthExceededError";
  }
}
```

### 13.2 错误码映射

| HTTP 状态码 | 含义 | 处理策略 |
|------------|------|---------|
| 400 | 请求格式错误 | 记录日志，不重试 |
| 401 | 认证失败 | 不重试，报告配置错误 |
| 403 | 权限不足 | 不重试，报告权限问题 |
| 429 | 速率限制 | 等待 `retry-after` 后重试 |
| 500 | 服务器内部错误 | 指数退避重试 |
| 503 | 服务不可用 | 指数退避重试 |

### 13.3 重试策略

```typescript
// src/provider/retry.ts
export interface RetryConfig {
  maxRetries: number;        // 默认 3
  baseDelayMs: number;       // 默认 1000
  maxDelayMs: number;       // 默认 30000
  retryableStatusCodes: number[]; // 默认 [429, 500, 503]
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableStatusCodes: [429, 500, 503],
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  abortSignal?: AbortSignal,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (abortSignal?.aborted) throw new Error("Aborted");

    try {
      return await fn();
    } catch (err: any) {
      lastError = err;

      const statusCode = err.statusCode ?? err.status;
      if (!config.retryableStatusCodes.includes(statusCode)) {
        throw err;
      }

      if (attempt === config.maxRetries) throw err;

      // 指数退避 + 抖动
      const delay = Math.min(
        config.baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000,
        config.maxDelayMs,
      );

      // 429 时优先使用 retry-after 头
      let waitMs = delay;
      if (statusCode === 429 && err.retryAfterMs) {
        waitMs = err.retryAfterMs;
      }

      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }

  throw lastError!;
}
```

---

## 14. 嵌入模型适配

### 14.1 EmbeddingProvider 接口

```typescript
// src/provider/manager.ts (已有抽象类)
export abstract class EmbeddingProvider {
  providerConfig: Record<string, unknown> = {};
  abstract getEmbedding(text: string): Promise<number[]>;
  abstract getEmbeddings(texts: string[]): Promise<number[][]>;
  abstract getDim(): number;
}
```

### 14.2 各 API 嵌入端点与特性对比

| 维度 | OpenAI | Gemini | Anthropic |
|------|--------|--------|-----------|
| 端点 | `POST /v1/embeddings` | `POST /v1/models/{model}:embedContent` | 不提供嵌入 API |
| 认证 | `Authorization: Bearer <key>` | `x-goog-api-key: <key>` | - |
| 批量 | `input: string[]` | `requests: [{ model, content }]` | - |
| 模型 | `text-embedding-3-small/large`, `text-embedding-ada-002` | `text-embedding-004`, `embedding-001` | - |
| 维度 | 1536 / 3072 (可降维) | 768 / 256 | - |
| 最大输入 | 8191 tokens | 2048 tokens | - |

> **注意**：Anthropic 不提供嵌入 API。使用 Anthropic 作为 LLM Provider 时，嵌入模型需搭配 OpenAI 或 Gemini 的嵌入实现。

### 14.3 OpenAI Embedding 适配

#### 请求格式

```typescript
interface OpenAIEmbeddingRequest {
  model: string;                           // text-embedding-3-small 等
  input: string | string[];                // 单条或批量
  dimensions?: number;                     // 降维目标维度 (text-embedding-3-* 支持)
  encoding_format?: "float" | "base64";    // 默认 float
}
```

#### 响应格式

```typescript
interface OpenAIEmbeddingResponse {
  object: "list";
  data: Array<{
    object: "embedding";
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}
```

#### Provider 实现

```typescript
// src/provider/implementations/openai-embedding-provider.ts
export interface OpenAIEmbeddingConfig {
  apiKey: string;
  baseUrl: string;
  model: string;                           // text-embedding-3-small 等
  dimensions?: number;                     // 降维维度
}

export class OpenAIEmbeddingProvider extends EmbeddingProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private dimensions?: number;
  private cachedDim: number | null = null;

  constructor(config: OpenAIEmbeddingConfig) {
    super();
    this.providerConfig = config;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    this.model = config.model;
    this.dimensions = config.dimensions;
  }

  async getEmbedding(text: string): Promise<number[]> {
    const results = await this.getEmbeddings([text]);
    return results[0];
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: texts,
      encoding_format: "float",
    };
    if (this.dimensions) body.dimensions = this.dimensions;

    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`OpenAI Embedding API error: ${resp.status} ${errorText}`);
    }

    const data: OpenAIEmbeddingResponse = await resp.json();

    // 按 index 排序确保顺序一致
    const sorted = data.data.sort((a, b) => a.index - b.index);
    const embeddings = sorted.map(d => d.embedding);

    // 缓存维度
    if (!this.cachedDim && embeddings.length > 0) {
      this.cachedDim = embeddings[0].length;
    }

    return embeddings;
  }

  getDim(): number {
    if (this.cachedDim) return this.cachedDim;

    // 根据模型返回默认维度
    const modelDims: Record<string, number> = {
      "text-embedding-3-small": 1536,
      "text-embedding-3-large": 3072,
      "text-embedding-ada-002": 1536,
    };
    if (this.dimensions) return this.dimensions;
    return modelDims[this.model] ?? 1536;
  }
}
```

### 14.4 Gemini Embedding 适配

#### 请求格式

```typescript
// 单条嵌入
interface GeminiEmbedRequest {
  model: string;              // models/text-embedding-004
  content: {
    parts: [{ text: string }];
  };
  taskType?: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT" | "SEMANTIC_SIMILARITY"
           | "CLASSIFICATION" | "CLUSTERING" | "QUESTION_ANSWERING"
           | "FACT_VERIFICATION";
  title?: string;             // 仅 RETRIEVAL_DOCUMENT 时可用
}

// 批量嵌入
interface GeminiBatchEmbedRequest {
  requests: GeminiEmbedRequest[];
}
```

#### 响应格式

```typescript
// 单条
interface GeminiEmbedResponse {
  embedding: {
    values: number[];
  };
}

// 批量
interface GeminiBatchEmbedResponse {
  embeddings: Array<{
    values: number[];
  }>;
}
```

#### Provider 实现

```typescript
// src/provider/implementations/gemini-embedding-provider.ts
export interface GeminiEmbeddingConfig {
  apiKey: string;
  baseUrl: string;
  model: string;              // text-embedding-004 等
  taskType?: string;          // 默认 RETRIEVAL_DOCUMENT
}

export class GeminiEmbeddingProvider extends EmbeddingProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private taskType: string;
  private cachedDim: number | null = null;

  constructor(config: GeminiEmbeddingConfig) {
    super();
    this.providerConfig = config;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.model = config.model;
    this.taskType = config.taskType ?? "RETRIEVAL_DOCUMENT";
  }

  async getEmbedding(text: string): Promise<number[]> {
    const url = `${this.baseUrl}/models/${this.model}:embedContent?key=${this.apiKey}`;
    const body = {
      model: `models/${this.model}`,
      content: { parts: [{ text }] },
      taskType: this.taskType,
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Gemini Embedding API error: ${resp.status} ${errorText}`);
    }

    const data: GeminiEmbedResponse = await resp.json();
    if (!this.cachedDim) this.cachedDim = data.embedding.values.length;
    return data.embedding.values;
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    // Gemini 批量嵌入
    const url = `${this.baseUrl}/models/${this.model}:batchEmbedContents?key=${this.apiKey}`;
    const body = {
      requests: texts.map(text => ({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        taskType: this.taskType,
      })),
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Gemini Batch Embedding API error: ${resp.status} ${errorText}`);
    }

    const data: GeminiBatchEmbedResponse = await resp.json();
    const embeddings = data.embeddings.map(e => e.values);
    if (!this.cachedDim && embeddings.length > 0) {
      this.cachedDim = embeddings[0].length;
    }
    return embeddings;
  }

  getDim(): number {
    if (this.cachedDim) return this.cachedDim;
    const modelDims: Record<string, number> = {
      "text-embedding-004": 768,
      "embedding-001": 768,
      "text-multilingual-embedding-002": 256,
    };
    return modelDims[this.model] ?? 768;
  }
}
```

### 14.5 EmbeddingProvider 工厂注册

```typescript
// src/provider/factory.ts 扩展
export type EmbeddingProviderTypeKey = "openai_embedding" | "gemini_embedding";

const EMBEDDING_FACTORIES: Map<EmbeddingProviderTypeKey, (config: any) => EmbeddingProvider> = new Map();

export function registerEmbeddingFactory(key: EmbeddingProviderTypeKey, factory: (config: any) => EmbeddingProvider): void {
  EMBEDDING_FACTORIES.set(key, factory);
}

export function createEmbeddingProvider(key: EmbeddingProviderTypeKey, config: any): EmbeddingProvider {
  const factory = EMBEDDING_FACTORIES.get(key);
  if (!factory) throw new Error(`Unknown embedding provider type: ${key}`);
  return factory(config);
}

registerEmbeddingFactory("openai_embedding", (config) => new OpenAIEmbeddingProvider(config));
registerEmbeddingFactory("gemini_embedding", (config) => new GeminiEmbeddingProvider(config));
```

### 14.6 ProviderManager 嵌入 Provider 查找

```typescript
// ProviderManager 扩展
export class ProviderManager {
  // ... 已有字段 ...

  /**
   * 获取当前使用的嵌入 Provider
   */
  getUsingEmbeddingProvider(umo?: string): EmbeddingProvider | null {
    if (this.embeddingInsts.length === 0) return null;
    return this.embeddingInsts[0];
  }

  /**
   * 根据 ID 获取嵌入 Provider
   */
  getEmbeddingProviderById(id: string): EmbeddingProvider | null {
    return this.embeddingInsts.find(p => (p.providerConfig as any).id === id) ?? null;
  }

  /**
   * 注册嵌入 Provider
   */
  registerEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingInsts.push(provider);
  }
}
```

---

## 15. 重排序模型适配

### 15.1 RerankProvider 接口

```typescript
// src/provider/manager.ts (已有抽象类)
export interface RerankResult {
  index: number;              // 原始文档列表中的索引
  relevanceScore: number;    // 相关性分数
  document: { text: string };
}

export abstract class RerankProvider {
  providerConfig: Record<string, unknown> = {};
  abstract rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]>;
}
```

### 15.2 各 API 重排序端点与特性对比

| 维度 | Cohere | Jina AI | Voyage AI |
|------|--------|---------|-----------|
| 端点 | `POST /v1/rerank` | `POST /v1/rerank` | `POST /v1/rerank` |
| 认证 | `Authorization: Bearer <key>` | `Authorization: Bearer <key>` | `Authorization: Bearer <key>` |
| 模型 | `rerank-v3.5`, `rerank-english-v3.0` | `jina-reranker-v2-base-multilingual` | `rerank-2`, `rerank-2-lite` |
| 最大文档数 | 1000 | 1000 | 1000 |
| 最大查询长度 | 4096 tokens | 8192 tokens | 32000 tokens |
| 最大文档长度 | 4096 tokens | 8192 tokens | 32000 tokens |
| 返回分数 | 归一化 [0, 1] | 归一化 [0, 1] | 归一化 [0, 1] |

> **注意**：OpenAI、Gemini、Anthropic 均不提供重排序 API。重排序通常由 Cohere、Jina AI、Voyage AI 等专业服务提供。OpenAI 兼容 API 的第三方服务（如 DashScope/通义、SiliconFlow）也可能提供 rerank 端点。

### 15.3 通用 Rerank API 适配

大多数重排序 API 遵循类似的请求/响应格式（Cohere 风格已成为事实标准）：

#### 请求格式

```typescript
interface RerankRequest {
  model: string;
  query: string;
  documents: string[];
  top_n?: number;               // 返回前 N 个结果
  return_documents?: boolean;    // 是否返回文档原文
}
```

#### 响应格式

```typescript
interface RerankResponse {
  id: string;
  results: Array<{
    index: number;
    relevance_score: number;
    document?: { text: string };
  }>;
  meta?: {
    api: { version: string };
    billed_units: { input_tokens: number; output_tokens: number };
  };
}
```

#### 通用 Provider 实现

```typescript
// src/provider/implementations/generic-rerank-provider.ts
export interface GenericRerankConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxDocuments?: number;        // 默认 1000
}

export class GenericRerankProvider extends RerankProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private maxDocuments: number;

  constructor(config: GenericRerankConfig) {
    super();
    this.providerConfig = config;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    this.maxDocuments = config.maxDocuments ?? 1000;
  }

  async rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]> {
    // 限制文档数量
    const docs = documents.slice(0, this.maxDocuments);

    const body: Record<string, unknown> = {
      model: this.model,
      query,
      documents: docs,
      return_documents: true,
    };
    if (topN) body.top_n = topN;

    const resp = await fetch(`${this.baseUrl}/rerank`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Rerank API error: ${resp.status} ${errorText}`);
    }

    const data: RerankResponse = await resp.json();

    return data.results.map(r => ({
      index: r.index,
      relevanceScore: r.relevance_score,
      document: { text: r.document?.text ?? docs[r.index] ?? "" },
    }));
  }
}
```

### 15.4 预置 Rerank Provider 配置

```typescript
// 常用重排序服务预置配置
export const PRESET_RERANK_CONFIGS = {
  cohere: {
    baseUrl: "https://api.cohere.ai/v1",
    model: "rerank-v3.5",
  },
  jina: {
    baseUrl: "https://api.jina.ai/v1",
    model: "jina-reranker-v2-base-multilingual",
  },
  voyage: {
    baseUrl: "https://api.voyageai.com/v1",
    model: "rerank-2",
  },
  siliconflow: {
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "BAAI/bge-reranker-v2-m3",
  },
  dashscope: {
    baseUrl: "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-ranking",
    model: "gte-rerank",
  },
} as const;
```

### 15.5 RerankProvider 工厂注册

```typescript
// src/provider/factory.ts 扩展
export type RerankProviderTypeKey = "cohere" | "jina" | "voyage" | "generic";

const RERANK_FACTORIES: Map<RerankProviderTypeKey, (config: any) => RerankProvider> = new Map();

export function registerRerankFactory(key: RerankProviderTypeKey, factory: (config: any) => RerankProvider): void {
  RERANK_FACTORIES.set(key, factory);
}

export function createRerankProvider(key: RerankProviderTypeKey, config: any): RerankProvider {
  const factory = RERANK_FACTORIES.get(key);
  if (!factory) throw new Error(`Unknown rerank provider type: ${key}`);
  return factory(config);
}

// 所有 rerank provider 使用通用实现，仅 baseUrl/model 不同
for (const [key, preset] of Object.entries(PRESET_RERANK_CONFIGS)) {
  registerRerankFactory(key as RerankProviderTypeKey, (config) => {
    return new GenericRerankProvider({
      ...preset,
      ...config,
      baseUrl: config.baseUrl ?? preset.baseUrl,
      model: config.model ?? preset.model,
    });
  });
}
registerRerankFactory("generic", (config) => new GenericRerankProvider(config));
```

### 15.6 ProviderManager 重排序 Provider 查找

```typescript
// ProviderManager 扩展
export class ProviderManager {
  // ... 已有字段 ...

  /**
   * 获取当前使用的重排序 Provider
   */
  getUsingRerankProvider(umo?: string): RerankProvider | null {
    if (this.rerankInsts.length === 0) return null;
    return this.rerankInsts[0];
  }

  /**
   * 根据 ID 获取重排序 Provider
   */
  getRerankProviderById(id: string): RerankProvider | null {
    return this.rerankInsts.find(p => (p.providerConfig as any).id === id) ?? null;
  }

  /**
   * 注册重排序 Provider
   */
  registerRerankProvider(provider: RerankProvider): void {
    this.rerankInsts.push(provider);
  }
}
```

---

## 16. 知识库检索集成

### 16.1 知识库检索架构

```
用户消息 (MessageEvent)
  │
  ▼
ProcessStage → applyKnowledgeBase()
  │
  ▼
KnowledgeBaseManager.retrieve(query, kbNames)
  │
  ├── 1. 查询嵌入: EmbeddingProvider.getEmbedding(query)
  │
  ├── 2. 向量检索: VectorStore.search(embedding, topK)
  │       └── 返回候选文档片段 (dense retrieval)
  │
  ├── 3. (可选) 稀疏检索: BM25/Sparse.search(query, topK)
  │       └── 返回候选文档片段 (sparse retrieval)
  │
  ├── 4. 结果融合: Reciprocal Rank Fusion (RRF)
  │       └── 合并 dense + sparse 结果
  │
  ├── 5. (可选) 重排序: RerankProvider.rerank(query, docs, topM)
  │       └── 精排后返回最相关文档
  │
  └── 6. 拼接上下文 → 注入 LLM 请求
```

### 16.2 KnowledgeBase 数据模型

```typescript
// src/knowledge-base/types.ts
export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  emoji: string;
  embeddingProviderId: string;     // 关联的嵌入 Provider ID
  rerankProviderId: string | null; // 关联的重排序 Provider ID (可选)
  chunkSize: number;               // 文档分块大小 (字符数)
  chunkOverlap: number;            // 分块重叠 (字符数)
  topKDense: number;               // 向量检索返回数
  topKSparse: number;              // 稀疏检索返回数
  topMFinal: number;               // 最终返回数 (重排序后)
}

export interface KBDocument {
  id: string;
  kbId: string;
  name: string;
  url: string;                     // 文档来源 URL
  type: string;                    // pdf / txt / md / url 等
  createdAt: Date;
  chunkCount: number;
}

export interface KBChunk {
  id: string;
  docId: string;
  kbId: string;
  content: string;                 // 文本内容
  index: number;                   // 在文档中的分块序号
  embedding?: number[];            // 向量嵌入
}
```

### 16.3 VectorStore 抽象

```typescript
// src/knowledge-base/vector-store.ts
export interface VectorSearchResult {
  chunkId: string;
  content: string;
  score: number;                   // 相似度分数
  docName: string;
  metadata?: Record<string, unknown>;
}

export abstract class VectorStore {
  abstract initialize(): Promise<void>;
  abstract close(): Promise<void>;

  /** 插入向量 */
  abstract upsert(chunkId: string, embedding: number[], metadata: {
    content: string;
    docId: string;
    docName: string;
    index: number;
  }): Promise<void>;

  /** 批量插入 */
  abstract batchUpsert(items: Array<{
    chunkId: string;
    embedding: number[];
    metadata: { content: string; docId: string; docName: string; index: number };
  }>): Promise<void>;

  /** 向量检索 */
  abstract search(
    queryEmbedding: number[],
    topK: number,
  ): Promise<VectorSearchResult[]>;

  /** 删除文档的所有分块 */
  abstract deleteByDocId(docId: string): Promise<void>;

  /** 删除知识库的所有数据 */
  abstract deleteByKbId(kbId: string): Promise<void>;

  /** 获取分块数量 */
  abstract count(kbId?: string): Promise<number>;
}
```

### 16.4 内置向量存储实现

#### InMemoryVectorStore

```typescript
// src/knowledge-base/stores/in-memory-vector-store.ts
export class InMemoryVectorStore extends VectorStore {
  private entries: Map<string, {
    embedding: number[];
    content: string;
    docId: string;
    docName: string;
    index: number;
  }> = new Map();

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async upsert(chunkId: string, embedding: number[], metadata: any): Promise<void> {
    this.entries.set(chunkId, { embedding, ...metadata });
  }

  async batchUpsert(items: any[]): Promise<void> {
    for (const item of items) {
      await this.upsert(item.chunkId, item.embedding, item.metadata);
    }
  }

  async search(queryEmbedding: number[], topK: number): Promise<VectorSearchResult[]> {
    const results: Array<{ chunkId: string; score: number; content: string; docName: string }> = [];

    for (const [chunkId, entry] of this.entries) {
      const score = cosineSimilarity(queryEmbedding, entry.embedding);
      results.push({ chunkId, score, content: entry.content, docName: entry.docName });
    }

    // 按相似度降序排列
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK).map(r => ({
      chunkId: r.chunkId,
      content: r.content,
      score: r.score,
      docName: r.docName,
    }));
  }

  async deleteByDocId(docId: string): Promise<void> {
    for (const [id, entry] of this.entries) {
      if (entry.docId === docId) this.entries.delete(id);
    }
  }

  async deleteByKbId(kbId: string): Promise<void> {
    // InMemory 不按 kbId 分区，需在 metadata 中添加 kbId
    this.entries.clear();
  }

  async count(kbId?: string): Promise<number> {
    return this.entries.size;
  }
}

/** 余弦相似度 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}
```

### 16.5 文档分块器

```typescript
// src/knowledge-base/chunker.ts
export interface ChunkerConfig {
  chunkSize: number;       // 分块大小 (字符数)，默认 500
  chunkOverlap: number;    // 重叠字符数，默认 50
  separator?: string;       // 分隔符，默认 "\n\n"
}

export class TextChunker {
  private config: ChunkerConfig;

  constructor(config?: Partial<ChunkerConfig>) {
    this.config = {
      chunkSize: config?.chunkSize ?? 500,
      chunkOverlap: config?.chunkOverlap ?? 50,
      separator: config?.separator ?? "\n\n",
    };
  }

  /**
   * 将文本分块
   */
  chunk(text: string): string[] {
    const chunks: string[] = [];

    // 先按分隔符拆分
    const paragraphs = text.split(this.config.separator!).filter(Boolean);

    let currentChunk = "";

    for (const paragraph of paragraphs) {
      // 如果当前块 + 新段落不超过大小限制，合并
      if (currentChunk.length + paragraph.length + this.config.separator!.length <= this.config.chunkSize) {
        currentChunk = currentChunk ? currentChunk + this.config.separator! + paragraph : paragraph;
      } else {
        // 当前块已满，保存
        if (currentChunk) chunks.push(currentChunk);

        // 如果单个段落超过 chunkSize，需要硬切分
        if (paragraph.length > this.config.chunkSize) {
          const hardChunks = this.hardSplit(paragraph);
          chunks.push(...hardChunks.slice(0, -1));
          currentChunk = hardChunks[hardChunks.length - 1];
        } else {
          currentChunk = paragraph;
        }
      }
    }

    if (currentChunk) chunks.push(currentChunk);

    // 添加重叠
    return this.addOverlap(chunks);
  }

  private hardSplit(text: string): string[] {
    const result: string[] = [];
    for (let i = 0; i < text.length; i += this.config.chunkSize) {
      result.push(text.slice(i, i + this.config.chunkSize));
    }
    return result;
  }

  private addOverlap(chunks: string[]): string[] {
    if (this.config.chunkOverlap <= 0 || chunks.length <= 1) return chunks;

    const result: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      let chunk = chunks[i];
      if (i > 0) {
        const prevChunk = chunks[i - 1];
        const overlapText = prevChunk.slice(-this.config.chunkOverlap);
        chunk = overlapText + this.config.separator! + chunk;
      }
      result.push(chunk);
    }
    return result;
  }
}
```

### 16.6 KnowledgeBaseManager 完整实现

```typescript
// src/knowledge-base/manager.ts
export class KnowledgeBaseManager {
  private providerManager: ProviderManager;
  private kbs: Map<string, KnowledgeBase> = new Map();
  private kbHelpers: Map<string, KBHelper> = new Map();
  private vectorStore: VectorStore;
  private chunker: TextChunker;

  constructor(providerManager: ProviderManager) {
    this.providerManager = providerManager;
    this.vectorStore = new InMemoryVectorStore();
    this.chunker = new TextChunker();
  }

  async initialize(): Promise<void> {
    await this.vectorStore.initialize();
  }

  async terminate(): Promise<void> {
    await this.vectorStore.close();
  }

  /**
   * 创建知识库
   */
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
  }): Promise<KBHelper> {
    const kbId = generateId();
    const kb: KnowledgeBase = {
      id: kbId,
      name: options.kbName,
      description: options.description ?? "",
      emoji: options.emoji ?? "📚",
      embeddingProviderId: options.embeddingProviderId,
      rerankProviderId: options.rerankProviderId ?? null,
      chunkSize: options.chunkSize ?? 500,
      chunkOverlap: options.chunkOverlap ?? 50,
      topKDense: options.topKDense ?? 5,
      topKSparse: options.topKSparse ?? 5,
      topMFinal: options.topMFinal ?? 3,
    };

    // 验证嵌入 Provider 存在
    const embeddingProvider = this.providerManager.getEmbeddingProviderById(kb.embeddingProviderId);
    if (!embeddingProvider) {
      throw new Error(`Embedding provider not found: ${kb.embeddingProviderId}`);
    }

    // 验证重排序 Provider (如果指定)
    let rerankProvider: RerankProvider | null = null;
    if (kb.rerankProviderId) {
      rerankProvider = this.providerManager.getRerankProviderById(kb.rerankProviderId);
      if (!rerankProvider) {
        throw new Error(`Rerank provider not found: ${kb.rerankProviderId}`);
      }
    }

    this.kbs.set(kbId, kb);
    const helper = new KBHelper(kb, embeddingProvider, rerankProvider, this.vectorStore, this.chunker);
    this.kbHelpers.set(kbId, helper);

    return helper;
  }

  /**
   * 上传文档到知识库
   */
  async uploadFromUrl(kbId: string, url: string, options?: Record<string, unknown>): Promise<KBDocument> {
    const helper = this.kbHelpers.get(kbId);
    if (!helper) throw new Error(`Knowledge base not found: ${kbId}`);
    return helper.uploadFromUrl(url, options);
  }

  /**
   * 上传文本到知识库
   */
  async uploadText(kbId: string, text: string, docName: string): Promise<KBDocument> {
    const helper = this.kbHelpers.get(kbId);
    if (!helper) throw new Error(`Knowledge base not found: ${kbId}`);
    return helper.uploadText(text, docName);
  }

  /**
   * 检索知识库
   */
  async retrieve(query: string, kbNames: string[], topKFusion?: number, topMFinal?: number): Promise<string | null> {
    const allResults: VectorSearchResult[] = [];

    for (const kbName of kbNames) {
      const helper = this.getKbByName(kbName);
      if (!helper) continue;

      const results = await helper.search(query, topKFusion);
      allResults.push(...results);
    }

    if (allResults.length === 0) return null;

    // 去重 + 按分数排序
    const unique = new Map<string, VectorSearchResult>();
    for (const r of allResults) {
      if (!unique.has(r.chunkId) || unique.get(r.chunkId)!.score < r.score) {
        unique.set(r.chunkId, r);
      }
    }

    const sorted = [...unique.values()].sort((a, b) => b.score - a.score);
    const finalCount = topMFinal ?? 3;
    const topResults = sorted.slice(0, finalCount);

    // 拼接为上下文文本
    return topResults
      .map((r, i) => `[${i + 1}] (来源: ${r.docName}, 相关度: ${r.score.toFixed(3)})\n${r.content}`)
      .join("\n\n---\n\n");
  }

  getKb(kbId: string): KBHelper | null {
    return this.kbHelpers.get(kbId) ?? null;
  }

  getKbByName(kbName: string): KBHelper | null {
    for (const [_, kb] of this.kbs) {
      if (kb.name === kbName) return this.kbHelpers.get(kb.id) ?? null;
    }
    return null;
  }

  async deleteKb(kbId: string): Promise<boolean> {
    await this.vectorStore.deleteByKbId(kbId);
    this.kbs.delete(kbId);
    this.kbHelpers.delete(kbId);
    return true;
  }

  listKbs(): KnowledgeBase[] {
    return [...this.kbs.values()];
  }
}
```

### 16.7 KBHelper 内部辅助类

```typescript
// src/knowledge-base/kb-helper.ts
export class KBHelper {
  readonly kb: KnowledgeBase;
  private embeddingProvider: EmbeddingProvider;
  private rerankProvider: RerankProvider | null;
  private vectorStore: VectorStore;
  private chunker: TextChunker;
  private documents: Map<string, KBDocument> = new Map();

  constructor(
    kb: KnowledgeBase,
    embeddingProvider: EmbeddingProvider,
    rerankProvider: RerankProvider | null,
    vectorStore: VectorStore,
    chunker: TextChunker,
  ) {
    this.kb = kb;
    this.embeddingProvider = embeddingProvider;
    this.rerankProvider = rerankProvider;
    this.vectorStore = vectorStore;
    this.chunker = new TextChunker({
      chunkSize: kb.chunkSize,
      chunkOverlap: kb.chunkOverlap,
    });
  }

  /**
   * 上传文档
   */
  async uploadFromUrl(url: string, options?: Record<string, unknown>): Promise<KBDocument> {
    // 下载文档内容
    const resp = await fetch(url);
    if (!resp.ok) throw new KnowledgeBaseUploadError(`Failed to fetch: ${url}`);
    const text = await resp.text();

    const docName = url.split("/").pop() ?? url;
    return this.uploadText(text, docName, url);
  }

  /**
   * 上传文本内容
   */
  async uploadText(text: string, docName: string, url?: string): Promise<KBDocument> {
    const docId = generateId();
    const doc: KBDocument = {
      id: docId,
      kbId: this.kb.id,
      name: docName,
      url: url ?? "",
      type: this.detectDocType(docName),
      createdAt: new Date(),
      chunkCount: 0,
    };

    // 分块
    const chunks = this.chunker.chunk(text);
    doc.chunkCount = chunks.length;

    // 批量嵌入
    const embeddings = await this.embeddingProvider.getEmbeddings(chunks);

    // 写入向量存储
    const items = chunks.map((content, i) => ({
      chunkId: `${docId}_chunk_${i}`,
      embedding: embeddings[i],
      metadata: {
        content,
        docId,
        docName,
        index: i,
      },
    }));

    await this.vectorStore.batchUpsert(items);
    this.documents.set(docId, doc);

    return doc;
  }

  /**
   * 检索
   */
  async search(query: string, topK?: number): Promise<VectorSearchResult[]> {
    const k = topK ?? this.kb.topKDense;

    // 1. 查询嵌入
    const queryEmbedding = await this.embeddingProvider.getEmbedding(query);

    // 2. 向量检索
    const denseResults = await this.vectorStore.search(queryEmbedding, k);

    // 3. 如果有重排序 Provider，执行重排序
    if (this.rerankProvider && denseResults.length > 0) {
      const documents = denseResults.map(r => r.content);
      const rerankResults = await this.rerankProvider.rerank(
        query,
        documents,
        this.kb.topMFinal,
      );

      // 将重排序结果映射回 VectorSearchResult
      return rerankResults.map(rr => ({
        chunkId: denseResults[rr.index]?.chunkId ?? "",
        content: rr.document.text,
        score: rr.relevanceScore,
        docName: denseResults[rr.index]?.docName ?? "",
      }));
    }

    // 4. 无重排序，直接返回 topMFinal 个结果
    return denseResults.slice(0, this.kb.topMFinal);
  }

  private detectDocType(name: string): string {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const typeMap: Record<string, string> = {
      pdf: "pdf", txt: "txt", md: "markdown", markdown: "markdown",
      json: "json", csv: "csv", html: "html", htm: "html",
    };
    return typeMap[ext] ?? "unknown";
  }
}
```

### 16.8 知识库在管线中的集成

#### ProcessStage 中的知识库注入

```typescript
// src/pipeline/stages/process.ts (知识库注入部分)
async process(event: MessageEvent): Promise<void> {
  const request = event.requestLlm(event.getMessageStr(), {
    imageUrls: event.getImageUrls(),
  });

  // 注入知识库
  const kbResult = await this.applyKnowledgeBase(event, request);
  if (kbResult) {
    request.systemPrompt = (request.systemPrompt ?? "") +
      `\n\n---\n以下是从知识库中检索到的相关信息，请参考这些信息回答用户的问题：\n\n${kbResult}`;
  }

  // 调用 LLM
  // ...
}

private async applyKnowledgeBase(
  event: MessageEvent,
  request: ProviderRequest,
): Promise<string | null> {
  // 从配置中获取关联的知识库名称
  const kbNames = this.ctx.config.knowledgeBaseNames;
  if (!kbNames || kbNames.length === 0) return null;

  return this.ctx.knowledgeBaseManager.retrieve(
    event.getMessageStr(),
    kbNames,
  );
}
```

#### AgentConfig 扩展

```typescript
// src/config/manager.ts 扩展
export interface AgentConfig {
  // ... 已有字段 ...

  // 知识库配置
  knowledgeBaseNames: string[];          // 关联的知识库名称列表
  knowledgeBaseTopKDense: number;        // 向量检索返回数，默认 5
  knowledgeBaseTopMFinal: number;       // 最终返回数，默认 3
  knowledgeBaseRerankEnabled: boolean;  // 是否启用重排序，默认 true
}

// createDefaultConfig 扩展
knowledgeBaseNames: [],
knowledgeBaseTopKDense: 5,
knowledgeBaseTopMFinal: 3,
knowledgeBaseRerankEnabled: true,
```

### 16.9 检索流程完整时序

```
用户: "什么是 RAG？"
  │
  ▼ ProcessStage.applyKnowledgeBase()
  │
  ├─ 1. EmbeddingProvider.getEmbedding("什么是 RAG？")
  │     └─ OpenAI: POST /v1/embeddings
  │        └─ 返回: [0.012, -0.034, ...] (1536维向量)
  │
  ├─ 2. VectorStore.search(embedding, topK=5)
  │     └─ InMemoryVectorStore: 余弦相似度计算
  │        └─ 返回: 5 个候选文档片段
  │
  ├─ 3. RerankProvider.rerank("什么是 RAG？", docs, topN=3)
  │     └─ Cohere: POST /v1/rerank
  │        └─ 返回: 精排后 3 个最相关片段
  │
  └─ 4. 拼接上下文
        └─ "[1] (来源: rag_intro.md, 相关度: 0.952)\nRAG 是检索增强生成..."
           "[2] (来源: rag_guide.md, 相关度: 0.891)\nRAG 的核心步骤..."
           "[3] (来源: rag_examples.md, 相关度: 0.834)\n以下是 RAG 的应用场景..."
  │
  ▼ 注入 systemPrompt → 调用 LLM
```

### 16.10 知识库配置示例

```typescript
// 配置示例：创建知识库并关联到 Agent
const providerManager = new ProviderManager();

// 注册嵌入 Provider
providerManager.registerEmbeddingProvider(new OpenAIEmbeddingProvider({
  id: "emb-openai",
  apiKey: "sk-xxx",
  model: "text-embedding-3-small",
  dimensions: 1536,
}));

// 注册重排序 Provider
providerManager.registerRerankProvider(new GenericRerankProvider({
  id: "rerank-cohere",
  apiKey: "xxx",
  baseUrl: "https://api.cohere.ai/v1",
  model: "rerank-v3.5",
}));

// 创建知识库
const kbManager = new KnowledgeBaseManager(providerManager);
await kbManager.initialize();

const kb = await kbManager.createKb({
  kbName: "product-docs",
  description: "产品文档知识库",
  embeddingProviderId: "emb-openai",
  rerankProviderId: "rerank-cohere",
  chunkSize: 500,
  chunkOverlap: 50,
  topKDense: 5,
  topMFinal: 3,
});

// 上传文档
await kbManager.uploadFromUrl(kb.kb.id, "https://example.com/docs/intro.md");
await kbManager.uploadFromUrl(kb.kb.id, "https://example.com/docs/api-reference.md");

// 配置 Agent 使用知识库
const agentConfig = configManager.createDefaultConfig("agent-1");
agentConfig.knowledgeBaseNames = ["product-docs"];
agentConfig.knowledgeBaseTopKDense = 5;
agentConfig.knowledgeBaseTopMFinal = 3;
agentConfig.knowledgeBaseRerankEnabled = true;
```

---

## 17. 目录结构

```
src/provider/
├── types.ts                          # ProviderType 枚举, ProviderMeta
├── provider.ts                       # Provider 接口, ProviderChatParams
├── manager.ts                        # ProviderManager, STT/TTS/Embedding/Rerank
├── modalities.ts                     # sanitizeContextsByModalities
├── factory.ts                        # Provider 工厂 (含 Embedding/Rerank 工厂)
├── retry.ts                          # 重试策略
├── errors.ts                         # API 错误类型
├── index.ts                          # 统一导出
├── converters/
│   ├── openai-converter.ts           # OpenAI Chat 消息转换
│   ├── openai-responses-converter.ts # OpenAI Responses 消息转换
│   ├── gemini-converter.ts           # Gemini 消息转换
│   ├── anthropic-converter.ts        # Anthropic 消息转换
│   └── index.ts                      # 转换器导出
├── parsers/
│   ├── sse-parser.ts                 # 通用 SSE 解析器
│   ├── openai-stream-parser.ts       # OpenAI Chat 流式解析
│   ├── openai-responses-parser.ts    # OpenAI Responses 流式解析
│   ├── gemini-stream-parser.ts       # Gemini 流式解析
│   ├── anthropic-stream-parser.ts    # Anthropic 流式解析
│   └── index.ts                      # 解析器导出
└── implementations/
    ├── openai-provider.ts            # OpenAI Chat Completions
    ├── openai-responses-provider.ts  # OpenAI Responses API
    ├── gemini-provider.ts            # Google Gemini
    ├── anthropic-provider.ts         # Anthropic
    ├── openai-embedding-provider.ts  # OpenAI Embedding (新增)
    ├── gemini-embedding-provider.ts   # Gemini Embedding (新增)
    ├── generic-rerank-provider.ts    # 通用 Rerank (Cohere/Jina/Voyage) (新增)
    └── index.ts                      # 实现导出

src/knowledge-base/
├── types.ts                          # KnowledgeBase, KBDocument, KBChunk 接口 (新增)
├── vector-store.ts                   # VectorStore 抽象 + VectorSearchResult (新增)
├── chunker.ts                        # TextChunker 文档分块器 (新增)
├── kb-helper.ts                      # KBHelper 单知识库检索逻辑 (新增)
├── manager.ts                        # KnowledgeBaseManager (已有，需完善)
├── stores/
│   └── in-memory-vector-store.ts    # InMemoryVectorStore (新增)
└── index.ts                          # 统一导出
```
