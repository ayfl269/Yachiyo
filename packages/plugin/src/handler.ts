import type { EventType } from "./event-type.js";
import type { HandlerFilter } from "./filter.js";
import type { MessageEvent } from "@yachiyo/message/event.js";

export interface StarHandlerMetadata {
  eventType: EventType;
  handlerFullName: string;
  handlerName: string;
  handlerModulePath: string;
  handler: (event: MessageEvent, ...args: unknown[]) => unknown;
  eventFilters: HandlerFilter[];
  desc: string;
  extrasConfigs: Record<string, unknown>;
  enabled: boolean;
}
