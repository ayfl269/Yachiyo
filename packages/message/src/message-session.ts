import { MessageType } from "./types.js";

export class MessageSession {
  platformId!: string;
  messageType!: MessageType;
  sessionId!: string;

  toString(): string {
    return `${this.platformId}:${this.messageType}:${this.sessionId}`;
  }

  static fromStr(s: string): MessageSession {
    // Format: `${platformId}:${messageType}:${sessionId}`. The session id may
    // itself contain colons (e.g. a UMO-style `onebot11:group:123`), so only
    // the first two separators are structural — the remainder is the session
    // id. The previous `parts[2]` truncated such ids to their first segment.
    const first = s.indexOf(":");
    const second = first === -1 ? -1 : s.indexOf(":", first + 1);
    const session = new MessageSession();
    if (second === -1) {
      // Malformed / legacy single-field string: keep it whole as the session id.
      session.platformId = s;
      session.messageType = "" as MessageType;
      session.sessionId = "";
      return session;
    }
    session.platformId = s.slice(0, first);
    session.messageType = s.slice(first + 1, second) as MessageType;
    session.sessionId = s.slice(second + 1);
    return session;
  }
}
