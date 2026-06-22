import type { Message } from "../message.js";
import type { ContextConfig } from "./config.js";
import { EstimateTokenCounter } from "./token-counter.js";
import type { TokenCounter } from "./token-counter.js";
import { TruncateByTurnsCompressor, LLMSummaryCompressor } from "./compressor.js";
import type { ContextCompressor } from "./compressor.js";
import { ContextTruncator } from "./truncator.js";

export class ContextManager {
  private config: ContextConfig;
  private tokenCounter: TokenCounter;
  private truncator: ContextTruncator;
  private compressor: { shouldCompress: ContextCompressor["shouldCompress"]; compress: (messages: Message[]) => Promise<Message[]> };

  constructor(config: ContextConfig) {
    this.config = config;
    this.tokenCounter = config.customTokenCounter ?? new EstimateTokenCounter();
    this.truncator = new ContextTruncator();

    if (config.customCompressor) {
      this.compressor = {
        shouldCompress: config.customCompressor.shouldCompress.bind(config.customCompressor),
        compress: (messages) => config.customCompressor!.compress(messages),
      };
    } else if (config.llmCompressProvider) {
      const keepRecentRatio = config.llmCompressKeepRecentRatio ?? 0.15;
      const llmCompressor = new LLMSummaryCompressor(
        config.llmCompressProvider,
        keepRecentRatio,
        config.llmCompressInstruction
      );
      this.compressor = {
        shouldCompress: llmCompressor.shouldCompress.bind(llmCompressor),
        compress: llmCompressor.compress.bind(llmCompressor),
      };
    } else {
      const truncateCompressor = new TruncateByTurnsCompressor(config.truncateTurns);
      this.compressor = {
        shouldCompress: truncateCompressor.shouldCompress.bind(truncateCompressor),
        compress: truncateCompressor.compress.bind(truncateCompressor),
      };
    }
  }

  async process(messages: Message[], trustedTokenUsage = 0): Promise<Message[]> {
    try {
      let result = messages;
      let currentTrustedTokenUsage = trustedTokenUsage;

      // Step 1: Enforce max turns (truncation)
      if (this.config.enforceMaxTurns > 0) {
        result = this.truncator.truncateByTurns(
          result,
          this.config.enforceMaxTurns,
          this.config.truncateTurns
        );
        if (result.length !== messages.length) {
          currentTrustedTokenUsage = 0;
        }
      }

      // Step 2: Token-based compression
      if (this.config.maxContextTokens > 0) {
        const totalTokens = this.tokenCounter.countTokens(result, currentTrustedTokenUsage);
        if (this.compressor.shouldCompress(result, totalTokens, this.config.maxContextTokens)) {
          result = await this.runCompression(result, totalTokens);
        }
      }

      return result;
    } catch (e) {
      console.error("Error during context processing:", e);
      return messages;
    }
  }

  private async runCompression(messages: Message[], prevTokens: number): Promise<Message[]> {
    console.debug("Compress triggered, starting compression...");

    let compressed = await this.compressor.compress(messages);

    const tokensAfter = this.tokenCounter.countTokens(compressed);
    const compressRate = (tokensAfter / this.config.maxContextTokens) * 100;
    console.info(
      `Compress completed. ${prevTokens} -> ${tokensAfter} tokens, compression rate: ${compressRate.toFixed(2)}%.`
    );

    // Double check: if still over limit, halve
    if (tokensAfter > this.config.maxContextTokens) {
      console.info("Context still exceeds max tokens after compression, applying halving truncation...");
      compressed = this.truncator.truncateByHalving(compressed);
    }

    return compressed;
  }
}
