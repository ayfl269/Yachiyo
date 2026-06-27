import { AgentState } from "../types.js";
import type {
  AgentResponse,
  AgentStats,
  CallToolResult,
  ContextWrapper,
  LLMResponse,
  Provider,
  ProviderChatParams,
  ProviderRequest,
  TextContent,
  ImageContent,
  EmbeddedResource,
  MessageChain,
} from "../types.js";
import { BaseAgentRunner } from "./base.js";
import type { BaseAgentRunHooks } from "../hooks.js";
import type { BaseFunctionToolExecutor } from "../tool-executor.js";
import { ToolSet } from "../tool.js";
import type { FunctionTool } from "../tool.js";
import { createContextConfig } from "../context/config.js";
import type { ContextConfig } from "../context/config.js";
import { ContextManager } from "../context/manager.js";
import { EstimateTokenCounter } from "../context/token-counter.js";
import type { TokenCounter } from "../context/token-counter.js";
import type { ContextCompressor } from "../context/compressor.js";
import {
  bindCheckpointMessages,
  validateMessage,
  serializeMessage,
  type Message,
} from "../message.js";
import { createAgentStats, createMessageChain } from "../types.js";
import { ToolTimeoutError } from "../types.js";
import { sanitizeContextsByModalities, logContextSanitizeStats } from "@yachiyo/provider/modalities.js";
import { toolImageCache } from "../tool-image-cache.js";
import type { CachedImage } from "../tool-image-cache.js";
import { resolveImageToDataUrl, resolveAudioToDataUrl } from "../download-utils.js";

// Constants
const TOOL_RESULT_MAX_ESTIMATED_TOKENS = 27_500;
const TOOL_RESULT_PREVIEW_MAX_ESTIMATED_TOKENS = 7_000;
const EMPTY_OUTPUT_RETRY_ATTEMPTS = 3; // 恢复为 3 次重试以应对偶发网络/API波动
const EMPTY_OUTPUT_RETRY_WAIT_MIN_S = 1; // 恢复最小等待时间 1 秒
const EMPTY_OUTPUT_RETRY_WAIT_MAX_S = 5; // 恢复最大等待时间 5 秒

const USER_INTERRUPTION_MESSAGE =
  "[SYSTEM: User actively interrupted the response generation. " +
  "Partial output before interruption is preserved.]";

const FOLLOW_UP_NOTICE_TEMPLATE =
  "\n\n[SYSTEM NOTICE] User sent follow-up messages while tool execution " +
  "was in progress. Prioritize these follow-up instructions in your next " +
  "actions. In your very next action, briefly acknowledge to the user " +
  "that their follow-up message(s) were received before continuing.\n" +
  "{followUpLines}";

const MAX_STEPS_REACHED_PROMPT =
  "Maximum tool call limit reached. " +
  "Stop calling tools, and based on the information you have gathered, " +
  "summarize your task and findings, and reply to the user directly.";

const SKILLS_LIKE_REQUERY_INSTRUCTION_TEMPLATE =
  "You have decided to call tool(s): {toolNames}. Now call the tool(s) " +
  "with required arguments using the tool schema, and follow the existing " +
  "tool-use rules.";

const SKILLS_LIKE_REQUERY_REPAIR_INSTRUCTION =
  "This is the second-stage tool execution step. " +
  "You must do exactly one of the following: " +
  "1. Call one of the selected tools using the provided tool schema. " +
  "2. If calling a tool is no longer possible or appropriate, reply to the user " +
  "with a brief explanation of why. " +
  "Do not return an empty response. " +
  "Do not ignore the selected tools without explanation.";

const REPEATED_TOOL_NOTICE_L1_THRESHOLD = 3;
const REPEATED_TOOL_NOTICE_L2_THRESHOLD = 4;
const REPEATED_TOOL_NOTICE_L3_THRESHOLD = 5;

const REPEATED_TOOL_NOTICE_L1_TEMPLATE =
  "\n\n[SYSTEM NOTICE] By the way, you have executed the same tool " +
  "`{toolName}` {streak} times consecutively. Double-check whether another " +
  "tool, different arguments, or a summary would move the task forward better.";

const REPEATED_TOOL_NOTICE_L2_TEMPLATE =
  "\n\n[SYSTEM NOTICE] Important: you have executed the same tool " +
  "`{toolName}` {streak} times consecutively. Unless this repetition is " +
  "clearly necessary, stop repeating the same action and either switch " +
  "tools, refine parameters, or summarize what is still missing.";

const REPEATED_TOOL_NOTICE_L3_TEMPLATE =
  "\n\n[SYSTEM NOTICE] Important: you have executed the same tool " +
  "`{toolName}` {streak} times consecutively. Repetition is now very " +
  "high. Continue only if each call is clearly producing new information. " +
  "Otherwise, change strategy, adjust arguments, or explain the limitation " +
  "to the user.";

const TOOL_RESULT_OVERFLOW_NOTICE_TEMPLATE =
  "Truncated tool output preview shown above. " +
  "The tool output was too large to include directly and was written to " +
  "`{overflowPath}`. Use {readToolHint} to inspect it. " +
  "Use a narrower window when reading large files.";

// Follow-up ticket
interface FollowUpTicket {
  seq: number;
  text: string;
  consumed: boolean;
  resolved: Promise<void>;
  resolveFn: () => void;
}

function createFollowUpTicket(seq: number, text: string): FollowUpTicket {
  let resolveFn!: () => void;
  const resolved = new Promise<void>((resolve) => { resolveFn = resolve; });
  return { seq, text, consumed: false, resolved, resolveFn };
}

// Tool execution interrupted error
class ToolExecutionInterrupted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionInterrupted";
  }
}

// Empty model output error
class EmptyModelOutputError extends Error {
  constructor() {
    super("Model returned empty output");
    this.name = "EmptyModelOutputError";
  }
}

// Reset parameters
export interface ToolLoopResetParams<TContext = unknown> {
  provider: Provider;
  request: ProviderRequest;
  runContext: ContextWrapper<TContext>;
  toolExecutor: BaseFunctionToolExecutor<TContext>;
  agentHooks: BaseAgentRunHooks<TContext>;
  streaming?: boolean;
  enforceMaxTurns?: number;
  llmCompressInstruction?: string;
  llmCompressKeepRecent?: number;
  llmCompressKeepRecentRatio?: number;
  llmCompressProvider?: Provider;
  truncateTurns?: number;
  customTokenCounter?: TokenCounter;
  customCompressor?: ContextCompressor;
  toolSchemaMode?: "full" | "skills_like";
  fallbackProviders?: Provider[];
  toolResultOverflowDir?: string;
  readTool?: FunctionTool;
}

