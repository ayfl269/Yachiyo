import type { Agent } from "./agent.js";
import { createHandoffTool, type HandoffTool } from "./handoff.js";
import type { FunctionTool } from "./tool.js";

export interface SubAgentConfig {
  name: string;
  enabled?: boolean;
  system_prompt?: string;
  public_description?: string;
  persona_id?: string;
  provider_id?: string;
  tools?: string[] | null;
}

export interface SubAgentOrchestratorConfig {
  main_enable?: boolean;
  remove_main_duplicate_tools?: boolean;
  router_system_prompt?: string;
  agents?: SubAgentConfig[];
}

export interface PersonaData {
  prompt?: string;
  tools?: string[] | null;
  _beginDialogsProcessed?: unknown[];
  [key: string]: unknown;
}

export interface SubAgentPersonaManager {
  getPersonaById(personaId: string | null | undefined): PersonaData | null;
}

export class SubAgentOrchestrator {
  handoffs: HandoffTool[] = [];
  private personaMgr: SubAgentPersonaManager | null = null;

  constructor(personaMgr?: SubAgentPersonaManager) {
    this.personaMgr = personaMgr ?? null;
  }

  setPersonaManager(mgr: SubAgentPersonaManager): void {
    this.personaMgr = mgr;
  }

  async reloadFromConfig(cfg: SubAgentOrchestratorConfig): Promise<void> {
    const agents = cfg.agents ?? [];
    if (!Array.isArray(agents)) return;

    const handoffs: HandoffTool[] = [];

    for (const item of agents) {
      if (!item || typeof item !== "object") continue;
      if (item.enabled === false) continue;

      const name = String(item.name ?? "").trim();
      if (!name) continue;

      let instructions = String(item.system_prompt ?? "").trim();
      const publicDescription = String(item.public_description ?? "").trim();
      const providerId = item.provider_id ? String(item.provider_id).trim() || undefined : undefined;
      let tools = item.tools;
      let beginDialogs: unknown[] | undefined;

      // Resolve persona data
      const personaId = item.persona_id ? String(item.persona_id).trim() || undefined : undefined;
      const personaData = this.personaMgr?.getPersonaById(personaId ?? null) ?? null;

      if (personaId && !personaData) {
        console.warn(
          `SubAgent persona ${personaId} not found, fallback to inline prompt.`
        );
      }

      if (personaData) {
        const prompt = String(personaData.prompt ?? "").trim();
        if (prompt) {
          instructions = prompt;
        }

        // Deep clone begin dialogs from persona
        if (personaData._beginDialogsProcessed) {
          beginDialogs = structuredClone(personaData._beginDialogsProcessed);
        }

        // Use persona's tools if defined
        if (personaData.tools !== undefined) {
          tools = personaData.tools;
        }

        // Auto-generate public description from prompt if missing
        if (!publicDescription && prompt) {
          // Use first 120 chars of prompt as description
          const desc = prompt.slice(0, 120).trim();
          if (desc) {
            // Will be used below
          }
        }
      }

      // Normalize tools
      if (tools === null || tools === undefined) {
        tools = null; // null = all tools
      } else if (!Array.isArray(tools)) {
        tools = [];
      } else {
        tools = tools.map((t) => String(t).trim()).filter(Boolean);
      }

      const agent: Agent = {
        name,
        instructions: instructions || undefined,
        tools: tools as (string | FunctionTool)[] | undefined,
        beginDialogs: beginDialogs,
      };

      // Generate description: prefer explicit, then persona prompt excerpt
      let handoffDescription = publicDescription || undefined;
      if (!handoffDescription && personaData?.prompt) {
        handoffDescription = personaData.prompt.slice(0, 120).trim() || undefined;
      }

      const handoff = createHandoffTool(agent, handoffDescription);
      handoff.providerId = providerId;
      handoffs.push(handoff);
    }

    for (const handoff of handoffs) {
      console.info(`Registered subagent handoff tool: ${handoff.name}`);
    }

    this.handoffs = handoffs;
  }
}
