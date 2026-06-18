import type { EventType } from "./event-type.js";
import type { StarHandlerMetadata } from "./handler.js";

export class StarHandlerRegistry {
  private handlers: StarHandlerMetadata[] = [];

  getHandlersByEventType(
    eventType: EventType,
    onlyActivated?: boolean,
    pluginsName?: string[],
  ): StarHandlerMetadata[] {
    return this.handlers.filter(h => {
      if (h.eventType !== eventType) return false;
      if (onlyActivated && !h.enabled) return false;
      if (pluginsName && pluginsName.length > 0 && !pluginsName.includes(h.handlerModulePath)) return false;
      return true;
    });
  }

  getHandlerByFullName(fullName: string): StarHandlerMetadata | null {
    return this.handlers.find(h => h.handlerFullName === fullName) ?? null;
  }

  getHandlersByModuleName(moduleName: string): StarHandlerMetadata[] {
    return this.handlers.filter(h => h.handlerModulePath === moduleName);
  }

  append(handler: StarHandlerMetadata): void {
    this.handlers.push(handler);
  }
}
