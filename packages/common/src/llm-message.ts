// ContentPart types
export type ContentPartType = "text" | "think" | "image_url" | "audio_url";

// Base interface for all content parts
export interface ContentPartBase {
  type: ContentPartType;
  _noSave?: boolean;
}

// Text content part
export interface TextPart extends ContentPartBase {
  type: "text";
  text: string;
}

// Thinking/reasoning content part
export interface ThinkPart extends ContentPartBase {
  type: "think";
  think: string;
  encrypted?: string;
}

/**
 * Merge another ThinkPart's content into the target (for streaming concatenation).
 * Returns true if merge was successful, false otherwise.
 */
export function mergeThinkPartInPlace(
  target: ThinkPart,
  other: ThinkPart
): boolean {
  if (target.encrypted) return false;
  target.think += other.think;
  if (other.encrypted) {
    target.encrypted = other.encrypted;
  }
  return true;
}

// Image URL content part
export interface ImageURLPart extends ContentPartBase {
  type: "image_url";
  image_url: {
    url: string;
    id?: string;
  };
}

// Audio URL content part
export interface AudioURLPart extends ContentPartBase {
  type: "audio_url";
  audio_url: {
    url: string;
    id?: string;
  };
}

// Union type for all content parts
export type ContentPart = TextPart | ThinkPart | ImageURLPart | AudioURLPart;

/**
 * Mark a ContentPart as temporary (not persisted to history).
 */
export function markContentPartAsTemp<T extends ContentPart>(part: T): T {
  part._noSave = true;
  return part;
}

// ContentPart registry for polymorphic deserialization
const contentPartRegistry = new Map<string, (data: Record<string, unknown>) => ContentPart>();

function registerContentPart(
  type: string,
  factory: (data: Record<string, unknown>) => ContentPart
): void {
  contentPartRegistry.set(type, factory);
}

// Register built-in content part types
registerContentPart("text", (data) => ({
  type: "text",
  text: String(data.text ?? ""),
  _noSave: data._noSave ? true : undefined,
}));

registerContentPart("think", (data) => ({
  type: "think",
  think: String(data.think ?? ""),
  encrypted: data.encrypted != null ? String(data.encrypted) : undefined,
  _noSave: data._noSave ? true : undefined,
}));

registerContentPart("image_url", (data) => {
  const imageUrl = data.image_url as Record<string, unknown> | undefined;
  return {
    type: "image_url",
    image_url: {
      url: String(imageUrl?.url ?? ""),
      id: imageUrl?.id != null ? String(imageUrl.id) : undefined,
    },
    _noSave: data._noSave ? true : undefined,
  };
});

registerContentPart("audio_url", (data) => {
  const audioUrl = data.audio_url as Record<string, unknown> | undefined;
  return {
    type: "audio_url",
    audio_url: {
      url: String(audioUrl?.url ?? ""),
      id: audioUrl?.id != null ? String(audioUrl.id) : undefined,
    },
    _noSave: data._noSave ? true : undefined,
  };
});

/**
 * Deserialize a ContentPart from a plain object.
 * Uses the registry to dispatch to the correct factory based on the `type` field.
 */
export function deserializeContentPart(data: Record<string, unknown>): ContentPart {
  const typeValue = data.type as string | undefined;
  if (!typeValue || !contentPartRegistry.has(typeValue)) {
    throw new Error(`Cannot validate ${JSON.stringify(data)} as ContentPart`);
  }
  return contentPartRegistry.get(typeValue)!(data);
}

/**
 * Serialize a ContentPart to a plain object.
 */
export function serializeContentPart(part: ContentPart): Record<string, unknown> {
  const result: Record<string, unknown> = { type: part.type };

  switch (part.type) {
    case "text":
      result.text = part.text;
      break;
    case "think":
      result.think = part.think;
      if (part.encrypted != null) result.encrypted = part.encrypted;
      break;
    case "image_url":
      result.image_url = { url: part.image_url.url };
      if (part.image_url.id != null) result.image_url = { url: part.image_url.url, id: part.image_url.id };
      break;
    case "audio_url":
      result.audio_url = { url: part.audio_url.url };
      if (part.audio_url.id != null) result.audio_url = { url: part.audio_url.url, id: part.audio_url.id };
      break;
  }

  if (part._noSave) result._noSave = true;
  return result;
}

// ToolCall model
export interface ToolCallFunction {
  name: string;
  arguments?: string;
}

export interface ToolCall {
  type: "function";
  id: string;
  function: ToolCallFunction;
  extraContent?: Record<string, unknown>;
}

// ToolCallPart - partial streaming tool call arguments
export interface ToolCallPart {
  arguments_part?: string;
}

export function serializeToolCall(tc: ToolCall): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: tc.type,
    id: tc.id,
    function: { name: tc.function.name, arguments: tc.function.arguments },
  };
  if (tc.extraContent != null) result.extra_content = tc.extraContent;
  return result;
}

// Checkpoint data
export interface CheckpointData {
  id: string;
}

// Message role types
export type MessageRole = "system" | "user" | "assistant" | "tool" | "_checkpoint";

// Message interface
export interface Message {
  role: MessageRole;
  content?: string | ContentPart[] | CheckpointData;
  tool_calls?: ToolCall[] | Record<string, unknown>[];
  tool_call_id?: string;
  /** Not persisted to history */
  _noSave?: boolean;
  /** Links to platform message history */
  _checkpointAfter?: CheckpointData;
}

// Message segment types (convenience constructors)
export interface AssistantMessageSegment extends Message {
  role: "assistant";
}

export interface ToolCallMessageSegment extends Message {
  role: "tool";
  tool_call_id: string;
}

export interface UserMessageSegment extends Message {
  role: "user";
}

