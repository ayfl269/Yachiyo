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
        if (part.thought) {
          if (typeof part.thought === "string") {
            result.reasoningContent = part.thought;
          } else if (part.text) {
            result.reasoningContent = part.text;
          }
          hasContent = true;
        } else if (part.text) {
          result.completionText = part.text;
          hasContent = true;
        }
        if (part.functionCall) {
          const fc = part.functionCall;
          const id = `gemini_fc_${fc.name}_${functionCallIndex++}`;
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
