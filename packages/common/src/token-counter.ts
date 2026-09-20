import type { Message } from "./llm-message.js";
import { isTextPart, isThinkPart, isImageURLPart, isAudioURLPart } from "./llm-message.js";

export interface TokenCounter {
  countTokens(messages: Message[], trustedTokenUsage?: number): number;
}

// Token estimate constants
const IMAGE_TOKEN_ESTIMATE = 765;
const AUDIO_TOKEN_ESTIMATE = 500;

export class EstimateTokenCounter implements TokenCounter {
  countTokens(messages: Message[], trustedTokenUsage = 0): number {
    if (trustedTokenUsage > 0) return trustedTokenUsage;

    let total = 0;
    for (const msg of messages) {
      const content = msg.content;
      if (typeof content === "string") {
        total += this.estimateTokens(content);
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (isTextPart(part)) total += this.estimateTokens(part.text);
          else if (isThinkPart(part)) total += this.estimateTokens(part.think);
          else if (isImageURLPart(part)) total += IMAGE_TOKEN_ESTIMATE;
          else if (isAudioURLPart(part)) total += AUDIO_TOKEN_ESTIMATE;
        }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          total += this.estimateTokens(JSON.stringify(tc));
        }
      }
    }
    return total;
  }

  private estimateTokens(text: string): number {
    // CJK characters tokenize at roughly 1 token per character on Qwen /
    // Gemini / DeepSeek (the previous 0.6 coefficient understated
    // Chinese-heavy prompts by ~40%, which delayed cacheThreshold triggers
    // and context compression until close to the hard window limit).
    let cjkCount = 0;
    for (const c of text) {
      if (
        (c >= "\u4e00" && c <= "\u9fff") ||
        (c >= "\u3400" && c <= "\u4dbf") ||
        (c >= "\u3040" && c <= "\u30ff") ||
        (c >= "\uac00" && c <= "\ud7af")
      ) {
        cjkCount++;
      }
    }
    const otherCount = text.length - cjkCount;
    return Math.floor(cjkCount * 1.0 + otherCount * 0.3);
  }
}