export interface SystemMessageSegment extends Message {
  role: "system";
}

export interface CheckpointMessageSegment extends Message {
  role: "_checkpoint";
  content?: CheckpointData;
}

/**
 * Validate a Message object.
 * - role="_checkpoint" → content must be CheckpointData
 * - role="assistant" with tool_calls → content can be undefined
 * - All other cases → content is required
 */
export function validateMessage(data: Record<string, unknown>): Message {
  const role = data.role as MessageRole;
  const content = data.content;
  const toolCalls = data.tool_calls;

  if (role === "_checkpoint") {
    if (typeof content === "object" && content !== null && !Array.isArray(content) && "id" in (content as Record<string, unknown>)) {
      return {
        role,
        content: content as CheckpointData,
        _noSave: data._noSave ? true : undefined,
      };
    }
    throw new Error("checkpoint message content must be CheckpointData");
  }

  if (content !== undefined && content !== null && typeof content === "object" && !Array.isArray(content) && "id" in (content as Record<string, unknown>)) {
    throw new Error("CheckpointData is only allowed for role='_checkpoint'");
  }

  // assistant + tool_calls: allow content to be undefined
  if (role === "assistant" && toolCalls != null) {
    // valid even without content
  } else if (content === undefined || content === null) {
    throw new Error("content is required unless role='assistant' and tool_calls is not undefined");
  }

  const message: Message = { role };

  if (typeof content === "string") {
    message.content = content;
  } else if (Array.isArray(content)) {
    message.content = (content as Record<string, unknown>[]).map(
      (part) => deserializeContentPart(part)
    );
  } else if (content !== undefined && content !== null) {
    message.content = content as CheckpointData;
  }

  if (toolCalls != null) {
    message.tool_calls = toolCalls as ToolCall[] | Record<string, unknown>[];
  }
  if (data.tool_call_id != null) {
    message.tool_call_id = String(data.tool_call_id);
  }
  if (data._noSave) {
    message._noSave = true;
  }

  return message;
}

/**
 * Serialize a Message to a plain object.
 */
export function serializeMessage(message: Message): Record<string, unknown> {
  const data: Record<string, unknown> = { role: message.role };

  if (message.content !== undefined) {
    if (typeof message.content === "string") {
      data.content = message.content;
    } else if (Array.isArray(message.content)) {
      data.content = message.content
        .filter((part) => !part._noSave)
        .map((part) => serializeContentPart(part));
    } else {
      // CheckpointData
      data.content = message.content;
    }
  }

  if (message.tool_calls != null) {
    data.tool_calls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((tc) =>
          "type" in tc ? serializeToolCall(tc as ToolCall) : tc
        )
      : message.tool_calls;
  }

  if (message.tool_call_id != null) {
    data.tool_call_id = message.tool_call_id;
  }

  return data;
}

// Checkpoint message utilities

export function isCheckpointMessage(
  message: Message | Record<string, unknown>
): boolean {
  if ("role" in message) {
    return message.role === "_checkpoint";
  }
  return false;
}

export function getCheckpointId(
  message: Message | Record<string, unknown>
): string | null {
  if (!isCheckpointMessage(message)) return null;

  const content = "content" in message ? message.content : undefined;
  if (typeof content === "object" && content !== null && "id" in (content as Record<string, unknown>)) {
    const id = (content as CheckpointData).id;
    return typeof id === "string" && id ? id : null;
  }
  return null;
}

function getCheckpointData(
  message: Message | Record<string, unknown>
): CheckpointData | null {
  if (!isCheckpointMessage(message)) return null;

  const content = "content" in message ? message.content : undefined;
  if (typeof content === "object" && content !== null && !Array.isArray(content) && "id" in (content as Record<string, unknown>)) {
    return content as CheckpointData;
  }
  return null;
}

/**
 * Strip checkpoint messages before sending to LLM.
 */
export function stripCheckpointMessages(
  history: Record<string, unknown>[]
): Record<string, unknown>[] {
  return history.filter((message) => !isCheckpointMessage(message));
}

/**
 * Load persisted history and bind checkpoint segments to prior messages.
 */
export function bindCheckpointMessages(
  history: Record<string, unknown>[]
): Message[] {
  const messages: Message[] = [];
  for (const item of history) {
    if (isCheckpointMessage(item)) {
      const checkpoint = getCheckpointData(item);
      if (checkpoint && messages.length > 0) {
        messages[messages.length - 1]._checkpointAfter = checkpoint;
      }
      continue;
    }
    const message = validateMessage(item);
    if (item._noSave) message._noSave = true;
    messages.push(message);
  }
  return messages;
}

/**
 * Dump runtime messages and reinsert bound checkpoint segments for persistence.
 */
export function dumpMessagesWithCheckpoints(
  messages: Message[]
): Record<string, unknown>[] {
  const dumped: Record<string, unknown>[] = [];
  for (const message of messages) {
    const data = serializeMessage(message);
    // Filter out _noSave content parts
    if (Array.isArray(message.content)) {
      data.content = message.content
        .filter((part) => !part._noSave)
        .map((part) => serializeContentPart(part));
    }
    dumped.push(data);
    if (message._checkpointAfter) {
      dumped.push({ role: "_checkpoint", content: message._checkpointAfter });
    }
  }
  return dumped;
}

export function isTextPart(part: ContentPart): part is TextPart {
  return part.type === "text";
}

export function isThinkPart(part: ContentPart): part is ThinkPart {
  return part.type === "think";
}

export function isImageURLPart(part: ContentPart): part is ImageURLPart {
  return part.type === "image_url";
}

export function isAudioURLPart(part: ContentPart): part is AudioURLPart {
  return part.type === "audio_url";
}

