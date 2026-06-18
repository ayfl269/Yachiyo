import type { Message } from "../message.js";
import { splitIntoRounds } from "./round-utils.js";

export class ContextTruncator {
  private hasToolCalls(message: Message): boolean {
    return (
      message.role === "assistant" &&
      message.tool_calls != null &&
      message.tool_calls.length > 0
    );
  }

  private static splitSystemRest(
    messages: Message[]
  ): [Message[], Message[]] {
    let firstNonSystem = messages.length; // Default: all messages are system
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== "system") {
        firstNonSystem = i;
        break;
      }
    }
    return [messages.slice(0, firstNonSystem), messages.slice(firstNonSystem)];
  }

  private static ensureUserMessage(
    systemMessages: Message[],
    truncated: Message[],
    originalMessages: Message[]
  ): Message[] {
    if (truncated.length > 0 && truncated[0].role === "user") {
      return [...systemMessages, ...truncated];
    }
    const firstUser = originalMessages.find((m) => m.role === "user");
    if (!firstUser) return [...systemMessages, ...truncated];
    return [...systemMessages, firstUser, ...truncated];
  }

  /**
   * Fix the message list to ensure tool call and tool response pairing validity.
   */
  fixMessages(messages: Message[]): Message[] {
    if (!messages.length) return messages;

    const fixedMessages: Message[] = [];
    let pendingAssistant: Message | null = null;
    let pendingTools: Message[] = [];

    const flushPendingIfValid = (): void => {
      if (pendingAssistant && pendingTools.length > 0) {
        fixedMessages.push(pendingAssistant);
        fixedMessages.push(...pendingTools);
      }
      pendingAssistant = null;
      pendingTools = [];
    };

    for (const msg of messages) {
      if (msg.role === "tool") {
        if (pendingAssistant) pendingTools.push(msg);
        continue;
      }

      if (this.hasToolCalls(msg)) {
        flushPendingIfValid();
        pendingAssistant = msg;
        continue;
      }

      flushPendingIfValid();
      fixedMessages.push(msg);
    }

    flushPendingIfValid();
    return fixedMessages;
  }

  /**
   * Turn-based truncation strategy.
   */
  truncateByTurns(
    messages: Message[],
    keepMostRecentTurns: number,
    dropTurns = 1
  ): Message[] {
    if (keepMostRecentTurns === -1) return messages;

    const [systemMessages, nonSystemMessages] = ContextTruncator.splitSystemRest(messages);
    const rounds = splitIntoRounds(nonSystemMessages);
    if (rounds.length <= keepMostRecentTurns) return messages;

    const numToKeep = keepMostRecentTurns - dropTurns + 1;
    const truncatedRounds = numToKeep <= 0 ? [] : rounds.slice(-numToKeep);
    const truncatedContexts = truncatedRounds.flat();

    const firstUserIdx = truncatedContexts.findIndex((m) => m.role === "user");
    const adjusted = firstUserIdx > 0 ? truncatedContexts.slice(firstUserIdx) : truncatedContexts;

    const result = ContextTruncator.ensureUserMessage(systemMessages, adjusted, messages);
    return this.fixMessages(result);
  }

  /**
   * Drop the oldest N turns.
   */
  truncateByDroppingOldestTurns(messages: Message[], dropTurns = 1): Message[] {
    if (dropTurns <= 0) return messages;

    const [systemMessages, nonSystemMessages] = ContextTruncator.splitSystemRest(messages);
    const rounds = splitIntoRounds(nonSystemMessages);

    let truncatedNonSystem: Message[];
    if (rounds.length <= dropTurns) {
      truncatedNonSystem = [];
    } else {
      const truncatedRounds = rounds.slice(dropTurns);
      truncatedNonSystem = truncatedRounds.flat();
    }

    const firstUserIdx = truncatedNonSystem.findIndex((m) => m.role === "user");
    if (firstUserIdx > 0) {
      truncatedNonSystem = truncatedNonSystem.slice(firstUserIdx);
    }

    const result = ContextTruncator.ensureUserMessage(systemMessages, truncatedNonSystem, messages);
    return this.fixMessages(result);
  }

  /**
   * Halve the number of messages, keeping the most recent ones.
   */
  truncateByHalving(messages: Message[]): Message[] {
    if (messages.length <= 2) return messages;

    const [systemMessages, nonSystemMessages] = ContextTruncator.splitSystemRest(messages);
    const rounds = splitIntoRounds(nonSystemMessages);
    const roundsToDelete = Math.floor(rounds.length / 2);
    if (roundsToDelete === 0) return messages;

    let truncatedNonSystem = rounds.slice(roundsToDelete).flat();
    const firstUserIdx = truncatedNonSystem.findIndex((m) => m.role === "user");
    if (firstUserIdx > 0) {
      truncatedNonSystem = truncatedNonSystem.slice(firstUserIdx);
    }

    const result = ContextTruncator.ensureUserMessage(systemMessages, truncatedNonSystem, messages);
    return this.fixMessages(result);
  }
}
