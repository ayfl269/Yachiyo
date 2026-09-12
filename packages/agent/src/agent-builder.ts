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
  /** LLM 调用本身是否流式（textChatStream vs textChat）。默认 true。 */
  streaming?: boolean;
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
    funcTool.merge(fullToolSet);
  } else if (toolManager && !request.funcTool) {
    request.funcTool = toolManager.getFullToolSet();
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

  // Apply tool call prompt (model-specific)
  if (request.funcTool && (request.funcTool as ToolSet).length > 0) {
    const mode = config.toolSchemaMode ?? "full";
    const toolPrompt = getToolCallPrompt(provider.type, mode);
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
    streaming: config.streaming ?? true,
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

// ---- Model-Specific Tool Call Prompts ----

/**
 * 公共前缀：工具使用原则（与 provider 无关）。
 *
 * 这段内容解决"模型不主动调工具"的根因——之前的 prompt 只讲"怎么调"，不讲
 * "何时该调"和"必须调不能空承诺"，导致模型倾向于直接文字回复。
 *
 * 每个 provider 专用 prompt 都以此前缀开头，再接上该 provider 的输出格式说明。
 * 所有 provider 都需要这套原则，因为这是行为引导而非格式说明。
 */
const TOOL_CALL_PRINCIPLES = `You are a tool-augmented assistant. The tools listed below are available to you.
Use them PROACTIVELY whenever the user's request falls into a tool's scope —
do NOT wait for the user to explicitly say "use tool X".

## Tool-calling principles

1. **Tool-first for actionable requests.** When the user asks you to DO
   something (read/write a file, run a command, search the web, fetch a
   URL, control a browser, set a reminder, save a memory, etc.), call
   the appropriate tool FIRST, then reply based on the result. Do not
   reply with text like "好的，我来帮你做X" without actually calling
   the tool — the action only happens through tool calls.

2. **Never fabricate tool results.** If you don't have a tool that can
   answer the user's question, say so honestly instead of making up
   information.

3. **Trigger by intent, not by keyword.** Even if the user does not
   mention the tool name, you should recognize the intent. Examples:
   - "帮我看看这个网页讲了什么" → web_fetch_tool
   - "查一下最近的XX新闻" → web_search_tool
   - "把这段话存到文件里" → file_write_tool
   - "5分钟后提醒我开会" → scheduler_tool
   - "记住我喜欢简洁回复" → memory_tool (action=save, type=user_profile)
   - "运行一下这段Python" → execute_python
   - "打开浏览器访问 example.com" → browser_navigate

4. **Tools are not optional.** Replying with a plain-text promise like
   "我会去查的" or "我会在5分钟后提醒你" WITHOUT calling the tool means
   the action will NEVER actually happen — the background scheduler,
   file system, and network only act through tool calls.

5. **After receiving tool results**, analyze them and decide whether to
   call another tool or respond to the user. Multi-step tool chains are
   encouraged when the task requires them.`;

const OPENAI_TOOL_CALL_PROMPT = `${TOOL_CALL_PRINCIPLES}

## Output format (OpenAI Chat Completions)

When you need to take action, call a tool by outputting a tool_calls array in your reply. Each tool call must be an object with:
- "id": a unique identifier (e.g. "call_1")
- "type": "function"
- "function": { "name": "<tool_name>", "arguments": "<JSON-stringified-args>" }

For example:
{"id":"call_abc","type":"function","function":{"name":"web_fetch_tool","arguments":"{\\"url\\":\\"https://example.com\\"}"}}

Always verify the tool exists in the provided list before calling it.
Pass all required parameters as defined in each tool's schema.
Do not make up values for or fabricate tool results.`;

const ANTHROPIC_TOOL_CALL_PROMPT = `${TOOL_CALL_PRINCIPLES}

## Output format (Anthropic Messages API)

When you need to take action, call a tool by adding a tool_use content block to your reply. Each tool use must be an object with:
- "type": "tool_use"
- "id": a unique identifier (e.g. "toolu_1")
- "name": the tool name
- "input": the tool arguments as a JSON object

For example:
{"type":"tool_use","id":"toolu_abc","name":"web_fetch_tool","input":{"url":"https://example.com"}}

Always verify the tool exists in the provided list before calling it.
Pass all required parameters as defined in each tool's input_schema.
Do not make up values for or fabricate tool results.`;

const GEMINI_TOOL_CALL_PROMPT = `${TOOL_CALL_PRINCIPLES}

## Output format (Google Gemini API)

When you need to take action, call a tool by outputting a functionCall part in your reply. Each function call must include:
- "name": the function name
- "args": the function arguments as a JSON object

For example:
{"functionCall":{"name":"web_fetch_tool","args":{"url":"https://example.com"}}}

Always verify the tool exists in the provided list before calling it.
Pass all required parameters as defined in each tool's schema.
Do not make up values for or fabricate tool results.`;

const OPENAI_RESPONSES_TOOL_CALL_PROMPT = `${TOOL_CALL_PRINCIPLES}

## Output format (OpenAI Responses API)

When you need to take action, call a tool by outputting a function_call item in your input. Each function call must include:
- "type": "function_call"
- "id": a unique identifier (e.g. "call_1")
- "name": the function name
- "arguments": the function arguments as a JSON string

For example:
{"type":"function_call","id":"call_abc","call_id":"call_abc","name":"web_fetch_tool","arguments":"{\\"url\\":\\"https://example.com\\"}"}

Always verify the tool exists in the provided list before calling it.
Pass all required parameters as defined in each tool's schema.
Do not make up values for or fabricate tool results.`;

// ---- Skills-like mode prompts (first stage: tool selection only) ----

const SKILLS_LIKE_SELECT_PROMPT = `You are a tool-augmented assistant. The tools below are available to you. First, select which tool(s) you want to use by name only. In the next step you will be asked to provide the required arguments.
- Review each tool's name and description.
- Choose the tool(s) that best match the user's request.
- Do not invent tool names.
- Do not call tools in this step — only select them.`;

function getToolCallPrompt(providerType: string, schemaMode: string): string {
  if (schemaMode === "skills_like") {
    return SKILLS_LIKE_SELECT_PROMPT;
  }

  switch (providerType) {
    case "openai":
      return OPENAI_TOOL_CALL_PROMPT;
    case "anthropic":
      return ANTHROPIC_TOOL_CALL_PROMPT;
    case "gemini":
      return GEMINI_TOOL_CALL_PROMPT;
    case "openai_responses":
      return OPENAI_RESPONSES_TOOL_CALL_PROMPT;
    default:
      return OPENAI_TOOL_CALL_PROMPT;
  }
}

