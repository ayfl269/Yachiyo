import { PipelineStage, registerStage } from "../stage.js";
import type { PipelineContext } from "../context.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import { EventResult, ResultContentType } from "@yachiyo/message/event-result.js";
import { ComponentType, type ImageComponent, type RecordComponent, type PlainComponent } from "@yachiyo/message/components.js";
import type { ProviderType } from "@yachiyo/provider/types.js";
import type { ToolLoopAgentRunner } from "@yachiyo/agent/runners/tool-loop-agent-runner.js";
import type { RunAgentResult } from "@yachiyo/agent/agent-runner.js";
import { EventType } from "@yachiyo/plugin/event-type.js";
import type { StarHandlerMetadata } from "@yachiyo/plugin/handler.js";
import type { ProviderStat } from "@yachiyo/conversation/store.js";
import { registerActiveRunner, unregisterActiveRunner } from "../follow-up.js";
import { buildSkillsPrompt } from "@yachiyo/skill/manager.js";
import { EstimateTokenCounter } from "@yachiyo/agent/context/token-counter.js";
import type { Message } from "@yachiyo/common/llm-message.js";

/** Build a typed PlainComponent without duplicating the text or using `as any`. */
function plainText(text: string): PlainComponent {
  return { type: ComponentType.Plain, text, toDict: () => ({ type: "text", data: { text } }) };
}

/**
 * Remove reasoning/thinking content parts from a message before it is written
 * to the conversation transcript.
 *
 * Thinking is provider-internal: it must not be part of the persisted record
 * because (a) replaying it on every later turn wastes tokens and bloats
 * storage / background memory indexing, and (b) its signature can go stale
 * (Anthropic thinking signature, Gemini thoughtSignature), so a persisted
 * signature may be rejected by the provider on replay. The visible text is
 * preserved unchanged.
 *
 * Returns the content without `think` parts: the original string for
 * string-only content, the filtered array for part arrays, or `undefined` when
 * nothing but thinking remains (the caller then drops the message). Non-array,
 * non-string content (checkpoint data) is returned as-is.
 */
function stripThinkParts(content: Message["content"]): Message["content"] {
  if (typeof content === "string" || content === undefined) return content;
  if (!Array.isArray(content)) return content;
  const filtered = content.filter((part) => part.type !== "think");
  return filtered.length > 0 ? filtered : undefined;
}

/**
 * Ordered list of visible assistant utterances produced by a run.
 *
 * `runResult.chains` carries every `llm_result` text the runner emitted, in
 * order: the intermediate narration between tool calls, then the final reply.
 * It excludes tool mechanics and reasoning. This is the single source of truth
 * for "what the assistant said this run" — both delivery
 * ({@link ProcessStage.applyNonStreamingResult}) and persistence
 * ({@link ProcessStage.saveRunHistory}) consume it, so what the user receives
 * and what is stored cannot diverge.
 *
 * Falls back to the final response text when no text chains were collected
 * (e.g. a buffered/streaming path that did not populate `chains`).
 */
function extractAssistantUtterances(runResult: RunAgentResult): string[] {
  const fromChains = runResult.chains
    .filter((c) => c.type === "text" && typeof c.message === "string" && c.message.trim().length > 0)
    .map((c) => c.message as string);
  if (fromChains.length > 0) return fromChains;

  const fr = runResult.finalResponse;
  const text = fr?.completionText ?? fr?.resultChain?.message ?? "";
  return text.trim().length > 0 ? [text] : [];
}

