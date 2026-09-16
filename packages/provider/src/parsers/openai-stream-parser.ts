import type { LLMResponse, TokenUsage } from "@yachiyo/common/llm-types.js";
import type { Message } from "@yachiyo/common/llm-message.js";
import { EstimateTokenCounter } from "@yachiyo/common/token-counter.js";
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
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

interface ToolCallAccum {
  id: string;
  name: string;
  arguments: string;
}

interface FinalToolCalls {
  ids: string[];
  names: string[];
  args: Record<string, unknown>[];
}

function finalizeToolCalls(accum: Map<number, ToolCallAccum>): FinalToolCalls {
  const sorted = [...accum.entries()].sort(([a], [b]) => a - b);
  return {
    ids: sorted.map(([, v]) => v.id),
    names: sorted.map(([, v]) => v.name),
    args: sorted.map(([, v]) => {
      try {
        return JSON.parse(v.arguments);
      } catch {
        return { raw: v.arguments };
      }
    }),
  };
}

function parseUsage(raw: NonNullable<OpenAIChunk["usage"]>): TokenUsage {
  const promptTokens = raw.prompt_tokens ?? raw.input_tokens ?? 0;
  const completionTokens = raw.completion_tokens ?? raw.output_tokens ?? 0;
  const total = raw.total_tokens ?? promptTokens + completionTokens;
  const cacheReadInputTokens = raw.prompt_tokens_details?.cached_tokens ?? 0;
  return { promptTokens, completionTokens, total, cacheReadInputTokens };
}

/**
 * Local token estimate used when the upstream never reports usage (gateways
 * that ignore `stream_options.include_usage`, or plain HTTP proxies). Mirrors
 * the non-streaming paths in the provider implementations so streaming and
 * non-streaming token accounting stay consistent.
 */
function estimateUsage(inputMessages: Message[], outputText: string): TokenUsage {
  const counter = new EstimateTokenCounter();
  const promptTokens = counter.countTokens(inputMessages);
  const completionTokens = outputText
    ? counter.countTokens([{ role: "assistant", content: outputText } as Message])
    : 0;
  return { promptTokens, completionTokens, total: promptTokens + completionTokens };
}

export async function* parseOpenAIStream(
  response: Response,
  abortSignal?: AbortSignal,
  inputMessages?: Message[],
): AsyncGenerator<LLMResponse, void, unknown> {
  const toolCallsAccum = new Map<number, ToolCallAccum>();
  // Finalized tool calls, attached to the first chunk emitted after they are
  // known complete (the usage chunk, when `include_usage` is on, or the
  // terminal below otherwise). The agent runner treats a chunk carrying usage
  // OR tool calls as terminal, so bundling them together ensures neither is
  // dropped when it stops early.
  let finalToolCalls: FinalToolCalls | undefined;
  let finalToolCallsAttached = false;
  // Accumulated user-visible text, used only for the local usage estimate when
  // the upstream omits usage.
  let accumulatedText = "";
  let sawUsage = false;

  for await (const event of parseSSEStream(response, abortSignal)) {
    if (event.data === "[DONE]") {
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

    // `choices` is EMPTY on the trailing usage-only chunk that OpenAI (and
    // compatible gateways) emit when `stream_options.include_usage` is set.
    // Usage must therefore be handled BEFORE any per-choice logic, otherwise
    // the usage-only chunk is dropped and token accounting is lost.
    const choice = chunk.choices?.[0];
    const result: LLMResponse = { role: "assistant", isChunk: true };

    if (choice) {
      const delta = choice.delta;

      if (delta?.content != null) {
        result.completionText = delta.content;
        accumulatedText += delta.content;
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

      // The model signalled the tool-call block is complete. Defer emitting
      // them until the usage chunk or terminal so a following usage-only chunk
      // is still read.
      if (choice.finish_reason === "tool_calls" && !finalToolCalls && toolCallsAccum.size > 0) {
        finalToolCalls = finalizeToolCalls(toolCallsAccum);
        toolCallsAccum.clear();
      }

      // NOTE: terminal `finish_reason` values ("stop", "length",
      // "content_filter", "function_call") are intentionally NOT emitted here.
      // They arrive on an empty-delta chunk that is normally followed by the
      // usage chunk; emitting a terminal immediately would make downstream
      // stop before reading usage, losing token accounting. A single terminal
      // is emitted at end of stream instead.
    }

    if (chunk.usage) {
      result.usage = parseUsage(chunk.usage);
      sawUsage = true;
      // Attach finalized tool calls to the usage chunk. The agent runner stops
      // at the first chunk carrying usage OR tool calls, so bundling both onto
      // this chunk is the only way to capture them together. (Attaching them
      // to the earlier `finish_reason: "tool_calls"` chunk would make the
      // runner stop before the usage chunk is read.)
      if (finalToolCalls !== undefined && !finalToolCallsAttached) {
        result.toolsCallIds = finalToolCalls.ids;
        result.toolsCallName = finalToolCalls.names;
        result.toolsCallArgs = finalToolCalls.args;
        finalToolCallsAttached = true;
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

  // Flush any tool calls accumulated without a `finish_reason: "tool_calls"`
  // marker — some OpenAI-compatible gateways/proxies terminate without ever
  // sending it. Without this the tool chain silently breaks mid-conversation
  // (the model asked for a tool but downstream never sees it).
  if (finalToolCalls === undefined && toolCallsAccum.size > 0) {
    finalToolCalls = finalizeToolCalls(toolCallsAccum);
    toolCallsAccum.clear();
  }

  // Exactly one terminal non-chunk per stream, carrying any accumulated tool
  // calls and the usage estimate. Emitted even when no `finish_reason` was
  // seen so downstream consumers always finalize the step. The agent runner
  // merges the accumulated streamed text into this response.
  const terminal: LLMResponse = { role: "assistant", isChunk: false };
  if (finalToolCalls !== undefined && !finalToolCallsAttached) {
    terminal.toolsCallIds = finalToolCalls.ids;
    terminal.toolsCallName = finalToolCalls.names;
    terminal.toolsCallArgs = finalToolCalls.args;
  }
  if (!sawUsage && inputMessages) {
    terminal.usage = estimateUsage(inputMessages, accumulatedText);
  }
  yield terminal;
}
