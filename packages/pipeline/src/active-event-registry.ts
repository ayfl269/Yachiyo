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
    const set = this.events.get(key);
    if (!set) return;
    set.delete(event);
    // Purge empty sets to prevent the Map from accumulating an entry for
    // every unifiedMsgOrigin ever seen (unbounded growth over long runs).
    if (set.size === 0) {
      this.events.delete(key);
    }
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
