import type { Agent } from "./agent.js";
import { createFunctionTool } from "./tool.js";

export interface HandoffTool<TContext = unknown> extends ReturnType<typeof createHandoffTool<TContext>> {}

/**
 * Create a HandoffTool for delegating tasks to another agent.
 */
export function createHandoffTool<TContext = unknown>(
  agent: Agent<TContext>,
  toolDescription?: string
) {
  const description = toolDescription ?? defaultHandoffDescription(agent.name);
  const tool = createFunctionTool<TContext>({
    name: `transfer_to_${agent.name}`,
    parameters: defaultHandoffParameters(),
    description,
    active: true,
    isBackgroundTask: false,
  });

  // Attach agent-specific properties
  return Object.assign(tool, {
    agent,
    providerId: undefined as string | undefined,
  });
}

function defaultHandoffParameters(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "The input to be handed off to another agent. This should be a clear and concise request or task.",
      },
      image_urls: {
        type: "array",
        items: { type: "string" },
        description: "Optional: An array of image sources (public HTTP URLs or local file paths) used as references in multimodal tasks.",
      },
      background_task: {
        type: "boolean",
        description:
          "Defaults to false. Set to true if the task may take noticeable time, involves external tools, or the user does not need to wait.",
      },
    },
  };
}

function defaultHandoffDescription(agentName?: string): string {
  return `Delegate tasks to ${agentName ?? "another"} agent to handle the request.`;
}
