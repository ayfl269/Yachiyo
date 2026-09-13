import type { MessageEvent } from "@yachiyo/message/event.js";
import type { StarHandlerMetadata } from "@yachiyo/plugin/handler.js";
import type { EventType } from "@yachiyo/plugin/event-type.js";
import { EventResult } from "@yachiyo/message/event-result.js";

function isAsyncGenerator(obj: unknown): obj is AsyncGenerator<unknown, unknown> {
  return obj != null &&
    typeof obj === "object" &&
    Symbol.asyncIterator in obj &&
    typeof obj[Symbol.asyncIterator] === "function" &&
    "next" in obj &&
    typeof (obj as AsyncGenerator<unknown, unknown>).next === "function";
}

export async function* callHandler(
  event: MessageEvent,
  handler: StarHandlerMetadata,
  ...args: unknown[]
): AsyncGenerator<unknown> {
  try {
    const result = handler.handler(event, ...args);
    if (isAsyncGenerator(result)) {
      let yielded = false;
      for await (const val of result) {
        yielded = true;
        if (val instanceof EventResult) {
          event.setResult(val);
        }
        yield val;
      }
      if (!yielded) yield undefined;
    } else {
      const val = await result;
      if (val instanceof EventResult) {
        event.setResult(val);
      }
      yield val;
    }
  } catch (e) {
    if (e instanceof TypeError) {
      console.error(`Handler ${handler.handlerFullName} TypeError: ${e}`);
    }
    // Attach the handler name to the error so log entries and the pipeline
    // top-level catch identify the failing handler instead of an anonymous
    // "undefined is not a function" style message (#96). The original error
    // is preserved as `cause`.
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`Handler ${handler.handlerFullName} failed: ${detail}`, { cause: e });
  }
}

export async function callEventHook(
  event: MessageEvent,
  hookType: EventType,
  handlers: StarHandlerMetadata[],
  ...args: unknown[]
): Promise<boolean> {
  for (const handler of handlers) {
    for await (const _ of callHandler(event, handler, ...args)) {
      if (event.isStopped()) return true;
    }
  }
  return false;
}
