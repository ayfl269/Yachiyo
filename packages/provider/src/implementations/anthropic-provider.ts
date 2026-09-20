import type { Provider, ProviderChatParams } from "../provider.js";
import type { LLMResponse, ProviderConfig, TokenUsage } from "@yachiyo/common/llm-types.js";
import type { Message } from "@yachiyo/common/llm-message.js";
import { messageToAnthropic } from "../converters/anthropic-converter.js";
import { parseAnthropicStream } from "../parsers/anthropic-stream-parser.js";
import { sanitizeContextsByModalities } from "../modalities.js";
import { withRetry } from "../retry.js";
import { ProviderAPIError, RateLimitError, safeParseJsonResponse } from "../errors.js";
import { EstimateTokenCounter } from "@yachiyo/common/token-counter.js";
import { getProxyAgent } from "@yachiyo/common";
import { applyCustomExtraBody } from "../extra-body.js";

export interface AnthropicProviderConfig extends ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  anthropicVersion?: string;
  maxTokens?: number;
  proxy?: string;
}

export class AnthropicProvider implements Provider {
  readonly type = "anthropic";
  providerConfig: ProviderConfig;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private anthropicVersion: string;
  private maxTokens: number;
  private proxy?: string;

  constructor(config: AnthropicProviderConfig) {
    this.providerConfig = config;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.anthropic.com";
    this.model = config.model;
    this.anthropicVersion = config.anthropicVersion ?? "2023-06-01";
    this.maxTokens = config.maxTokens ?? 4096;
    this.proxy = config.proxy;
  }

