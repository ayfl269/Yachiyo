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
    } catch {
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
      const promptTokensDetails = (chunk.usage as any).prompt_tokens_details;
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

    const isFinalChunk = choice.finish_reason === "stop" || choice.finish_reason === "end_turn";

    if (hasContent) {
      yield result;
    } else if (isFinalChunk) {
      yield { ...result, isChunk: false };
    }
  }
}
