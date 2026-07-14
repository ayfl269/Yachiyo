import { MessageType, type PlatformMetadata } from "./types.js";
import { ComponentType, type MessageComponent } from "./components.js";
import { PlatformMessage } from "./platform-message.js";
import { MessageSession } from "./message-session.js";
import { EventResult } from "./event-result.js";
import { unlinkSync } from "fs";
import type { MessageChain, ProviderRequest, Conversation } from "@yachiyo/common/llm-types.js";
import type { ToolSet } from "@yachiyo/agent/tool.js";
import type { FunctionToolManager } from "@yachiyo/agent/func-tool-manager.js";
import type { Message } from "@yachiyo/common/llm-message.js";

export const SINGLE_USER_UMO = "single:user:session";

export abstract class MessageEvent {
  messageStr: string;
  messageObj: PlatformMessage;
  platformMeta: PlatformMetadata;
  session: MessageSession;
  isWake: boolean = false;
  isAtOrWakeCommand: boolean = false;
  /** System-generated events (e.g. proactive reminders) bypass wake
   *  checks and rate limits so the pipeline always processes them. */
  isSystem: boolean = false;
  createdAt: number;

  private extras: Map<string, unknown> = new Map();
  private forceStopped: boolean = false;
  private result: EventResult | null = null;
  skipLlm: boolean = false;
  private temporaryLocalFiles: string[] = [];

  constructor(
    messageStr: string,
    messageObj: PlatformMessage,
    platformMeta: PlatformMetadata,
    sessionId: string,
  ) {
    this.messageStr = messageStr;
    this.messageObj = messageObj;
    this.platformMeta = platformMeta;
    this.session = new MessageSession();
    this.session.platformId = platformMeta.id;
    this.session.messageType = messageObj.type;
    this.session.sessionId = sessionId;
    this.createdAt = Date.now();
  }

  get unifiedMsgOrigin(): string {
    return SINGLE_USER_UMO;
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  getPlatformName(): string { return this.platformMeta.name; }
  getPlatformId(): string { return this.platformMeta.id; }
  getMessageStr(): string { return this.messageStr; }
  getMessageType(): MessageType { return this.messageObj.type; }
  getGroupId(): string { return this.messageObj.groupId; }
  getSelfId(): string { return this.messageObj.selfId; }
  getSenderId(): string { return this.messageObj.sender.userId; }
  getSenderName(): string { return this.messageObj.sender.nickname ?? ""; }
  isPrivateChat(): boolean { return this.messageObj.type === MessageType.FRIEND_MESSAGE; }
  isWakeUp(): boolean { return this.isWake; }

  setResult(result: EventResult | string): void {
    if (typeof result === "string") {
      this.result = new EventResult().plain(result);
    } else {
      this.result = result;
    }
  }

  getResult(): EventResult | null { return this.result; }
  clearResult(): void { this.result = null; }

  stopEvent(): void { this.forceStopped = true; }
  continueEvent(): void { this.forceStopped = false; }
  isStopped(): boolean {
    return this.forceStopped || (this.result?.isStopped() ?? false);
  }

  setSkipLlm(skip: boolean): void { this.skipLlm = skip; }

  plainResult(text: string): EventResult {
    return new EventResult().plain(text);
  }

  setExtra(key: string, value: unknown): void { this.extras.set(key, value); }
  getExtra<T = unknown>(key: string, defaultValue?: T): T | undefined {
    return (this.extras.get(key) as T) ?? defaultValue;
  }
  clearExtra(): void { this.extras.clear(); }

  trackTemporaryLocalFile(path: string): void { this.temporaryLocalFiles.push(path); }
  cleanupTemporaryLocalFiles(): void {
    for (const filePath of this.temporaryLocalFiles) {
      try {
        unlinkSync(filePath);
      } catch { /* ignore */ }
    }
    this.temporaryLocalFiles = [];
  }

  abstract send(components: MessageComponent[]): Promise<void>;
  abstract sendStreaming(
    generator: AsyncGenerator<MessageChain, void>,
    useFallback?: boolean,
  ): Promise<void>;

  async sendTyping(): Promise<void> {}
  async stopTyping(): Promise<void> {}
  async react(emoji: string): Promise<void> {
    await this.send([{ type: ComponentType.Plain, text: emoji, toDict() { return { type: "text", data: { text: emoji } }; } } as MessageComponent]);
  }

  requestLlm(prompt: string, options?: {
    funcToolManager?: FunctionToolManager;
    toolSet?: ToolSet;
    sessionId?: string;
    imageUrls?: string[];
    audioUrls?: string[];
    contexts?: Message[];
    systemPrompt?: string;
    conversation?: Conversation;
  }): ProviderRequest {
    return {
      prompt,
      imageUrls: options?.imageUrls ?? [],
      audioUrls: options?.audioUrls ?? [],
      contexts: options?.contexts ?? [],
      systemPrompt: options?.systemPrompt,
      funcTool: options?.toolSet,
      sessionId: options?.sessionId,
      conversation: options?.conversation,
      extraUserContentParts: [],
    };
  }
}