export class ToolLoopAgentRunner<TContext = unknown> extends BaseAgentRunner<TContext> {
  // State
  private req!: ProviderRequest;
  private provider!: Provider;
  private fallbackProviders: Provider[] = [];
  /** 记录原始（首次选择的）provider，用于统计和日志，fallback 切换后仍保留 */
  private originalProvider!: Provider;
  private streaming = false;
  private toolExecutor!: BaseFunctionToolExecutor<TContext>;
  private agentHooks!: BaseAgentRunHooks<TContext>;
  private runContext!: ContextWrapper<TContext>;
  private finalLlmResp: LLMResponse | null = null;
  private aborted = false;
  private abortController = new AbortController();
  private pendingFollowUps: FollowUpTicket[] = [];
  private followUpSeq = 0;
  private lastToolName: string | null = null;
  private sameToolStreak = 0;
  private stats: AgentStats = createAgentStats();
  private contextManager!: ContextManager;
  private contextConfig!: ContextConfig;
  private toolSchemaMode: "full" | "skills_like" = "full";
  private toolSchemaParamSet: ToolSet | null = null;
  private skillLikeRawToolSet: ToolSet | null = null;
  private toolResultOverflowDir: string | null = null;
  private readTool: FunctionTool | null = null;
  private toolResultTokenCounter = new EstimateTokenCounter();

  async reset(
    runContext: ContextWrapper<TContext>,
    agentHooks: BaseAgentRunHooks<TContext>,
    ...args: unknown[]
  ): Promise<void> {
    const params = args[0] as ToolLoopResetParams<TContext>;
    if (!params) throw new Error("ToolLoopResetParams is required");

    this.req = params.request;
    this.streaming = params.streaming ?? false;
    this.provider = params.provider;
    this.originalProvider = params.provider; // 记录原始 provider，fallback 后不丢失
    this.finalLlmResp = null;
    this.state = AgentState.IDLE;
    this.toolExecutor = params.toolExecutor;
    this.agentHooks = params.agentHooks;
    this.runContext = runContext;
    if (this.req.funcTool) {
      this.runContext._funcToolSet = this.req.funcTool as ToolSet;
    }
    this.runContext._provider = this.provider;
    this.aborted = false;
    this.abortController = new AbortController();
    this.pendingFollowUps = [];
    this.followUpSeq = 0;
    this.lastToolName = null;
    this.sameToolStreak = 0;
    this.toolResultOverflowDir = params.toolResultOverflowDir ?? null;
    this.readTool = params.readTool ?? null;
    this.toolResultTokenCounter = new EstimateTokenCounter();

    // Deduplicate fallback providers
    this.fallbackProviders = [];
    const seenProviderIds = new Set([String(this.provider.providerConfig.id ?? "")]);
    for (const fb of params.fallbackProviders ?? []) {
      const fbId = String(fb.providerConfig.id ?? "");
      if (fb === this.provider) continue;
      if (fbId && seenProviderIds.has(fbId)) continue;
      this.fallbackProviders.push(fb);
      if (fbId) seenProviderIds.add(fbId);
    }

    // Build context config
    this.contextConfig = createContextConfig({
      maxContextTokens: this.provider.providerConfig.maxContextTokens ?? 0,
      enforceMaxTurns: params.enforceMaxTurns ?? -1,
      truncateTurns: params.truncateTurns ?? 1,
      llmCompressInstruction: params.llmCompressInstruction,
      llmCompressKeepRecent: params.llmCompressKeepRecent ?? 0,
      llmCompressKeepRecentRatio: params.llmCompressKeepRecentRatio ?? 0.15,
      llmCompressProvider: params.llmCompressProvider,
      customTokenCounter: params.customTokenCounter,
      customCompressor: params.customCompressor,
    });
    this.contextManager = new ContextManager(this.contextConfig);

    // Skills-like mode setup
    this.toolSchemaMode = params.toolSchemaMode ?? "full";
    this.toolSchemaParamSet = null;
    this.skillLikeRawToolSet = null;

    if (this.toolSchemaMode === "skills_like") {
      const toolSet = this.req.funcTool as ToolSet;
      if (toolSet) {
        this.skillLikeRawToolSet = toolSet;
        const lightSet = toolSet.getLightToolSet();
        this.toolSchemaParamSet = toolSet.getParamOnlyToolSet();
        this.req.funcTool = lightSet;
      }
    }

    // Build initial message list
    const messages = bindCheckpointMessages(
      (this.req.contexts ?? []) as Record<string, unknown>[]
    );

    // Append current user message
    if (
      this.req.prompt ||
      (this.req.imageUrls && this.req.imageUrls.length > 0) ||
      (this.req.audioUrls && this.req.audioUrls.length > 0) ||
      (this.req.extraUserContentParts && this.req.extraUserContentParts.length > 0)
    ) {
      const userMsg = await this.assembleRequestContextForProvider(this.req);
      messages.push(validateMessage(userMsg));
    }

    // Insert system prompt at the beginning
    if (this.req.systemPrompt) {
      messages.unshift({ role: "system", content: this.req.systemPrompt });
    }

    this.runContext.messages = messages;
    this.stats = createAgentStats();
    this.stats.startTime = Date.now();
  }

  private readToolHint(): string {
    if (this.readTool) return `\`${this.readTool.name}\``;
    return "the available file-read tool";
  }

  private async assembleRequestContextForProvider(
    request: ProviderRequest
  ): Promise<Record<string, unknown>> {
    const modalities = this.provider.providerConfig.modalities;
    if (!Array.isArray(modalities)) {
      return this.assembleContextDefault(request);
    }

    const supportsImage = modalities.includes("image");
    const supportsAudio = modalities.includes("audio");
    if (supportsImage && supportsAudio) {
      return this.assembleContextDefault(request);
    }

    const contentBlocks: Record<string, unknown>[] = [];
    if (request.prompt) {
      contentBlocks.push({ type: "text", text: request.prompt });
    }

    const imageUrls = supportsImage ? request.imageUrls : [];
    const audioUrls = supportsAudio ? request.audioUrls : [];

    for (const url of imageUrls) {
      // Download remote images and convert to base64 data URLs
      const dataUrl = await resolveImageToDataUrl(url);
      contentBlocks.push({ type: "image_url", image_url: { url: dataUrl ?? url } });
    }
    for (const url of audioUrls) {
      // Download remote audio and convert to base64 data URLs
      const dataUrl = await resolveAudioToDataUrl(url);
      contentBlocks.push({ type: "audio_url", audio_url: { url: dataUrl ?? url } });
    }
    if (!supportsImage) {
      for (const _ of request.imageUrls ?? []) {
        contentBlocks.push({ type: "text", text: "[Image]" });
      }
    }
    if (!supportsAudio) {
      for (const _ of request.audioUrls ?? []) {
        contentBlocks.push({ type: "text", text: "[Audio]" });
      }
    }

    if (request.extraUserContentParts) {
      contentBlocks.push(...(request.extraUserContentParts as unknown as Record<string, unknown>[]));
    }

    return { role: "user", content: contentBlocks };
  }

