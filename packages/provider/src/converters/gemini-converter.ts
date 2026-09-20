import type { ContentPart, Message, ToolCall } from "@yachiyo/common/llm-message.js";

// ─── Gemini API types ───

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  /**
   * Opaque signature attached to a thought/functionCall part. Gemini thinking
   * models require it to be echoed back verbatim when the turn is replayed
   * (notably in function-calling loops), otherwise the API rejects the request.
   */
  thoughtSignature?: string;
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
    case "think": {
      // Gemini represents thinking as a part flagged `thought: true`. Sending
      // it back as `[Thinking] ...` plain text (the old behaviour) pollutes the
      // model's context with a marker string. A native thought part is only
      // valid when accompanied by its opaque `thoughtSignature` (required for
      // function-calling replay); without one Gemini rejects/ignores it, and
      // the thought summary does not need to be replayed on ordinary turns.
      // Redacted/opaque blocks have no Gemini equivalent — drop them too.
      if (part.redacted || !part.encrypted) return null;
      return { text: part.think, thought: true, thoughtSignature: part.encrypted };
    }
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
  const signature = tc.extraContent?.thoughtSignature;
  return {
    functionCall: {
      name: tc.function.name,
      args,
    },
    ...(typeof signature === "string" ? { thoughtSignature: signature } : {}),
  };
}

function convertContentParts(content: ContentPart[]): GeminiPart[] {
  const mapped = content.map(contentPartToGemini).filter((p): p is GeminiPart => p !== null);
  // Some upstreams reject a standalone empty-text thought part replayed with
  // its signature ("Unsupported input part type: go/debug*"). The documented
  // replay shape carries the signature on a real content part, so fold a
  // signature-only thought part into the next part. A trailing one has
  // nothing to ride on and is dropped along with its signature.
  const parts: GeminiPart[] = [];
  let pendingSignature: string | undefined;
  for (const part of mapped) {
    if (part.thought && !part.text) {
      pendingSignature = part.thoughtSignature ?? pendingSignature;
      continue;
    }
    parts.push(
      pendingSignature && !part.thoughtSignature ? { ...part, thoughtSignature: pendingSignature } : part
    );
    pendingSignature = undefined;
  }
  return parts;
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
        // Strip the `__idx_<n>` suffix appended by gemini-provider.ts /
        // gemini-stream-parser.ts for concurrent tool calls. Only the function
        // name should remain.
        funcName = funcName.replace(/__idx_\d+$/, "");
      } else {
        // Find the actual tool name by searching backwards through messages
        // using tool_call_id matching (not reference equality), so this works
        // even when the messages array has been rebuilt (e.g. context compression,
        // fallback switching, history loading).
        const targetId = msg.tool_call_id;
        for (let i = messages.length - 1; i >= 0; i--) {
          const prevMsg = messages[i];
          if (prevMsg === msg) continue;
          if (prevMsg.role === "assistant" && prevMsg.tool_calls) {
            const foundTool = (prevMsg.tool_calls as ToolCall[]).find((tc) => tc.id === targetId);
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
