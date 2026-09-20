import type { LLMResponse } from "@yachiyo/common/llm-types.js";
import { parseSSEStream } from "./sse-parser.js";

interface ResponsesUsageDetails {
  cached_tokens?: number;
  cache_write_tokens?: number;
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  /**
   * The Responses API reports cache usage under `input_tokens_details`
   * (`cached_tokens` = cache read, `cache_write_tokens` = cache write). Some
   * OpenAI-compatible gateways mirror the Chat Completions shape instead, so
   * `prompt_tokens_details` is accepted as a fallback.
   */
  input_tokens_details?: ResponsesUsageDetails;
  prompt_tokens_details?: ResponsesUsageDetails;
}

/**
 * Extract cache-read / cache-write tokens from a Responses API `usage` object.
 * `input_tokens_details` is authoritative; `prompt_tokens_details` only covers
 * gateways that proxy the Chat Completions field naming.
 */
export function extractResponsesCacheTokens(usage: {
  input_tokens_details?: ResponsesUsageDetails;
  prompt_tokens_details?: ResponsesUsageDetails;
}): { cacheReadInputTokens: number; cacheCreationInputTokens: number } {
  // Merge per field rather than `??` on the whole object: a gateway may emit an
  // empty `input_tokens_details: {}` alongside a populated
  // `prompt_tokens_details`, and object-level `??` would then wrongly stop at
  // the empty authoritative object and drop the fallback values.
  const primary = usage.input_tokens_details;
  const fallback = usage.prompt_tokens_details;
  return {
    cacheReadInputTokens: primary?.cached_tokens ?? fallback?.cached_tokens ?? 0,
    cacheCreationInputTokens:
      primary?.cache_write_tokens ?? fallback?.cache_write_tokens ?? 0,
  };
}

interface FunctionCallAccum {
  id: string;
  name: string;
  arguments: string;
  callId: string;
}

export async function* parseResponsesStream(
  response: Response,
  abortSignal?: AbortSignal,
): AsyncGenerator<LLMResponse, void, unknown> {
  const toolCallAccum = new Map<string, FunctionCallAccum>();

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
      case "response.output_text.delta": {
        const d = data as { delta?: string };
        if (d.delta) {
          result.completionText = d.delta;
        }
        break;
      }

      case "response.reasoning_summary_text.delta": {
        const d = data as { delta?: string };
        if (d.delta) {
          result.reasoningContent = d.delta;
        }
        break;
      }

      // Raw chain-of-thought text (emitted when the request sets
      // `include: ["reasoning.encrypted_content"]` or for models that stream
      // the full reasoning text rather than a summary).
      case "response.reasoning_text.delta": {
        const d = data as { delta?: string };
        if (d.delta) {
          result.reasoningContent = d.delta;
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        const d = data as { item_id?: string; delta?: string };
        if (d.item_id && d.delta) {
          let accum = toolCallAccum.get(d.item_id);
          if (accum) {
            accum.arguments += d.delta;
          }
        }
        break;
      }

      case "response.output_item.added": {
        const d = data as {
          item?: {
            type?: string;
            id?: string;
            call_id?: string;
            name?: string;
          };
        };
        if (d.item?.type === "function_call" && d.item.id) {
          toolCallAccum.set(d.item.id, {
            id: d.item.call_id ?? "",
            name: d.item.name ?? "",
            arguments: "",
            callId: d.item.call_id ?? "",
          });
        }
        break;
      }

      case "response.output_item.done": {
        const d = data as {
          item?: {
            type?: string;
            id?: string;
            call_id?: string;
            name?: string;
            arguments?: string;
            encrypted_content?: string;
          };
        };
        // Reasoning item: capture the encrypted payload (present when the
        // request sets `include: ["reasoning.encrypted_content"]`) so it can be
        // replayed verbatim on the next turn.
        if (d.item?.type === "reasoning" && typeof d.item.encrypted_content === "string") {
          result.reasoningSignature = d.item.encrypted_content;
        }
        if (d.item?.type === "function_call" && d.item?.id) {
          const accum = toolCallAccum.get(d.item.id);
          if (accum) {
            const finalArgs = accum.arguments || d.item.arguments || "";
            result.toolsCallIds = [accum.callId || d.item.call_id || accum.id];
            result.toolsCallName = [accum.name || d.item.name || ""];
            try {
              result.toolsCallArgs = [JSON.parse(finalArgs)];
            } catch {
              result.toolsCallArgs = [{ raw: finalArgs }];
            }
            toolCallAccum.delete(d.item.id);
          }
        }
        break;
      }

      case "response.completed": {
        const d = data as { response?: { usage?: ResponsesUsage } };
        if (d.response?.usage) {
          const u = d.response.usage;
          const { cacheReadInputTokens, cacheCreationInputTokens } =
            extractResponsesCacheTokens(u);
          result.usage = {
            promptTokens: u.input_tokens ?? 0,
            completionTokens: u.output_tokens ?? 0,
            total: u.total_tokens ?? 0,
            cacheReadInputTokens,
            cacheCreationInputTokens,
          };
        }
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