@registerStage
export class ProcessStage extends PipelineStage {
  private ctx!: PipelineContext;
  private maxStep: number = 30;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.ctx = ctx;
    this.maxStep = ctx.config.maxStep ?? 30;
  }

  async *process(event: MessageEvent): AsyncGenerator<void, void> {
    const hasValidMessage = Boolean(event.messageStr?.trim());
    const hasMediaContent = event.messageObj.components.some(
      c => [ComponentType.Image, ComponentType.File, ComponentType.Record, ComponentType.Video].includes(c.type)
    );
    if (!hasValidMessage && !hasMediaContent) return;

    try {
      // Bot 平台动作记录（如 agent 通过工具发起的戳一戳）：
      // 仅把动作描述作为 assistant 记录追加到会话历史，不触发 agent 运行、
      // 不触发 agent 生命周期钩子（OnAgentBegin/Done）、不发送任何回复。
      // 获取会话锁确保与触发该动作的 agent 运行（saveRunHistory 追加写入
      // 历史）串行，避免并发交错写入。
      if (event.getExtra<boolean>("_botActionNote")) {
        const releaseNoteLock = await this.ctx.sessionLockManager.acquireLock(event.unifiedMsgOrigin);
        try {
          const note = (event.messageStr ?? "").trim();
          if (note) {
            const { convId, umo } = await this.resolveConversation(event);
            await this.saveAssistantMessage(umo, convId, note);
          }
          return;
        } finally {
          releaseNoteLock();
        }
      }

      try { await event.sendTyping(); } catch { /* ignore */ }

      await this.ctx.callEventHook(event, EventType.OnAgentBeginEvent);
      if (event.isStopped()) return;

      // Acquire the session lock for BOTH the activatedHandlers path and the
      // Agent path. Previously only the Agent path held the lock, which meant
      // a plugin handler and an in-flight agent run could concurrently write
      // to the same conversation history (saveUserMessage / saveAssistantMessage),
      // causing lost updates and interleaved JSON. The lock is held until both
      // branches complete.
      const releaseLock = await this.ctx.sessionLockManager.acquireLock(event.unifiedMsgOrigin);
      try {
      const activatedHandlers = event.getExtra<StarHandlerMetadata[]>("activated_handlers") ?? [];
      if (activatedHandlers.length > 0) {
        for (const handler of activatedHandlers) {
          for await (const _ of this.ctx.callHandler(event, handler)) {
            if (event.isStopped()) break;
          }
          if (event.isStopped()) break;
        }
        if (event.getResult()) {
          // 在 yield 前保存用户消息和助手消息（避免 respond 阶段 clearResult 后丢失）
          const { convId, umo } = await this.saveUserMessage(event);
          const result = event.getResult();
          if (result) {
            const responseText = result.getPlainText();
            if (responseText) {
              await this.saveAssistantMessage(umo, convId, responseText);
              // Cache assistant text before yield — respond stage will clearResult()
              event.setExtra("_cachedAssistantText", responseText);
            }
          }
          yield;
          await this.ctx.callEventHook(event, EventType.OnAgentDoneEvent);
          this.recordConversationToMemory(event);
          return;
        }
      }

      const systemPrompt = await this.buildSystemPrompt();
      const dynamicContext = await this.buildDynamicContext(event);

        // Distinguish "no provider available" (null) from a real exception:
        // only the former gets the "no available model" message; real errors
        // get the generic error path below so they are not misdiagnosed (#89).
        let buildResult: import("@yachiyo/agent/agent-builder.js").MainAgentBuildResult | null;
        try {
          buildResult = await this.buildAgent(event, systemPrompt, dynamicContext);
        } catch {
          // Full error already logged inside buildAgent; send the generic
          // user-facing message without leaking internals (#89).
          await event.send([plainText("抱歉，处理您的消息时发生了内部错误，请稍后重试。")]);
          return;
        }
      if (!buildResult) {
        console.warn("[ProcessStage] buildAgent returned null - no provider available");
        await event.send([plainText("抱歉，当前没有可用的模型来处理您的消息，请检查 Provider 配置。")]);
        return;
      }

      const { agentRunner } = buildResult;

        // Stop check must come BEFORE saveUserMessage (#91): otherwise a
        // stopped event persists a user message into history that will never
        // receive a reply.
        if (event.isStopped()) return;

        // 在执行 agent 前保存用户消息
        const { convId, umo } = await this.saveUserMessage(event);

        await this.ctx.callEventHook(event, EventType.OnLLMRequestEvent);
        if (event.isStopped()) return;

        // Attach the pipeline-level trace span (created by PipelineScheduler.execute)
        // to the agent's run context so the agent runner and tool executor can
        // record child events onto the same trace. No-op when trace is not
        // configured (e.g. tests that bypass PipelineScheduler).
        const traceSpan = (event as unknown as { traceSpan?: import("@yachiyo/common/trace.js").TraceSpan }).traceSpan;
        if (traceSpan && agentRunner.currentRunContext) {
          agentRunner.currentRunContext._traceSpan = traceSpan;
        }

        registerActiveRunner(event.unifiedMsgOrigin, agentRunner);
        try {
          // 平台消息投递一律缓冲后一次性发送（消息适配器不再支持逐 chunk 流式投递）。
          // LLM 调用本身是否流式由 buildAgent() 中的 modelStreaming 决定，
          // runner 会正确收集 streaming_delta 并聚合为完整结果。
          const { runAgent } = await import("@yachiyo/agent/agent-runner.js");
          const runResult = await runAgent(agentRunner, {
            maxStep: this.maxStep,
            shouldStop: () => event.isStopped(),
            onError: (err) => console.error(`[ProcessStage] Agent error: ${err}`),
            // Renew the session lock TTL on each step so the watchdog
            // does not force-release it during long multi-step tool
            // execution.
            onStepStart: () => releaseLock.renew(),
          });

          // Record provider token stats after agent run completes
          await this.recordTokenStats(agentRunner);

          // Expose the run's reasoning/thinking text to the decoration stage
          // (`displayReasoningText`). `MainAgentHooks` is exported but was never
          // wired into `buildMainAgent`, so nothing populated this extra and the
          // "[思考过程]" feature could never activate. Populate it here from the
          // final LLM response.
          const reasoningContent = runResult.finalResponse?.reasoningContent;
          if (reasoningContent) {
            event.setExtra("reasoning_content", reasoningContent);
          }

          await this.applyNonStreamingResult(event, runResult);

          // Append-only persistence of the messages this run produced. The
          // reply text extracted below is passed as a fallback so a reply is
          // never lost when the run view yields nothing storable. Note the
          // internal instruction of system-triggered runs needs no special
          // handling here: it is the run's *prompt*, which the start index
          // already excludes.
          await this.saveRunHistory(agentRunner, umo, convId, {
            fallbackAssistantText: event.getExtra<string>("_cachedAssistantText"),
            // Persist exactly what was delivered (set by
            // applyNonStreamingResult). Undefined for error responses so the
            // message-scan fallback does not resurrect the error text.
            assistantUtterances: event.getExtra<string[]>("_runAssistantUtterances"),
          });
          yield;
        } finally {
          unregisterActiveRunner(event.unifiedMsgOrigin, agentRunner);
        }

        await this.ctx.callEventHook(event, EventType.OnAgentDoneEvent);

        // Record conversation turn to short-term memory
        this.recordConversationToMemory(event);
      } finally {
        releaseLock();
      }
    } catch (e) {
      // Log the full error server-side for diagnostics; send the user a
      // generic message so internal details (file paths, hostnames, SQL
      // fragments, stack traces) cannot leak through the chat reply.
      console.error("[ProcessStage] Pipeline error:", e);
      // Do not send a duplicate error to the user when the event was already
      // stopped (nothing will be delivered anyway) or a result is already
      // pending (respond stage will deliver it) (#90).
      if (!event.isStopped() && !event.getResult()) {
        await event.send([plainText("抱歉，处理您的消息时发生了内部错误，请稍后重试。")]);
      }
    } finally {
      try { await event.stopTyping(); } catch { /* ignore */ }
    }
  }

  /**
   * Apply the non-streaming agent run result to the event: choose the
   * assistant text from `finalResponse` (preferred) or fall back to the
   * collected `chains`, set the `EventResult`, and cache the text so
   * {@link recordConversationToMemory} can still see it after `respond`
   * clears the result.
   *
   * This method deliberately does NOT write to conversation history: the
   * reply is persisted by {@link saveRunHistory} (from the run view, with this
   * text as a fallback). Having two writers for the same message is harmless
   * under "overwrite" semantics but produces duplicates once persistence is
   * append-only.
   */
  private async applyNonStreamingResult(
    event: MessageEvent,
    runResult: RunAgentResult,
  ): Promise<void> {
    const utterances = extractAssistantUtterances(runResult);

    if (runResult.finalResponse?.role === "err") {
      // Error responses are shown to the user but never persisted as
      // assistant history. `_cachedAssistantText` / `_runAssistantUtterances`
      // are intentionally left unset so saveRunHistory stores nothing.
      const errText = runResult.finalResponse.completionText
        ?? (runResult.finalResponse.resultChain?.message ?? "");
      event.setResult(
        new EventResult()
          .setResultContentType(ResultContentType.LLM_RESULT)
          .plain(errText)
      );
      return;
    }

    if (utterances.length === 0) {
      console.warn("[ProcessStage] No final response from agent!");
      return;
    }

    // Agent mode: deliver every visible utterance (intermediate narration +
    // final reply) as its own component so the user follows the agent's work.
    // Chat mode (default): deliver only the final reply. The SAME list is
    // stashed for saveRunHistory, so delivery and persistence cannot diverge.
    const sendIntermediate = this.ctx.config.sendIntermediateReplies === true;
    const delivered = sendIntermediate
      ? utterances
      : [utterances[utterances.length - 1]];

    const result = new EventResult().setResultContentType(ResultContentType.LLM_RESULT);
    for (const text of delivered) {
      result.plain(text);
    }
    event.setResult(result);
    event.setExtra("_cachedAssistantText", delivered.join("\n\n"));
    event.setExtra("_runAssistantUtterances", delivered);
  }

  /**
   * Build the **static** portion of the system prompt.
   *
   * Only content that is stable across requests belongs here: the system
   * message is the very first message of the conversation and therefore the
   * anchor of the provider-side prompt cache (Anthropic `cache_control`,
   * Gemini `cachedContent`, OpenAI automatic prefix caching). Anything that
   * changes per request — the current time, retrieved knowledge, memory
   * snapshots — must NOT live here or it invalidates the cached prefix on
   * every single turn. See {@link buildDynamicContext}.
   */
  private async buildSystemPrompt(): Promise<string | undefined> {
    let systemPrompt: string | undefined;

    const persona = await this.resolveActivePersona();
    if (persona) {
      systemPrompt = persona.prompt;
    }

    // Inject extra context (static configuration)
    const extraContext = this.ctx.config.extraContext?.trim();
    if (extraContext) {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n[Extra Context]\n${extraContext}`
        : `[Extra Context]\n${extraContext}`;
    }

    // Restrict the advertised skills to the persona's selection when it has one
    // (`skills === null` means "all"). Previously the persona's `skills` list
    // was never read, so the Dashboard setting had no effect.
    let activeSkills = this.ctx.skillManager.listSkills({ activeOnly: true });
    if (persona && Array.isArray(persona.skills)) {
      const allowed = new Set(persona.skills.map((s) => String(s).trim()).filter(Boolean));
      activeSkills = activeSkills.filter((s) => allowed.has(s.name));
    }
    const skillsPrompt = buildSkillsPrompt(activeSkills);
    if (skillsPrompt) {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${skillsPrompt}`
        : skillsPrompt;
    }

    return systemPrompt;
  }

  /**
   * Resolve the persona active for this request: the config default, falling
   * back to the manager's default persona. Shared by the system-prompt builder
   * (prompt + skills) and the agent builder (tool allowlist) so both read the
   * same persona consistently.
   */
  private async resolveActivePersona(): Promise<import("@yachiyo/persona/manager.js").Personality | null> {
    const personaId = this.ctx.config.defaultPersonaId;
    return this.ctx.personaManager.resolveSelectedPersona(personaId || null);
  }

  /**
   * Build the **volatile** per-request context: current date/time, retrieved
   * knowledge base entries and the memory snapshot.
   *
   * This is deliberately kept out of the system prompt and injected into the
   * current user message instead (see {@link buildAgent}). The user message is
   * always the newest, never-cached part of the request, so volatile content
   * placed there leaves the static system prefix and the append-only history
   * prefix byte-stable across turns — which is what makes prompt caching hit.
   * Putting it in the system prompt made the prefix change every second and
   * reduced the cache hit rate to zero for every provider.
   */
  private async buildDynamicContext(event: MessageEvent): Promise<string | undefined> {
    const parts: string[] = [];

    // Current date/time (configurable)
    if (this.ctx.config.injectDateTime !== false) {
      const tz = this.ctx.config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const now = new Date();
      let timeInfo: string;
      try {
        timeInfo = now.toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long", hour12: false });
      } catch {
        timeInfo = now.toLocaleString("en-US", { dateStyle: "full", timeStyle: "long", hour12: false });
      }
      parts.push(`Current date/time: ${timeInfo} (Timezone: ${tz})`);
    }

    const kbNames = this.ctx.config.knowledgeBaseNames;
    if (kbNames && kbNames.length > 0) {
      const kbContext = await this.ctx.knowledgeBaseManager.retrieve(
        event.messageStr,
        kbNames
      );
      if (kbContext) {
        parts.push(`[Knowledge Base Reference]\n${kbContext}`);
      }
    }

    // Memory context (user profile, long-term memories, etc.)
    const memoryContext = this.buildMemoryContext(event);
    if (memoryContext) {
      parts.push(memoryContext);
    }

    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  private async buildAgent(event: MessageEvent, systemPrompt?: string, dynamicContext?: string): Promise<import("@yachiyo/agent/agent-builder.js").MainAgentBuildResult | null> {
    try {
      const { buildMainAgent } = await import("@yachiyo/agent/agent-builder.js");

      // Apply prompt prefix
      let prompt = event.messageStr ?? "";
      // Strip CQ image/face/record codes from prompt when same media is sent as imageUrls/audioUrls,
      // to avoid sending raw CQ code text alongside actual image data which confuses LLMs (e.g. Gemini returns empty parts).
      const hasImageUrls = event.messageObj.components.some(c => c.type === ComponentType.Image);
      const hasAudioUrls = event.messageObj.components.some(c => c.type === ComponentType.Record);
      if ((hasImageUrls || hasAudioUrls) && /\[CQ:/.test(prompt)) {
        prompt = prompt
          .replace(/\[CQ:image,[^\]]*\]/g, "")
          .replace(/\[CQ:record,[^\]]*\]/g, "")
          .replace(/\[CQ:face,[^\]]*\]/g, "")
          .replace(/\[CQ:video,[^\]]*\]/g, "")
          .replace(/\[CQ:retweet,[^\]]*\]/g, "")
          .trim();
        // If prompt becomes empty after stripping CQ codes but media exists, use a placeholder
        if (!prompt && (hasImageUrls || hasAudioUrls)) {
          prompt = hasImageUrls && hasAudioUrls ? "[图片和语音]" : hasImageUrls ? "[图片]" : "[语音]";
        }
      }
      const promptPrefix = this.ctx.config.promptPrefix?.trim();
      if (promptPrefix) {
        if (promptPrefix.includes("{{prompt}}")) {
          prompt = promptPrefix.replace("{{prompt}}", prompt);
        } else {
          prompt = `${promptPrefix}${prompt}`;
        }
      }

      // Load conversation history
      const umo = event.unifiedMsgOrigin;
      let convId = await this.ctx.conversationManager.getCurrConversationId(umo);
      let conv = convId ? await this.ctx.conversationManager.getConversation(umo, convId) : null;
      if (convId && !conv) convId = null;
      if (!convId || !conv) {
        convId = await this.ctx.conversationManager.newConversation(umo);
        conv = await this.ctx.conversationManager.getConversation(umo, convId);
      }
      let historyContexts: import("@yachiyo/agent/message.js").Message[] = [];
      try {
        historyContexts = conv ? JSON.parse(conv.history) : [];
        // Clean raw CQ codes from history contexts to avoid prompt clutter
        for (const msg of historyContexts) {
          if (typeof msg.content === "string" && /\[CQ:/.test(msg.content)) {
            msg.content = msg.content
              .replace(/\[CQ:image,[^\]]*\]/g, "")
              .replace(/\[CQ:record,[^\]]*\]/g, "")
              .replace(/\[CQ:face,[^\]]*\]/g, "")
              .replace(/\[CQ:video,[^\]]*\]/g, "")
              .replace(/\[CQ:retweet,[^\]]*\]/g, "")
              .trim();
          }
        }
      } catch {
        console.warn("[ProcessStage] Failed to parse conversation history, starting fresh");
        historyContexts = [];
      }

      // The complete stored history is sent as prompt context. Size control is
      // handled downstream by token-based compression in the agent runner
      // (ContextManager), which replaces the oldest rounds with a summary at a
      // stable position. A front-truncating sliding window is deliberately NOT
      // applied here: dropping the oldest messages shifts the prefix of every
      // subsequent request, which invalidates the provider-side prompt cache
      // (Anthropic `cache_control`, Gemini `cachedContent`, OpenAI prefix
      // caching) on every turn once the history exceeds the window. Storage is
      // append-only regardless (background memory indexing reads the full log).
      const providerRequest = event.requestLlm(prompt, {
        // Session id is used by provider-side prompt caching (Gemini keys its
        // server-side cachedContents by it). Without this every conversation
        // fell back to the literal "default" key, so enabling caching would
        // make all sessions share (and constantly evict) one cache.
        sessionId: conv?.id ?? event.unifiedMsgOrigin,
        imageUrls: event.messageObj.components
          .filter((c): c is ImageComponent => c.type === ComponentType.Image)
          .map(c => c.url ?? c.file)
          .filter((u): u is string => Boolean(u)),
        audioUrls: event.messageObj.components
          .filter((c): c is RecordComponent => c.type === ComponentType.Record)
          .map(c => c.url ?? c.file)
          .filter((u): u is string => Boolean(u)),
        systemPrompt,
        dynamicContext,
        contexts: historyContexts,
        conversation: conv ? {
          id: conv.id,
          unifiedMsgOrigin: conv.unifiedMsgOrigin,
          personaId: conv.personaId ?? undefined,
          history: conv.history,
          platformId: conv.platformId ?? undefined,
          tokenUsage: conv.tokenUsage ?? undefined,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
        } : undefined,
      });

      providerRequest.temperature = this.ctx.config.temperature;

      const provider = this.ctx.providerManager?.getUsingProvider?.(
        "chat_completion" as ProviderType,
        event.unifiedMsgOrigin
      );

      if (!provider) {
        console.warn("[ProcessStage] No provider found for chat_completion");
        return null;
      }

      // 获取 fallback providers，实现多供应商自动切换
      const fallbackProviders = this.ctx.providerManager?.getFallbackProviders?.() ?? [];

      // LLM 调用本身是否走流式：由事件级覆盖(enable_streaming，默认 true)与模型配置
      // (modelStreaming)共同决定。平台消息投递已统一为缓冲后一次性发送（不再逐 chunk 流式），
      // 因此这里不再受任何平台投递能力影响；runner 会正确收集 streaming_delta chunk
      // 并聚合为完整结果，LLM 流式只是获得首 token 延迟、可取消性、工具调用早出等内部收益。
      const enableStreaming = event.getExtra<boolean>("enable_streaming") ?? true;
      const modelStreaming = this.ctx.config.modelStreaming ?? true;
      const useStreaming = enableStreaming && modelStreaming;
      // 提供商级提示缓存，默认开启。对 OpenAI/Responses 无影响（服务端自动
      // 缓存）；仅 Anthropic/Gemini 会改变请求体。存量 config blob 无该字段
      // 时按开启处理，用户可在 Dashboard 关闭。
      const providerCaching = this.ctx.config.providerCachingEnabled ?? true;
      // Context-size control now relies entirely on token-based compression
      // (there is no longer a per-turn message-count window). Forward the
      // user's chosen strategy so the dashboard settings actually take effect:
      // `llm_compress` produces a summary at a fixed position (cache-friendly),
      // while the `truncate_by_turns` fallback drops old rounds.
      const cfg = this.ctx.config;
      // Persona tool allowlist: `null`/undefined = all tools. Resolved here (not
      // in buildSystemPrompt) so the agent builder can filter the tool set.
      const persona = await this.resolveActivePersona();
      const result = await buildMainAgent({
        provider,
        request: providerRequest,
        context: event,
        toolManager: this.ctx.toolManager,
        fallbackProviders,
        config: {
          allowedTools: persona?.tools ?? null,
          streaming: useStreaming,
          providerCaching,
          // AgentConfig stores this in MILLISECONDS (dashboard label: 毫秒,
          // default 120000); the agent layer works in SECONDS. Forwarding it
          // unconverted would set a 120000-second (33h) timeout, so divide.
          // Guard non-positive/NaN back to undefined → agent default.
          toolCallTimeout:
            typeof cfg.toolCallTimeout === "number" &&
            Number.isFinite(cfg.toolCallTimeout) &&
            cfg.toolCallTimeout > 0
              ? Math.round(cfg.toolCallTimeout / 1000)
              : undefined,
          contextLimitReachedStrategy: cfg.contextLimitReachedStrategy,
          llmCompressInstruction: cfg.llmCompressInstruction,
          llmCompressKeepRecent: cfg.llmCompressKeepRecent,
          llmCompressKeepRecentRatio: cfg.llmCompressKeepRecentRatio,
          llmCompressProviderId: cfg.llmCompressProviderId,
          enforceMaxTurns: cfg.enforceMaxTurns,
          truncateTurns: cfg.truncateTurns,
          reasoningEffort: cfg.reasoningEffort,
          autoReasoningEffort: cfg.autoReasoningEffort,
        },
      });

      return result;
    } catch (e) {
      // Real errors must NOT be collapsed into "no provider available" (null) —
      // that misleads debugging into blaming provider configuration (#89).
      // Log the full error here, then rethrow so the caller sends the generic
      // user-facing message instead of the misleading "no model" one.
      console.error("Failed to build agent:", e);
      throw e;
    }
  }

  /** 解析（必要时创建）当前会话，返回 { convId, umo } */
  private async resolveConversation(event: MessageEvent): Promise<{ convId: string; umo: string }> {
    const umo = event.unifiedMsgOrigin;
    let convId = await this.ctx.conversationManager.getCurrConversationId(umo);
    let conv = convId ? await this.ctx.conversationManager.getConversation(umo, convId) : null;

    // session_conversations 有映射但 conversations 表无对应记录 → 重建
    if (convId && !conv) {
      convId = null;
    }

    if (!convId || !conv) {
      convId = await this.ctx.conversationManager.newConversation(umo);
    }

    return { convId, umo };
  }

  private async saveUserMessage(event: MessageEvent): Promise<{ convId: string; umo: string }> {
    const { convId, umo } = await this.resolveConversation(event);
    const conv = await this.ctx.conversationManager.getConversation(umo, convId);

    // System-generated events (e.g. proactive reminders) carry internal
    // instructions in messageStr that should NOT be persisted to the user's
    // conversation history. Instead of skipping the user entry entirely (which
    // lost the turn), persist the clean summary the adapter attached via
    // `_historyUserMessage` — the platform layer documents that "ProcessStage
    // will save this version". An explicitly empty summary skips the write.
    const historyUserMessage = event.getExtra<string>("_historyUserMessage");

    const history: Array<{ role: string; content: string }> = conv ? (() => { try { return JSON.parse(conv.history); } catch { return []; } })() : [];

    if (historyUserMessage !== undefined) {
      if (!historyUserMessage.trim()) return { convId, umo };
      history.push({ role: "user", content: historyUserMessage });

      await this.ctx.conversationManager.updateConversation(umo, convId, {
        history: JSON.stringify(history),
      });

      return { convId, umo };
    }

    let userContent = event.messageStr ?? "";
    const hasImageUrls = event.messageObj.components.some(c => c.type === ComponentType.Image);
    const hasAudioUrls = event.messageObj.components.some(c => c.type === ComponentType.Record);
    if ((hasImageUrls || hasAudioUrls) && /\[CQ:/.test(userContent)) {
      userContent = userContent
        .replace(/\[CQ:image,[^\]]*\]/g, "")
        .replace(/\[CQ:record,[^\]]*\]/g, "")
        .replace(/\[CQ:face,[^\]]*\]/g, "")
        .replace(/\[CQ:video,[^\]]*\]/g, "")
        .replace(/\[CQ:retweet,[^\]]*\]/g, "")
        .trim();
      if (!userContent && (hasImageUrls || hasAudioUrls)) {
        userContent = hasImageUrls && hasAudioUrls ? "[图片和语音]" : hasImageUrls ? "[图片]" : "[语音]";
      }
    }

    history.push({ role: "user", content: userContent });

    // Append-only: persist the complete raw history. Background memory
    // indexing (MemoryConsolidator -> getUnindexedConversations) reads the
    // full transcript, and per-request prompt size is handled by the
    // context-control stage — so storage must never destructively truncate.
    await this.ctx.conversationManager.updateConversation(umo, convId, {
      history: JSON.stringify(history),
    });

    return { convId, umo };
  }

  private async saveAssistantMessage(umo: string, convId: string, text: string): Promise<void> {
    if (!text.trim()) return;
    try {
      const conv = await this.ctx.conversationManager.getConversation(umo, convId);
      if (!conv) return;
      const history: Array<{ role: string; content: string }> = (() => { try { return JSON.parse(conv.history); } catch { return []; } })();
      history.push({ role: "assistant", content: text });

      // Append-only: persist the complete raw history (see saveUserMessage).
      await this.ctx.conversationManager.updateConversation(umo, convId, {
        history: JSON.stringify(history),
      });
    } catch (e) {
      console.error("Failed to save assistant message:", e);
    }
  }

  /**
   * Append the messages produced by this agent run to the stored conversation
   * transcript.
   *
   * Persistence is **append-only**: only `messages[runMessagesStartIndex…]` —
   * this run's own assistant output — is written, and it is concatenated onto
   * the stored history instead of replacing it.
   *
   * Why not re-write the whole run view (the previous behaviour): the view is
   * mutated in place by `ContextManager.process()`, which drops the oldest
   * turns or replaces them with an LLM summary. Persisting that view therefore
   * deleted the earliest turns from storage — and storage is precisely what the
   * background memory indexer reads (`getUnindexedConversations`), so long
   * conversations lost exactly the history they most needed to keep.
   *
   * Loaded history and the current user message are NOT written here: the
   * loaded part is already in storage and `saveUserMessage` owns the user
   * message. That gives every message exactly one writer, which is what makes
   * append-only writes idempotent without needing per-message ids.
   *
   * Filtering: tool-call mechanics and reasoning/thinking content are not
   * conversation content. `think` parts are stripped before persisting — see
   * {@link stripThinkParts} — because they are provider-internal:
   *   - replaying them every later turn wastes tokens and storage/memory, and
   *   - their signatures (Anthropic thinking signature, Gemini thoughtSignature)
   *     can go stale, so replaying a persisted signature can make the provider
   *     reject the request.
   * The visible text of each turn is preserved unchanged.
   */
  private async saveRunHistory(
    agentRunner: ToolLoopAgentRunner,
    umo: string,
    convId: string,
    options?: { fallbackAssistantText?: string; assistantUtterances?: string[] },
  ): Promise<void> {
    const produced: Record<string, unknown>[] = [];

    if (options?.assistantUtterances !== undefined) {
      // Preferred path (production): persist EXACTLY the utterances that were
      // delivered to the user. One assistant entry per delivered segment, in
      // order. An explicit empty array means "nothing was delivered" (e.g. an
      // error response) and persists nothing — it does NOT fall through to the
      // message scan. This is what keeps delivery and persistence identical.
      for (const text of options.assistantUtterances) {
        if (typeof text === "string" && text.trim().length > 0) {
          produced.push({ role: "assistant", content: text });
        }
      }
    } else {
      // Fallback path (tests / callers without a delivered-utterance list):
      // derive storable messages from the run view.
      const messages = agentRunner.currentRunContext?.messages;
      // Fall back to "nothing was produced" when a runner does not report a
      // boundary: skipping is recoverable, re-appending loaded history is not.
      const startIndex = typeof agentRunner.runMessagesStartIndex === "number"
        ? agentRunner.runMessagesStartIndex
        : (messages?.length ?? 0);

      for (const msg of (messages ?? []).slice(startIndex)) {
        if (msg.role === "system" || msg.role === "_checkpoint") continue;
        if (msg.role === "tool") continue;
        if (msg._noSave) continue;

        // Strip reasoning parts and decide whether any *visible* content
        // remains. A message whose only content is thinking has no
        // conversation value and must not be persisted as a standalone entry.
        const content = stripThinkParts(msg.content);
        const hasVisibleText = typeof content === "string"
          ? content.trim().length > 0
          : Array.isArray(content) && content.length > 0;
        if (msg.role === "assistant" && !hasVisibleText) continue;

        const entry: Record<string, unknown> = { role: msg.role };
        if (content !== undefined) entry.content = content;
        produced.push(entry);
      }

      if (produced.length === 0) {
        // Nothing storable came out of the run (the reply was dropped by
        // compression, or the run context was already consumed). Fall back to
        // the text extracted by the pipeline so a reply is never lost.
        const fallback = options?.fallbackAssistantText;
        if (!fallback || !fallback.trim()) return;
        produced.push({ role: "assistant", content: fallback });
      }
    }

    // Nothing to append (e.g. an explicit empty utterance list for an error
    // response): skip the write entirely rather than rewriting the transcript
    // with identical content.
    if (produced.length === 0) return;

    // Read the stored transcript first. If it cannot be read, skip the write
    // entirely: appending blind could duplicate turns and overwriting could
    // destroy history — neither is acceptable for an append-only path.
    let stored: Record<string, unknown>[] = [];
    try {
      const conv = await this.ctx.conversationManager.getConversation(umo, convId);
      if (conv?.history) {
        const parsed: unknown = JSON.parse(conv.history);
        if (Array.isArray(parsed)) stored = parsed as Record<string, unknown>[];
      }
    } catch (e) {
      console.error("[ProcessStage] Failed to read conversation history; skipping history append:", e);
      return;
    }

    await this.ctx.conversationManager.updateConversation(umo, convId, {
      history: JSON.stringify([...stored, ...produced]),
    });
  }

  private async recordTokenStats(agentRunner: ToolLoopAgentRunner): Promise<void> {
    try {
      const stats = agentRunner.getStats();

      // If API returned zero usage (e.g. proxies that don't calculate tokens),
      // fall back to local token estimation from conversation messages
      if (stats.tokenUsage.total <= 0) {
        const messages = agentRunner.currentRunContext?.messages;
        if (messages && messages.length > 0) {
          const counter = new EstimateTokenCounter();
          const estimated = counter.countTokens(messages);
          stats.tokenUsage.promptTokens = estimated;
          stats.tokenUsage.completionTokens = 0;
          stats.tokenUsage.total = estimated;
          console.log(`[ProcessStage] API returned zero usage, estimated tokens: ${estimated}`);
        } else {
          return;
        }
      }

      // Clamp to 0: some providers report cache-read tokens that are not a
      // subset of `promptTokens` (Gemini reports `cachedContentTokenCount`
      // separately from `promptTokenCount`), so the subtraction can go negative
      // and corrupt the aggregated dashboard stats.
      const cachedInput = stats.tokenUsage.cacheReadInputTokens ?? 0;
      const otherInput = Math.max(0, stats.tokenUsage.promptTokens - cachedInput);

      const stat: ProviderStat = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        providerId: agentRunner.getProviderId(),
        model: agentRunner.getModel(),
        // `promptTokens` is the inclusive input total for every provider
        // (cache-read + cache-write + uncached). Non-hit input therefore is the
        // total minus the cache-read portion; cache-write tokens stay counted as
        // "other" input so the overall input total is preserved.
        tokenInputOther: otherInput,
        tokenInputCached: cachedInput,
        tokenOutput: stats.tokenUsage.completionTokens,
        startTime: stats.startTime,
        endTime: stats.endTime || Date.now(),
        timeToFirstToken: stats.timeToFirstToken,
        createdAt: new Date(),
      };
      await this.ctx.conversationManager.recordProviderStat(stat);
    } catch (e) {
      console.error("[ProcessStage] Failed to record token stats:", e);
    }
  }

  /**
   * Build memory context string for injection into system prompt.
   * Injects: user profile, long-term memories, history index.
   * All limits are configurable via AgentConfig.
   */
  private buildMemoryContext(_event: MessageEvent): string | null {
    const store = this.ctx.memoryStore;
    if (!store) return null;

    const config = this.ctx.config;
    if (!config.memoryEnabled) return null;

    const parts: string[] = [];

    try {
      // 1. User profile (structured: preferences, background, style)
      const profileEntry = store.recall("user_profile");
      if (profileEntry) {
        try {
          const profile = JSON.parse(profileEntry.value);
          const lines: string[] = [];
          if (profile.background) lines.push(`* **背景信息**：${profile.background}`);
          if (profile.preferences) lines.push(`* **偏好习惯**：${profile.preferences}`);
          if (profile.style) lines.push(`* **交流风格**：${profile.style}`);
          if (lines.length > 0) {
            parts.push(`#### 用户画像\n${lines.join("\n")}`);
          }
        } catch {
          parts.push(`#### 用户画像\n- ${profileEntry.value}`);
        }
      }

      // 2. Long-term core memories (exclude raw dialogue memories promoted from short-term)
      const longTermMemories = store.list(config.memoryInjectLongTermCount, { memoryType: "long_term" })
        .filter(m => !m.key.startsWith("short_term_") && !m.tags.includes("short_term"));
      if (longTermMemories.length > 0) {
        const memoryLines = longTermMemories
          .map(m => `- [${m.key}] ${m.value}`)
          .join("\n");
        parts.push(`#### 长期核心背景\n${memoryLines}`);
      }

      // 3. Persona-bound memories (if persona is active)
      const personaId = config.defaultPersonaId;
      if (personaId) {
        const personaMemories = store.list(config.memoryInjectPersonaCount, { memoryType: "persona", scope: "persona", scopeId: personaId });
        if (personaMemories.length > 0) {
          const personaLines = personaMemories
            .map(m => `- [${m.key}] ${m.value}`)
            .join("\n");
          parts.push(`#### 角色记忆\n${personaLines}`);
        }
      }
    } catch (e) {
      console.error("[ProcessStage] Failed to build memory context:", e);
      return null;
    }

    if (parts.length === 0) return null;
    return `### 历史背景与上下文管理\n${parts.join("\n\n")}`;
  }

  /**
   * Check and trigger memory consolidation/indexing after conversation turn.
   * Called after OnAgentDoneEvent.
   *
   * Short-term memory is managed in-context via automatic context compression
   * (ContextManager / LLMSummaryCompressor) and full conversation persistence,
   * so raw message turns are no longer saved as ephemeral KV rows in the
   * long-term memories table.
   */
  private recordConversationToMemory(event: MessageEvent): void {
    if (event.getExtra<boolean>("_debugChat") === true) return;
    if (!this.ctx.config.memoryEnabled) return;

    try {
      // Trigger consolidation/indexing if thresholds are met
      if (this.ctx.memoryConsolidator) {
        this.ctx.memoryConsolidator.checkAndConsolidate().catch((e) => {
          console.error("[ProcessStage] Failed to check and consolidate memory:", e);
        });
      }
    } catch (e) {
      console.error("[ProcessStage] Failed to check memory consolidation:", e);
    }
  }
}

