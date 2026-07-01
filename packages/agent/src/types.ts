import type { Message } from "./message.js";
import type { Provider } from "@yachiyo/common/llm-types.js";

// Re-export extracted types for compatibility
export type {
  TokenUsage,
  MessageChain,
  LLMResponse,
  ProviderRequest,
  Conversation,
  ProviderConfig,
  Provider,
  ProviderChatParams,
} from "@yachiyo/common/llm-types.js";

export { createMessageChain } from "@yachiyo/common/llm-types.js";

// Agent state enum
export enum AgentState {
  IDLE = "IDLE",
  RUNNING = "RUNNING",
  DONE = "DONE",
  ERROR = "ERROR",
}

// Agent statistics
export interface AgentStats {
  tokenUsage: import("@yachiyo/common/llm-types.js").TokenUsage;
  startTime: number;
  endTime: number;
  timeToFirstToken: number;
}

export function createAgentStats(): AgentStats {
  return {
    tokenUsage: {
      promptTokens: 0,
      completionTokens: 0,
      total: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    startTime: 0,
    endTime: 0,
    timeToFirstToken: 0,
  };
}

export function getStatsDuration(stats: AgentStats): number {
  return stats.endTime - stats.startTime;
}

// Context wrapper - runtime context for agent execution
export interface ContextWrapper<TContext = unknown> {
  context: TContext;
  messages: Message[];
  toolCallTimeout: number;
  /**
   * AbortController for the currently-executing tool. Set by the tool
   * executor before each call and aborted on timeout so long-running
   * operations (shell, fetch, file I/O) can be cancelled cleanly.
   */
  _toolAbortController?: AbortController;
  _toolMgr?: import("./func-tool-manager.js").FunctionToolManager;
  _funcToolSet?: import("./tool.js").ToolSet;
  _provider?: Provider;
}

/**
 * Sentinel error class for tool execution timeouts. Using a dedicated
 * class instead of string matching on `e.message === "timeout"` avoids
 * misclassifying errors from third-party libraries that happen to use
 * the same message literal.
 */
export class ToolTimeoutError extends Error {
  public readonly timeoutSeconds: number;
  constructor(timeoutSeconds: number) {
    super(`Tool execution timeout after ${timeoutSeconds} seconds.`);
    this.name = "ToolTimeoutError";
    this.timeoutSeconds = timeoutSeconds;
  }
}

export function createContextWrapper<TContext = unknown>(
  context: TContext,
  options?: Partial<Pick<ContextWrapper<TContext>, "messages" | "toolCallTimeout">>
): ContextWrapper<TContext> {
  return {
    context,
    messages: options?.messages ?? [],
    toolCallTimeout: options?.toolCallTimeout ?? 120,
  };
}

// No-context type alias
export type NoContext = ContextWrapper<null>;

// Agent response data
export interface AgentResponseData {
  chain: import("@yachiyo/common/llm-types.js").MessageChain;
}

// Agent response types
export type AgentResponseType =
  | "streaming_delta"
  | "llm_result"
  | "tool_call"
  | "tool_call_result"
  | "err"
  | "aborted";

// Agent response
export interface AgentResponse {
  type: AgentResponseType;
  data: AgentResponseData;
}

// Tool calls result
export interface ToolCallsResult {
  toolCallsInfo: Message; // Assistant message with tool_calls
  toolCallsResult: Message[]; // Tool response messages
}

// CallToolResult (MCP Protocol)
export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string; // Base64 encoded
  mimeType: string;
}

export interface TextResourceContents {
  text: string;
  uri?: string;
  mimeType?: string;
}

export interface BlobResourceContents {
  blob: string; // Base64 encoded
  uri?: string;
  mimeType: string;
}

export interface EmbeddedResource {
  type: "resource";
  resource: TextResourceContents | BlobResourceContents;
}

export interface CallToolResult {
  content: (TextContent | ImageContent | EmbeddedResource)[];
  isError?: boolean;
}
