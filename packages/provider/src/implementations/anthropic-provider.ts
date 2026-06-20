import type { Provider, ProviderChatParams } from "../provider.js";
import type { LLMResponse, ProviderConfig, TokenUsage } from "@yachiyo/common/llm-types.js";
import type { Message } from "@yachiyo/common/llm-message.js";
import { messageToAnthropic } from "../converters/anthropic-converter.js";
import { parseAnthropicStream } from "../parsers/anthropic-stream-parser.js";
import { sanitizeContextsByModalities } from "../modalities.js";
import { withRetry } from "../retry.js";
import { ProviderAPIError, RateLimitError, safeParseJsonResponse } from "../errors.js";
import { EstimateTokenCounter } from "@yachiyo/common/token-counter.js";

export interface AnthropicProviderConfig extends ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  anthropicVersion?: string;
  maxTokens?: number;
}

export class AnthropicProvider implements Provider {
  providerConfig: ProviderConfig;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private anthropicVersion: string;
  private maxTokens: number;

  constructor(config: AnthropicProviderConfig) {
    this.providerConfig = config;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.anthropic.com";
    this.model = config.model;
    this.anthropicVersion = config.anthropicVersion ?? "2023-06-01";
    this.maxTokens = config.maxTokens ?? 4096;
  }

  async textChat(params: ProviderChatParams): Promise<LLMResponse> {
    const { abortSignal } = params;
    const { body, headers, sanitized } = this.prepareRequest(params, false);

    const url = `${this.baseUrl}/v1/messages`;

    const response = await withRetry(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: abortSignal,
        });
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

    const response = await withRetry(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: abortSignal,
        });
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
        const lastTool = tools[tools.length - 1] as any;
        lastTool.cache_control = { type: "ephemeral" };
      }
      body.tools = tools;
    }

    if (enableCaching && messages.length > 0) {
      const setCacheControlOnMessage = (msg: any) => {
        if (typeof msg.content === "string") {
          msg.content = [
            {
              type: "text",
              text: msg.content,
              cache_control: { type: "ephemeral" },
            },
          ];
        } else if (Array.isArray(msg.content) && msg.content.length > 0) {
          const lastBlock = msg.content[msg.content.length - 1];
          (lastBlock as any).cache_control = { type: "ephemeral" };
        }
      };
      // Set cache control on the last message
      setCacheControlOnMessage(messages[messages.length - 1]);
      // If messages length >= 4, also set on the third-to-last message (to cache historical checkpoints)
      if (messages.length >= 4) {
        setCacheControlOnMessage(messages[messages.length - 3]);
      }
    }

    const headers = this.buildHeaders(enableCaching);

    return { body, headers, sanitized };
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
      const promptTokens = u.input_tokens ?? 0;
      const completionTokens = u.output_tokens ?? 0;
      const total = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);

      if (total === 0 && inputMessages) {
        result.usage = this.estimateUsage(inputMessages, result.completionText ?? "");
      } else {
        result.usage = {
          promptTokens,
          completionTokens,
          total,
          cacheCreationInputTokens: u.cache_creation_input_tokens,
          cacheReadInputTokens: u.cache_read_input_tokens,
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
