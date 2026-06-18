import { MessageType, MessageMember, Group } from "./types.js";
import { MessageComponent } from "./components.js";

export class PlatformMessage {
  type!: MessageType;
  selfId!: string;
  sessionId!: string;
  messageId!: string;
  group: Group | null = null;
  sender!: MessageMember;
  components: MessageComponent[] = [];
  messageStr: string = "";
  rawMessage: unknown = null;
  timestamp!: number;

  get groupId(): string {
    return this.group?.groupId ?? "";
  }
}
