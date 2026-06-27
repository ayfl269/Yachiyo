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
  let currentToolCall: ToolCallAccum | null = null;

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
          result.usage = {
            promptTokens: d.message.usage.input_tokens ?? 0,
            completionTokens: 0,
            total: d.message.usage.input_tokens ?? 0,
            cacheCreationInputTokens: d.message.usage.cache_creation_input_tokens,
            cacheReadInputTokens: d.message.usage.cache_read_input_tokens,
          };
        }
        break;
      }

      case "content_block_start": {
        const d = data as {
          content_block?: {
            type?: string;
            id?: string;
            name?: string;
            text?: string;
          };
        };
        if (d.content_block?.type === "tool_use" && d.content_block.id) {
          currentToolCall = {
            id: d.content_block.id,
            name: d.content_block.name ?? "",
            arguments: "",
          };
        }
        if (d.content_block?.type === "text" && d.content_block.text) {
          result.completionText = d.content_block.text;
        }
        break;
      }

      case "content_block_delta": {
        const d = data as {
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
          if (currentToolCall) {
            currentToolCall.arguments += d.delta.partial_json;
          }
        }
        break;
      }

      case "content_block_stop": {
        if (currentToolCall) {
          result.toolsCallIds = [currentToolCall.id];
          result.toolsCallName = [currentToolCall.name];
          try {
            result.toolsCallArgs = [JSON.parse(currentToolCall.arguments)];
          } catch {
            result.toolsCallArgs = [{ raw: currentToolCall.arguments }];
          }
          currentToolCall = null;
        }
        break;
      }

      case "message_delta": {
        const d = data as { usage?: { output_tokens?: number } };
        if (d.usage) {
          result.usage = {
            promptTokens: 0,
            completionTokens: d.usage.output_tokens ?? 0,
            total: d.usage.output_tokens ?? 0,
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
