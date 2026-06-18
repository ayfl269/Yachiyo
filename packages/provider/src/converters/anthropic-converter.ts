import type { ContentPart, Message, ToolCall } from "@yachiyo/common/llm-message.js";

// ─── Anthropic API types ───

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicConversionResult {
  system: string;
  messages: AnthropicMessage[];
}

// ─── Helpers ───

function parseDataUri(uri: string): { mimeType: string; base64: string } | null {
  const match = uri.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

export function contentPartToAnthropic(part: ContentPart): AnthropicContentBlock | null {
  if (part._noSave) return null;

  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "think":
      return { type: "thinking", thinking: part.think };
    case "image_url": {
      const url = part.image_url.url;
      const parsed = parseDataUri(url);
      if (parsed) {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mimeType,
            data: parsed.base64,
          },
        };
      }
      // Not a data URI — fall back to text
      return { type: "text", text: url };
    }
    case "audio_url": {
      // Anthropic doesn't support audio natively; fall back to text
      return { type: "text", text: part.audio_url.url };
    }
  }
}

function toolCallToAnthropicToolUse(tc: ToolCall): AnthropicToolUseBlock {
  let input: Record<string, unknown> = {};
  if (tc.function.arguments) {
    try {
      input = JSON.parse(tc.function.arguments);
    } catch {
      input = { raw: tc.function.arguments };
    }
  }
  return {
    type: "tool_use",
    id: tc.id,
    name: tc.function.name,
    input,
  };
}

function convertContent(
  content: Message["content"]
): string | AnthropicContentBlock[] | undefined {
  if (content === undefined) return undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map(contentPartToAnthropic)
    .filter((p): p is AnthropicContentBlock => p !== null);
  return parts.length > 0 ? parts : undefined;
}

// ─── Main converter ───

export function messageToAnthropic(messages: Message[]): AnthropicConversionResult {
  let system = "";
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    // Skip checkpoint messages
    if (msg.role === "_checkpoint") continue;

    // System messages → top-level system string
    if (msg.role === "system") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p) => !p._noSave && p.type === "text")
                .map((p) => (p as { text: string }).text)
                .join("\n")
            : "";
      if (system) system += "\n";
      system += text;
      continue;
    }

    // Tool result messages → user message with tool_result block
    if (msg.role === "tool") {
      const outputText =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p) => !p._noSave && p.type === "text")
                .map((p) => (p as { text: string }).text)
                .join("\n")
            : "";

      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id ?? "",
            content: outputText,
          },
        ],
      });
      continue;
    }

    // user / assistant messages
    const blocks: AnthropicContentBlock[] = [];
    const converted = convertContent(msg.content);

    if (typeof converted === "string") {
      blocks.push({ type: "text", text: converted });
    } else if (Array.isArray(converted)) {
      blocks.push(...converted);
    }

    // Assistant tool calls → tool_use blocks
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls as ToolCall[]) {
        blocks.push(toolCallToAnthropicToolUse(tc));
      }
    }

    if (blocks.length > 0) {
      result.push({
        role: msg.role as "user" | "assistant",
        content: blocks,
      });
    }
  }

  return { system, messages: result };
}
