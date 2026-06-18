import { MessageType } from "./types.js";

export class MessageSession {
  platformId!: string;
  messageType!: MessageType;
  sessionId!: string;

  toString(): string {
    return `${this.platformId}:${this.messageType}:${this.sessionId}`;
  }

  static fromStr(s: string): MessageSession {
    const parts = s.split(":");
    const session = new MessageSession();
    session.platformId = parts[0] ?? "";
    session.messageType = (parts[1] ?? "") as MessageType;
    session.sessionId = parts[2] ?? "";
    return session;
  }
}
