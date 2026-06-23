import { PipelineStage, registerStage } from "../stage.js";
import type { PipelineContext } from "../context.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import { EventResult, ResultContentType } from "@yachiyo/message/event-result.js";
import { ComponentType, type ImageComponent, type RecordComponent } from "@yachiyo/message/components.js";
import type { MessageChain } from "@yachiyo/agent/types.js";
import type { ProviderType } from "@yachiyo/provider/types.js";
import type { ToolLoopAgentRunner } from "@yachiyo/agent/runners/tool-loop-agent-runner.js";
import { EventType } from "@yachiyo/plugin/event-type.js";
import type { StarHandlerMetadata } from "@yachiyo/plugin/handler.js";
import type { ProviderStat } from "@yachiyo/conversation/store.js";
import { registerActiveRunner, unregisterActiveRunner } from "../follow-up.js";
import { buildSkillsPrompt } from "@yachiyo/skill/manager.js";
import { EstimateTokenCounter } from "@yachiyo/agent/context/token-counter.js";

@registerStage
export class ProcessStage extends PipelineStage {
  private ctx!: PipelineContext;
  private streamingResponse: boolean = true;
  private maxStep: number = 30;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.ctx = ctx;
    this.streamingResponse = ctx.config.streamingResponse ?? true;
    this.maxStep = ctx.config.maxStep ?? 30;
  }

  async *process(event: MessageEvent): AsyncGenerator<void, void> {
    const hasValidMessage = Boolean(event.messageStr?.trim());
    const hasMediaContent = event.messageObj.components.some(
      c => [ComponentType.Image, ComponentType.File, ComponentType.Record, ComponentType.Video].includes(c.type)
    );
    if (!hasValidMessage && !hasMediaContent) return;

    try {
      try { await event.sendTyping(); } catch { /* ignore */ }

      await this.ctx.callEventHook(event, EventType.OnAgentBeginEvent);
      if (event.isStopped()) return;

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
          if (result && result.resultContentType !== ResultContentType.STREAMING_RESULT) {
            const responseText = result.getPlainText();
            if (responseText) {
              await this.saveAssistantMessage(umo, convId, responseText);
              // Cache assistant text before yield — respond stage will clearResult()
              event.setExtra("_cachedAssistantText", responseText);
            }
          } else if (result?.resultContentType === ResultContentType.STREAMING_RESULT) {
            event.setExtra("_saveHistory_convId", convId);
            event.setExtra("_saveHistory_umo", umo);
          }
          yield;
          await this.ctx.callEventHook(event, EventType.OnAgentDoneEvent);
          this.recordConversationToMemory(event);
          return;
        }
      }

      const releaseLock = await this.ctx.sessionLockManager.acquireLock(event.unifiedMsgOrigin);
      try {
        const systemPrompt = await this.buildSystemPrompt(event);

        const buildResult = await this.buildAgent(event, systemPrompt);
      if (!buildResult) {
        console.warn("[ProcessStage] buildAgent returned null - no provider available");
        await event.send([{
          type: ComponentType.Plain,
          text: "抱歉，当前没有可用的模型来处理您的消息，请检查 Provider 配置。",
          toDict() { return { type: "text", data: { text: "抱歉，当前没有可用的模型来处理您的消息，请检查 Provider 配置。" } }; },
        } as any]);
        return;
      }

      const { agentRunner } = buildResult;

      console.log(`[ProcessStage] Agent built successfully. Starting execution for session: ${event.sessionId}`);

        // 在执行 agent 前保存用户消息
        const { convId, umo } = await this.saveUserMessage(event);

        await this.ctx.callEventHook(event, EventType.OnLLMRequestEvent);
        if (event.isStopped()) return;

        registerActiveRunner(event.unifiedMsgOrigin, agentRunner);
        try {
          const enableStreaming = event.getExtra<boolean>("enable_streaming") ?? this.streamingResponse;
          const platformSupportsStreaming = event.platformMeta.supportStreamingMessage;

          if (enableStreaming && platformSupportsStreaming) {
          const streamGenerator = this.runAgentStreaming(agentRunner, event);
            event.setResult(
              new EventResult()
                .setResultContentType(ResultContentType.STREAMING_RESULT)
                .setAsyncStream(streamGenerator)
            );
            // 设置 extras 供 respond 阶段保存流式助手消息
            event.setExtra("_saveHistory_convId", convId);
            event.setExtra("_saveHistory_umo", umo);
            yield;
          } else {
            const { runAgent } = await import("@yachiyo/agent/agent-runner.js");
            const runResult = await runAgent(agentRunner, {
              maxStep: this.maxStep,
              shouldStop: () => event.isStopped(),
              onError: (err) => console.error(`[ProcessStage] Agent error: ${err}`),
            });

            // Record provider token stats after agent run completes
            await this.recordTokenStats(agentRunner);

            if (runResult.finalResponse) {
              const respText = runResult.finalResponse.completionText ?? (runResult.finalResponse.resultChain?.message ?? "");
              // If finalResponse has no text, fall back to collected chains (e.g. fallback empty-response message)
              const chainText = respText || runResult.chains
                .filter(c => c.type === "text" && c.message)
                .map(c => c.message)
                .join("");
              const assistantText = chainText || respText;
              if (runResult.finalResponse.role === "err") {
                event.setResult(
                  new EventResult()
                    .setResultContentType(ResultContentType.LLM_RESULT)
                    .plain(assistantText)
                );
              } else {
                await this.saveAssistantMessage(umo, convId, assistantText);
                event.setResult(
                  new EventResult()
                    .setResultContentType(ResultContentType.LLM_RESULT)
                    .plain(assistantText)
                );
                // Cache assistant text before yield — respond stage will clearResult()
                event.setExtra("_cachedAssistantText", assistantText);
              }
            } else {
              // No finalResponse — try to use collected chains as fallback
              const chainText = runResult.chains
                .filter(c => c.type === "text" && c.message)
                .map(c => c.message)
                .join("");
              if (chainText) {
                await this.saveAssistantMessage(umo, convId, chainText);
                event.setResult(
                  new EventResult()
                    .setResultContentType(ResultContentType.LLM_RESULT)
                    .plain(chainText)
                );
                // Cache assistant text before yield — respond stage will clearResult()
                event.setExtra("_cachedAssistantText", chainText);
              } else {
                console.warn("[ProcessStage] No final response from agent!");
              }
            }
            yield;
          }
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
      const errMsg = e instanceof Error ? e.message : String(e);
      await event.send([
        { type: ComponentType.Plain, text: `Error: ${errMsg}`, toDict() { return { type: "text", data: { text: errMsg } }; } } as import("@yachiyo/message/components.js").MessageComponent
      ]);
    } finally {
      try { await event.stopTyping(); } catch { /* ignore */ }
    }
  }

  private async buildSystemPrompt(event: MessageEvent): Promise<string | undefined> {
    let systemPrompt: string | undefined;

    const personaId = this.ctx.config.defaultPersonaId;
    const persona = await this.ctx.personaManager.resolveSelectedPersona(personaId || null);
    if (persona) {
      systemPrompt = persona.prompt;
    }

    // Inject current date/time (configurable)
    if (this.ctx.config.injectDateTime !== false) {
      const tz = this.ctx.config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const now = new Date();
      let timeInfo: string;
      try {
        timeInfo = now.toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long", hour12: false });
      } catch {
        timeInfo = now.toLocaleString("en-US", { dateStyle: "full", timeStyle: "long", hour12: false });
      }
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\nCurrent date/time: ${timeInfo} (Timezone: ${tz})`
        : `Current date/time: ${timeInfo} (Timezone: ${tz})`;
    }

    // Inject extra context
    const extraContext = this.ctx.config.extraContext?.trim();
    if (extraContext) {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n[Extra Context]\n${extraContext}`
        : `[Extra Context]\n${extraContext}`;
    }

    const kbNames = this.ctx.config.knowledgeBaseNames;
    if (kbNames && kbNames.length > 0) {
      const kbContext = await this.ctx.knowledgeBaseManager.retrieve(
        event.messageStr,
        kbNames
      );
      if (kbContext) {
        systemPrompt = systemPrompt
          ? `${systemPrompt}\n\n[Knowledge Base Reference]\n${kbContext}`
          : `[Knowledge Base Reference]\n${kbContext}`;
      }
    }

    const activeSkills = this.ctx.skillManager.listSkills({ activeOnly: true });
    const skillsPrompt = buildSkillsPrompt(activeSkills);
    if (skillsPrompt) {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${skillsPrompt}`
        : skillsPrompt;
    }

    // Inject memory context (user profile, long-term memories, etc.)
    const memoryContext = this.buildMemoryContext(event);
    if (memoryContext) {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${memoryContext}`
        : memoryContext;
    }

    return systemPrompt;
  }

  private async buildAgent(event: MessageEvent, systemPrompt?: string): Promise<import("@yachiyo/agent/agent-builder.js").MainAgentBuildResult | null> {
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

      const providerRequest = event.requestLlm(prompt, {
        imageUrls: event.messageObj.components
          .filter((c): c is ImageComponent => c.type === ComponentType.Image)
          .map(c => c.url ?? c.file)
          .filter((u): u is string => Boolean(u)),
        audioUrls: event.messageObj.components
          .filter((c): c is RecordComponent => c.type === ComponentType.Record)
          .map(c => c.url ?? c.file)
          .filter((u): u is string => Boolean(u)),
        systemPrompt,
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

      const enableStreaming = event.getExtra<boolean>("enable_streaming") ?? this.streamingResponse;
    const platformSupportsStreaming = event.platformMeta.supportStreamingMessage;
    const modelStreaming = this.ctx.config.modelStreaming ?? true;
    // 当平台不支持流式或配置禁用模型流式时，LLM 也应使用非流式模式，避免产生大量无用 chunk
    const useStreaming = enableStreaming && platformSupportsStreaming && modelStreaming;
    const result = await buildMainAgent({
      provider,
      request: providerRequest,
      context: event,
      toolManager: this.ctx.toolManager,
      fallbackProviders,
      config: {
        streamingResponse: useStreaming,
      },
    });

    return result;
    } catch (e) {
      console.error("Failed to build agent:", e);
      return null;
    }
  }

  private async *runAgentStreaming(
    agentRunner: ToolLoopAgentRunner,
    event: MessageEvent,
  ): AsyncGenerator<MessageChain, void> {
    let chunkCount = 0;
    let steps = 0;
    try {
      // Loop through agent steps (like runAgent does) to handle tool calls
      while (steps < this.maxStep + 1) {
        steps++;

        if (event.isStopped()) {
          agentRunner.requestStop?.();
        }

        for await (const resp of agentRunner.step()) {
          if (resp.type === "streaming_delta") {
            chunkCount++;
            yield resp.data.chain;
          } else if (resp.type === "llm_result") {
            chunkCount++;
            yield resp.data.chain;
          } else if (resp.type === "err") {
            chunkCount++;
            yield resp.data.chain;
          } else if (resp.type === "aborted") {
            return;
          }
          // type === "tool_use" and "tool_result" are handled internally by the runner
        }

        // Check if agent is done
        if (agentRunner.done() || agentRunner.wasAborted()) {
          break;
        }
      }

      // Record provider token stats after agent run completes
      await this.recordTokenStats(agentRunner);
    } catch (e) {
      console.error("Agent streaming error:", e);
    }
  }

  private async saveUserMessage(event: MessageEvent): Promise<{ convId: string; umo: string }> {
    const umo = event.unifiedMsgOrigin;
    let convId = await this.ctx.conversationManager.getCurrConversationId(umo);
    let conv = convId ? await this.ctx.conversationManager.getConversation(umo, convId) : null;

    // session_conversations 有映射但 conversations 表无对应记录 → 重建
    if (convId && !conv) {
      convId = null;
    }

    if (!convId || !conv) {
      convId = await this.ctx.conversationManager.newConversation(umo);
      conv = await this.ctx.conversationManager.getConversation(umo, convId);
    }

    const history: Array<{ role: string; content: string }> = conv ? (() => { try { return JSON.parse(conv.history); } catch { return []; } })() : [];
    
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

    // Truncate history to prevent unbounded growth
    const maxHistoryMessages = this.ctx.config.maxHistoryMessages ?? 200;
    if (history.length > maxHistoryMessages) {
      history.splice(0, history.length - maxHistoryMessages);
    }

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

      // Truncate history to prevent unbounded growth
      const maxHistoryMessages = this.ctx.config.maxHistoryMessages ?? 200;
      if (history.length > maxHistoryMessages) {
        history.splice(0, history.length - maxHistoryMessages);
      }

      await this.ctx.conversationManager.updateConversation(umo, convId, {
        history: JSON.stringify(history),
      });
    } catch (e) {
      console.error("Failed to save assistant message:", e);
    }
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

      const stat: ProviderStat = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        providerId: agentRunner.getProviderId(),
        model: agentRunner.getModel(),
        tokenInputOther: stats.tokenUsage.promptTokens - (stats.tokenUsage.cacheReadInputTokens ?? 0) + (stats.tokenUsage.cacheCreationInputTokens ?? 0),
        tokenInputCached: stats.tokenUsage.cacheReadInputTokens ?? 0,
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
  private buildMemoryContext(event: MessageEvent): string | null {
    const store = this.ctx.memoryStore;
    if (!store) return null;

    const config = this.ctx.config;
    if (!config.memoryEnabled) return null;

    const userId = event.getSenderId();
    const umo = event.unifiedMsgOrigin;
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
   * Record a conversation turn (user message + assistant response) to short-term memory.
   * Called after OnAgentDoneEvent.
   */
  private recordConversationToMemory(event: MessageEvent): void {
    const store = this.ctx.memoryStore;
    if (!store) return;
    if (!this.ctx.config.memoryEnabled) return;

    try {
      const userId = event.getSenderId();
      const umo = event.unifiedMsgOrigin;
      const userMessage = event.messageStr?.trim() ?? "";
      // Try result first; fall back to cached text (respond stage clears result after sending)
      const result = event.getResult();
      const assistantMessage = (result?.getPlainText()?.trim())
        || event.getExtra<string>("_cachedAssistantText")?.trim()
        || "";

      if (!userMessage || !assistantMessage) return;

      // Save user message as short-term memory
      const timestamp = Date.now();
      store.save(
        `short_term_${umo}_${timestamp}_user`,
        userMessage,
        ["conversation", "short_term"],
        {
          memoryType: "short_term",
          scope: "session",
          scopeId: umo,
          priority: 0,
        }
      );

      // Save assistant response as short-term memory
      store.save(
        `short_term_${umo}_${timestamp}_assistant`,
        assistantMessage,
        ["conversation", "short_term"],
        {
          memoryType: "short_term",
          scope: "session",
          scopeId: umo,
          priority: 0,
        }
      );

      // Trigger consolidation if thresholds are met
      if (this.ctx.memoryConsolidator) {
        this.ctx.memoryConsolidator.checkAndConsolidate().catch((e) => {
          console.error("[ProcessStage] Failed to check and consolidate memory:", e);
        });
      }
    } catch (e) {
      console.error("[ProcessStage] Failed to record conversation to memory:", e);
    }
  }
}
