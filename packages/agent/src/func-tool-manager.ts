import type { FunctionTool, ToolHandler } from "./tool.js";
import { ToolSet, createFunctionTool } from "./tool.js";
import type { MCPClient } from "./mcp-client.js";
import { type MCPToolInstance } from "./mcp-tool.js";
import type { Provider } from "./types.js";

export interface MCPInitSummary {
  total: number;
  success: number;
  failed: string[];
}

export class MCPInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MCPInitError";
  }
}

export class MCPInitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MCPInitTimeoutError";
  }
}

interface MCPServerRuntime {
  name: string;
  client: MCPClient;
}

const DEFAULT_MCP_INIT_TIMEOUT = 180_000; // ms
const DEFAULT_MCP_ENABLE_TIMEOUT = 180_000; // ms

export class FunctionToolManager {
  /** All tools including MCP tools and plugin tools */
  funcList: FunctionTool[] = [];
  /** Provider instances for lookup by ID */
  providers: Provider[] = [];
  /**
   * Name → tools-with-that-name index. Each array holds tools in insertion
   * order, mirroring `funcList`. Used by {@link getFunc} to avoid O(N)
   * scans on every tool dispatch — important when MCP servers register
   * hundreds of tools and `getFunc` is called from the hot path of
   * `tool-executor.ts` and `ToolSet.addTool`.
   *
   * Mutated in lockstep with {@link funcList} via {@link indexAdd} and
   * {@link indexRemove}.
   */
  private toolIndex: Map<string, FunctionTool[]> = new Map();
  /** MCP server runtime state */
  private mcpServerRuntime: Map<string, MCPServerRuntime> = new Map();
  private mcpStarting: Set<string> = new Set();
  private initTimeout: number;
  private enableTimeout: number;

  constructor(options?: { initTimeout?: number; enableTimeout?: number }) {
    this.initTimeout = options?.initTimeout ?? DEFAULT_MCP_INIT_TIMEOUT;
    this.enableTimeout = options?.enableTimeout ?? DEFAULT_MCP_ENABLE_TIMEOUT;
  }

  empty(): boolean {
    return this.funcList.length === 0;
  }

  getProviderById(providerId: string): Provider | null {
    return this.providers.find(p => p.providerConfig?.id === providerId) ?? null;
  }

  // ---- Plugin Tool Management ----

  addFunc(
    name: string,
    funcArgs: Array<{ name: string; type: string; description?: string; [key: string]: unknown }>,
    desc: string,
    handler: ToolHandler
  ): void {
    this.removeFunc(name);
    const params: Record<string, unknown> = {
      type: "object",
      properties: {},
    };
    for (const param of funcArgs) {
      const p = { ...param };
      const paramName = String(p.name);
      delete (p as Record<string, unknown>).name;
      (params.properties as Record<string, unknown>)[paramName] = p;
    }
    const tool = createFunctionTool({ name, parameters: params, description: desc, handler });
    this.funcList.push(tool);
    this.indexAdd(tool);
    console.info(`Added llm tool: ${name}`);
  }

  removeFunc(name: string): void {
    const idx = this.funcList.findIndex((f) => f.name === name);
    if (idx >= 0) {
      const [removed] = this.funcList.splice(idx, 1);
      this.indexRemove(removed);
    }
  }

  getFunc(name: string): FunctionTool | undefined {
    // O(1) average lookup via the name index. Falls back to a full scan only
    // if the index is somehow out of sync (defensive — shouldn't happen).
    const tools = this.toolIndex.get(name);
    if (tools && tools.length > 0) {
      // Prefer active tools (last loaded wins, matching ToolSet.addTool behavior)
      for (let i = tools.length - 1; i >= 0; i--) {
        if (tools[i].active ?? true) return tools[i];
      }
      // Fallback: return last matching tool regardless of active state
      return tools[tools.length - 1];
    }
    return undefined;
  }

  // ---- Index maintenance ----

  private indexAdd(tool: FunctionTool): void {
    const list = this.toolIndex.get(tool.name);
    if (list) list.push(tool);
    else this.toolIndex.set(tool.name, [tool]);
  }

  private indexRemove(tool: FunctionTool): void {
    const list = this.toolIndex.get(tool.name);
    if (!list) return;
    const idx = list.indexOf(tool);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this.toolIndex.delete(tool.name);
  }

  // ---- Tool Set ----

  getFullToolSet(): ToolSet {
    const toolSet = new ToolSet();
    for (const tool of this.funcList) {
      toolSet.addTool(tool);
    }
    return toolSet;
  }

  // ---- Tool Activation ----

  deactivateTool(name: string): boolean {
    const tool = this.getFunc(name);
    if (tool) {
      tool.active = false;
      return true;
    }
    return false;
  }

  activateTool(name: string): boolean {
    const tool = this.getFunc(name);
    if (tool) {
      tool.active = true;
      return true;
    }
    return false;
  }

  // ---- MCP Client Management ----

  get mcpClientDict(): ReadonlyMap<string, MCPClient> {
    const map = new Map<string, MCPClient>();
    for (const [name, runtime] of this.mcpServerRuntime) {
      map.set(name, runtime.client);
    }
    return map;
  }

