import type { Provider, ProviderRequest } from "./types.js";
import { createContextWrapper } from "./types.js";
import type { BaseAgentRunHooks } from "./hooks.js";
import { EmptyAgentHooks } from "./hooks.js";
import { ToolLoopAgentRunner } from "./runners/tool-loop-agent-runner.js";
import { FunctionToolExecutor } from "./tool-executor.js";
import { ToolSet } from "./tool.js";
import type { FunctionTool } from "./tool.js";
import type { FunctionToolManager } from "./func-tool-manager.js";
import type { SubAgentOrchestrator } from "./subagent-orchestrator.js";

// ---- Build Config ----

export interface MainAgentBuildConfig {
  toolCallTimeout?: number;
  toolSchemaMode?: "full" | "skills_like";
  providerWakePrefix?: string;
  streamingResponse?: boolean;
  sanitizeContextByModalities?: boolean;
  kbAgenticMode?: boolean;
  contextLimitReachedStrategy?: "truncate_by_turns" | "llm_compress";
  llmCompressInstruction?: string;
  llmCompressKeepRecent?: number;
  llmCompressKeepRecentRatio?: number;
  llmCompressProviderId?: string;
  maxContextLength?: number;
  fallbackMaxContextTokens?: number;
  enforceMaxTurns?: number;
  truncateTurns?: number;
  llmSafetyMode?: boolean;
  safetyModeStrategy?: "system_prompt";
  providerSettings?: Record<string, unknown>;
  subagentOrchestrator?: Record<string, unknown>;
  timezone?: string | null;
  toolResultOverflowDir?: string;
  readTool?: FunctionTool;
  fallbackProviderIds?: string[];
}

export interface MainAgentBuildResult<TContext = unknown> {
  agentRunner: ToolLoopAgentRunner<TContext>;
  providerRequest: ProviderRequest;
  provider: Provider;
}

// ---- Provider Selector ----

export type ProviderSelector = () => Provider | null;

// ---- Build Main Agent ----

