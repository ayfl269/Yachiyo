import type { ContentPart, Message } from "./llm-message.js";

// Token usage tracking
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  total: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

// Message chain for response data
export interface MessageChain {
  type: string;
  chain?: unknown[];
  message?: string;
}

export function createMessageChain(type: string, message?: string): MessageChain {
  return { type, message };
}

// LLM Response
export interface LLMResponse {
  role: "assistant" | "err";
  completionText?: string;
  reasoningContent?: string;
  reasoningSignature?: string;
  resultChain?: MessageChain;
  isChunk: boolean;
  usage?: TokenUsage;
  toolsCallName?: string[];
  toolsCallArgs?: Record<string, unknown>[];
  toolsCallIds?: string[];
}

export interface ToolSetInterface {
  empty(): boolean;
  openaiSchema(omitEmptyParameterField?: boolean): Record<string, unknown>[];
  anthropicSchema(): Record<string, unknown>[];
  googleSchema(): Record<string, unknown>;
}

// Provider request
export interface ProviderRequest {
  prompt?: string;
  imageUrls: string[];
  audioUrls: string[];
  contexts: Message[] | Record<string, unknown>[];
  systemPrompt?: string;
  funcTool?: ToolSetInterface;
  sessionId?: string;
  model?: string;
  conversation?: Conversation;
  extraUserContentParts: ContentPart[];
  temperature?: number;
}

// Conversation
export interface Conversation {
  id: string;
  unifiedMsgOrigin: string;
  personaId?: string;
  history: string;
  platformId?: string;
  tokenUsage?: number;
  createdAt: Date;
  updatedAt: Date;
}

// Provider configuration
export interface ProviderConfig {
  id?: string | number;
  maxContextTokens?: number;
  /**
   * Provider 支持的能力列表。已知值: "text", "image", "audio", "tool_use"。
   *
   * 语义:
   * - undefined / null: 视为全部支持（向后兼容，sanitizeContextsByModalities 直接返回原上下文）
   * - 显式数组: 仅当数组包含某能力时，对应上下文才保留；缺失的能力会被 sanitizer 抹除
   *
   * ⚠️ 危险: 若显式配置 modalities 但漏掉 "tool_use"，sanitizeContextsByModalities 会把
   * 所有 role:"tool" 消息转为 user，并删除 assistant 的 tool_calls —— 模型将完全丢失
   * 工具调用历史，导致不主动调用工具。
   *
   * Chat provider 通常应包含 ["text", "tool_use"]（多数现代 chat 模型都支持工具调用）。
   * ProviderManager.registerProvider 在 modalities 为 undefined 时会自动补全为
   * ["text", "tool_use"]；用户显式配置时以用户为准。
   */
  modalities?: string[];
  enableCaching?: boolean;
  [key: string]: unknown;
}

// Provider interface
export interface Provider {
  providerConfig: ProviderConfig;
  type: string;
  textChat(params: ProviderChatParams): Promise<LLMResponse>;
  textChatStream?(params: ProviderChatParams): AsyncGenerator<LLMResponse, void, unknown>;
  /** Release provider-held resources (server-side caches, connections, etc.). */
  dispose?(): Promise<void>;
}

export interface ProviderChatParams {
  contexts: Message[] | Record<string, unknown>[];
  funcTool?: ToolSetInterface;
  model?: string;
  sessionId?: string;
  extraUserContentParts?: ContentPart[];
  abortSignal?: AbortSignal;
  enableCaching?: boolean;
  temperature?: number;
}