  async initMcpClients(
    mcpServerConfig: Record<string, Record<string, unknown>>,
    raiseOnAllFailed = false
  ): Promise<MCPInitSummary> {
    const activeConfigs: Array<{ name: string; cfg: Record<string, unknown> }> = [];
    for (const [name, cfg] of Object.entries(mcpServerConfig)) {
      if (cfg.active !== false) {
        activeConfigs.push({ name, cfg });
      }
    }

    if (!activeConfigs.length) {
      return { total: 0, success: 0, failed: [] };
    }

    console.info(`Waiting for ${activeConfigs.length} MCP services to initialize...`);

    let successCount = 0;
    const failedServices: string[] = [];

    const results = await Promise.allSettled(
      activeConfigs.map(({ name, cfg }) =>
        this.startMcpServer(name, cfg)
      )
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        successCount++;
      } else {
        const name = activeConfigs[i].name;
        console.error(`Failed to initialize MCP server ${name}: ${result.reason}`);
        failedServices.push(name);
        this.mcpServerRuntime.delete(name);
      }
    }

    const summary: MCPInitSummary = {
      total: activeConfigs.length,
      success: successCount,
      failed: failedServices,
    };

    console.info(
      `MCP services initialization completed: ${summary.success}/${summary.total} successful, ${summary.failed.length} failed.`
    );

    if (summary.total > 0 && summary.success === 0) {
      const msg = "All MCP services failed to initialize.";
      if (raiseOnAllFailed) throw new MCPInitError(msg);
      console.error(msg);
    }

    return summary;
  }

  async startMcpServer(name: string, cfg: Record<string, unknown>): Promise<void> {
    if (this.mcpServerRuntime.has(name) || this.mcpStarting.has(name)) {
      console.warn(`MCP server ${name} is already running or starting.`);
      return;
    }

    this.mcpStarting.add(name);

    try {
      const { MCPClient } = await import("./mcp-client.js");
      const mcpClient = new MCPClient();
      mcpClient.name = name;

      await mcpClient.connectToServer(cfg, name);
      const toolsRes = await mcpClient.listToolsAndSave();

      // Remove previous tools from this MCP server. Use in-place splice
      // (rather than reassigning funcList) so the toolIndex stays in sync
      // — reassigning funcList would orphan the index.
      const toRemove = this.funcList.filter((f) => isMCPToolOfServer(f, name));
      for (const removed of toRemove) {
        const idx = this.funcList.indexOf(removed);
        if (idx >= 0) this.funcList.splice(idx, 1);
        this.indexRemove(removed);
      }

      // Add MCP tools
      for (const tool of mcpClient.tools) {
        const { createMCPTool } = await import("./mcp-tool.js");
        const funcTool = createMCPTool(tool, mcpClient, name);
        this.funcList.push(funcTool);
        this.indexAdd(funcTool);
      }

      const toolNames = toolsRes.tools.map((t) => t.name);
      console.info(`Connected to MCP server ${name}, Tools: ${toolNames}`);

      this.mcpServerRuntime.set(name, {
        name,
        client: mcpClient,
      });
      // Non-blocking: return immediately after registration. Shutdown is
      // handled by disableMcpServer → terminateMcpClient directly.
    } finally {
      this.mcpStarting.delete(name);
    }
  }

  async enableMcpServer(name: string, cfg: Record<string, unknown>): Promise<void> {
    await this.startMcpServer(name, cfg);
  }

  async disableMcpServer(name: string | null): Promise<void> {
    if (name) {
      await this.terminateMcpClient(name);
    } else {
      const names = Array.from(this.mcpServerRuntime.keys());
      await Promise.all(names.map((n) => this.terminateMcpClient(n)));
    }
  }

  /** Terminate an MCP client and remove its tools. Public for dashboard use. */
  async terminateMcpClient(name: string): Promise<void> {
    const runtime = this.mcpServerRuntime.get(name);
    if (runtime) {
      try {
        await runtime.client.close();
      } catch { /* ignore */ }
      this.mcpServerRuntime.delete(name);
      console.info(`Disconnected from MCP server ${name}`);
    }
    // Use in-place splice (not funcList = filter(...)) so the toolIndex
    // stays in sync — reassigning funcList would orphan the index.
    const toRemove = this.funcList.filter((f) => isMCPToolOfServer(f, name));
    for (const removed of toRemove) {
      const idx = this.funcList.indexOf(removed);
      if (idx >= 0) this.funcList.splice(idx, 1);
      this.indexRemove(removed);
    }
    this.mcpStarting.delete(name);
  }

  // ---- Schema Helpers ----

  getFuncDescOpenaiStyle(omitEmptyParameterField = false): Record<string, unknown>[] {
    const tools = this.funcList.filter((f) => f.active);
    return new ToolSet(tools).openaiSchema(omitEmptyParameterField);
  }

  getFuncDescAnthropicStyle(): Record<string, unknown>[] {
    const tools = this.funcList.filter((f) => f.active);
    return new ToolSet(tools).anthropicSchema();
  }

  getFuncDescGoogleGenaiStyle(): Record<string, unknown> {
    const tools = this.funcList.filter((f) => f.active);
    return new ToolSet(tools).googleSchema();
  }
}

function isMCPToolOfServer(tool: FunctionTool, serverName: string): boolean {
  return "mcpServerName" in tool && (tool as MCPToolInstance).mcpServerName === serverName;
}
