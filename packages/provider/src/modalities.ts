import type { Message } from "@yachiyo/common/llm-message.js";

export interface ContextSanitizeStats {
  fixedImageBlocks: number;
  fixedAudioBlocks: number;
  fixedToolMessages: number;
  removedToolCalls: number;
}

export function createContextSanitizeStats(): ContextSanitizeStats {
  return {
    fixedImageBlocks: 0,
    fixedAudioBlocks: 0,
    fixedToolMessages: 0,
    removedToolCalls: 0,
  };
}

export function isSanitizeStatsChanged(stats: ContextSanitizeStats): boolean {
  return (
    stats.fixedImageBlocks > 0 ||
    stats.fixedAudioBlocks > 0 ||
    stats.fixedToolMessages > 0 ||
    stats.removedToolCalls > 0
  );
}

/**
 * Sanitize message contexts based on provider modalities.
 *
 * - Strips image/audio content parts if the provider doesn't support them
 * - Converts tool messages to user messages if the provider doesn't support tool_use
 * - Removes tool_calls from assistant messages if the provider doesn't support tool_use
 */
export function sanitizeContextsByModalities(
  contexts: (Message | Record<string, unknown>)[],
  modalities: string[] | undefined | null
): [Record<string, unknown>[], ContextSanitizeStats] {
  if (!contexts.length) {
    return [[], createContextSanitizeStats()];
  }

  if (!modalities || !Array.isArray(modalities)) {
    const copied = contexts.map((msg) => messageToDict(msg)).filter((m): m is Record<string, unknown> => m !== null);
    return [copied, createContextSanitizeStats()];
  }

  const supportsImage = modalities.includes("image");
  const supportsAudio = modalities.includes("audio");
  const supportsToolUse = modalities.includes("tool_use");

  if (supportsImage && supportsAudio && supportsToolUse) {
    const copied = contexts.map((msg) => messageToDict(msg)).filter((m): m is Record<string, unknown> => m !== null);
    return [copied, createContextSanitizeStats()];
  }

  const sanitized: Record<string, unknown>[] = [];
  const stats = createContextSanitizeStats();

  for (const rawMsg of contexts) {
    const msg = messageToDict(rawMsg);
    if (!msg) continue;

    const role = msg.role as string | undefined;
    if (!role) continue;

    // Handle tool_use modality
    if (!supportsToolUse) {
      if (role === "tool") {
        stats.fixedToolMessages++;
        msg.role = "user";
        msg.content = toolResultPlaceholder(msg.content);
        delete msg.tool_call_id;
      }
      if (role === "assistant" && "tool_calls" in msg) {
        stats.removedToolCalls++;
        delete msg.tool_calls;
        delete msg.tool_call_id;
      }
    }

    // Handle image/audio modalities
    if (!supportsImage || !supportsAudio) {
      const content = msg.content;
      if (Array.isArray(content)) {
        const filteredParts: unknown[] = [];
        let removedAnyMultimodal = false;

        for (const part of content) {
          if (typeof part === "object" && part !== null && "type" in (part as Record<string, unknown>)) {
            const partType = String((part as Record<string, unknown>).type ?? "").toLowerCase();

            if (!supportsImage && (partType === "image_url" || partType === "image")) {
              removedAnyMultimodal = true;
              stats.fixedImageBlocks++;
              filteredParts.push({ type: "text", text: "[Image]" });
              continue;
            }

            if (!supportsAudio && (partType === "audio_url" || partType === "input_audio")) {
              removedAnyMultimodal = true;
              stats.fixedAudioBlocks++;
              filteredParts.push({ type: "text", text: "[Audio]" });
              continue;
            }
          }
          filteredParts.push(part);
        }

        if (removedAnyMultimodal) {
          msg.content = filteredParts;
        }
      }
    }

    // Skip empty assistant messages
    if (role === "assistant") {
      const content = msg.content;
      const hasToolCalls = Boolean(msg.tool_calls);
      if (!hasToolCalls) {
        if (!content) continue;
        if (typeof content === "string" && !content.trim()) continue;
      }
    }

    sanitized.push(msg);
  }

  return [sanitized, stats];
}

function messageToDict(message: Message | Record<string, unknown>): Record<string, unknown> | null {
  if (typeof message === "object" && message !== null) {
    if ("role" in message) {
      // It's already a Message-like object, shallow copy it
      return { ...message };
    }
  }
  return null;
}

function toolResultPlaceholder(content: unknown): string {
  if (typeof content === "string") {
    const text = content.trim();
    if (!text) return "[Tool result]";
    return `[Tool result]\n${text}`;
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const part of content) {
      if (typeof part === "object" && part !== null && "type" in (part as Record<string, unknown>)) {
        const partType = String((part as Record<string, unknown>).type ?? "").toLowerCase();
        if (partType === "text") {
          textParts.push(String((part as Record<string, unknown>).text ?? ""));
        } else if (partType === "image_url" || partType === "image") {
          textParts.push("[Image]");
        } else if (partType === "audio_url" || partType === "input_audio") {
          textParts.push("[Audio]");
        }
      }
    }
    const joined = textParts.filter(Boolean).join("\n").trim();
    if (!joined) return "[Tool result]";
    return `[Tool result]\n${joined}`;
  }

  return "[Tool result]";
}

/**
 * Log context sanitize stats if any changes were made.
 */
export function logContextSanitizeStats(stats: ContextSanitizeStats): void {
  if (!isSanitizeStatsChanged(stats)) return;
  console.debug(
    `context modality fix applied: ` +
    `fixed_image_blocks=${stats.fixedImageBlocks}, ` +
    `fixed_audio_blocks=${stats.fixedAudioBlocks}, ` +
    `fixed_tool_messages=${stats.fixedToolMessages}, ` +
    `removed_tool_calls=${stats.removedToolCalls}`
  );
}
