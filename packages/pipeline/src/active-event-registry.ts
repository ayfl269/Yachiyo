import type { MessageEvent } from "@yachiyo/message/event.js";

export class ActiveEventRegistry {
  private events: Map<string, Set<MessageEvent>> = new Map();

  register(event: MessageEvent): void {
    const key = event.unifiedMsgOrigin;
    if (!this.events.has(key)) this.events.set(key, new Set());
    this.events.get(key)!.add(event);
  }

  unregister(event: MessageEvent): void {
    const key = event.unifiedMsgOrigin;
    this.events.get(key)?.delete(event);
  }

  stopAll(umo: string, exclude?: MessageEvent): number {
    let count = 0;
    for (const event of this.events.get(umo) ?? []) {
      if (event !== exclude) {
        event.stopEvent();
        count++;
      }
    }
    return count;
  }

  requestAgentStopAll(umo: string, exclude?: MessageEvent): number {
    let count = 0;
    for (const event of this.events.get(umo) ?? []) {
      if (event !== exclude) {
        event.setExtra("agent_stop_requested", true);
        count++;
      }
    }
    return count;
  }
}

export const activeEventRegistry = new ActiveEventRegistry();
