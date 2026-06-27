import type { ProviderManager, STTProvider, TTSProvider, EmbeddingProvider } from "@yachiyo/provider/manager.js";
import type { ConversationManager } from "@yachiyo/conversation/manager.js";
import type { ConfigManager, AgentConfig } from "@yachiyo/config/manager.js";
import type { FunctionToolManager } from "@yachiyo/agent/func-tool-manager.js";
import type { AsyncQueue } from "@yachiyo/common/async-queue.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import type { MessageSession } from "@yachiyo/message/message-session.js";
import type { MessageComponent } from "@yachiyo/message/components.js";
import type { LLMResponse } from "@yachiyo/agent/types.js";
import type { Message } from "@yachiyo/agent/message.js";
import type { Provider } from "@yachiyo/provider/provider.js";
import type { ProviderType } from "@yachiyo/provider/types.js";
import { createContextWrapper } from "@yachiyo/agent/types.js";

export class PluginContext {
  private providerManager: ProviderManager;
  private toolManager: FunctionToolManager;
  private conversationManager: ConversationManager;
  private eventQueue: AsyncQueue<MessageEvent>;
  private configManager: ConfigManager | null;

  constructor(options: {
    providerManager: ProviderManager;
    toolManager: FunctionToolManager;
    conversationManager: ConversationManager;
    eventQueue: AsyncQueue<MessageEvent>;
    configManager?: ConfigManager;
  }) {
    this.providerManager = options.providerManager;
    this.toolManager = options.toolManager;
    this.conversationManager = options.conversationManager;
    this.eventQueue = options.eventQueue;
    this.configManager = options.configManager ?? null;
  }

  getUsingProvider(_umo: string): Provider | null {
    return this.providerManager.getUsingProvider("chat_completion" as ProviderType);
  }

  getProviderById(providerId: string): Provider | null {
    return this.providerManager.providerInsts.find(p => p.providerConfig?.id === providerId) ?? null;
  }

  getAllProviders(): Provider[] {
    return this.providerManager.providerInsts;
  }

  getLlmToolManager(): FunctionToolManager {
    return this.toolManager;
  }

  getConversationManager(): ConversationManager {
    return this.conversationManager;
  }

  getEventQueue(): AsyncQueue<MessageEvent> {
    return this.eventQueue;
  }

  async sendMessage(session: MessageSession, _components: MessageComponent[]): Promise<void> {
    let forceStopped = false;
    const tempFiles: string[] = [];
    const syntheticEvent = {
      messageStr: "",
      messageObj: { type: "friend", groupId: "", selfId: "", sender: { userId: "plugin", nickname: "Plugin" } },
      platformMeta: { id: "plugin", name: "PluginContext" } as any,
      session,
      isWake: false,
      isAtOrWakeCommand: false,
      createdAt: Date.now(),
      stopEvent() { forceStopped = true; },
      continueEvent() { forceStopped = false; },
      isStopped() { return forceStopped; },
      setSkipLlm(_skip: boolean) {},
      trackTemporaryLocalFile(path: string) { tempFiles.push(path); },
      cleanupTemporaryLocalFiles() { tempFiles.length = 0; },
      getMessageStr() { return ""; },
      get unifiedMsgOrigin() { return "single:user:session"; },
      get sessionId() { return session?.sessionId ?? "" },
      getPlatformName() { return "Plugin"; },
      getPlatformId() { return "plugin"; },
      getMessageType() { return "friend"; },
      getGroupId() { return ""; },
      getSelfId() { return ""; },
      getSenderId() { return "plugin"; },
      getSenderName() { return "Plugin"; },
      isPrivateChat() { return true; },
      isWakeUp() { return false; },
      setResult(_result: any) {},
      send: async () => {},
      sendStreaming: async function* (_generator: any) {},
    } as unknown as MessageEvent;
    this.eventQueue.put(syntheticEvent);
  }

  async llmGenerate(prompt: string, options?: Record<string, unknown>): Promise<string> {
    const provider = this.providerManager.getUsingProvider("chat_completion" as ProviderType);
    if (!provider) throw new Error("No LLM provider available");

    // 支持 fallback：主 provider 失败时尝试 fallback providers
    const candidates = [provider, ...this.providerManager.getFallbackProviders()];
    let lastError: Error | null = null;

    for (const prov of candidates) {
      try {
        const response: LLMResponse = await prov.textChat({
          contexts: [{ role: "user", content: prompt }],
          ...options,
        });
        return response.completionText ?? "";
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        console.warn(`[PluginContext] Provider ${prov.providerConfig?.id ?? "?"} llmGenerate 失败，尝试下一个`);
      }
    }
    throw lastError ?? new Error("All providers failed in llmGenerate");
  }