  private async assembleContextDefault(
    request: ProviderRequest
  ): Promise<Record<string, unknown>> {
    const contentBlocks: Record<string, unknown>[] = [];

    if (request.prompt) {
      contentBlocks.push({ type: "text", text: request.prompt });
    } else if ((request.imageUrls?.length ?? 0) > 0 || (request.audioUrls?.length ?? 0) > 0) {
      // Some providers require text content; add placeholder when only media is present
      contentBlocks.push({ type: "text", text: "<attachment>" });
    }
    for (const url of request.imageUrls ?? []) {
      // Download remote images and convert to base64 data URLs
      const dataUrl = await resolveImageToDataUrl(url);
      if (!dataUrl) {
        console.warn(`[AgentRunner] Image download FAILED for url=${url.slice(0, 120)}, pushing original URL as fallback`);
        contentBlocks.push({ type: "image_url", image_url: { url } });
      } else {
        contentBlocks.push({ type: "image_url", image_url: { url: dataUrl } });
      }
    }
    for (const url of request.audioUrls ?? []) {
      // Download remote audio and convert to base64 data URLs
      const dataUrl = await resolveAudioToDataUrl(url);
      contentBlocks.push({ type: "audio_url", audio_url: { url: dataUrl ?? url } });
    }
    if (request.extraUserContentParts) {
      contentBlocks.push(...(request.extraUserContentParts as unknown as Record<string, unknown>[]));
    }
    return { role: "user", content: contentBlocks };
  }

  async *step(): AsyncGenerator<AgentResponse, void, unknown> {
    if (!this.req) throw new Error("Request is not set. Please call reset() first.");

    if (this.state === AgentState.IDLE) {
      try {
        await this.agentHooks.onAgentBegin(this.runContext);
      } catch (e) {
        console.error("Error in onAgentBegin hook:", e);
      }
    }

    this.transitionState(AgentState.RUNNING);
    let llmRespResult: LLMResponse | null = null;

    // Context compression/truncation
    const tokenUsage = this.req.conversation?.tokenUsage ?? 0;
    this.runContext.messages = await this.contextManager.process(
      this.runContext.messages,
      tokenUsage
    );

    // Call LLM with fallback
    // Accumulate text/reasoning across streaming chunks so final usage chunk doesn't lose content
    let accumulatedText = "";
    let accumulatedReasoning = "";
    let accumulatedToolCallIds: string[] = [];
    let accumulatedToolCallNames: string[] = [];
    let accumulatedToolCallArgs: Record<string, unknown>[] = [];

    for await (const llmResponse of this.iterLlmResponsesWithFallback()) {

      if (llmResponse.isChunk) {
        if (this.stats.timeToFirstToken === 0) {
          this.stats.timeToFirstToken = Date.now() - this.stats.startTime;
        }

        // Accumulate content from this chunk
        if (llmResponse.completionText) {
          accumulatedText += llmResponse.completionText;
        }
        if (llmResponse.reasoningContent) {
          accumulatedReasoning += llmResponse.reasoningContent;
        }
        if (llmResponse.toolsCallIds?.length) {
          accumulatedToolCallIds.push(...llmResponse.toolsCallIds);
          accumulatedToolCallNames.push(...(llmResponse.toolsCallName ?? []));
          accumulatedToolCallArgs.push(...(llmResponse.toolsCallArgs ?? []));
        }

        if (llmResponse.reasoningContent) {
          yield {
            type: "streaming_delta",
            data: { chain: createMessageChain("reasoning", llmResponse.reasoningContent) },
          };
        }
        if (llmResponse.resultChain) {
          yield {
            type: "streaming_delta",
            data: { chain: llmResponse.resultChain },
          };
        } else if (llmResponse.completionText) {
          yield {
            type: "streaming_delta",
            data: { chain: createMessageChain("text", llmResponse.completionText) },
          };
        }

        // If this chunk contains tool calls or usage info, treat it as the final response
        if (llmResponse.toolsCallName?.length || llmResponse.usage) {
          if (llmResponse.usage) {
            this.stats.tokenUsage.promptTokens += llmResponse.usage.promptTokens;
            this.stats.tokenUsage.completionTokens += llmResponse.usage.completionTokens;
            this.stats.tokenUsage.total += llmResponse.usage.total;
            if (llmResponse.usage.cacheCreationInputTokens) {
              this.stats.tokenUsage.cacheCreationInputTokens = (this.stats.tokenUsage.cacheCreationInputTokens ?? 0) + llmResponse.usage.cacheCreationInputTokens;
            }
            if (llmResponse.usage.cacheReadInputTokens) {
              this.stats.tokenUsage.cacheReadInputTokens = (this.stats.tokenUsage.cacheReadInputTokens ?? 0) + llmResponse.usage.cacheReadInputTokens;
            }
            if (this.req.conversation) {
              this.req.conversation.tokenUsage = llmResponse.usage.total;
            }
          }
          // Merge accumulated content into final result so text isn't lost
          llmRespResult = {
            ...llmResponse,
            completionText: llmResponse.completionText || accumulatedText || undefined,
            reasoningContent: llmResponse.reasoningContent || accumulatedReasoning || undefined,
          };
          if (accumulatedToolCallIds.length > 0 && !llmRespResult.toolsCallIds?.length) {
            llmRespResult.toolsCallIds = accumulatedToolCallIds;
            llmRespResult.toolsCallName = accumulatedToolCallNames;
            llmRespResult.toolsCallArgs = accumulatedToolCallArgs;
          }
          break;
        }

        if (this.isStopRequested()) {
          llmRespResult = {
            role: "assistant",
            completionText: USER_INTERRUPTION_MESSAGE,
            reasoningContent: llmResponse.reasoningContent,
            reasoningSignature: llmResponse.reasoningSignature,
            isChunk: false,
          };
          break;
        }
        continue;
      }
      llmRespResult = llmResponse;

      if (llmResponse.usage) {
        this.stats.tokenUsage.promptTokens += llmResponse.usage.promptTokens;
        this.stats.tokenUsage.completionTokens += llmResponse.usage.completionTokens;
        this.stats.tokenUsage.total += llmResponse.usage.total;
        if (llmResponse.usage.cacheCreationInputTokens) {
          this.stats.tokenUsage.cacheCreationInputTokens = (this.stats.tokenUsage.cacheCreationInputTokens ?? 0) + llmResponse.usage.cacheCreationInputTokens;
        }
        if (llmResponse.usage.cacheReadInputTokens) {
          this.stats.tokenUsage.cacheReadInputTokens = (this.stats.tokenUsage.cacheReadInputTokens ?? 0) + llmResponse.usage.cacheReadInputTokens;
        }
        if (this.req.conversation) {
          this.req.conversation.tokenUsage = llmResponse.usage.total;
        }
      }
      break;
    }

    if (!llmRespResult) {
      if (this.isStopRequested()) {
        llmRespResult = { role: "assistant", completionText: "", isChunk: false };
      } else {
        return;
      }
    }

    if (this.isStopRequested()) {
      yield await this.finalizeAbortedStep(llmRespResult);
      return;
    }

    const llmResp = llmRespResult;

    // Handle error response
    if (llmResp.role === "err") {
      this.finalLlmResp = llmResp;
      this.stats.endTime = Date.now();
      this.transitionState(AgentState.ERROR);
      this.resolveUnconsumedFollowUps();
      const errorText = `LLM 响应错误: ${llmResp.completionText ?? "未知错误"}`;
      yield {
        type: "err",
        data: { chain: createMessageChain("err", errorText) },
      };
      return;
    }

    // No tool calls → Agent is done
    if (!llmResp.toolsCallName?.length) {
      await this.completeWithAssistantResponse(llmResp);
    }

    // Yield LLM result (reasoning + text)
    if (llmResp.reasoningContent) {
      yield {
        type: "llm_result",
        data: { chain: createMessageChain("reasoning", llmResp.reasoningContent) },
      };
    }
    if (llmResp.resultChain) {
      yield {
        type: "llm_result",
        data: { chain: llmResp.resultChain },
      };
    } else if (llmResp.completionText) {
      yield {
        type: "llm_result",
        data: { chain: createMessageChain("text", llmResp.completionText) },
      };
    } else if (llmResp.reasoningContent && !llmResp.toolsCallName?.length) {
      // LLM only returned reasoning without a final answer — prompt it to produce one
      this.runContext.messages.push({
        role: "user",
        content: "Please provide your final answer based on your reasoning above. Do not repeat your thinking process, just give the answer.",
      });
      return;
    } else if (!llmResp.toolsCallName?.length) {
      // LLM returned completely empty — yield fallback so pipeline can respond
      yield {
        type: "llm_result",
        data: { chain: createMessageChain("text", "(模型未返回有效回复，请检查 LLM 配置)") },
      };
    }

    // Handle tool calls
    if (llmResp.toolsCallName?.length) {
      // Skills-like mode: re-query with param-only schema
      if (this.toolSchemaMode === "skills_like") {
        const [requeryResp] = await this.resolveToolExec(llmResp);
        if (!requeryResp.toolsCallName?.length) {
          // LLM didn't call any tool after re-query → treat as assistant response
          if (requeryResp.reasoningContent) {
            yield {
              type: "llm_result",
              data: { chain: createMessageChain("reasoning", requeryResp.reasoningContent) },
            };
          }
          if (requeryResp.resultChain) {
            yield {
              type: "llm_result",
              data: { chain: requeryResp.resultChain },
            };
          } else if (requeryResp.completionText) {
            yield {
              type: "llm_result",
              data: { chain: createMessageChain("text", requeryResp.completionText) },
            };
          }
          await this.completeWithAssistantResponse(requeryResp);
          return;
        } else {
          llmResp.toolsCallName = requeryResp.toolsCallName;
          llmResp.toolsCallArgs = requeryResp.toolsCallArgs;
          llmResp.toolsCallIds = requeryResp.toolsCallIds;
        }
      }

      // Execute tools
      const toolCallResultBlocks: Message[] = [];

      try {
        for await (const result of this.handleFunctionTools(this.req, llmResp)) {
          if (result.kind === "tool_call_result_blocks") {
            toolCallResultBlocks.push(...(result.toolCallResultBlocks ?? []));
          } else if (result.kind === "message_chain") {
            const chain = result.messageChain;
            if (!chain?.type) continue;
            const arType = chain.type === "tool_direct_result" ? "tool_call_result" : chain.type;
            yield { type: arType as AgentResponse["type"], data: { chain } };
          }
        }
      } catch (e) {
        if (e instanceof ToolExecutionInterrupted) {
          yield await this.finalizeAbortedStep(llmResp);
          return;
        }
        throw e;
      }

      // Add tool results to context
      const parts: ContentPartForMsg[] | undefined = [];
      if (llmResp.reasoningContent != null || llmResp.reasoningSignature) {
        parts.push(
          {
            type: "think",
            think: llmResp.reasoningContent ?? "",
            encrypted: llmResp.reasoningSignature,
          }
        );
      }
      if (llmResp.completionText) {
        parts.push({ type: "text", text: llmResp.completionText });
      }

      const assistantMsg: Message = {
        role: "assistant",
        content: parts.length > 0 ? parts : undefined,
        tool_calls: llmResp.toolsCallName.map((name, i) => ({
          type: "function" as const,
          id: llmResp.toolsCallIds![i],
          function: {
            name,
            arguments: JSON.stringify(llmResp.toolsCallArgs?.[i] ?? {}),
          },
        })),
      };

      this.runContext.messages.push(assistantMsg);
      this.runContext.messages.push(...toolCallResultBlocks);
    }
  }

