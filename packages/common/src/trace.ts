import { generateId } from "./id-generator.js";

let traceEnabled: boolean = false;

export function setTraceEnabled(enabled: boolean): void {
  traceEnabled = enabled;
}

export function isTraceEnabled(): boolean {
  return traceEnabled;
}

export class TraceSpan {
  spanId: string;
  name: string;
  umo: string | null;
  senderName: string | null;
  messageOutline: string | null;
  startedAt: number;

  constructor(name: string, umo?: string, senderName?: string, messageOutline?: string) {
    this.spanId = generateId();
    this.name = name;
    this.umo = umo ?? null;
    this.senderName = senderName ?? null;
    this.messageOutline = messageOutline ?? null;
    this.startedAt = Date.now();
  }

  record(action: string, fields?: Record<string, unknown>): void {
    if (!traceEnabled) return;
    console.debug(`[Trace:${this.spanId}] ${action}`, {
      span: this.name,
      umo: this.umo,
      sender: this.senderName,
      outline: this.messageOutline,
      ...fields,
      elapsed: Date.now() - this.startedAt,
    });
  }
}