  async toolLoopAgent(request: { prompt: string; systemPrompt?: string; maxSteps?: number }): Promise<LLMResponse> {
    const provider = this.providerManager.getUsingProvider("chat_completion" as ProviderType);
    if (!provider) throw new Error("No LLM provider available for toolLoopAgent");

    // 支持 fallback
    const candidates = [provider, ...this.providerManager.getFallbackProviders()];
    let lastError: Error | null = null;

    for (const prov of candidates) {
      try {
        return await this.runToolLoopWithProvider(prov, request);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        console.warn(`[PluginContext] Provider ${prov.providerConfig?.id ?? "?"} toolLoopAgent 失败，尝试下一个`);
      }
    }
    throw lastError ?? new Error("All providers failed in toolLoopAgent");
  }

  /** 使用指定 provider 执行工具循环 */
  private async runToolLoopWithProvider(
    provider: Provider,
    request: { prompt: string; systemPrompt?: string; maxSteps?: number }
  ): Promise<LLMResponse> {

    const maxSteps = request.maxSteps ?? 10;
    const toolSet = this.toolManager.getFullToolSet();
    const messages: Message[] = [];

    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }
    messages.push({ role: "user", content: request.prompt });

    for (let step = 0; step < maxSteps; step++) {
      const response: LLMResponse = await provider.textChat({
        contexts: messages,
        funcTool: toolSet.empty() ? undefined : toolSet,
      });

      const toolCallNames = response.toolsCallName;
      const toolCallArgs = response.toolsCallArgs;
      const toolCallIds = response.toolsCallIds;

      if (!toolCallNames || toolCallNames.length === 0) {
        return response;
      }

      const assistantMsg: Message = {
        role: "assistant",
        content: response.completionText ?? "",
        tool_calls: toolCallNames.map((name, i) => ({
          type: "function" as const,
          id: toolCallIds?.[i] ?? `call_${i}`,
          function: {
            name,
            arguments: typeof toolCallArgs?.[i] === "string"
              ? (toolCallArgs[i] as string)
              : JSON.stringify(toolCallArgs?.[i] ?? {}),
          },
        })),
      };
      messages.push(assistantMsg);

      for (let i = 0; i < toolCallNames.length; i++) {
        const toolName = toolCallNames[i];
        const toolArgs = toolCallArgs?.[i] ?? {};
        const toolCallId = toolCallIds?.[i] ?? `call_${i}`;

        let toolResult: string;
        try {
          const tool = toolSet.getTool(toolName);
          if (tool && tool.call) {
            const parsedArgs = typeof toolArgs === "string" ? this.safeParseJson(toolArgs) : toolArgs;
            const ctx = createContextWrapper(null);
            const result = await tool.call(ctx, parsedArgs);
            toolResult = typeof result === "string" ? result : JSON.stringify(result);
          } else {
            toolResult = JSON.stringify({ error: `Tool '${toolName}' not found` });
          }
        } catch (err: any) {
          toolResult = JSON.stringify({ error: err?.message ?? String(err) });
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: toolResult,
        });
      }
    }

    return provider.textChat({ contexts: messages });
  }

  private safeParseJson(str: string): unknown {
    try {
      return JSON.parse(str);
    } catch {
      return str;
    }
  }

  getSttProvider(): STTProvider | null {
    return this.providerManager.getUsingSttProvider();
  }

  getTtsProvider(): TTSProvider | null {
    return this.providerManager.getUsingTtsProvider();
  }

  getEmbeddingProvider(): EmbeddingProvider | null {
    return this.providerManager.getUsingEmbeddingProvider();
  }

  getConfig(): Record<string, unknown> {
    if (!this.configManager) return {};
    const confInfo = this.configManager.getConfInfo("");
    return { ...confInfo.config } as unknown as Record<string, unknown>;
  }

  getAgentConfig(): AgentConfig | null {
    if (!this.configManager) return null;
    const confInfo = this.configManager.getConfInfo("");
    return confInfo.config;
  }
}
