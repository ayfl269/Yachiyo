import type { ContentPart, Message, ToolCall } from "@yachiyo/common/llm-message.js";

// ─── OpenAI Responses API types ───

export interface ResponsesInputText {
  type: "input_text";
  text: string;
}

export interface ResponsesInputImage {
  type: "input_image";
  image_url: string;
}

export type ResponsesContentPart = ResponsesInputText | ResponsesInputImage;

export interface ResponsesFunctionCall {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export interface ResponsesMessage {
  role: "user" | "assistant";
  content?: string | ResponsesContentPart[];
}

export type ResponsesInputItem =
  | ResponsesMessage
  | ResponsesFunctionCall
  | ResponsesFunctionCallOutput;

export interface ResponsesConversionResult {
  instructions: string;
  input: ResponsesInputItem[];
}

// ─── Helpers ───

export function contentPartToResponsesContent(part: ContentPart): ResponsesContentPart | null {
  if (part._noSave) return null;

  switch (part.type) {
    case "text":
      return { type: "input_text", text: part.text };
    case "think":
      return { type: "input_text", text: `[Thinking] ${part.think}` };
    case "image_url":
      return { type: "input_image", image_url: part.image_url.url };
    case "audio_url":
      // Responses API doesn't have a native audio content part; fall back to text
      return { type: "input_text", text: part.audio_url.url };
  }
}

function toolCallToResponsesFunctionCall(tc: ToolCall): ResponsesFunctionCall {
  return {
    type: "function_call",
    id: tc.id,
    call_id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments ?? "{}",
  };
}

export function extractFunctionCalls(
  toolCalls: ToolCall[] | Record<string, unknown>[]
): ResponsesFunctionCall[] {
  return (toolCalls as ToolCall[]).map(toolCallToResponsesFunctionCall);
}

function convertContent(
  content: Message["content"]
): string | ResponsesContentPart[] | undefined {
  if (content === undefined) return undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map(contentPartToResponsesContent)
    .filter((p): p is ResponsesContentPart => p !== null);
  return parts.length > 0 ? parts : undefined;
}

// ─── Main converter ───

export function messageToResponsesInput(messages: Message[]): ResponsesConversionResult {
  let instructions = "";
  const input: ResponsesInputItem[] = [];

  for (const msg of messages) {
    // Skip checkpoint messages
    if (msg.role === "_checkpoint") continue;

    // System messages → instructions
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
      if (instructions) instructions += "\n";
      instructions += text;
      continue;
    }

    // Tool result messages → function_call_output
    if (msg.role === "tool") {
      const output =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p) => !p._noSave && p.type === "text")
                .map((p) => (p as { text: string }).text)
                .join("\n")
            : "";
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id ?? "",
        output,
      });
      continue;
    }

    // user / assistant messages
    const item: ResponsesMessage = {
      role: msg.role as "user" | "assistant",
      content: convertContent(msg.content),
    };
    input.push(item);

    // Assistant tool calls → function_call items
    if (msg.role === "assistant" && msg.tool_calls) {
      const calls = extractFunctionCalls(msg.tool_calls);
      input.push(...calls);
    }
  }

  return { instructions, input };
}
