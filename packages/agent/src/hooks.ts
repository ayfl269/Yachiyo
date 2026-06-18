import type { ContextWrapper, LLMResponse, CallToolResult } from "./types.js";
import type { FunctionTool } from "./tool.js";

export interface BaseAgentRunHooks<TContext = unknown> {
  onAgentBegin(runContext: ContextWrapper<TContext>): Promise<void>;
  onToolStart(
    runContext: ContextWrapper<TContext>,
    tool: FunctionTool,
    toolArgs: Record<string, unknown> | null
  ): Promise<void>;
  onToolEnd(
    runContext: ContextWrapper<TContext>,
    tool: FunctionTool,
    toolArgs: Record<string, unknown> | null,
    toolResult: CallToolResult | null
  ): Promise<void>;
  onAgentDone(
    runContext: ContextWrapper<TContext>,
    llmResponse: LLMResponse
  ): Promise<void>;
}

export class EmptyAgentHooks<TContext = unknown> implements BaseAgentRunHooks<TContext> {
  async onAgentBegin(): Promise<void> {}
  async onToolStart(): Promise<void> {}
  async onToolEnd(): Promise<void> {}
  async onAgentDone(): Promise<void> {}
}
