import type { ContentPart, Message, ToolCall } from "@yachiyo/common/llm-message.js";

// ─── OpenAI Chat Completions types ───

export interface OpenAIContentPart {
  type: "text" | "image_url" | "input_audio";
  text?: string;
  image_url?: { url: string; detail?: string };
  input_audio?: { data: string; format: string };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAIContentPart[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

// ─── Helpers ───

function parseDataUri(uri: string): { mimeType: string; base64: string } | null {
  const match = uri.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

function contentPartToOpenAI(part: ContentPart): OpenAIContentPart | null {
  if (part._noSave) return null;

  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "think":
      return { type: "text", text: `[Thinking] ${part.think}` };
    case "image_url": {
      const url = part.image_url.url;
      const parsed = parseDataUri(url);
      if (parsed) {
        // OpenAI image_url also accepts data: URIs directly
        return { type: "image_url", image_url: { url } };
      }
      return { type: "image_url", image_url: { url } };
    }
    case "audio_url": {
      const url = part.audio_url.url;
      const parsed = parseDataUri(url);
      if (parsed) {
        return {
          type: "input_audio",
          input_audio: { data: parsed.base64, format: parsed.mimeType.split("/")[1] ?? "wav" },
        };
      }
      // Fallback: pass URL as text
      return { type: "text", text: url };
    }
  }
}

function toolCallToOpenAI(tc: ToolCall): OpenAIToolCall {
  return {
    id: tc.id,
    type: "function",
    function: {
      name: tc.function.name,
      arguments: tc.function.arguments ?? "{}",
    },
  };
}

function convertContent(
  content: Message["content"]
): string | OpenAIContentPart[] | undefined {
  if (content === undefined) return undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.map(contentPartToOpenAI).filter((p): p is OpenAIContentPart => p !== null);
  return parts.length > 0 ? parts : undefined;
}

// ─── Main converter ───

export function messageToOpenAI(messages: Message[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of messages) {
    // Skip checkpoint messages
    if (msg.role === "_checkpoint") continue;

    if (msg.role === "tool") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p) => !p._noSave)
                .map((p) => (p.type === "text" ? p.text : ""))
                .join("\n")
            : "";
      result.push({
        role: "tool",
        tool_call_id: msg.tool_call_id ?? "",
        content,
      });
      continue;
    }

    const openaiMsg: OpenAIMessage = {
      role: msg.role as "system" | "user" | "assistant",
      content: convertContent(msg.content),
    };

    if (msg.role === "assistant" && msg.tool_calls) {
      openaiMsg.tool_calls = (msg.tool_calls as ToolCall[]).map(toolCallToOpenAI);
    }

    result.push(openaiMsg);
  }

  return result;
}
