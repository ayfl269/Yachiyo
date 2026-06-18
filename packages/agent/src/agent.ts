import type { BaseAgentRunHooks } from "./hooks.js";
import type { FunctionTool } from "./tool.js";

export interface Agent<TContext = unknown> {
  name: string;
  instructions?: string;
  tools?: (string | FunctionTool<TContext>)[];
  runHooks?: BaseAgentRunHooks<TContext>;
  beginDialogs?: unknown[];
  dynamic?: boolean;
  sandboxPolicy?: Record<string, unknown>;
}

export function createAgent<TContext = unknown>(
  options: {
    name: string;
    instructions?: string;
    tools?: (string | FunctionTool<TContext>)[];
    runHooks?: BaseAgentRunHooks<TContext>;
    beginDialogs?: unknown[];
  }
): Agent<TContext> {
  return {
    name: options.name,
    instructions: options.instructions,
    tools: options.tools,
    runHooks: options.runHooks,
    beginDialogs: options.beginDialogs,
  };
}
