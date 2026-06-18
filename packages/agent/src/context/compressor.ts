import type { Message } from "../message.js";
import type { Provider } from "@yachiyo/provider/provider.js";
import type { TokenCounter } from "./token-counter.js";
import { EstimateTokenCounter } from "./token-counter.js";
import { ContextTruncator } from "./truncator.js";
import { splitIntoRounds } from "./round-utils.js";

export interface ContextCompressor {
  shouldCompress(messages: Message[], currentTokens: number, maxTokens: number): boolean;
  compress(messages: Message[]): Promise<Message[]>;
}

export class TruncateByTurnsCompressor implements ContextCompressor {
  private truncateTurns: number;
  private compressionThreshold: number;

  constructor(truncateTurns = 1, compressionThreshold = 0.82) {
    this.truncateTurns = truncateTurns;
    this.compressionThreshold = compressionThreshold;
  }

  shouldCompress(_messages: Message[], currentTokens: number, maxTokens: number): boolean {
    if (maxTokens <= 0 || currentTokens <= 0) return false;
    return currentTokens / maxTokens > this.compressionThreshold;
  }

  async compress(messages: Message[]): Promise<Message[]> {
    const truncator = new ContextTruncator();
    return truncator.truncateByDroppingOldestTurns(messages, this.truncateTurns);
  }
}

/**
 * Extract leading system messages from a message list.
 */
function extractSystemMessages(messages: Message[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      result.push(msg);
    } else {
      break;
    }
  }
  return result;
}

export class LLMSummaryCompressor implements ContextCompressor {
  private provider: Provider;
  private keepRecentRatio: number;
  private compressionThreshold: number;
  private instructionText: string;
  private tokenCounter: TokenCounter;

  private static readonly TASK_CONTINUATION_INSTRUCTION =
    "If a task appears to be in progress, end the summary with the latest " +
    "known result and the concrete next step to continue the task.";

  constructor(
    provider: Provider,
    keepRecentRatio = 0.15,
    instructionText?: string,
    compressionThreshold = 0.82,
    tokenCounter?: TokenCounter,
  ) {
    this.provider = provider;
    this.keepRecentRatio = Math.min(Math.max(keepRecentRatio, 0), 0.3);
    this.compressionThreshold = compressionThreshold;
    this.tokenCounter = tokenCounter ?? new EstimateTokenCounter();
    this.instructionText = instructionText ??
      "Based on our full conversation history, produce a concise summary of key takeaways and/or project progress.\n" +
      "The primary goal of this summary is to enable seamless continuation of the work that follows.\n" +
      "1. Systematically cover all core topics discussed and the final conclusion/outcome for each; clearly highlight the latest primary focus.\n" +
      "2. If any tools were used, summarize tool usage (total call count) and extract the most valuable insights from tool outputs.\n" +
      "3. If any materials (files, documents, code, references) were read during the conversation that may be helpful for subsequent work, list each one with its scope and path.\n" +
      "4. If there was an initial user goal, state it first and describe the current progress/status.\n" +
      "5. Write the summary in the user's language.\n";
  }

  shouldCompress(_messages: Message[], currentTokens: number, maxTokens: number): boolean {
    if (maxTokens <= 0 || currentTokens <= 0) return false;
    return currentTokens / maxTokens > this.compressionThreshold;
  }

  /**
   * Split rounds into summarised history and exact recent context by token ratio.
   * The token budget is computed from total tokens * keepRecentRatio.
   * Round-granular: always preserves the latest whole round.
   */
  private splitRecentRoundsByTokenRatio(
    rounds: Message[][],
    totalTokens: number,
  ): [Message[][], Message[][]] {
    if (!rounds.length || this.keepRecentRatio <= 0 || totalTokens <= 0) {
      return [rounds, []];
    }

    const budget = Math.max(1, Math.floor(totalTokens * this.keepRecentRatio));
    let used = 0;
    let recentStart = rounds.length;

    for (let idx = rounds.length - 1; idx >= 0; idx--) {
      const roundTokens = this.tokenCounter.countTokens(rounds[idx]);
      if (used > 0 && used + roundTokens > budget) {
        break;
      }
      used += roundTokens;
      recentStart = idx;
    }

    return [rounds.slice(0, recentStart), rounds.slice(recentStart)];
  }

