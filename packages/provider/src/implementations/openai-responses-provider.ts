import type { Provider, ProviderChatParams } from "../provider.js";
import type { LLMResponse, ProviderConfig, TokenUsage } from "@yachiyo/common/llm-types.js";
import type { Message } from "@yachiyo/common/llm-message.js";
import { messageToResponsesInput, extractFunctionCalls } from "../converters/openai-responses-converter.js";
import { parseResponsesStream } from "../parsers/openai-responses-stream-parser.js";
import { sanitizeContextsByModalities } from "../modalities.js";
import { withRetry } from "../retry.js";
import { ProviderAPIError, RateLimitError, safeParseJsonResponse } from "../errors.js";
import { EstimateTokenCounter } from "@yachiyo/common/token-counter.js";

export interface OpenAIResponsesProviderConfig extends ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  organization?: string;
}

export class OpenAIResponsesProvider implements Provider {
  providerConfig: ProviderConfig;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private organization?: string;

  constructor(config: OpenAIResponsesProviderConfig) {
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
    const { instructions, input } = messageToResponsesInput(sanitized as unknown as Message[]);

    const body: Record<string, unknown> = {
      model: useModel,
      input,
      stream: false,
    };

    if (params.temperature !== undefined) {
      body.temperature = params.temperature;
    } else if (this.providerConfig.temperature !== undefined) {
      body.temperature = Number(this.providerConfig.temperature);
    }

    if (instructions) {
      body.instructions = instructions;
    }

    if (funcTool && !funcTool.empty()) {
      body.tools = funcTool.openaiSchema(true).map((t) => ({
        type: "function",
        ...t,
      }));
    }

    const url = `${this.baseUrl}/responses`;
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

    const data = await safeParseJsonResponse(response, "openai_responses");
    return this.parseResponse(data, sanitized as unknown as Message[]);
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
    const { instructions, input } = messageToResponsesInput(sanitized as unknown as Message[]);

    const body: Record<string, unknown> = {
      model: useModel,
      input,
      stream: true,
    };

    if (params.temperature !== undefined) {
      body.temperature = params.temperature;
    } else if (this.providerConfig.temperature !== undefined) {
      body.temperature = Number(this.providerConfig.temperature);
    }

    if (instructions) {
      body.instructions = instructions;
    }

    if (funcTool && !funcTool.empty()) {
      body.tools = funcTool.openaiSchema(true).map((t) => ({
        type: "function",
        ...t,
      }));
    }

    const url = `${this.baseUrl}/responses`;
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

    yield* parseResponsesStream(response, abortSignal);
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
      throw new RateLimitError("openai-responses", retryAfter ?? undefined);
    }

    throw new ProviderAPIError("openai-responses", statusCode, undefined, errorMessage);
  }

  private parseResponse(data: Record<string, unknown>, inputMessages?: Message[]): LLMResponse {
    const result: LLMResponse = { role: "assistant", isChunk: false };

    const output = data.output as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(output)) {
      const textParts: string[] = [];
      const toolCallIds: string[] = [];
      const toolCallNames: string[] = [];
      const toolCallArgs: Record<string, unknown>[] = [];

      for (const item of output) {
        const type = item.type as string;

        if (type === "message") {
          const content = item.content as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part.type === "output_text" && typeof part.text === "string") {
                textParts.push(part.text);
              }
            }
          }
        }

        if (type === "function_call") {
          toolCallIds.push((item.call_id as string) ?? (item.id as string) ?? "");
          toolCallNames.push((item.name as string) ?? "");
          const argsStr = (item.arguments as string) ?? "{}";
          try {
            toolCallArgs.push(JSON.parse(argsStr));
          } catch {
            toolCallArgs.push({ raw: argsStr });
          }
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
      const promptTokens = u.input_tokens ?? u.prompt_tokens ?? 0;
      const completionTokens = u.output_tokens ?? u.completion_tokens ?? 0;
      const total = u.total_tokens ?? (promptTokens + completionTokens);

      if (total === 0 && inputMessages) {
        result.usage = this.estimateUsage(inputMessages, result.completionText ?? "");
      } else {
        const promptTokensDetails = u.prompt_tokens_details as any;
        const cacheReadInputTokens = promptTokensDetails?.cached_tokens ?? 0;
        result.usage = {
          promptTokens,
          completionTokens,
          total,
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
