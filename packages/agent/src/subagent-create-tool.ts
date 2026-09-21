/**
 * Dynamic sub-agent creation tool.
 * Allows the LLM to create new sub-agents at runtime and delegate tasks to them.
 */

import { createFunctionTool, type FunctionTool } from "./tool.js";
import { createAgent, type Agent } from "./agent.js";
import { createHandoffTool, type HandoffTool } from "./handoff.js";
import type { ContextWrapper, CallToolResult } from "./types.js";
import { resolveToolContextOwner } from "./types.js";

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
  /**
   * Registered sub-agents, keyed by name. Each entry records the owning session
   * (UMO) so one session cannot enumerate or delete another session's dynamic
   * sub-agents. `owner === undefined` means "unowned" (standalone/test callers,
   * or callers whose context carried no UMO) and is visible to owner-less calls
   * only, mirroring interactive-shell session scoping.
   */
  private agents: Map<string, { agent: Agent; handoff: HandoffTool; owner?: string }> = new Map();

  /** Register a dynamically created sub-agent and its handoff tool. */
  register(agent: Agent, handoff: HandoffTool, owner?: string): void {
    this.agents.set(agent.name, { agent, handoff, owner });
  }

  /** Unregister a sub-agent by name. */
  unregister(name: string): boolean {
    return this.agents.delete(name);
  }

  /** Get a sub-agent by name. */
  get(name: string): { agent: Agent; handoff: HandoffTool } | undefined {
    return this.agents.get(name);
  }

  /** True when `owner` may operate on an entry (undefined owner = no filter). */
  private ownedBy(entry: { owner?: string }, owner?: string): boolean {
    if (owner === undefined) return true;
    return entry.owner === owner;
  }

  /**
   * Get all registered sub-agents, optionally scoped to an owning session.
   * Passing `undefined` returns everything (standalone callers).
   */
  getAll(owner?: string): { agent: Agent; handoff: HandoffTool }[] {
    return [...this.agents.values()].filter((e) => this.ownedBy(e, owner));
  }

  /** Get all handoff tools for registered sub-agents (optionally scoped). */
  getHandoffTools(owner?: string): HandoffTool[] {
    return [...this.agents.values()].filter((e) => this.ownedBy(e, owner)).map((entry) => entry.handoff);
  }

  /** Check if a sub-agent with the given name exists (optionally scoped). */
  has(name: string, owner?: string): boolean {
    const entry = this.agents.get(name);
    if (!entry) return false;
    return this.ownedBy(entry, owner);
  }

  /** List registered sub-agent names (optionally scoped). */
  names(owner?: string): string[] {
    return [...this.agents.entries()]
      .filter(([, e]) => this.ownedBy(e, owner))
      .map(([name]) => name);
  }

  /**
   * Unregister a sub-agent only when it is owned by `owner` (or `owner` is
   * undefined). Returns false if the name is absent OR owned by someone else,
   * so a cross-session delete is rejected.
   */
  unregisterOwned(name: string, owner?: string): boolean {
    const entry = this.agents.get(name);
    if (!entry) return false;
    if (!this.ownedBy(entry, owner)) return false;
    return this.agents.delete(name);
  }

  /** Clear all registered sub-agents. */
  clear(): void {
    this.agents.clear();
  }
}

/** Global singleton registry. */
export const dynamicSubAgentRegistry = new DynamicSubAgentRegistry();

/** Maximum number of dynamic sub-agents to prevent resource exhaustion. */
const MAX_DYNAMIC_SUBAGENTS = 50;

/** Maximum length of sub-agent instructions to prevent prompt bloat. */
const MAX_INSTRUCTIONS_LENGTH = 16 * 1024; // 16KB

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

      // Enforce instructions length limit to prevent prompt bloat / resource exhaustion
      if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
        return { content: [{ type: "text", text: `error: Sub-agent instructions too long (${instructions.length} chars, max ${MAX_INSTRUCTIONS_LENGTH}).` }], isError: true };
      }

      const owner = resolveToolContextOwner(_ctx, { warnLabel: "SubAgentTool" });

      // Enforce maximum sub-agent count to prevent resource exhaustion
      if (dynamicSubAgentRegistry.getAll().length >= MAX_DYNAMIC_SUBAGENTS) {
        return { content: [{ type: "text", text: `error: Maximum number of dynamic sub-agents (${MAX_DYNAMIC_SUBAGENTS}) reached. Delete unused sub-agents before creating new ones.` }], isError: true };
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

      // Register in the global registry, tagged with the owning session so
      // other sessions cannot enumerate or delete it.
      dynamicSubAgentRegistry.register(agent, handoff, owner);

      // Also register with the FunctionToolManager and ToolSet if available.
      // `handoff` is an already-built FunctionTool instance; addFunc() is
      // for building a new tool from (name, args, desc, handler) primitives
      // and would create an invalid tool (handler=undefined) when passed an
      // instance. addToolInstance() dedupes by name (so re-creating a
      // same-named sub-agent replaces the old handoff) and keeps toolIndex
      // in sync — pushing to funcList directly would break getFunc().
      const wrapper = _ctx as ContextWrapper<SubAgentCreateToolContext> | undefined;
      const toolMgr = wrapper?._toolMgr;
      if (toolMgr) {
        toolMgr.addToolInstance(handoff);
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
      const owner = resolveToolContextOwner(_ctx, { warnLabel: "SubAgentTool" });
      const entries = dynamicSubAgentRegistry.getAll(owner);

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

      const owner = resolveToolContextOwner(_ctx, { warnLabel: "SubAgentTool" });

      if (!dynamicSubAgentRegistry.has(name)) {
        return { content: [{ type: "text", text: `error: Sub-agent "${name}" not found.` }], isError: true };
      }

      // Remove from registry, but only if this session owns it. A cross-session
      // delete must not remove another session's sub-agent.
      if (!dynamicSubAgentRegistry.unregisterOwned(name, owner)) {
        return { content: [{ type: "text", text: `error: Sub-agent "${name}" belongs to another session.` }], isError: true };
      }

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
