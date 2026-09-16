import type { LLMResponse } from "@yachiyo/common/llm-types.js";
import { parseSSEStream } from "./sse-parser.js";

interface GeminiPart {
  text?: string;
  thought?: string | boolean;
  thoughtSignature?: string;
  functionCall?: {
    name: string;
    args?: Record<string, unknown>;
  };
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiPart[];
    role?: string;
  };
  finishReason?: string;
}

interface GeminiChunk {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

export async function* parseGeminiStream(
  response: Response,
  abortSignal?: AbortSignal,
): AsyncGenerator<LLMResponse, void, unknown> {
  let functionCallIndex = 0;
  let chunkCount = 0;
  let yieldedCount = 0;
  // Gemini's `streamGenerateContent` reports `usageMetadata` on EVERY chunk,
  // and the counts are cumulative. Downstream (ToolLoopAgentRunner) treats any
  // chunk carrying `usage` as the terminal response and stops reading, so
  // attaching usage to a mid-stream chunk truncates the reply after the first
  // text delta. Instead, cache the latest cumulative usage and emit it once on
  // a terminal chunk at end of stream — matching the OpenAI/Anthropic parsers.
  let lastUsage: LLMResponse["usage"] | undefined;

  for await (const event of parseSSEStream(response, abortSignal)) {
    chunkCount++;
    let chunk: GeminiChunk;
    try {
      chunk = JSON.parse(event.data);
    } catch {
      // Diagnostic: log unparseable events. Kept at warn level but truncated
      // so malformed upstream responses stay visible; the payload preview may
      // contain conversation content, hence the hard length cap.
      const preview = (event.data ?? "").slice(0, 200);
      console.warn(`[GeminiStreamParser] Chunk ${chunkCount}: failed to parse, data preview length=${(event.data ?? "").length}`);
      console.debug(`[GeminiStreamParser] Chunk ${chunkCount} unparseable data preview: ${preview}`);
      continue;
    }

    // Diagnostic: log first few chunks' raw structure. Downgraded to
    // console.debug: raw chunk JSON contains session content and must not be
    // emitted at warn level in production logs.
    if (chunkCount <= 3) {
      console.debug(`[GeminiStreamParser] Chunk ${chunkCount} raw:`, JSON.stringify(chunk).slice(0, 500));
    }

    const result: LLMResponse = { role: "assistant", isChunk: true };
    let hasContent = false;

    const parts = chunk.candidates?.[0]?.content?.parts;
    if (parts) {
      // A single chunk may carry multiple functionCall parts; accumulate them
      // instead of letting the last one overwrite the previous (which silently
      // dropped parallel tool calls).
      const chunkToolCallIds: string[] = [];
      const chunkToolCallNames: string[] = [];
      const chunkToolCallArgs: Record<string, unknown>[] = [];
      const chunkToolCallExtra: Record<string, unknown>[] = [];

      for (const part of parts) {
        // `part.thought` marks a thinking part. The official Gemini API uses
        // the boolean form: `thought: true` means part.text IS the model's
        // reasoning (thought summary), NOT user-visible completion text.
        // Some proxies use a string form where the thought text itself is in
        // the `thought` field. Either way the content must be routed to
        // reasoningContent — matching the non-streaming path in
        // gemini-provider.ts. Routing boolean-flagged text into
        // completionText leaks thinking content into user-visible replies.
        if (part.thought) {
          if (typeof part.thought === "string" && part.thought.length > 0) {
            result.reasoningContent = (result.reasoningContent ?? "") + part.thought;
            hasContent = true;
          } else if (typeof part.text === "string" && part.text.length > 0) {
            result.reasoningContent = (result.reasoningContent ?? "") + part.text;
            hasContent = true;
          }
        } else if (typeof part.text === "string" && part.text.length > 0) {
          // Only parts WITHOUT the thought flag are user-visible completion.
          result.completionText = (result.completionText ?? "") + part.text;
          hasContent = true;
        }
        // Thinking models return an opaque signature that must be echoed back
        // verbatim on replay (required for function-calling turns).
        if (typeof part.thoughtSignature === "string" && part.thoughtSignature) {
          result.reasoningSignature = part.thoughtSignature;
          hasContent = true;
        }
        if (part.functionCall) {
          const fc = part.functionCall;
          // C-14 fix: the previous ID format `gemini_fc_<name>_<idx>` could
          // not be reversed by gemini-converter.ts, which used
          // `slice("gemini_fc_".length)` and ended up with `<name>_<idx>`
          // (e.g. "getWeather_0") instead of `<name>`. This broke the
          // tool-call round-trip. We now use a `__idx_<n>` suffix that the
          // converter strips via regex, leaving the original function name
          // intact even when it contains underscores or trailing digits.
          const id = `gemini_fc_${fc.name}__idx_${functionCallIndex++}`;
          chunkToolCallIds.push(id);
          chunkToolCallNames.push(fc.name);
          chunkToolCallArgs.push(fc.args ?? {});
          chunkToolCallExtra.push(
            typeof part.thoughtSignature === "string" && part.thoughtSignature
              ? { thoughtSignature: part.thoughtSignature }
              : {},
          );
          hasContent = true;
        }
      }

      if (chunkToolCallIds.length > 0) {
        result.toolsCallIds = chunkToolCallIds;
        result.toolsCallName = chunkToolCallNames;
        result.toolsCallArgs = chunkToolCallArgs;
        if (chunkToolCallExtra.some((e) => Object.keys(e).length > 0)) {
          result.toolsCallExtraContent = chunkToolCallExtra;
        }
      }
    }

    if (chunk.usageMetadata) {
      const u = chunk.usageMetadata;
      lastUsage = {
        promptTokens: u.promptTokenCount ?? 0,
        completionTokens: u.candidatesTokenCount ?? 0,
        total: u.totalTokenCount ?? 0,
        cacheReadInputTokens: u.cachedContentTokenCount,
      };
    }

    // A chunk carrying tool calls is terminal for the agent runner (it stops at
    // the first chunk with tool calls OR usage). Gemini reports usageMetadata
    // on that same chunk, so bundle the usage onto it — otherwise the terminal
    // usage emitted below is never read on tool-call turns and accounting is
    // lost. Plain text chunks deliberately do NOT carry usage: attaching it
    // would stop the stream after the first delta.
    if (result.toolsCallName !== undefined && lastUsage !== undefined) {
      result.usage = lastUsage;
    }

    if (hasContent) {
      yieldedCount++;
      yield result;
    }
  }

  // Emit exactly one terminal (non-chunk) response carrying the cumulative
  // usage. Doing it here rather than on each chunk prevents downstream from
  // stopping the stream early (see the `lastUsage` comment above). Emitted
  // unconditionally so downstream always finalizes the step, matching the
  // OpenAI/Anthropic parsers.
  yield { role: "assistant", isChunk: false, usage: lastUsage };

  // Diagnostic: summary (stays at warn — no content, purely structural)
  if (chunkCount > 0 && yieldedCount === 0) {
    console.warn(`[GeminiStreamParser] Stream ended: ${chunkCount} chunks received, ${yieldedCount} yielded (all empty!)`);
  }
}
