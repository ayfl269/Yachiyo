import type { MessageEvent } from "@yachiyo/message/event.js";

export abstract class HandlerFilter {
  abstract filter(event: MessageEvent, cfg: Record<string, unknown>): boolean;
}

export class CommandFilter extends HandlerFilter {
  private commandName: string;
  private alias: string[];

  constructor(commandName: string, alias: string[] = []) {
    super();
    this.commandName = commandName;
    this.alias = alias;
  }

  filter(event: MessageEvent, cfg: Record<string, unknown>): boolean {
    const msg = event.getMessageStr();
    return msg.startsWith(this.commandName) || this.alias.some(a => msg.startsWith(a));
  }
}

export class RegexFilter extends HandlerFilter {
  private pattern: RegExp;

  constructor(pattern: string | RegExp) {
    super();
    this.pattern = typeof pattern === "string" ? new RegExp(pattern) : pattern;
  }

  filter(event: MessageEvent, cfg: Record<string, unknown>): boolean {
    return this.pattern.test(event.getMessageStr());
  }
}

export enum EventMessageType { GROUP_MESSAGE, PRIVATE_MESSAGE, OTHER_MESSAGE, ALL }

export class EventMessageTypeFilter extends HandlerFilter {
  private requiredType: EventMessageType;

  constructor(requiredType: EventMessageType) {
    super();
    this.requiredType = requiredType;
  }

  filter(event: MessageEvent, cfg: Record<string, unknown>): boolean {
    if (this.requiredType === EventMessageType.ALL) return true;
    if (this.requiredType === EventMessageType.GROUP_MESSAGE) return !event.isPrivateChat();
    if (this.requiredType === EventMessageType.PRIVATE_MESSAGE) return event.isPrivateChat();
    return true;
  }
}

export class CommandGroupFilter extends HandlerFilter {
  private commands: string[];

  constructor(commands: string[]) {
    super();
    this.commands = commands;
  }

  filter(event: MessageEvent, cfg: Record<string, unknown>): boolean {
    const msg = event.getMessageStr();
    return this.commands.some(cmd => msg.startsWith(cmd));
  }
}

export class PlatformAdapterTypeFilter extends HandlerFilter {
  private platformName: string;

  constructor(platformName: string) {
    super();
    this.platformName = platformName;
  }

  filter(event: MessageEvent, cfg: Record<string, unknown>): boolean {
    return event.getPlatformName() === this.platformName;
  }
}

export class CustomFilter extends HandlerFilter {
  private fn: (event: MessageEvent, cfg: Record<string, unknown>) => boolean;

  constructor(fn: (event: MessageEvent, cfg: Record<string, unknown>) => boolean) {
    super();
    this.fn = fn;
  }

  filter(event: MessageEvent, cfg: Record<string, unknown>): boolean {
    return this.fn(event, cfg);
  }
}

export class CustomFilterOr extends HandlerFilter {
  private filters: HandlerFilter[];

  constructor(filters: HandlerFilter[]) {
    super();
    this.filters = filters;
  }

  filter(event: MessageEvent, cfg: Record<string, unknown>): boolean {
    return this.filters.some(f => f.filter(event, cfg));
  }
}

export class CustomFilterAnd extends HandlerFilter {
  private filters: HandlerFilter[];

  constructor(filters: HandlerFilter[]) {
    super();
    this.filters = filters;
  }

  filter(event: MessageEvent, cfg: Record<string, unknown>): boolean {
    return this.filters.every(f => f.filter(event, cfg));
  }
}
