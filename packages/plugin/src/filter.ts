import type { MessageEvent } from "@yachiyo/message/event.js";
import { MessageType } from "@yachiyo/message/types.js";

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

  filter(event: MessageEvent, _cfg: Record<string, unknown>): boolean {
    const msg = event.getMessageStr();
    // 命令后必须是行尾或空白，避免 "help" 前缀误匹配 "helpme xxx"。
    const matches = (cmd: string): boolean => {
      if (!msg.startsWith(cmd)) return false;
      const rest = msg.slice(cmd.length);
      return rest.length === 0 || /^\s/.test(rest);
    };
    return matches(this.commandName) || this.alias.some(matches);
  }
}

export class RegexFilter extends HandlerFilter {
  private pattern: RegExp;

  constructor(pattern: string | RegExp) {
    super();
    this.pattern = typeof pattern === "string" ? new RegExp(pattern) : pattern;
  }

  filter(event: MessageEvent, _cfg: Record<string, unknown>): boolean {
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

  filter(event: MessageEvent, _cfg: Record<string, unknown>): boolean {
    if (this.requiredType === EventMessageType.ALL) return true;
    // 按 MessageType 精确区分：旧的 `!isPrivateChat()` 会把 OTHER_MESSAGE
    // 误判为群聊，而 OTHER_MESSAGE 分支则放行一切。
    if (this.requiredType === EventMessageType.GROUP_MESSAGE) {
      return event.getMessageType() === MessageType.GROUP_MESSAGE;
    }
    if (this.requiredType === EventMessageType.PRIVATE_MESSAGE) {
      return event.getMessageType() === MessageType.FRIEND_MESSAGE;
    }
    // OTHER_MESSAGE：只匹配非群聊、非私聊的消息（如频道/系统事件等）。
    return event.getMessageType() !== MessageType.GROUP_MESSAGE
      && event.getMessageType() !== MessageType.FRIEND_MESSAGE;
  }
}

export class CommandGroupFilter extends HandlerFilter {
  private commands: string[];

  constructor(commands: string[]) {
    super();
    this.commands = commands;
  }

  filter(event: MessageEvent, _cfg: Record<string, unknown>): boolean {
    const msg = event.getMessageStr();
    // Require end-of-line or whitespace after the command, matching
    // CommandFilter. Without this, command "help" also matched "helpme xxx".
    const matches = (cmd: string): boolean => {
      if (!msg.startsWith(cmd)) return false;
      const rest = msg.slice(cmd.length);
      return rest.length === 0 || /^\s/.test(rest);
    };
    return this.commands.some(matches);
  }
}

export class PlatformAdapterTypeFilter extends HandlerFilter {
  private platformName: string;

  constructor(platformName: string) {
    super();
    this.platformName = platformName;
  }

  filter(event: MessageEvent, _cfg: Record<string, unknown>): boolean {
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
