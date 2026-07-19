import type { Provider, ProviderChatParams } from "../provider.js";
import type { LLMResponse, ProviderConfig, TokenUsage } from "@yachiyo/common/llm-types.js";
import type { Message } from "@yachiyo/common/llm-message.js";
import { messageToOpenAI } from "../converters/openai-converter.js";
import { parseOpenAIStream } from "../parsers/openai-stream-parser.js";
import { sanitizeContextsByModalities } from "../modalities.js";
import { withRetry } from "../retry.js";
import { ProviderAPIError, RateLimitError, safeParseJsonResponse } from "../errors.js";
import { EstimateTokenCounter } from "@yachiyo/common/token-counter.js";

export interface OpenAIProviderConfig extends ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  organization?: string;
}

export class OpenAIProvider implements Provider {
  providerConfig: ProviderConfig;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private organization?: string;

  constructor(config: OpenAIProviderConfig) {
    this.providerConfig = config;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    this.model = config.model;
    this.organization = config.organization;
  }

  async textChat(params: ProviderChatParams): Promise<LLMResponse> {
    const { contexts, funcTool, model, abortSignal } = params;
    const useModel = model ?? this.model;

    const [sanitized] = sanitizeContextsByModalities(
      contexts,
      this.providerConfig.modalities,
    );
    const messages = messageToOpenAI(sanitized as unknown as Message[]);

    const body: Record<string, unknown> = {
      model: useModel,
      messages,
      stream: false,
    };

    if (params.temperature !== undefined) {
      body.temperature = params.temperature;
    } else if (this.providerConfig.temperature !== undefined) {
      body.temperature = Number(this.providerConfig.temperature);
    }

    if (funcTool && !funcTool.empty()) {
      body.tools = funcTool.openaiSchema(true);
    }

    const url = `${this.baseUrl}/chat/completions`;
    const headers = this.buildHeaders();

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

    const data = await safeParseJsonResponse(response, "openai");
    return this.parseChatResponse(data, sanitized as unknown as Message[]);
  }

  async *textChatStream(
    params: ProviderChatParams,
  ): AsyncGenerator<LLMResponse, void, unknown> {
    const { contexts, funcTool, model, abortSignal } = params;
    const useModel = model ?? this.model;

    const [sanitized] = sanitizeContextsByModalities(
      contexts,
      this.providerConfig.modalities,
    );
    const messages = messageToOpenAI(sanitized as unknown as Message[]);

    const body: Record<string, unknown> = {
      model: useModel,
      messages,
      stream: true,
    };

    if (params.temperature !== undefined) {
      body.temperature = params.temperature;
    } else if (this.providerConfig.temperature !== undefined) {
      body.temperature = Number(this.providerConfig.temperature);
    }

    if (funcTool && !funcTool.empty()) {
      body.tools = funcTool.openaiSchema(true);
    }

    const url = `${this.baseUrl}/chat/completions`;
    const headers = this.buildHeaders();

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

    yield* parseOpenAIStream(response, abortSignal);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.organization) {
      headers["OpenAI-Organization"] = this.organization;
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
      throw new RateLimitError("openai", retryAfter ?? undefined);
    }

    throw new ProviderAPIError("openai", statusCode, undefined, errorMessage);
  }

  private parseChatResponse(data: Record<string, unknown>, inputMessages?: Message[]): LLMResponse {
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const message = choice?.message as Record<string, unknown> | undefined;

    const result: LLMResponse = { role: "assistant", isChunk: false };

    if (message) {
      // Handle content: may be string, null, or array of content parts (e.g. [{type:"text", text:"..."}])
      const rawContent = message.content;
      if (rawContent === undefined || rawContent === null || (typeof rawContent === "string" && !rawContent.trim()) || (Array.isArray(rawContent) && rawContent.length === 0)) {
        console.warn(
          `[OpenAIProvider] Empty/missing content detected. ` +
          `rawContent type=${rawContent == null ? "null" : typeof rawContent}, ` +
          `value=${JSON.stringify(rawContent)}, ` +
          `finish_reason=${choice?.finish_reason ?? "none"}, ` +
          `has_tool_calls=${Array.isArray(message.tool_calls) && message.tool_calls.length > 0}`
        );
      }
      if (rawContent != null) {
        if (typeof rawContent === "string") {
          result.completionText = rawContent;
        } else if (Array.isArray(rawContent)) {
          // Extract text from array-format content parts
          const textParts = rawContent
            .filter((p: { type?: string; text?: string }) => p?.type === "text" && p?.text)
            .map((p: { type?: string; text?: string }) => p.text as string);
          result.completionText = textParts.length > 0 ? textParts.join("") : undefined;
        } else {
          result.completionText = String(rawContent);
        }
      }
      if (message.reasoning_content) {
        result.reasoningContent = message.reasoning_content as string;
      }
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        result.toolsCallIds = (message.tool_calls as Array<Record<string, unknown>>).map(
          (tc) => tc.id as string,
        );
        result.toolsCallName = (message.tool_calls as Array<Record<string, unknown>>).map(
          (tc) => ((tc.function as Record<string, unknown>)?.name ?? "") as string,
        );
        result.toolsCallArgs = (message.tool_calls as Array<Record<string, unknown>>).map(
          (tc) => {
            const args = ((tc.function as Record<string, unknown>)?.arguments ?? "{}") as string;
            try {
              return JSON.parse(args);
            } catch {
              return { raw: args };
            }
          },
        );
      }
    } else {
      // No message in response — log for debugging
      console.warn(
        `[OpenAIProvider] Empty response: choices=${JSON.stringify(choices?.length ?? 0)}, ` +
        `finish_reason=${choice?.finish_reason ?? "none"}, ` +
        `data keys=${Object.keys(data).join(",")}`
      );
    }

    if (data.usage) {
      const u = data.usage as Record<string, number>;
      const promptTokens = u.prompt_tokens ?? u.input_tokens ?? 0;
      const completionTokens = u.completion_tokens ?? u.output_tokens ?? 0;
      const total = u.total_tokens ?? (promptTokens + completionTokens);

      // If API returns all zeros (e.g. some proxies don't calculate usage),
      // fall back to local token estimation
      if (total === 0 && inputMessages) {
        const estimated = this.estimateUsage(inputMessages, result.completionText ?? "");
        result.usage = estimated;
      } else {
        const promptTokensDetails = u.prompt_tokens_details as { cached_tokens?: number } | undefined;
        const cacheReadInputTokens = promptTokensDetails?.cached_tokens ?? 0;
        result.usage = {
          promptTokens,
          completionTokens,
          total,
          cacheReadInputTokens,
        } as TokenUsage;
      }
    } else if (inputMessages) {
      // No usage at all from API, estimate locally
      const estimated = this.estimateUsage(inputMessages, result.completionText ?? "");
      result.usage = estimated;
    }

    return result;
  }

  private estimateUsage(inputMessages: Message[], outputText: string): TokenUsage {
    const counter = new EstimateTokenCounter();
    const promptTokens = counter.countTokens(inputMessages);
    const completionTokens = counter.countTokens([{ role: "assistant", content: outputText } as Message]);
    const total = promptTokens + completionTokens;
    return { promptTokens, completionTokens, total };
  }
}
