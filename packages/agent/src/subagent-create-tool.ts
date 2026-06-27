/**
 * Dynamic sub-agent creation tool.
 * Allows the LLM to create new sub-agents at runtime and delegate tasks to them.
 */

import { createFunctionTool, type FunctionTool } from "./tool.js";
import { createAgent, type Agent } from "./agent.js";
import { createHandoffTool, type HandoffTool } from "./handoff.js";
import type { ContextWrapper, CallToolResult } from "./types.js";

// ── Context type ──

export interface SubAgentCreateToolContext {
  event?: {
    unifiedMsgOrigin?: string;
  };
}

// ── Registry for dynamically created sub-agents ──

/**
 * Registry that tracks dynamically created sub-agents and their handoff tools.
 * Shared across the agent system so that newly created sub-agents can be
 * discovered by the tool executor and tool manager.
 */
export class DynamicSubAgentRegistry {
  private agents: Map<string, { agent: Agent; handoff: HandoffTool }> = new Map();

  /** Register a dynamically created sub-agent and its handoff tool. */
  register(agent: Agent, handoff: HandoffTool): void {
    this.agents.set(agent.name, { agent, handoff });
  }

  /** Unregister a sub-agent by name. */
  unregister(name: string): boolean {
    return this.agents.delete(name);
  }

  /** Get a sub-agent by name. */
  get(name: string): { agent: Agent; handoff: HandoffTool } | undefined {
    return this.agents.get(name);
  }

  /** Get all registered sub-agents. */
  getAll(): { agent: Agent; handoff: HandoffTool }[] {
    return [...this.agents.values()];
  }

  /** Get all handoff tools for registered sub-agents. */
  getHandoffTools(): HandoffTool[] {
    return [...this.agents.values()].map((entry) => entry.handoff);
  }

  /** Check if a sub-agent with the given name exists. */
  has(name: string): boolean {
    return this.agents.has(name);
  }

  /** List all registered sub-agent names. */
  names(): string[] {
    return [...this.agents.keys()];
  }

  /** Clear all registered sub-agents. */
  clear(): void {
    this.agents.clear();
  }
}

/** Global singleton registry. */
export const dynamicSubAgentRegistry = new DynamicSubAgentRegistry();

// ── Create Sub-Agent Tool ──

export function createSubAgentCreateTool(_workspaceRoot?: string): FunctionTool<SubAgentCreateToolContext> {
  return createFunctionTool<SubAgentCreateToolContext>({
    name: "create_subagent",
    description:
      "Create a new sub-agent dynamically. The sub-agent will be registered as a handoff target " +
      "that you can delegate tasks to using the `transfer_to_{name}` tool. " +
      "Use this when you need a specialized agent for a specific task that doesn't already exist.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "A unique name for the sub-agent. Must be alphanumeric with hyphens/underscores. Will be used as the handoff tool name: transfer_to_{name}.",
        },
        instructions: {
          type: "string",
          description: "System instructions/prompt for the sub-agent. Defines the agent's role, capabilities, and behavior.",
        },
        description: {
          type: "string",
          description: "A brief public description of what this sub-agent does. Used as the handoff tool description.",
        },
        tools: {
          type: "array",
          description: "List of tool names to make available to the sub-agent. If omitted, the sub-agent inherits all available tools.",
          items: { type: "string" },
        },
      },
      required: ["name", "instructions"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const name = String(args[0] ?? "").trim();
      const instructions = String(args[1] ?? "").trim();
      const description = args[2] != null ? String(args[2]).trim() : undefined;
      const tools = args[3] as string[] | undefined;

      // Validate name
      if (!name) {
        return { content: [{ type: "text", text: "error: Sub-agent name is required." }], isError: true };
      }

      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return { content: [{ type: "text", text: `error: Invalid sub-agent name "${name}". Use only alphanumeric characters, hyphens, and underscores.` }], isError: true };
      }

      // Validate instructions
      if (!instructions) {
        return { content: [{ type: "text", text: "error: Sub-agent instructions are required." }], isError: true };
      }

      // Check for name conflicts
      if (dynamicSubAgentRegistry.has(name)) {
        return { content: [{ type: "text", text: `error: A sub-agent named "${name}" already exists. Use a different name or delegate to the existing one via transfer_to_${name}.` }], isError: true };
      }

      // Create the agent (mark as dynamic for sandbox policy)
      const agent = createAgent({
        name,
        instructions,
        tools: tools ?? undefined,
      });
      // Mark as dynamically created so the executor applies the restrictive sandbox policy
      agent.dynamic = true;

      // Create the handoff tool
      const handoffDescription = description ?? instructions.slice(0, 120).trim();
      const handoff = createHandoffTool(agent, handoffDescription);

      // Register in the global registry
      dynamicSubAgentRegistry.register(agent, handoff);

      // Also register with the FunctionToolManager and ToolSet if available
      const wrapper = _ctx as ContextWrapper<SubAgentCreateToolContext> | undefined;
      const toolMgr = wrapper?._toolMgr;
      if (toolMgr) {
        toolMgr.funcList.push(handoff);
      }
      const funcToolSet = wrapper?._funcToolSet;
      if (funcToolSet) {
        funcToolSet.addTool(handoff);
      }

      const toolList = tools ? tools.join(", ") : "(all available tools)";
      return {
        content: [{
          type: "text",
          text:
            `Sub-agent "${name}" created successfully.\n` +
            `- Instructions: ${instructions.slice(0, 200)}${instructions.length > 200 ? "..." : ""}\n` +
            `- Tools: ${toolList}\n` +
            `- Handoff tool: transfer_to_${name}\n\n` +
            `You can now delegate tasks to this sub-agent by calling transfer_to_${name}.`,
        }],
      };
    },
  });
}

