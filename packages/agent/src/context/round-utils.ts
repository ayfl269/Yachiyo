import type { Message } from "../message.js";

/**
 * Split a flat message list into logical rounds.
 * A round begins at a `user` message and includes all subsequent
 * `assistant` / `tool` messages until the next `user` message.
 */
export function splitIntoRounds(messages: Message[]): Message[][] {
  const rounds: Message[][] = [];
  let current: Message[] = [];

  for (const msg of messages) {
    if (msg.role === "user" && current.length > 0) {
      rounds.push(current);
      current = [];
    }
    current.push(msg);
  }

  if (current.length > 0) {
    rounds.push(current);
  }

  return rounds;
}

/**
 * Render rounds into a plain-text string for LLM summarization.
 */
export function roundsToText(rounds: Message[][]): string {
  const lines: string[] = [];
  for (let i = 0; i < rounds.length; i++) {
    lines.push(`--- Round ${i + 1} ---`);
    for (const msg of rounds[i]) {
      const content = typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
      lines.push(`[${msg.role}] ${content}`);
    }
  }
  return lines.join("\n");
}
