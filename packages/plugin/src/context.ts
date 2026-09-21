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
import { extractOrderedArgs } from "@yachiyo/agent/tool-executor.js";

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

  getUsingProvider(umo: string): Provider | null {
    // 透传 umo：ProviderManager 目前虽未按 umo 区分选择，但保留该参数是其
    // 声明的契约（未来 per-umo provider 路由）。
    return this.providerManager.getUsingProvider("chat_completion" as ProviderType, umo);
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

  /**
   * #45: 插件主动发消息 API 暂不支持。
   *
   * 旧实现构造的伪 MessageEvent 结构不完整（无组件、send 为 no-op），事件虽
   * 进入 pipeline，但模型响应最终被 send() 静默丢弃——调用"成功"而消息从未
   * 发出。真正实现需要 PluginContext 持有适配器注册表/发送通道（当前构造
   * 依赖中没有），无法可靠落地；按最小改动原则改为抛出明确错误，避免静默
   * 丢弃掩盖问题。
   */
  async sendMessage(_session: MessageSession, _components: MessageComponent[]): Promise<void> {
    throw new Error(
      "PluginContext.sendMessage is not supported yet: the plugin context has no access to a platform send channel. " +
      "Use a pipeline handler (StarHandler) with event.send() to reply to an incoming message instead.",
    );
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
          if (!tool) {
            toolResult = JSON.stringify({ error: `Tool '${toolName}' not found` });
          } else {
            const parsedArgs = typeof toolArgs === "string" ? this.safeParseJson(toolArgs) : toolArgs;
            const argObj = (parsedArgs && typeof parsedArgs === "object")
              ? (parsedArgs as Record<string, unknown>)
              : {};
            const ctx = createContextWrapper(null);
            // Prefer the `handler` (positional dispatch in schema order), the
            // same way FunctionToolExecutor.executeLocal does. `createFunctionTool`
            // always installs a throwing default `call`, so testing `tool.call`
            // alone (as before) made every handler-based tool fail with
            // "FunctionTool.call() must be implemented..." and silently degraded
            // this loop to a no-tool chat.
            let result: unknown;
            if (tool.handler) {
              result = await tool.handler(ctx, ...extractOrderedArgs(tool, argObj));
            } else {
              result = await tool.call(ctx, argObj);
            }
            toolResult = typeof result === "string" ? result : JSON.stringify(result);
          }
        } catch (err: unknown) {
          toolResult = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
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

  /** Secret-looking config keys that must never reach plugin code. */
  private static readonly SECRET_KEY_PATTERN = /(key|secret|token|password|credential)/i;
  private static readonly SECRET_MASK = "********";

  /**
   * #61: 插件可见的配置必须脱敏。当前 AgentConfig 本身不含密钥字段，但配置
   * 结构可能演进（或被未来实现加入 provider 凭据），这里对疑似密钥字段统一
   * 掩码，防止向插件泄露全量配置中的 secret。
   */
  private maskSecretFields(config: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === "string" && value.length > 0 && PluginContext.SECRET_KEY_PATTERN.test(key)) {
        out[key] = PluginContext.SECRET_MASK;
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  getConfig(): Record<string, unknown> {
    if (!this.configManager) return {};
    const confInfo = this.configManager.getConfInfo("");
    return this.maskSecretFields({ ...confInfo.config } as unknown as Record<string, unknown>);
  }

  getAgentConfig(): AgentConfig | null {
    if (!this.configManager) return null;
    const confInfo = this.configManager.getConfInfo("");
    // Return a masked copy, consistent with getConfig(): the raw config may
    // hold secret-looking fields, and handing out the live reference also let
    // callers mutate the ConfigManager's internal state.
    return this.maskSecretFields({ ...confInfo.config } as unknown as Record<string, unknown>) as unknown as AgentConfig;
  }
}
