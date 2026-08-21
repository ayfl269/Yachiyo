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
