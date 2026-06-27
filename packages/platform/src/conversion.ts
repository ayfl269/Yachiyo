import { ComponentType, type PlainComponent, type AtComponent } from "@yachiyo/message/components.js";
import { PlatformMessage } from "@yachiyo/message/platform-message.js";

export abstract class MessageConverter<TPlatformMessage> {
  abstract convert(raw: TPlatformMessage, selfId: string): PlatformMessage;

  extractMessageStr(msg: PlatformMessage): string {
    const parts: string[] = [];
    for (const comp of msg.components) {
      switch (comp.type) {
        case ComponentType.Plain:
          parts.push((comp as PlainComponent).text);
          break;
        case ComponentType.At:
          parts.push(`@${(comp as AtComponent).qq}`);
          break;
        case ComponentType.AtAll:
          parts.push("@全体");
          break;
        default:
          break;
      }
    }
    return parts.join(" ").trim();
  }
}