  async compress(messages: Message[]): Promise<Message[]> {
    if (messages.length <= 4) return messages;

    const rounds = splitIntoRounds(messages);
    const totalTokens = this.tokenCounter.countTokens(messages);

    let [oldRounds, recentRounds] = this.splitRecentRoundsByTokenRatio(rounds, totalTokens);

    // The latest user message must always be in recent rounds
    if (messages.length > 0 && messages[messages.length - 1].role === "user" && oldRounds.length > 0) {
      const latestOldRound = oldRounds[oldRounds.length - 1];
      if (latestOldRound.length > 0 && latestOldRound[latestOldRound.length - 1] === messages[messages.length - 1]) {
        oldRounds = oldRounds.slice(0, -1);
        recentRounds = [latestOldRound, ...recentRounds];
      }
    }

    // If no old rounds to summarize, return original
    if (oldRounds.length === 0) {
      if (recentRounds.length > 0 && messages.length > 0 && messages[messages.length - 1].role === "user") {
        return messages;
      }
      oldRounds = rounds;
      recentRounds = [];
    }

    // Flatten old rounds for summarization
    let summaryContexts = oldRounds.flat();

    // Skip if only system messages
    if (!summaryContexts.some(msg => msg.role !== "system")) {
      if (recentRounds.length > 0 && messages.length > 0 && messages[messages.length - 1].role === "user") {
        return messages;
      }
      oldRounds = rounds;
      recentRounds = [];
      summaryContexts = oldRounds.flat();
      if (!summaryContexts.some(msg => msg.role !== "system")) {
        return messages;
      }
    }

    // Ensure the last message before our instruction is an assistant message
    if (summaryContexts[summaryContexts.length - 1].role !== "assistant") {
      summaryContexts.push({
        role: "assistant",
        content: "Acknowledged.",
      });
    }

    // Add summarization instruction
    summaryContexts.push({
      role: "user",
      content:
        "Generate a summary of our previous conversation history.\n" +
        `<extra_instruction>\n${this.instructionText}\n\n` +
        `${LLMSummaryCompressor.TASK_CONTINUATION_INSTRUCTION}</extra_instruction>\n` +
        "Respond ONLY with the summary content, without any additional text or formatting.",
    });

    try {
      const response = await this.provider.textChat({
        contexts: summaryContexts,
        enableCaching: true,
      });
      const summaryContent = (response.completionText ?? "").trim();

      if (!summaryContent) {
        console.warn("[LLMSummaryCompressor] LLM returned empty summary, keeping original messages.");
        return messages;
      }

      // Build result: system messages + summary pair + recent rounds
      const result = extractSystemMessages(messages);

      result.push({
        role: "user",
        content: `Our previous history conversation summary: ${summaryContent}`,
      });
      result.push({
        role: "assistant",
        content: "Acknowledged the summary of our previous conversation history.",
      });

      // Flatten recent rounds
      for (const rnd of recentRounds) {
        result.push(...rnd);
      }

      return result;
    } catch (e) {
      console.error("[LLMSummaryCompressor] Failed to generate summary:", e);
      return messages;
    }
  }
}

/**
 * @deprecated Use LLMSummaryCompressor with keepRecentRatio instead.
 * Split the message list into system messages, messages to summarize, and recent messages.
 */
export function splitHistory(
  messages: Message[],
  keepRecent: number
): [Message[], Message[], Message[]] {
  let firstNonSystem = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "system") {
      firstNonSystem = i;
      break;
    }
  }

  const systemMessages = messages.slice(0, firstNonSystem);
  const nonSystemMessages = messages.slice(firstNonSystem);

  if (nonSystemMessages.length <= keepRecent) {
    return [systemMessages, [], nonSystemMessages];
  }

  let splitIndex = nonSystemMessages.length - keepRecent;
  while (splitIndex > 0 && nonSystemMessages[splitIndex].role !== "user") {
    splitIndex--;
  }

  if (splitIndex === 0) {
    return [systemMessages, [], nonSystemMessages];
  }

  return [
    systemMessages,
    nonSystemMessages.slice(0, splitIndex),
    nonSystemMessages.slice(splitIndex),
  ];
}