  async textChat(params: ProviderChatParams): Promise<LLMResponse> {
    const { abortSignal } = params;
    const { body, headers, sanitized } = this.prepareRequest(params, false);

    const url = `${this.baseUrl}/v1/messages`;
    const dispatcher = await getProxyAgent(this.proxy);

    const response = await withRetry(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: abortSignal,
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit);
        await this.checkResponse(res);
        return res;
      },
      undefined,
      abortSignal,
    );

    const data = await safeParseJsonResponse(response, "anthropic");
    return this.parseResponse(data, sanitized as unknown as Message[]);
  }

  async *textChatStream(
    params: ProviderChatParams,
  ): AsyncGenerator<LLMResponse, void, unknown> {
    const { abortSignal } = params;
    const { body, headers } = this.prepareRequest(params, true);

    const url = `${this.baseUrl}/v1/messages`;
    const dispatcher = await getProxyAgent(this.proxy);

    const response = await withRetry(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: abortSignal,
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit);
        await this.checkResponse(res);
        return res;
      },
      undefined,
      abortSignal,
    );

    yield* parseAnthropicStream(response, abortSignal);
  }

  private prepareRequest(params: ProviderChatParams, stream: boolean) {
    const { contexts, funcTool, model } = params;
    const useModel = model ?? this.model;

    const [sanitized] = sanitizeContextsByModalities(
      contexts,
      this.providerConfig.modalities,
    );
    const { system, messages } = messageToAnthropic(sanitized as unknown as Message[]);

    const enableCaching = params.enableCaching ?? (this.providerConfig.enableCaching as boolean | undefined) ?? false;

    const body: Record<string, unknown> = {
      model: useModel,
      messages,
      max_tokens: this.maxTokens,
    };
    if (params.temperature !== undefined) {
      body.temperature = params.temperature;
    } else if (this.providerConfig.temperature !== undefined) {
      body.temperature = Number(this.providerConfig.temperature);
    }
    if (stream) {
      body.stream = true;
    }

    if (system) {
      if (enableCaching) {
        body.system = [
          {
            type: "text",
            text: system,
            cache_control: { type: "ephemeral" },
          },
        ];
      } else {
        body.system = system;
      }
    }

    if (funcTool && !funcTool.empty()) {
      const tools = funcTool.anthropicSchema();
      if (enableCaching && tools.length > 0) {
        const lastTool = tools[tools.length - 1] as Record<string, unknown>;
        lastTool.cache_control = { type: "ephemeral" };
      }
      body.tools = tools;
    }

    if (enableCaching && messages.length > 0) {
      const setCacheControlOnMessage = (msg: { content: unknown }) => {
        if (typeof msg.content === "string") {
          msg.content = [
            {
              type: "text",
              text: msg.content,
              cache_control: { type: "ephemeral" },
            },
          ];
        } else if (Array.isArray(msg.content) && msg.content.length > 0) {
          const lastBlock = msg.content[msg.content.length - 1] as Record<string, unknown>;
          lastBlock.cache_control = { type: "ephemeral" };
        }
      };
      // Set cache control on the last message — inside a tool loop each
      // iteration extends the previous request, so this checkpoint is what
      // makes consecutive iterations hit.
      setCacheControlOnMessage(messages[messages.length - 1]);
      // Anchor a second checkpoint on the last message before the volatile
      // per-request tail (dynamic context is merged into the final user
      // message by the converter, so this is the newest byte-stable history
      // boundary). The last-message checkpoint can never match on the next
      // user turn — its content changed — but this one replays verbatim.
      if (messages.length >= 2) {
        setCacheControlOnMessage(messages[messages.length - 2]);
      }
    }

    const headers = this.buildHeaders(enableCaching);

    return { body: applyCustomExtraBody(body, this.providerConfig.custom_extra_body), headers, sanitized };
  }

  private buildHeaders(enableCaching = false): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": this.anthropicVersion,
    };
    if (enableCaching) {
      headers["anthropic-beta"] = "prompt-caching-2024-07-31";
    }
    return headers;
  }

  private async checkResponse(res: Response): Promise<void> {
    if (res.ok) return;

    const statusCode = res.status;
    let errorMessage: string;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      const error = body?.error as Record<string, unknown> | undefined;
      errorMessage =
        (error?.message as string) ?? (body?.message as string) ?? res.statusText;
    } catch {
      errorMessage = res.statusText;
    }

    if (statusCode === 429) {
      const retryAfter = res.headers.get("retry-after");
      throw new RateLimitError("anthropic", retryAfter ?? undefined);
    }

    throw new ProviderAPIError("anthropic", statusCode, undefined, errorMessage);
  }

  private parseResponse(data: Record<string, unknown>, inputMessages?: Message[]): LLMResponse {
    const result: LLMResponse = { role: "assistant", isChunk: false };

    const content = data.content as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      const toolCallIds: string[] = [];
      const toolCallNames: string[] = [];
      const toolCallArgs: Record<string, unknown>[] = [];

      for (const block of content) {
        const type = block.type as string;

        if (type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        }

        if (type === "thinking" && typeof block.thinking === "string") {
          result.reasoningContent = block.thinking;
          // The signature is required to replay this thinking block on the
          // next turn of a tool-use loop; dropping it makes Anthropic reject
          // the follow-up request with a 400.
          if (typeof block.signature === "string") {
            result.reasoningSignature = block.signature;
          }
        }

        // `redacted_thinking` carries no readable text — only an opaque
        // `data` blob that must be echoed back verbatim with its `type`.
        if (type === "redacted_thinking" && typeof block.data === "string") {
          result.reasoningSignature = block.data;
          result.reasoningRedacted = true;
        }

        if (type === "tool_use") {
          toolCallIds.push(block.id as string);
          toolCallNames.push(block.name as string);
          toolCallArgs.push((block.input as Record<string, unknown>) ?? {});
        }
      }

      if (textParts.length > 0) {
        result.completionText = textParts.join("");
      }
      if (toolCallIds.length > 0) {
        result.toolsCallIds = toolCallIds;
        result.toolsCallName = toolCallNames;
        result.toolsCallArgs = toolCallArgs;
      }
    }

    if (data.usage) {
      const u = data.usage as Record<string, number>;
      const cacheCreationInputTokens = u.cache_creation_input_tokens ?? 0;
      const cacheReadInputTokens = u.cache_read_input_tokens ?? 0;
      // Anthropic's `input_tokens` EXCLUDES the cache-read/cache-write tokens;
      // the true billed input is the sum of all three. Normalise `promptTokens`
      // to that inclusive total so it matches OpenAI/Gemini semantics (where the
      // prompt count already contains the cached portion) and so `total` — used
      // for context-window tracking — is not understated on cached turns.
      const promptTokens = (u.input_tokens ?? 0) + cacheReadInputTokens + cacheCreationInputTokens;
      const completionTokens = u.output_tokens ?? 0;
      const total = promptTokens + completionTokens;

      if (total === 0 && inputMessages) {
        result.usage = this.estimateUsage(inputMessages, result.completionText ?? "");
      } else {
        result.usage = {
          promptTokens,
          completionTokens,
          total,
          cacheCreationInputTokens,
          cacheReadInputTokens,
        } as TokenUsage;
      }
    } else if (inputMessages) {
      result.usage = this.estimateUsage(inputMessages, result.completionText ?? "");
    }

    return result;
  }

  private estimateUsage(inputMessages: Message[], outputText: string): TokenUsage {
    const counter = new EstimateTokenCounter();
    const promptTokens = counter.countTokens(inputMessages);
    const completionTokens = counter.countTokens([{ role: "assistant", content: outputText } as Message]);
    return { promptTokens, completionTokens, total: promptTokens + completionTokens };
  }
}
