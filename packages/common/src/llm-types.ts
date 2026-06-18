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
  modalities?: string[];
  enableCaching?: boolean;
  [key: string]: unknown;
}

// Provider interface
export interface Provider {
  providerConfig: ProviderConfig;
  textChat(params: ProviderChatParams): Promise<LLMResponse>;
  textChatStream?(params: ProviderChatParams): AsyncGenerator<LLMResponse, void, unknown>;
}

export interface ProviderChatParams {
  contexts: Message[] | Record<string, unknown>[];
  funcTool?: ToolSetInterface;
  model?: string;
  sessionId?: string;
  extraUserContentParts?: ContentPart[];
  abortSignal?: AbortSignal;
  enableCaching?: boolean;
}