export async function buildMainAgent<TContext = unknown>(
  options: {
    provider: Provider;
    request: ProviderRequest;
    config?: MainAgentBuildConfig;
    toolManager?: FunctionToolManager;
    subagentOrchestrator?: SubAgentOrchestrator;
    agentHooks?: BaseAgentRunHooks<TContext>;
    toolExecutor?: FunctionToolExecutor;
    fallbackProviders?: Provider[];
    context?: TContext;
  }
): Promise<MainAgentBuildResult<TContext>> {
  const {
    provider,
    request,
    config = {},
    toolManager,
    subagentOrchestrator,
    agentHooks,
    toolExecutor,
    fallbackProviders = [],
    context,
  } = options;

  // Apply persona/tools if tool manager is available
  if (toolManager && request.funcTool) {
    const fullToolSet = toolManager.getFullToolSet();
    const funcTool = request.funcTool as ToolSet;
    console.log(`[AgentBuilder] Merging toolManager tools (${fullToolSet.length}) into existing funcTool (${funcTool.length})`);
    funcTool.merge(fullToolSet);
    console.log(`[AgentBuilder] After merge: funcTool has ${funcTool.length} tools`);
  } else if (toolManager && !request.funcTool) {
    request.funcTool = toolManager.getFullToolSet();
    console.log(`[AgentBuilder] Set funcTool from toolManager: ${(request.funcTool as ToolSet).length} tools`);
  } else {
    console.log(`[AgentBuilder] No toolManager or no merge needed. toolManager=${!!toolManager}, hasFuncTool=${!!request.funcTool}`);
  }

  // Apply sub-agent handoff tools
  if (subagentOrchestrator) {
    const orchCfg = config.subagentOrchestrator ?? {};
    if (orchCfg.main_enable !== false) {
      if (!request.funcTool) request.funcTool = new ToolSet();
      const funcTool = request.funcTool as ToolSet;
      for (const handoff of subagentOrchestrator.handoffs) {
        funcTool.addTool(handoff);
      }

      // Remove duplicate tools if configured
      if (orchCfg.remove_main_duplicate_tools) {
        const assignedTools = new Set<string>();
        const agents = (orchCfg.agents ?? []) as Array<Record<string, unknown>>;
        for (const a of agents) {
          if (a.enabled === false) continue;
          const tools = a.tools as string[] | null | undefined;
          if (tools === null || tools === undefined) {
            // null = all tools
            if (toolManager) {
              for (const t of toolManager.funcList) {
                const isHandoff = subagentOrchestrator.handoffs.some((h) => h.name === t.name);
                if (!isHandoff) assignedTools.add(t.name);
              }
            }
          } else if (Array.isArray(tools)) {
            for (const t of tools) assignedTools.add(String(t).trim());
          }
        }
        for (const toolName of assignedTools) {
          funcTool.removeTool(toolName);
        }
      }

      // Apply router system prompt
      const routerPrompt = String(orchCfg.router_system_prompt ?? "").trim();
      if (routerPrompt) {
        request.systemPrompt = `${request.systemPrompt ?? ""}\n${routerPrompt}\n`;
      }
    }
  }

  // Apply safety mode
  if (config.llmSafetyMode) {
    const safetyPrompt =
      "You are a helpful, harmless, and honest AI assistant. " +
      "You must not generate content that is harmful, unethical, or illegal. " +
      "Always prioritize user safety and well-being.";
    request.systemPrompt = `${safetyPrompt}\n\n${request.systemPrompt ?? ""}`;
  }

  // Apply tool call prompt
  if (request.funcTool && (request.funcTool as ToolSet).length > 0) {
    const toolPrompt =
      config.toolSchemaMode === "skills_like"
        ? SKILLS_LIKE_TOOL_CALL_PROMPT
        : FULL_TOOL_CALL_PROMPT;
    request.systemPrompt = `${request.systemPrompt ?? ""}\n${toolPrompt}\n`;
  }

  // Resolve fallback providers
  const resolvedFallbacks = fallbackProviders;

  // Resolve compression provider
  let compressProvider: Provider | undefined;
  if (
    config.contextLimitReachedStrategy === "llm_compress" &&
    config.llmCompressProviderId &&
    toolManager
  ) {
    // Try to resolve from tool manager's provider registry
    compressProvider = toolManager.getProviderById(config.llmCompressProviderId) ?? undefined;
  }

  // Create agent runner
  const agentRunner = new ToolLoopAgentRunner<TContext>();
  const runContext = createContextWrapper<TContext>(
    context ?? (null as unknown as TContext),
    { toolCallTimeout: config.toolCallTimeout ?? 120 }
  );
  if (toolManager) {
    runContext._toolMgr = toolManager;
  }

  await agentRunner.reset(runContext, agentHooks ?? new EmptyAgentHooks(), {
    provider,
    request,
    runContext,
    toolExecutor: toolExecutor ?? new FunctionToolExecutor(),
    agentHooks: agentHooks ?? new EmptyAgentHooks(),
    streaming: config.streamingResponse ?? true,
    enforceMaxTurns: config.enforceMaxTurns ?? -1,
    llmCompressInstruction: config.llmCompressInstruction,
    llmCompressKeepRecent: config.llmCompressKeepRecent,
    llmCompressKeepRecentRatio: config.llmCompressKeepRecentRatio,
    llmCompressProvider: compressProvider,
    truncateTurns: config.truncateTurns ?? 1,
    toolSchemaMode: config.toolSchemaMode ?? "full",
    fallbackProviders: resolvedFallbacks,
    toolResultOverflowDir: config.toolResultOverflowDir,
    readTool: config.readTool,
  });

  return {
    agentRunner,
    providerRequest: request,
    provider,
  };
}

// ---- Tool Call Prompts ----

const FULL_TOOL_CALL_PROMPT = `When you need to use a tool, you must output the tool call in the specified format.
- Always verify that the tool exists before calling it.
- Pass all required parameters for each tool call.
- After receiving tool results, analyze them and decide whether to call another tool or respond to the user.
- Do not make up values for or fabricate tool results.`;

const SKILLS_LIKE_TOOL_CALL_PROMPT = `When you decide to use a tool, first select the tool by name, then in the next step provide the required arguments.
- Step 1: Choose which tool(s) to use.
- Step 2: Provide the arguments for the selected tool(s) based on their schema.
- Always verify that the tool exists before calling it.
- Do not make up values for or fabricate tool results.`;

