import type { LLMResponse } from "@yachiyo/common/llm-types.js";
import { parseSSEStream } from "./sse-parser.js";

interface GeminiPart {
  text?: string;
  thought?: string | boolean;
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
  };
}

export async function* parseGeminiStream(
  response: Response,
  abortSignal?: AbortSignal,
): AsyncGenerator<LLMResponse, void, unknown> {
  let functionCallIndex = 0;
  let chunkCount = 0;
  let yieldedCount = 0;

  for await (const event of parseSSEStream(response, abortSignal)) {
    chunkCount++;
    let chunk: GeminiChunk;
    try {
      chunk = JSON.parse(event.data);
    } catch {
      // Diagnostic: log unparseable events
      console.warn(`[GeminiStreamParser] Chunk ${chunkCount}: failed to parse, data=${(event.data ?? "").slice(0, 200)}`);
      continue;
    }

    // Diagnostic: log first few chunks' raw structure
    if (chunkCount <= 3) {
      console.warn(`[GeminiStreamParser] Chunk ${chunkCount} raw:`, JSON.stringify(chunk).slice(0, 500));
    }

    const result: LLMResponse = { role: "assistant", isChunk: true };
    let hasContent = false;

    const parts = chunk.candidates?.[0]?.content?.parts;
    if (parts) {
      for (const part of parts) {
        // C-15 fix: Gemini's `part.thought` field has two distinct semantic
        // shapes and the original truthy check conflated them:
        //   1. string  → thought *itself* contains the reasoning content
        //   2. boolean → mere flag indicating "this part is a thinking block";
        //                it does NOT mean part.text should be treated as
        //                reasoning. When thought===true, part.text is still
        //                user-visible completion text.
        // Previously `if (part.thought)` matched both shapes, so a boolean
        // `true` flag caused part.text to be misclassified as reasoning and
        // silently dropped from the user-visible completion. We now use
        // strict type checks and only treat the string form as reasoning.
        if (typeof part.thought === "string" && part.thought.length > 0) {
          result.reasoningContent = part.thought;
          hasContent = true;
        }
        if (part.text) {
          // part.text is always user-visible completion, regardless of the
          // thought flag.
          result.completionText = part.text;
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
          result.toolsCallIds = [id];
          result.toolsCallName = [fc.name];
          result.toolsCallArgs = [fc.args ?? {}];
          hasContent = true;
        }
      }
    }

    if (chunk.usageMetadata) {
      const u = chunk.usageMetadata;
      result.usage = {
        promptTokens: u.promptTokenCount ?? 0,
        completionTokens: u.candidatesTokenCount ?? 0,
        total: u.totalTokenCount ?? 0,
      };
      hasContent = true;
    }

    if (hasContent) {
      yieldedCount++;
      yield result;
    }
  }

  // Diagnostic: summary
  if (chunkCount > 0 && yieldedCount === 0) {
    console.warn(`[GeminiStreamParser] Stream ended: ${chunkCount} chunks received, ${yieldedCount} yielded (all empty!)`);
  }
}