// ── List Sub-Agents Tool ──

export function createListSubAgentsTool(): FunctionTool<SubAgentCreateToolContext> {
  return createFunctionTool<SubAgentCreateToolContext>({
    name: "list_subagents",
    description: "List all dynamically created sub-agents and their descriptions.",
    parameters: {
      type: "object",
      properties: {},
    },
    active: true,
    handler: async (_ctx: unknown): Promise<CallToolResult> => {
      const entries = dynamicSubAgentRegistry.getAll();

      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No dynamic sub-agents have been created yet. Use create_subagent to create one." }] };
      }

      const formatted = entries
        .map((entry, i) => {
          const { agent, handoff } = entry;
          const toolList = agent.tools
            ? (Array.isArray(agent.tools) ? agent.tools.map((t) => typeof t === "string" ? t : t.name).join(", ") : "(all)")
            : "(all available tools)";
          return (
            `${i + 1}. **${agent.name}**\n` +
            `   Handoff: ${handoff.name}\n` +
            `   Instructions: ${agent.instructions?.slice(0, 150) ?? "(none)"}${(agent.instructions?.length ?? 0) > 150 ? "..." : ""}\n` +
            `   Tools: ${toolList}`
          );
        })
        .join("\n\n");

      return { content: [{ type: "text", text: `Dynamic sub-agents (${entries.length}):\n\n${formatted}` }] };
    },
  });
}

// ── Delete Sub-Agent Tool ──

export function createDeleteSubAgentTool(): FunctionTool<SubAgentCreateToolContext> {
  return createFunctionTool<SubAgentCreateToolContext>({
    name: "delete_subagent",
    description: "Delete a dynamically created sub-agent. The handoff tool will no longer be available.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the sub-agent to delete.",
        },
      },
      required: ["name"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const name = String(args[0] ?? "").trim();

      if (!name) {
        return { content: [{ type: "text", text: "error: Sub-agent name is required." }], isError: true };
      }

      if (!dynamicSubAgentRegistry.has(name)) {
        return { content: [{ type: "text", text: `error: Sub-agent "${name}" not found.` }], isError: true };
      }

      // Remove from registry
      dynamicSubAgentRegistry.unregister(name);

      // Also remove from FunctionToolManager and ToolSet if available
      const wrapper = _ctx as ContextWrapper<SubAgentCreateToolContext> | undefined;
      const toolMgr = wrapper?._toolMgr;
      if (toolMgr && typeof toolMgr.removeFunc === "function") {
        toolMgr.removeFunc(`transfer_to_${name}`);
      }
      const funcToolSet = wrapper?._funcToolSet;
      if (funcToolSet) {
        funcToolSet.removeTool(`transfer_to_${name}`);
      }

      return { content: [{ type: "text", text: `Sub-agent "${name}" deleted. The transfer_to_${name} tool is no longer available.` }] };
    },
  });
}

// ── Tool assembly ──

/**
 * Get the complete set of sub-agent management tools.
 */
export function getSubAgentManagementTools(workspaceRoot?: string): FunctionTool<SubAgentCreateToolContext>[] {
  return [
    createSubAgentCreateTool(workspaceRoot),
    createListSubAgentsTool(),
    createDeleteSubAgentTool(),
  ];
}
