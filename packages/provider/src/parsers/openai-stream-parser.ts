import type { LLMResponse, TokenUsage } from "@yachiyo/common/llm-types.js";
import { parseSSEStream } from "./sse-parser.js";

interface OpenAIDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

interface OpenAIChunk {
  choices?: Array<{
    index: number;
    delta?: OpenAIDelta;
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface ToolCallAccum {
  id: string;
  name: string;
  arguments: string;
}

export async function* parseOpenAIStream(
  response: Response,
  abortSignal?: AbortSignal,
): AsyncGenerator<LLMResponse, void, unknown> {
  const toolCallsAccum = new Map<number, ToolCallAccum>();
  let chunkIndex = 0;

  for await (const event of parseSSEStream(response, abortSignal)) {
    if (event.data === "[DONE]") {
      console.log(`[OpenAIStreamParser] Received [DONE] event, total chunks processed: ${chunkIndex}`);
      break;
    }

    let chunk: OpenAIChunk;
    try {
      chunk = JSON.parse(event.data);
    } catch (e) {
      // Log the parse failure so malformed upstream responses (HTML error
      // pages, truncated chunks, gateway errors) are visible during debugging
      // instead of being silently dropped. Truncate to avoid flooding logs.
      const preview = event.data.length > 200 ? event.data.slice(0, 200) + "…" : event.data;
      console.warn(`[OpenAIStreamParser] Failed to parse SSE data as JSON: ${e instanceof Error ? e.message : e}; data preview: ${preview}`);
      continue;
    }

    chunkIndex++;
    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta;
    const result: LLMResponse = { role: "assistant", isChunk: true };

    if (delta?.content != null) {
      result.completionText = delta.content;
    }

    if (delta?.reasoning_content) {
      result.reasoningContent = delta.reasoning_content;
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        let accum = toolCallsAccum.get(idx);
        if (!accum) {
          accum = { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" };
          toolCallsAccum.set(idx, accum);
        }
        if (tc.id) accum.id = tc.id;
        if (tc.function?.name) accum.name = tc.function.name;
        if (tc.function?.arguments) accum.arguments += tc.function.arguments;
      }
    }

    if (choice.finish_reason === "tool_calls" && toolCallsAccum.size > 0) {
      const sorted = [...toolCallsAccum.entries()].sort(([a], [b]) => a - b);
      result.toolsCallIds = sorted.map(([, v]) => v.id);
      result.toolsCallName = sorted.map(([, v]) => v.name);
      result.toolsCallArgs = sorted.map(([, v]) => {
        try {
          return JSON.parse(v.arguments);
        } catch {
          return { raw: v.arguments };
        }
      });
      toolCallsAccum.clear();
    }

    if (chunk.usage) {
      const promptTokens = chunk.usage.prompt_tokens ?? chunk.usage.input_tokens ?? 0;
      const completionTokens = chunk.usage.completion_tokens ?? chunk.usage.output_tokens ?? 0;
      const total = chunk.usage.total_tokens ?? (promptTokens + completionTokens);
      const promptTokensDetails = (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details;
      const cacheReadInputTokens = promptTokensDetails?.cached_tokens ?? 0;
      const usage: TokenUsage = {
        promptTokens,
        completionTokens,
        total,
        cacheReadInputTokens,
      };
      result.usage = usage;
    }

    const hasContent =
      result.completionText !== undefined ||
      result.reasoningContent !== undefined ||
      result.toolsCallName !== undefined ||
      result.usage !== undefined;

    // OpenAI finish_reason values: "stop", "length", "tool_calls",
    // "content_filter", "function_call" (legacy). `end_turn` is Anthropic's
    // finish reason and must NOT be treated as an OpenAI final-chunk marker —
    // doing so could cause the parser to yield a spurious empty non-chunk
    // when an OpenAI-compatible proxy leaks Anthropic-style values.
    // `length` (max tokens reached) and `content_filter` (safety filter
    // triggered) are both terminal states that must be emitted as final
    // chunks so downstream consumers know generation stopped.
    const isFinalChunk =
      choice.finish_reason === "stop" ||
      choice.finish_reason === "length" ||
      choice.finish_reason === "content_filter" ||
      choice.finish_reason === "function_call";

    if (hasContent) {
      yield result;
    } else if (isFinalChunk) {
      yield { ...result, isChunk: false };
    }
  }
}
