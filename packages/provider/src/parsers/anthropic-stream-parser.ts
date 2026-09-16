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
  // reports the completion (output) token count. We cache the message_start
  // values and emit ONE usage object from `message_delta` carrying the
  // cumulative totals.
  //
  // Downstream semantics (verified): the agent runner ACCUMULATES usage
  // across chunks (`stats.tokenUsage.promptTokens += ...`) and also treats
  // any chunk carrying `usage` as the final response, breaking the stream
  // loop. Emitting usage on message_start therefore both double-counted the
  // prompt tokens (message_start P + message_delta P) and truncated the
  // stream right after message_start. `message_start` no longer yields a
  // usage chunk; the final cumulative usage comes with `message_delta`.
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
        // Cache the prompt-side usage only. Do NOT attach `result.usage`
        // here: downstream accumulates usage per chunk and treats any
        // usage-bearing chunk as the final response, so a message_start
        // usage chunk would double-count prompt tokens and cut the stream
        // short. The cumulative usage is emitted once from message_delta.
        if (d.message?.usage) {
          cachedPromptTokens = d.message.usage.input_tokens ?? 0;
          cachedCacheCreationInputTokens = d.message.usage.cache_creation_input_tokens;
          cachedCacheReadInputTokens = d.message.usage.cache_read_input_tokens;
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
            data?: string;
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
        // `redacted_thinking` has no readable text — only an opaque `data`
        // blob that must be replayed verbatim. Surface it as the reasoning
        // signature with the redacted flag so downstream persists it.
        if (d.content_block?.type === "redacted_thinking" && typeof d.content_block.data === "string") {
          result.reasoningSignature = d.content_block.data;
          result.reasoningRedacted = true;
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
            signature?: string;
            partial_json?: string;
          };
        };
        if (d.delta?.type === "text_delta" && d.delta.text) {
          result.completionText = d.delta.text;
        }
        if (d.delta?.type === "thinking_delta" && d.delta.thinking) {
          result.reasoningContent = d.delta.thinking;
        }
        // The thinking signature arrives in its own `signature_delta` event,
        // separate from the `thinking_delta` text. It is required to replay
        // the thinking block on the next tool-use turn.
        if (d.delta?.type === "signature_delta" && d.delta.signature) {
          result.reasoningSignature = d.delta.signature;
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
      result.reasoningSignature !== undefined ||
      result.toolsCallName !== undefined ||
      result.usage !== undefined;

    if (hasContent) {
      yield result;
    }
  }
}
