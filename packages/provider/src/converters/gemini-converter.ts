import type { ContentPart, Message, ToolCall } from "@yachiyo/common/llm-message.js";

// ─── Gemini API types ───

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

export interface GeminiContent {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
}

export interface GeminiConversionResult {
  systemInstruction?: { parts: GeminiPart[] };
  contents: GeminiContent[];
}

// ─── Helpers ───

function parseDataUri(uri: string): { mimeType: string; base64: string } | null {
  const match = uri.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

export function contentPartToGemini(part: ContentPart): GeminiPart | null {
  if (part._noSave) return null;

  switch (part.type) {
    case "text":
      return { text: part.text };
    case "think":
      return { text: `[Thinking] ${part.think}` };
    case "image_url": {
      const url = part.image_url.url;
      const parsed = parseDataUri(url);
      if (parsed) {
        return { inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } };
      }
      // Not a data URI — fall back to text description
      return { text: url };
    }
    case "audio_url": {
      const url = part.audio_url.url;
      const parsed = parseDataUri(url);
      if (parsed) {
        return { inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } };
      }
      return { text: url };
    }
  }
}

function toolCallToGeminiFunctionCall(tc: ToolCall): GeminiPart {
  let args: Record<string, unknown> = {};
  if (tc.function.arguments) {
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      args = { raw: tc.function.arguments };
    }
  }
  return {
    functionCall: {
      name: tc.function.name,
      args,
    },
  };
}

function convertContentParts(content: ContentPart[]): GeminiPart[] {
  return content.map(contentPartToGemini).filter((p): p is GeminiPart => p !== null);
}

// ─── Main converter ───

export function messageToGemini(messages: Message[]): GeminiConversionResult {
  let systemInstruction: { parts: GeminiPart[] } | undefined;
  const contents: GeminiContent[] = [];

  const addContentParts = (role: "user" | "model" | "function", newParts: GeminiPart[]) => {
    if (newParts.length === 0) return;
    const lastContent = contents[contents.length - 1];
    if (lastContent && lastContent.role === role) {
      lastContent.parts.push(...newParts);
    } else {
      contents.push({ role, parts: [...newParts] });
    }
  };

  for (const msg of messages) {
    // Skip checkpoint messages
    if (msg.role === "_checkpoint") continue;

    // System messages → systemInstruction
    if (msg.role === "system") {
      const parts: GeminiPart[] = [];
      if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        parts.push(...convertContentParts(msg.content));
      }
      if (parts.length > 0) {
        if (systemInstruction) {
          systemInstruction.parts.push(...parts);
        } else {
          systemInstruction = { parts };
        }
      }
      continue;
    }

    // Tool result messages → function role
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

      let responseData: Record<string, unknown>;
      try {
        responseData = JSON.parse(outputText);
      } catch {
        responseData = { result: outputText };
      }

      let funcName = msg.tool_call_id ?? "";
      if (funcName.startsWith("gemini_fc_")) {
        funcName = funcName.slice("gemini_fc_".length);
        // Strip the `__idx_<n>` suffix appended by gemini-stream-parser.ts
        // for concurrent tool calls. Only the function name should remain.
        funcName = funcName.replace(/__idx_\d+$/, "");
      } else {
        // Find the actual tool name from previous assistant tool calls in history
        const currentIndex = messages.indexOf(msg);
        for (let i = currentIndex - 1; i >= 0; i--) {
          const prevMsg = messages[i];
          if (prevMsg.role === "assistant" && prevMsg.tool_calls) {
            const foundTool = (prevMsg.tool_calls as ToolCall[]).find((tc) => tc.id === msg.tool_call_id);
            if (foundTool) {
              funcName = foundTool.function.name;
              break;
            }
          }
        }
      }

      addContentParts("function", [
        {
          functionResponse: {
            name: funcName,
            response: responseData,
          },
        },
      ]);
      continue;
    }

    // user / assistant messages
    const role: "user" | "model" = msg.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];

    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      parts.push(...convertContentParts(msg.content));
    }

    // Assistant tool calls → functionCall parts
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls as ToolCall[]) {
        parts.push(toolCallToGeminiFunctionCall(tc));
      }
    }

    addContentParts(role, parts);
  }

  return { systemInstruction, contents };
}
