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
  /**
   * Whether LLM calls are streamed. Inherited from the parent run so
   * sub-agent handoffs use the same streaming configuration as the main
   * agent (`textChatStream` vs `textChat`). Set by
   * {@link ToolLoopAgentRunner.reset}; defaults to non-streaming when unset.
   */
  _streaming?: boolean;
  /**
   * Fallback providers inherited from the parent agent's run context.
   * Sub-agent handoff uses these when the sub-agent's primary provider
   * fails (empty output, network error, etc.), mirroring the main
   * agent's `iterLlmResponsesWithFallback` behaviour.
   *
   * Set by {@link ToolLoopAgentRunner.reset} on the main agent's
   * runContext; sub-agents inherit it via `createContextWrapper` /
   * the shallow copy in `executeHandoff`. May be undefined when no
   * fallback providers are configured.
   */
  _fallbackProviders?: Provider[];
  /**
   * Trace span attached by the pipeline layer ({@link PipelineScheduler})
   * so the agent runner and tool executor can record child events onto
   * the same trace without taking a hard dependency on the pipeline
   * package. The agent package only depends on the framework-agnostic
   * `TraceSpan` type from `@yachiyo/common/trace`.
   *
   * Undefined when trace is not configured (e.g. tests, standalone
   * usage). `recordTrace` helpers must no-op when this is undefined.
   */
  _traceSpan?: import("@yachiyo/common/trace.js").TraceSpan;
  /**
   * Handoff chain depth of the current run. The main agent runs at depth 0;
   * each `transfer_to_*` increments it. The tool executor refuses handoffs
   * beyond {@link MAX_HANDOFF_DEPTH} to bound recursion.
   */
  _handoffDepth?: number;
  /**
   * Effective sandbox policy governing the current run. Set by the tool
   * executor when a handoff creates a sub-agent context. When the current
   * agent performs another handoff, the executor intersects this policy
   * with the target agent's policy so a restricted sub-agent cannot
   * escalate privileges by transferring to an unrestricted one.
   */
  _sandboxPolicy?: import("./sandbox.js").SandboxPolicy;
  /**
   * Reasoning/thinking intensity inherited from the parent run. Sub-agent
   * handoffs read this so they honor the same effort as the main agent.
   */
  _reasoningEffort?: import("@yachiyo/common/llm-types.js").ReasoningEffort;
  /**
   * Effective reasoning effort for the CURRENT step, including any value chosen
   * by the automatic controller. Updated by the runner before each step; a
   * sub-agent handoff reads this so it inherits the parent's live (possibly
   * escalated) effort rather than only the static default.
   */
  _currentReasoningEffort?: import("@yachiyo/common/llm-types.js").ReasoningEffort;
  /**
   * Name of the agent owning the current run (sub-agent name for handoffs).
   * Undefined for the main agent. Used for diagnostics.
   */
  _agentName?: string;
  /**
   * Identity used as the {@link import("./coordination.js").FileLockManager}
   * holder for file operations in this run. Unique per run: the main agent
   * gets `main#<umo>#<uuid>` (set by `buildMainAgent`) and each handoff
   * invocation gets `<agentName>#<uuid>` (set by the tool executor). Without a
   * per-run identity, concurrent sessions shared the singleton `"__main__"`
   * holder and `FileLockManager.canGrant`'s same-holder re-entrancy let them
   * both take the "exclusive" write lock. When undefined (e.g. standalone tool
   * usage in tests), tools fall back to the `"__main__"` holder.
   */
  _lockHolderId?: string;
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

/**
 * Labels for which the "could not resolve an owner" warning has already been
 * emitted, so a context-shape refactor is logged once per tool family rather
 * than on every call.
 */
const ownerResolutionWarnedLabels = new Set<string>();

/**
 * Resolve the session owner (UMO) from a raw tool context.
 *
 * When invoked from the pipeline, the wrapper's `context` IS the MessageEvent
 * (it exposes `unifiedMsgOrigin` directly); standalone/test callers may instead
 * pass a `{ event: { unifiedMsgOrigin } }` shape or a non-event object such as
 * `createContextWrapper(null)`. Returns `undefined` when no owner can be
 * determined.
 *
 * A missing owner is legitimate for standalone callers. But if a `context`
 * object IS present yet exposes no recognizable `unifiedMsgOrigin`, that means
 * an unknown context shape — warn once (per `warnLabel`) so a future context
 * refactor that silently disables per-session isolation is visible in logs.
 */
export function resolveToolContextOwner(
  ctx: unknown,
  options?: { warnLabel?: string; warnOnUnknownContext?: boolean },
): string | undefined {
  const wrapper = ctx as {
    context?: { unifiedMsgOrigin?: string; event?: { unifiedMsgOrigin?: string } };
  } | undefined;
  const context = wrapper?.context;

  if (typeof context?.unifiedMsgOrigin === "string" && context.unifiedMsgOrigin) {
    return context.unifiedMsgOrigin;
  }
  const nested = context?.event?.unifiedMsgOrigin;
  if (typeof nested === "string" && nested) {
    return nested;
  }

  if (
    options?.warnOnUnknownContext !== false &&
    context != null &&
    typeof context === "object"
  ) {
    const label = options?.warnLabel ?? "tool";
    if (!ownerResolutionWarnedLabels.has(label)) {
      ownerResolutionWarnedLabels.add(label);
      console.warn(
        `[${label}] Could not resolve a session owner from the tool context; ` +
        `per-session isolation is disabled for this tool. ` +
        `This likely means the tool context shape changed — update resolveToolContextOwner.`,
      );
    }
  }
  return undefined;
}

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
