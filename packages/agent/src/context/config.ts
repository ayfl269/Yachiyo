import type { Provider } from "@yachiyo/provider/provider.js";
import type { TokenCounter } from "./token-counter.js";
import type { ContextCompressor } from "./compressor.js";

export interface ContextConfig {
  /** Maximum number of context tokens. <= 0 means no limit. */
  maxContextTokens: number;
  /** Maximum number of conversation turns to keep. -1 means no limit. */
  enforceMaxTurns: number;
  /** Number of turns to discard at once when truncation is triggered. */
  truncateTurns: number;
  /** Instruction prompt for LLM-based compression. */
  llmCompressInstruction?: string;
  /** Number of recent messages to keep during LLM-based compression. */
  llmCompressKeepRecent: number;
  /** Ratio of recent context tokens to keep during LLM-based compression (0-0.3). Overrides llmCompressKeepRecent if > 0. */
  llmCompressKeepRecentRatio?: number;
  /** LLM provider used for compression tasks. */
  llmCompressProvider?: Provider;
  /** Custom token counting method. */
  customTokenCounter?: TokenCounter;
  /** Custom context compression method. */
  customCompressor?: ContextCompressor;
}

export function createContextConfig(
  overrides?: Partial<ContextConfig>
): ContextConfig {
  return {
    maxContextTokens: 0,
    enforceMaxTurns: -1,
    truncateTurns: 1,
    llmCompressKeepRecent: 0,
    llmCompressKeepRecentRatio: 0.15,
    ...overrides,
  };
}
