import { BaseAgentRunHooks } from "@yachiyo/agent/hooks.js";
import type { ContextWrapper } from "@yachiyo/agent/types.js";
import type { LLMResponse } from "@yachiyo/agent/types.js";
import type { MessageChain } from "@yachiyo/agent/types.js";
import type { FunctionTool } from "@yachiyo/agent/tool.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import type { EventType } from "@yachiyo/plugin/event-type.js";
import type { StarHandlerMetadata } from "@yachiyo/plugin/handler.js";
import { callEventHook } from "./handler-utils.js";

export class MainAgentHooks implements BaseAgentRunHooks<MessageEvent> {
  private eventHandlers: StarHandlerMetadata[] = [];

  setEventHandlers(handlers: StarHandlerMetadata[]): void {
    this.eventHandlers = handlers;
  }

  async onAgentBegin(runContext: ContextWrapper<MessageEvent>): Promise<void> {
    const { EventType } = await import("@yachiyo/plugin/event-type.js");
    await callEventHook(runContext.context, EventType.OnAgentBeginEvent, this.eventHandlers);
  }

  async onAgentDone(
    runContext: ContextWrapper<MessageEvent>,
    llmResponse: LLMResponse,
  ): Promise<void> {
    const { EventType } = await import("@yachiyo/plugin/event-type.js");
    if (llmResponse.reasoningContent) {
      runContext.context.setExtra("reasoning_content", llmResponse.reasoningContent);
    }
    await callEventHook(runContext.context, EventType.OnLLMResponseEvent, this.eventHandlers, llmResponse);
    await callEventHook(runContext.context, EventType.OnAgentDoneEvent, this.eventHandlers, llmResponse);
  }

  async onToolStart(
    runContext: ContextWrapper<MessageEvent>,
    tool: FunctionTool,
    toolArgs: Record<string, unknown>,
  ): Promise<void> {
    const { EventType } = await import("@yachiyo/plugin/event-type.js");
    await callEventHook(runContext.context, EventType.OnUsingLLMToolEvent, this.eventHandlers, tool, toolArgs);
  }

  async onToolEnd(
    runContext: ContextWrapper<MessageEvent>,
    tool: FunctionTool,
    toolArgs: Record<string, unknown>,
    toolResult: any,
  ): Promise<void> {
    const { EventType } = await import("@yachiyo/plugin/event-type.js");
    runContext.context.clearResult();
    await callEventHook(runContext.context, EventType.OnLLMToolRespondEvent, this.eventHandlers, tool, toolArgs, toolResult);
  }
}

export const MAIN_AGENT_HOOKS = new MainAgentHooks();
