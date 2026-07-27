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

/**
 * Build a placeholder string for a tool-result message when the active
 * provider does not support tool_use. The original `role: "tool"` message
 * is converted to `role: "user"` with this placeholder so the model at
 * least sees the tool's output text.
 *
 * The placeholder explicitly frames the content as a system-injected
 * tool result rather than user-authored text — without this framing,
 * models frequently mistake the stripped tool output for the user's own
 * statement and reply to it as if the user had said it, which breaks
 * multi-step tool chains.
 */
function toolResultPlaceholder(content: unknown): string {
  const body = extractToolResultText(content);
  if (!body) {
    return "[SYSTEM: This message was originally a tool result, but the provider does not support tool_use. The tool returned no textual output.]";
  }
  return (
    "[SYSTEM: This message was originally a tool result, but the active provider " +
    "does not support tool_use. It has been converted to a user message so the " +
    "model can still see the tool's output. Do not treat this as the user's own " +
    "statement — it is the return value of a prior tool call.]\n" +
    `Tool output:\n${body}`
  );
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
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
    return textParts.filter(Boolean).join("\n").trim();
  }

  return "";
}

/**
 * Track which provider ids have already emitted the tool_use strip warning.
 * Each provider should warn at most once per process to avoid log spam on
 * every request — the underlying misconfiguration doesn't change between
 * calls, so one prominent warning is enough for the operator to notice.
 */
const toolUseStripWarnedProviders = new Set<string>();

/**
 * Log context sanitize stats if any changes were made.
 *
 * Tool-use sanitization (fixedToolMessages / removedToolCalls) is upgraded
 * to a `warn`-level, deduplicated message because it silently destroys the
 * model's tool-call history — a severe issue that otherwise goes unnoticed.
 * Image/audio sanitization stays at `debug` level since it is expected
 * behaviour for multimodal-incompatible providers.
 */
export function logContextSanitizeStats(
  stats: ContextSanitizeStats,
  providerId?: string
): void {
  if (!isSanitizeStatsChanged(stats)) return;

  const toolUseStripped = stats.fixedToolMessages > 0 || stats.removedToolCalls > 0;
  if (toolUseStripped) {
    const key = providerId ?? "unknown";
    if (!toolUseStripWarnedProviders.has(key)) {
      toolUseStripWarnedProviders.add(key);
      console.warn(
        `[modalities] Provider "${key}" does not support tool_use — ` +
        `tool-call history has been STRIPPED from the context. ` +
        `The model will not see prior tool invocations and may fail to call ` +
        `tools proactively. Add "tool_use" to this provider's modalities in ` +
        `the dashboard to fix this. ` +
        `(this request: tool_msgs→user=${stats.fixedToolMessages}, ` +
        `tool_calls_removed=${stats.removedToolCalls})`
      );
    } else {
      console.debug(
        `[modalities] Provider "${key}" tool_use sanitization: ` +
        `fixed_tool=${stats.fixedToolMessages}, removed_calls=${stats.removedToolCalls}`
      );
    }
    return;
  }

  console.debug(
    `context modality fix applied: ` +
    `fixed_image_blocks=${stats.fixedImageBlocks}, ` +
    `fixed_audio_blocks=${stats.fixedAudioBlocks}`
  );
}