  async *stepUntilDone(maxStep: number): AsyncGenerator<AgentResponse, void, unknown> {
    let stepCount = 0;
    while (!this.done() && stepCount < maxStep) {
      stepCount++;
      yield* this.step();
    }

    if (!this.done()) {
      console.warn(`Agent reached max steps (${maxStep}), forcing a final response.`);
      if (this.req) this.req.funcTool = undefined;
      this.runContext.messages.push({
        role: "user",
        content: MAX_STEPS_REACHED_PROMPT,
      });
      yield* this.step();
    }
  }

  done(): boolean {
    return this.state === AgentState.DONE || this.state === AgentState.ERROR;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  get currentRequest(): ProviderRequest {
    return this.req;
  }

  get currentRunContext(): ContextWrapper<TContext> {
    return this.runContext;
  }

  getFinalLlmResp(): LLMResponse | null {
    return this.finalLlmResp;
  }

  getStats(): AgentStats {
    return { ...this.stats };
  }

  /** 获取当前实际使用的 provider 的模型名 */
  getModel(): string {
    const configModel = this.provider.providerConfig.model;
    return this.req.model || (typeof configModel === "string" ? configModel : "") || "";
  }

  /** 获取原始（首次选择）provider 的 ID，用于统计和日志追踪 */
  getOriginalProviderId(): string {
    return String(this.originalProvider.providerConfig.id ?? "");
  }

  /** 获取当前实际使用的 provider ID */
  getProviderId(): string {
    return String(this.provider.providerConfig.id ?? "");
  }

  requestStop(): void {
    this.abortController.abort();
  }

  wasAborted(): boolean {
    return this.aborted;
  }

  // Follow-up message mechanism
  followUp(messageText: string): FollowUpTicket | null {
    if (this.done() || this.isStopRequested()) return null;
    const text = (messageText ?? "").trim();
    if (!text) return null;
    const ticket = createFollowUpTicket(this.followUpSeq++, text);
    this.pendingFollowUps.push(ticket);
    return ticket;
  }

  // Private methods

  private isStopRequested(): boolean {
    return this.abortController.signal.aborted;
  }

  private async completeWithAssistantResponse(llmResp: LLMResponse): Promise<void> {
    this.finalLlmResp = llmResp;
    this.transitionState(AgentState.DONE);
    this.stats.endTime = Date.now();

    const parts: ContentPartForMsg[] = [];
    if (llmResp.reasoningContent != null || llmResp.reasoningSignature) {
      parts.push({
        type: "think",
        think: llmResp.reasoningContent ?? "",
        encrypted: llmResp.reasoningSignature,
      });
    }
    // Prefer resultChain's plain text over completionText
    const textContent = llmResp.resultChain?.message ?? llmResp.completionText;
    if (textContent) {
      parts.push({ type: "text", text: textContent });
    }
    if (parts.length === 0) {
      console.warn("LLM returned empty assistant message with no tool calls.");
      // Diagnostic: dump full LLM response to identify why content is missing
      console.warn(
        `[AgentRunner] Empty response diagnostic:\n` +
        `  role=${llmResp.role}, isChunk=${llmResp.isChunk}\n` +
        `  completionText=${JSON.stringify(llmResp.completionText)} (type=${typeof llmResp.completionText})\n` +
        `  reasoningContent=${llmResp.reasoningContent ? `present(${(llmResp.reasoningContent as string).length}chars)` : "none"}\n` +
        `  resultChain=${llmResp.resultChain ? JSON.stringify(llmResp.resultChain).slice(0,300) : "none"}\n` +
        `  toolsCallName=${llmResp.toolsCallName?.length ?? 0}, toolsCallIds=${llmResp.toolsCallIds?.length ?? 0}\n` +
        `  usage=${llmResp.usage ? JSON.stringify(llmResp.usage) : "none"}`
      );
      // Yield a fallback response so the pipeline can send something back to the user
      this.runContext.messages.push({ role: "assistant", content: "(模型未返回有效回复)" });
    } else {
      this.runContext.messages.push({ role: "assistant", content: parts });
    }

    try {
      await this.agentHooks.onAgentDone(this.runContext, llmResp);
    } catch (e) {
      console.error("Error in onAgentDone hook:", e);
    }
    this.resolveUnconsumedFollowUps();
  }

  private async finalizeAbortedStep(
    llmResp: LLMResponse | null
  ): Promise<AgentResponse> {
    console.info("Agent execution was requested to stop by user.");
    if (!llmResp) {
      llmResp = { role: "assistant", completionText: "", isChunk: false };
    }
    if (llmResp.role !== "assistant") {
      llmResp = {
        role: "assistant",
        completionText: USER_INTERRUPTION_MESSAGE,
        isChunk: false,
      };
    }
    this.finalLlmResp = llmResp;
    this.aborted = true;
    this.transitionState(AgentState.DONE);
    this.stats.endTime = Date.now();

    const parts: ContentPartForMsg[] = [];
    if (llmResp.reasoningContent != null || llmResp.reasoningSignature) {
      parts.push({
        type: "think",
        think: llmResp.reasoningContent ?? "",
        encrypted: llmResp.reasoningSignature,
      });
    }
    if (llmResp.completionText) {
      parts.push({ type: "text", text: llmResp.completionText });
    }
    if (parts.length > 0) {
      this.runContext.messages.push({ role: "assistant", content: parts });
    }

    try {
      await this.agentHooks.onAgentDone(this.runContext, llmResp);
    } catch (e) {
      console.error("Error in onAgentDone hook:", e);
    }

    this.resolveUnconsumedFollowUps();
    return {
      type: "aborted",
      data: { chain: createMessageChain("aborted") },
    };
  }

  private resolveUnconsumedFollowUps(): void {
    if (!this.pendingFollowUps.length) return;
    const followUps = this.pendingFollowUps;
    this.pendingFollowUps = [];
    for (const ticket of followUps) {
      ticket.resolveFn();
    }
  }

  private consumeFollowUpNotice(): string {
    if (!this.pendingFollowUps.length) return "";
    const followUps = this.pendingFollowUps;
    this.pendingFollowUps = [];
    for (const ticket of followUps) {
      ticket.consumed = true;
      ticket.resolveFn();
    }
    const lines = followUps
      .map((t, i) => `${i + 1}. ${t.text}`)
      .join("\n");
    return FOLLOW_UP_NOTICE_TEMPLATE.replace("{followUpLines}", lines);
  }

  private mergeFollowUpNotice(content: string): string {
    const notice = this.consumeFollowUpNotice();
    return notice ? `${content}${notice}` : content;
  }

  private trackToolCallStreak(toolName: string): number {
    if (toolName === this.lastToolName) {
      this.sameToolStreak++;
    } else {
      this.lastToolName = toolName;
      this.sameToolStreak = 1;
    }
    return this.sameToolStreak;
  }

  private buildRepeatedToolCallGuidance(toolName: string, streak: number): string {
    if (streak < REPEATED_TOOL_NOTICE_L1_THRESHOLD) return "";

    if (streak >= REPEATED_TOOL_NOTICE_L3_THRESHOLD) {
      return REPEATED_TOOL_NOTICE_L3_TEMPLATE.replace("{toolName}", toolName).replace(
        "{streak}",
        String(streak)
      );
    }
    if (streak >= REPEATED_TOOL_NOTICE_L2_THRESHOLD) {
      return REPEATED_TOOL_NOTICE_L2_TEMPLATE.replace("{toolName}", toolName).replace(
        "{streak}",
        String(streak)
      );
    }
    return REPEATED_TOOL_NOTICE_L1_TEMPLATE.replace("{toolName}", toolName).replace(
      "{streak}",
      String(streak)
    );
  }

  // LLM response iteration with fallback
  private async *iterLlmResponsesWithFallback(): AsyncGenerator<LLMResponse, void, unknown> {
    const candidates = [this.provider, ...this.fallbackProviders];
    let lastException: Error | null = null;
    let lastErrResponse: LLMResponse | null = null;

    for (let idx = 0; idx < candidates.length; idx++) {
      const candidate = candidates[idx];
      const isLastCandidate = idx === candidates.length - 1;

      if (idx > 0) {
        console.warn(
          `Switched from ${this.provider.providerConfig.id} to fallback: ${candidate.providerConfig.id}`
        );
        // 跨供应商切换时标准化 tool_call_id，避免前缀不兼容
        this.normalizeToolCallIdsForProviderSwitch(this.runContext.messages);
        this.provider = candidate;
      }

      try {
        // Retry on empty output
        for (let attempt = 1; attempt <= EMPTY_OUTPUT_RETRY_ATTEMPTS; attempt++) {
          let hasStreamOutput = false;
          try {
            for await (const resp of this.iterLlmResponses({ includeModel: idx === 0 })) {
              if (resp.isChunk) {
                hasStreamOutput = true;
                yield resp;
                continue;
              }

              if (resp.role === "err" && !hasStreamOutput && !isLastCandidate) {
                lastErrResponse = resp;
                console.warn(
                  `Chat Model ${candidate.providerConfig.id} returns error, trying fallback.`
                );
                break;
              }

              yield resp;
              return;
            }
            if (hasStreamOutput) return;
          } catch (e) {
            if (e instanceof EmptyModelOutputError) {
              if (hasStreamOutput) break;
              lastException = e;
              const waitMs =
                Math.min(
                  EMPTY_OUTPUT_RETRY_WAIT_MAX_S * 1000,
                  EMPTY_OUTPUT_RETRY_WAIT_MIN_S * 1000 * Math.pow(2, attempt - 1)
                );
              console.warn(
                `Chat Model ${candidate.providerConfig.id} returned empty output on attempt ${attempt}/${EMPTY_OUTPUT_RETRY_ATTEMPTS}.`
              );
              await new Promise((resolve) => setTimeout(resolve, waitMs));
              continue;
            }
            throw e;
          }
        }
      } catch (exc) {
        lastException = exc instanceof Error ? exc : new Error(String(exc));
        console.warn(`Chat Model ${candidate.providerConfig.id} request error: ${exc}`);
        continue;
      }
    }

    // All providers failed
    if (lastErrResponse) {
      yield lastErrResponse;
      return;
    }
    const errMsg = lastException?.message ?? lastException?.toString() ?? "unknown error (all providers returned error responses without throwing)";
    yield {
      role: "err",
      completionText: `All chat models failed: ${errMsg}`,
      isChunk: false,
    };
  }

  private async *iterLlmResponses(options: { includeModel: boolean }): AsyncGenerator<LLMResponse, void, unknown> {
    const payload: ProviderChatParams = {
      contexts: this.sanitizeContextsForProvider(this.runContext.messages),
      funcTool: this.funcToolForProvider(),
      sessionId: this.req.sessionId,
      extraUserContentParts: this.req.extraUserContentParts,
      abortSignal: this.abortController.signal,
      temperature: this.req.temperature,
    };
    if (options.includeModel) {
      payload.model = this.req.model;
    }

    if (this.streaming && this.provider.textChatStream) {
      let hasMeaningfulContent = false;
      for await (const resp of this.provider.textChatStream(payload)) {
        if (resp.completionText || resp.reasoningContent || resp.toolsCallName?.length) {
          hasMeaningfulContent = true;
        }
        yield resp;
      }
      // If the entire stream produced no meaningful content, throw to trigger retry
      if (!hasMeaningfulContent) {
        throw new EmptyModelOutputError();
      }
    } else {
      const resp = await this.provider.textChat(payload);
      // Check for empty response (no text, no reasoning, no tool calls)
      if (
        resp.role !== "err" &&
        !resp.completionText &&
        !resp.reasoningContent &&
        !resp.toolsCallName?.length
      ) {
        console.warn(
          `[ToolLoopAgentRunner] LLM returned empty response. ` +
          `completionText=${JSON.stringify(resp.completionText)}, ` +
          `reasoningContent=${resp.reasoningContent ? "present" : "none"}, ` +
          `toolsCallName=${resp.toolsCallName?.length ?? 0}, ` +
          `usage=${resp.usage ? JSON.stringify(resp.usage) : "none"}`
        );
        throw new EmptyModelOutputError();
      }
      yield resp;
    }
  }

  private sanitizeContextsForProvider(
    contexts: Message[] | Record<string, unknown>[]
  ): Message[] | Record<string, unknown>[] {
    const modalities = this.provider.providerConfig.modalities;
    if (!modalities || !Array.isArray(modalities)) return contexts;

    const [sanitized, stats] = sanitizeContextsByModalities(
      contexts as (Message | Record<string, unknown>)[],
      modalities
    );
    logContextSanitizeStats(stats);
    return sanitized;
  }

  /**
   * 标准化消息历史中的 tool_call_id，移除供应商特定前缀（如 gemini_fc_），
   * 确保跨供应商 fallback 时 tool result 能正确匹配。
   */
  private normalizeToolCallIdsForProviderSwitch(messages: Message[]): void {
    // 已知的供应商特定前缀列表
    const KNOWN_PREFIXES = ["gemini_fc_"];
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls as Array<{ id?: string }>) {
          if (tc.id) {
            for (const prefix of KNOWN_PREFIXES) {
              if (tc.id.startsWith(prefix)) {
                tc.id = tc.id.slice(prefix.length);
                break;
              }
            }
          }
        }
      }
      if (msg.role === "tool" && msg.tool_call_id) {
        for (const prefix of KNOWN_PREFIXES) {
          if (msg.tool_call_id.startsWith(prefix)) {
            msg.tool_call_id = msg.tool_call_id.slice(prefix.length);
            break;
          }
        }
      }
    }
  }

  private funcToolForProvider(): import("@yachiyo/common/llm-types.js").ToolSetInterface | undefined {
    if (!this.req.funcTool) return undefined;
    const modalities = this.provider.providerConfig.modalities;
    if (Array.isArray(modalities) && !modalities.includes("tool_use")) {
      return undefined;
    }
    return this.req.funcTool;
  }

  // Handle function tools execution
  private async *handleFunctionTools(
    req: ProviderRequest,
    llmResponse: LLMResponse
  ): AsyncGenerator<HandleFunctionToolsResult, void, unknown> {
    const toolCallResultBlocks: Message[] = [];
    console.info(`Agent 使用工具: ${llmResponse.toolsCallName}`);

    const appendToolCallResult = (toolCallId: string, content: string): void => {
      toolCallResultBlocks.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: this.mergeFollowUpNotice(content),
      });
    };

    for (let i = 0; i < (llmResponse.toolsCallName?.length ?? 0); i++) {
      const funcToolName = llmResponse.toolsCallName![i];
      let funcToolArgs = llmResponse.toolsCallArgs?.[i] ?? {};
      const funcToolId = llmResponse.toolsCallIds![i];

      const toolResultBlocksStart = toolCallResultBlocks.length;
      const toolCallStreak = this.trackToolCallStreak(funcToolName);

      // Yield tool call notification
      yield HandleFunctionToolsResult.fromMessageChain(
        createMessageChain("tool_call", JSON.stringify({
          id: funcToolId,
          name: funcToolName,
          args: funcToolArgs,
          ts: Date.now(),
        }))
      );

      try {
        if (!req.funcTool) return;

        let funcTool: FunctionTool | undefined;
        let availableTools: string[];

        if (this.toolSchemaMode === "skills_like" && this.skillLikeRawToolSet) {
          funcTool = this.skillLikeRawToolSet.getTool(funcToolName);
          availableTools = this.skillLikeRawToolSet.names();
        } else {
          const funcToolSet = req.funcTool as ToolSet;
          funcTool = funcToolSet.getTool(funcToolName);
          availableTools = funcToolSet.names();
        }

        if (funcToolArgs == null) {
          // Some API may return null for tools with no parameters
          funcToolArgs = {};
        }

        console.info(`使用工具：${funcToolName}，参数：${JSON.stringify(funcToolArgs)}`);

        if (!funcTool) {
          console.warn(`未找到指定的工具: ${funcToolName}，将跳过。`);
          appendToolCallResult(
            funcToolId,
            `error: Tool ${funcToolName} not found. Available tools are: ${availableTools.join(", ")}`
          );
          continue;
        }

        // Parameter filtering
        let validParams: Record<string, unknown> = {};
        if (funcTool.handler) {
          const params = funcTool.parameters as Record<string, unknown>;
          if (params?.properties) {
            const expectedParams = new Set(Object.keys(params.properties as Record<string, unknown>));
            for (const [k, v] of Object.entries(funcToolArgs as Record<string, unknown>)) {
              if (expectedParams.has(k)) validParams[k] = v;
            }
          }
        } else {
          validParams = funcToolArgs as Record<string, unknown>;
        }

        try {
          await this.agentHooks.onToolStart(this.runContext, funcTool, validParams);
        } catch (e) {
          console.error("Error in onToolStart hook:", e);
        }

        const executor = this.toolExecutor.execute(funcTool, this.runContext, validParams);

        let finalResp: CallToolResult | null = null;
        for await (const resp of this.iterToolExecutorResults(executor)) {
          if (resp && typeof resp === "object" && "content" in resp) {
            const res = resp as CallToolResult;
            finalResp = res;

            if (!res.content || res.content.length === 0) {
              appendToolCallResult(funcToolId, "The tool returned no content.");
              continue;
            }

            const resultParts: string[] = [];
            const cachedImages: CachedImage[] = [];
            for (const contentItem of res.content) {
              if (contentItem.type === "text") {
                resultParts.push((contentItem as TextContent).text);
              } else if (contentItem.type === "image") {
                const imgContent = contentItem as ImageContent;
                // Cache the image for later retrieval
                try {
                  const cached = await toolImageCache.saveImage(
                    imgContent.data,
                    funcToolId,
                    funcToolName,
                    cachedImages.length,
                    imgContent.mimeType
                  );
                  cachedImages.push(cached);
                  resultParts.push(
                    `Image returned (base64, ${imgContent.mimeType}). ` +
                    `Cached at: ${cached.filePath}. ` +
                    `Use send_message_to_user to send it to the user.`
                  );
                } catch (e) {
                  console.warn(`[ToolLoop] Failed to cache image from tool ${funcToolName}:`, e);
                  resultParts.push(
                    `Image returned (base64, ${imgContent.mimeType}). ` +
                    `Use send_message_to_user to send it to the user.`
                  );
                }
              } else if (contentItem.type === "resource") {
                const resource = (contentItem as EmbeddedResource).resource;
                if ("text" in resource) {
                  resultParts.push(resource.text);
                } else if ("blob" in resource) {
                  // Binary resource - save as image if it's an image MIME type
                  const blobResource = resource as import("../types.js").BlobResourceContents;
                  const mimeType = blobResource.mimeType ?? "application/octet-stream";
                  if (mimeType.startsWith("image/")) {
                    try {
                      const cached = await toolImageCache.saveImage(
                        blobResource.blob,
                        funcToolId,
                        funcToolName,
                        cachedImages.length,
                        mimeType
                      );
                      cachedImages.push(cached);
                      resultParts.push(
                        `Image resource returned (${mimeType}). Cached at: ${cached.filePath}. ` +
                        `Use send_message_to_user to send it to the user.`
                      );
                      yield HandleFunctionToolsResult.fromCachedImage(cached);
                    } catch (e) {
                      console.warn(`[ToolLoop] Failed to cache image resource from tool ${funcToolName}:`, e);
                      resultParts.push(`Image resource returned (${mimeType}), but failed to cache.`);
                    }
                  } else {
                    resultParts.push(`Binary resource returned (${mimeType}). Content not displayable as text.`);
                  }
                } else {
                  resultParts.push("The tool has returned a data type that is not supported.");
                }
              }
            }

            // Yield cached images for downstream processing
            for (const cached of cachedImages) {
              yield HandleFunctionToolsResult.fromCachedImage(cached);
            }

            if (resultParts.length > 0) {
              let inlineResult = resultParts.join("\n\n");
              inlineResult = await this.materializeLargeToolResult(funcToolId, inlineResult);
              appendToolCallResult(
                funcToolId,
                inlineResult + this.buildRepeatedToolCallGuidance(funcToolName, toolCallStreak)
              );
            }
          } else if (resp === null) {
            this.transitionState(AgentState.DONE);
            this.stats.endTime = Date.now();
            appendToolCallResult(
              funcToolId,
              "The tool has no return value, or has sent the result directly to the user." +
                this.buildRepeatedToolCallGuidance(funcToolName, toolCallStreak)
            );
          }
        }

        try {
          await this.agentHooks.onToolEnd(this.runContext, funcTool, validParams, finalResp);
        } catch (e) {
          console.error("Error in onToolEnd hook:", e);
        }
      } catch (e) {
        if (e instanceof ToolExecutionInterrupted) throw e;
        console.warn(`Tool execution error: ${e}`);
        appendToolCallResult(
          funcToolId,
          `error: ${e}` + this.buildRepeatedToolCallGuidance(funcToolName, toolCallStreak)
        );
      }

      // Yield tool call result notification
      if (toolCallResultBlocks.length > toolResultBlocksStart) {
        const toolResultContent = String(toolCallResultBlocks[toolCallResultBlocks.length - 1].content);
        yield HandleFunctionToolsResult.fromMessageChain(
          createMessageChain("tool_call_result", JSON.stringify({
            id: funcToolId,
            ts: Date.now(),
            result: toolResultContent,
          }))
        );
        console.info(`Tool \`${funcToolName}\` Result: ${toolResultContent}`);
      }
    }

    // Yield final tool call result blocks
    if (toolCallResultBlocks.length > 0) {
      yield HandleFunctionToolsResult.fromToolCallResultBlocks(toolCallResultBlocks);
    }
  }

  private async *iterToolExecutorResults(
    executor: AsyncGenerator<CallToolResult | null, void, unknown>
  ): AsyncGenerator<CallToolResult | null, void, unknown> {
    try {
      while (true) {
        if (this.isStopRequested()) {
          throw new ToolExecutionInterrupted(
            "Tool execution interrupted before reading the next tool result."
          );
        }

        // Create a fresh AbortController for each tool call so the
        // underlying tool can be cancelled on timeout instead of
        // continuing to run in the background after the race is lost.
        const abortController = new AbortController();
        this.runContext._toolAbortController = abortController;

        let timerId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<IteratorResult<CallToolResult | null>>((_, reject) => {
          timerId = setTimeout(
            () => reject(new ToolTimeoutError(this.runContext.toolCallTimeout)),
            this.runContext.toolCallTimeout * 1000,
          );
        });

        try {
          const result = await Promise.race([
            executor.next(),
            timeoutPromise,
          ]);

          if (timerId) {
            clearTimeout(timerId);
          }

          if (result.done) return;
          yield result.value;
        } catch (e) {
          if (timerId) {
            clearTimeout(timerId);
          }
          if (e instanceof ToolTimeoutError) {
            // Abort the underlying tool so file writes, shell commands,
            // and network calls stop instead of running orphaned.
            abortController.abort();
            throw e;
          }
          if (e instanceof ToolExecutionInterrupted) throw e;
          throw e;
        } finally {
          // Clear the reference so the next iteration sets a fresh one.
          this.runContext._toolAbortController = undefined;
        }
      }
    } finally {
      // Ensure the async generator is properly closed to prevent resource leaks
      try {
        await executor.return(undefined);
      } catch (e) {
        // Best-effort cleanup; surface the error for diagnostics without failing the call.
        console.debug("[ToolLoop] Error during generator cleanup:", e);
      }
    }
  }

  // Tool result overflow handling
  private async materializeLargeToolResult(
    toolCallId: string,
    content: string
  ): Promise<string> {
    if (!this.toolResultOverflowDir || !this.readTool) return content;

    const estimatedTokens = this.toolResultTokenCounter.countTokens([
      { role: "tool", content, tool_call_id: toolCallId },
    ]);

    if (estimatedTokens <= TOOL_RESULT_MAX_ESTIMATED_TOKENS) return content;

    const preview = this.truncateToolResultPreview(content, toolCallId);

    try {
      const overflowPath = await this.writeToolResultOverflowFile(toolCallId, content);
      const notice = TOOL_RESULT_OVERFLOW_NOTICE_TEMPLATE
        .replace("{overflowPath}", overflowPath)
        .replace("{readToolHint}", this.readToolHint());
      return preview ? `${preview}\n\n${notice}` : notice;
    } catch (exc) {
      const errorNotice =
        `Tool output exceeded the inline result limit and could not be written: ${exc}`;
      return preview ? `${preview}\n\n${errorNotice}` : errorNotice;
    }
  }

  private truncateToolResultPreview(content: string, _toolCallId: string): string {
    let preview = content;
    while (preview) {
      const tokens = this.toolResultTokenCounter.countTokens([
        { role: "tool", content: preview, tool_call_id: _toolCallId },
      ]);
      if (tokens <= TOOL_RESULT_PREVIEW_MAX_ESTIMATED_TOKENS) return preview;
      const nextLen = Math.floor(preview.length / 2);
      if (nextLen <= 0) break;
      preview = preview.slice(0, nextLen);
    }
    return preview;
  }

  private async writeToolResultOverflowFile(
    toolCallId: string,
    content: string
  ): Promise<string> {
    const { promises: fs } = await import("fs");
    const path = await import("path");

    if (!this.toolResultOverflowDir) throw new Error("toolResultOverflowDir is not configured");

    const overflowDir = path.resolve(this.toolResultOverflowDir);
    const safeId = toolCallId.replace(/[^a-zA-Z0-9\-_.]/g, "_").replace(/^[._]+|[._]+$/g, "") || "tool_call";
    const fileName = `${safeId}_${crypto.randomUUID().slice(0, 8)}.txt`;
    const overflowPath = path.join(overflowDir, fileName);

    await fs.mkdir(overflowDir, { recursive: true });
    await fs.writeFile(overflowPath, content, "utf-8");

    return overflowPath;
  }

  // Skills-like mode re-query
  private async resolveToolExec(
    llmResp: LLMResponse
  ): Promise<[LLMResponse, ToolSet | null]> {
    const toolNames = llmResp.toolsCallName;
    const fullToolSet = this.req.funcTool as ToolSet | undefined;
    if (!toolNames?.length) return [llmResp, fullToolSet ?? null];

    if (!fullToolSet) return [llmResp, null];

    const subset = this.buildToolSubset(fullToolSet, toolNames);
    if (!subset.tools.length) return [llmResp, fullToolSet];

    if (this.toolSchemaParamSet) {
      const paramSubset = this.buildToolSubset(this.toolSchemaParamSet, toolNames);

      if (paramSubset.tools.length && toolNames.length) {
        const contexts = this.buildToolRequeryContext(toolNames);

        const requeryResp = await this.provider.textChat({
          contexts: this.sanitizeContextsForProvider(contexts),
          funcTool: paramSubset,
          model: this.req.model,
          sessionId: this.req.sessionId,
          extraUserContentParts: this.req.extraUserContentParts,
          abortSignal: this.abortController.signal,
        });

        if (requeryResp) llmResp = requeryResp;

        if (!llmResp.toolsCallName?.length && !this.hasMeaningfulAssistantReply(llmResp)) {
          console.warn("skills_like tool re-query returned no tool calls; retrying with stronger instruction.");
          const repairContexts = this.buildToolRequeryContext(
            toolNames,
            SKILLS_LIKE_REQUERY_REPAIR_INSTRUCTION
          );
          const repairResp = await this.provider.textChat({
            contexts: this.sanitizeContextsForProvider(repairContexts),
            funcTool: paramSubset,
            model: this.req.model,
            sessionId: this.req.sessionId,
            extraUserContentParts: this.req.extraUserContentParts,
            abortSignal: this.abortController.signal,
          });
          if (repairResp) llmResp = repairResp;
        }
      }
    }

    return [llmResp, subset];
  }

  private buildToolRequeryContext(
    toolNames: string[],
    extraInstruction?: string
  ): Record<string, unknown>[] {
    const contexts: Record<string, unknown>[] = this.runContext.messages.map((msg) =>
      serializeMessage(msg)
    );

    let instruction = SKILLS_LIKE_REQUERY_INSTRUCTION_TEMPLATE.replace(
      "{toolNames}",
      toolNames.join(", ")
    );
    if (extraInstruction) instruction = `${instruction}\n${extraInstruction}`;

    if (contexts.length > 0 && contexts[0].role === "system") {
      const content = String(contexts[0].content ?? "");
      contexts[0].content = `${content}\n${instruction}`;
    } else {
      contexts.unshift({ role: "system", content: instruction });
    }

    return contexts;
  }

  private buildToolSubset(toolSet: ToolSet, toolNames: string[]): ToolSet {
    const subset = new ToolSet();
    for (const name of toolNames) {
      const tool = toolSet.getTool(name);
      if (tool) subset.addTool(tool);
    }
    return subset;
  }

  private hasMeaningfulAssistantReply(llmResp: LLMResponse): boolean {
    return Boolean((llmResp.completionText ?? "").trim());
  }
}

