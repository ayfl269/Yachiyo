import type { LLMResponse } from "@yachiyo/common/llm-types.js";
import { parseSSEStream } from "./sse-parser.js";

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ToolCallAccum {
  id: string;
  name: string;
  arguments: string;
}

export async function* parseAnthropicStream(
  response: Response,
  abortSignal?: AbortSignal,
): AsyncGenerator<LLMResponse, void, unknown> {
  // Anthropic may stream multiple `tool_use` blocks concurrently within a
  // single message (parallel function calling). Each block carries an
  // `index` identifying which slot it belongs to. Previously we kept a single
  // `currentToolCall` variable, which meant that when a new
  // `content_block_start` arrived before the previous block's
  // `content_block_stop`, the previous tool call's accumulated arguments were
  // silently overwritten. We now key accumulators by block index so that
  // concurrent tool_use blocks can be tracked independently.
  const toolCallAccumByIndex = new Map<number, ToolCallAccum>();
  let activeToolIndex: number | null = null;

  // `message_start` reports the prompt (input) token count; `message_delta`
  // reports the completion (output) token count. Previously `message_delta`
  // overwrote the entire usage object with promptTokens: 0, discarding the
  // real prompt token count. We now cache the promptTokens from
  // `message_start` and re-emit it alongside the completion tokens in
  // `message_delta`, so downstream token accounting stays correct.
  let cachedPromptTokens = 0;
  let cachedCacheCreationInputTokens: number | undefined;
  let cachedCacheReadInputTokens: number | undefined;

  for await (const event of parseSSEStream(response, abortSignal)) {
    const eventType = event.event;
    if (!eventType) continue;

    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      continue;
    }

    const result: LLMResponse = { role: "assistant", isChunk: true };

    switch (eventType) {
      case "message_start": {
        const d = data as { message?: { usage?: AnthropicUsage } };
        if (d.message?.usage) {
          cachedPromptTokens = d.message.usage.input_tokens ?? 0;
          cachedCacheCreationInputTokens = d.message.usage.cache_creation_input_tokens;
          cachedCacheReadInputTokens = d.message.usage.cache_read_input_tokens;
          result.usage = {
            promptTokens: cachedPromptTokens,
            completionTokens: 0,
            total: cachedPromptTokens,
            cacheCreationInputTokens: cachedCacheCreationInputTokens,
            cacheReadInputTokens: cachedCacheReadInputTokens,
          };
        }
        break;
      }

      case "content_block_start": {
        const d = data as {
          index?: number;
          content_block?: {
            type?: string;
            id?: string;
            name?: string;
            text?: string;
          };
        };
        const blockIdx = d.index ?? 0;
        if (d.content_block?.type === "tool_use" && d.content_block.id) {
          const accum: ToolCallAccum = {
            id: d.content_block.id,
            name: d.content_block.name ?? "",
            arguments: "",
          };
          toolCallAccumByIndex.set(blockIdx, accum);
          activeToolIndex = blockIdx;
        }
        if (d.content_block?.type === "text" && d.content_block.text) {
          result.completionText = d.content_block.text;
        }
        break;
      }

      case "content_block_delta": {
        const d = data as {
          index?: number;
          delta?: {
            type?: string;
            text?: string;
            thinking?: string;
            partial_json?: string;
          };
        };
        if (d.delta?.type === "text_delta" && d.delta.text) {
          result.completionText = d.delta.text;
        }
        if (d.delta?.type === "thinking_delta" && d.delta.thinking) {
          result.reasoningContent = d.delta.thinking;
        }
        if (d.delta?.type === "input_json_delta" && d.delta.partial_json) {
          // Deltas carry their own `index` so we can route the partial JSON
          // to the correct accumulator even when multiple tool_use blocks
          // are interleaved on the wire.
          const idx: number = d.index ?? activeToolIndex ?? 0;
          const accum = toolCallAccumByIndex.get(idx);
          if (accum) {
            accum.arguments += d.delta.partial_json;
          }
        }
        break;
      }

      case "content_block_stop": {
        const d = data as { index?: number };
        const blockIdx: number = d.index ?? activeToolIndex ?? 0;
        const accum = toolCallAccumByIndex.get(blockIdx);
        if (accum) {
          result.toolsCallIds = [accum.id];
          result.toolsCallName = [accum.name];
          try {
            result.toolsCallArgs = [JSON.parse(accum.arguments)];
          } catch {
            result.toolsCallArgs = [{ raw: accum.arguments }];
          }
          toolCallAccumByIndex.delete(blockIdx);
          if (activeToolIndex === blockIdx) {
            activeToolIndex = null;
          }
        }
        break;
      }

      case "message_delta": {
        const d = data as { usage?: { output_tokens?: number } };
        if (d.usage) {
          const completionTokens = d.usage.output_tokens ?? 0;
          // Preserve the promptTokens from `message_start` instead of
          // overwriting with 0. `total` is the sum of the two so that
          // downstream consumers tracking cumulative token usage see the
          // correct totals.
          result.usage = {
            promptTokens: cachedPromptTokens,
            completionTokens,
            total: cachedPromptTokens + completionTokens,
            cacheCreationInputTokens: cachedCacheCreationInputTokens,
            cacheReadInputTokens: cachedCacheReadInputTokens,
          };
        }
        break;
      }

      case "message_stop": {
        break;
      }
    }

    const hasContent =
      result.completionText !== undefined ||
      result.reasoningContent !== undefined ||
      result.toolsCallName !== undefined ||
      result.usage !== undefined;

    if (hasContent) {
      yield result;
    }
  }
}
