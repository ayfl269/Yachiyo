import type { LLMResponse } from "@yachiyo/common/llm-types.js";
import { parseSSEStream } from "./sse-parser.js";

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
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
          };
        };
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
          const promptTokensDetails = u.prompt_tokens_details as { cached_tokens?: number } | undefined;
          const cacheReadInputTokens = promptTokensDetails?.cached_tokens ?? 0;
          result.usage = {
            promptTokens: u.input_tokens ?? 0,
            completionTokens: u.output_tokens ?? 0,
            total: u.total_tokens ?? 0,
            cacheReadInputTokens,
          };
        }
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