// Helper types
type ContentPartForMsg =
  | { type: "text"; text: string }
  | { type: "think"; think: string; encrypted?: string };

// HandleFunctionToolsResult
class HandleFunctionToolsResult {
  kind: "message_chain" | "tool_call_result_blocks" | "cached_image";
  messageChain?: MessageChain;
  toolCallResultBlocks?: Message[];
  cachedImage?: unknown;

  private constructor(
    kind: "message_chain" | "tool_call_result_blocks" | "cached_image",
    data?: { messageChain?: MessageChain; toolCallResultBlocks?: Message[]; cachedImage?: unknown }
  ) {
    this.kind = kind;
    if (data) {
      this.messageChain = data.messageChain;
      this.toolCallResultBlocks = data.toolCallResultBlocks;
      this.cachedImage = data.cachedImage;
    }
  }

  static fromMessageChain(chain: MessageChain): HandleFunctionToolsResult {
    return new HandleFunctionToolsResult("message_chain", { messageChain: chain });
  }

  static fromToolCallResultBlocks(blocks: Message[]): HandleFunctionToolsResult {
    return new HandleFunctionToolsResult("tool_call_result_blocks", {
      toolCallResultBlocks: blocks,
    });
  }

  static fromCachedImage(image: unknown): HandleFunctionToolsResult {
    return new HandleFunctionToolsResult("cached_image", { cachedImage: image });
  }
}
