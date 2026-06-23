import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type { CallToolResult } from "./types.js";

// ---- Custom Error Types ----

/**
 * Error thrown when a resource (connection, stream, etc.) has been closed.
 * This mirrors Python's `anyio.ClosedResourceError` and provides type-based
 * detection instead of fragile string matching on error messages.
 */
export class ClosedResourceError extends Error {
  constructor(message?: string, cause?: Error) {
    super(message ?? "Resource is closed", { cause });
    this.name = "ClosedResourceError";
  }
}

/**
 * Check if an error represents a closed/disconnected resource.
 *
 * Detection priority:
 * 1. Our own `ClosedResourceError` type
 * 2. MCP SDK's `McpError` with `ErrorCode.ConnectionClosed` (-32000)
 * 3. Known error names from SDK/transport layers
 * 4. Fallback: message-based heuristics for third-party code
 */
function isClosedResourceError(e: unknown): boolean {
  // 1. Our own type
  if (e instanceof ClosedResourceError) return true;

  if (e instanceof Error) {
    // 2. MCP SDK McpError with ConnectionClosed code
    // The SDK throws McpError with code -32000 (ErrorCode.ConnectionClosed)
    // when a connection is closed. We check the `code` property directly
    // to avoid a hard dependency on the SDK types at import time.
    const mcpErr = e as { code?: unknown; name?: string };
    if (typeof mcpErr.code === "number" && mcpErr.code === -32000) {
      return true;
    }

    // 3. Known error names from SDK/transport layers
    const name = e.name;
    if (name === "ClosedResourceError" || name === "ConnectionClosed" || name === "McpError") {
      // McpError with name check — only if code wasn't -32000 above,
      // but the error name suggests a connection issue
      if (name === "McpError") {
        // Already checked code above; if code wasn't -32000, it's not a connection error
        return false;
      }
      return true;
    }

    // 4. Fallback: message-based heuristics for third-party code
    // (e.g. transport-level errors that aren't McpError instances)
    const msg = e.message;
    if (
      msg.includes("Connection closed") ||
      msg.includes("disconnected") ||
      msg.includes("ECONNRESET") ||
      msg.includes("EPIPE")
    ) {
      return true;
    }
  }

  return false;
}

// ---- MCP Tool Definition ----

export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// ---- MCP Client Session ----

export interface MCPClientSession {
  initialize(): Promise<void>;
  listTools(): Promise<{ tools: MCPToolDefinition[] }>;
  callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
    readTimeoutSeconds?: number;
  }): Promise<CallToolResult>;
  close(): Promise<void>;
}

// ---- Stdio Security Validation ----

const DEFAULT_STDIO_COMMAND_ALLOWLIST = new Set([
  "python", "python3", "py", "node", "npx", "npm", "pnpm", "yarn",
  "bun", "bunx", "deno", "uv", "uvx",
]);

const DENIED_STDIO_COMMANDS = new Set([
  "bash", "sh", "zsh", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe",
  "pwsh", "pwsh.exe", "osascript", "open", "curl", "wget", "nc", "netcat",
  "telnet", "ssh", "scp", "rm", "mv", "cp", "dd", "mkfs", "sudo", "su",
  "chmod", "chown", "kill", "killall", "shutdown", "reboot", "poweroff", "halt",
]);

const SHELL_META_RE = /[\r\n\x00;&|<>`$]/;
const PYTHON_INLINE_CODE_FLAGS = new Set(["-c"]);
const JS_INLINE_CODE_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);
const DENIED_DOCKER_ARGS = new Set([
  "--privileged", "--pid=host", "--network=host", "--net=host", "--ipc=host",
]);
const STDIO_ALLOWLIST_ENV = "MCP_STDIO_ALLOWED_COMMANDS";

function normalizeStdioCommandName(command: string): string {
  command = command.trim();
  let commandName: string;
  if (command.includes("\\") || process.platform === "win32") {
    commandName = path.win32.basename(command);
  } else {
    commandName = path.posix.basename(command);
  }
  commandName = commandName.toLowerCase();
  for (const suffix of [".exe", ".cmd", ".bat"]) {
    if (commandName.endsWith(suffix)) {
      commandName = commandName.slice(0, -suffix.length);
    }
  }
  return commandName;
}

function getStdioCommandAllowlist(): Set<string> {
  const allowed = new Set(DEFAULT_STDIO_COMMAND_ALLOWLIST);
  const configured = process.env[STDIO_ALLOWLIST_ENV] ?? "";
  if (configured.trim()) {
    for (const item of configured.split(",")) {
      const trimmed = item.trim();
      if (trimmed) allowed.add(normalizeStdioCommandName(trimmed));
    }
  }
  return allowed;
}

function prepareConfig(config: Record<string, unknown>): Record<string, unknown> {
  const mcpServers = config.mcpServers as Record<string, Record<string, unknown>> | undefined;
  if (mcpServers) {
    const firstKey = Object.keys(mcpServers)[0];
    config = { ...mcpServers[firstKey] };
  } else {
    config = { ...config };
  }
  delete config.active;
  return config;
}

function isStdioConfig(config: Record<string, unknown>): boolean {
  const cfg = prepareConfig({ ...config });
  return !("url" in cfg);
}

function validateStdioArgs(commandName: string, args: unknown): void {
  if (args == null) return;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new Error("MCP stdio args must be an array of strings.");
  }

  for (const arg of args as string[]) {
    if (/\x00|\r|\n/.test(arg)) {
      throw new Error("MCP stdio args cannot contain control characters.");
    }
  }

  if (commandName.startsWith("python") || commandName === "py") {
    for (const arg of args as string[]) {
      if (
        PYTHON_INLINE_CODE_FLAGS.has(arg) ||
        (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("c"))
      ) {
        throw new Error(
          "MCP stdio Python servers must be launched from a module or file; inline code flags such as -c are not allowed."
        );
      }
    }
  } else if (
    commandName === "node" ||
    commandName === "deno" ||
    commandName === "bun" ||
    commandName.startsWith("node")
  ) {
    for (const arg of args as string[]) {
      if (
        JS_INLINE_CODE_FLAGS.has(arg) ||
        arg === "eval" ||
        (arg.startsWith("-") && !arg.startsWith("--") && /[ep]/.test(arg))
      ) {
        throw new Error(
          "MCP stdio JavaScript servers must be launched from a package or file; inline eval flags are not allowed."
        );
      }
    }
  } else if (commandName === "docker") {
    const denied: string[] = [];
    const argList = args as string[];
    for (let i = 0; i < argList.length; i++) {
      const arg = argList[i];
      if (DENIED_DOCKER_ARGS.has(arg)) {
        denied.push(arg);
      } else if (
        (arg === "--network" || arg === "--net" || arg === "--pid" || arg === "--ipc") &&
        i + 1 < argList.length &&
        argList[i + 1] === "host"
      ) {
        denied.push(`${arg} ${argList[i + 1]}`);
      }
    }
    if (denied.length > 0) {
      throw new Error(
        `MCP stdio Docker args are unsafe and not allowed: ${denied.join(", ")}.`
      );
    }
  }
}

/**
 * Validate stdio MCP config before any subprocess can be spawned.
 */
export function validateMcpStdioConfig(config: Record<string, unknown>): void {
  const cfg = prepareConfig({ ...config });
  if ("url" in cfg) return;

  const command = cfg.command as string | undefined;
  if (!command || !command.trim()) {
    throw new Error("MCP stdio server requires a non-empty command.");
  }
  if (SHELL_META_RE.test(command)) {
    throw new Error("MCP stdio command contains unsafe shell metacharacters.");
  }

  const commandName = normalizeStdioCommandName(command);
  if (DENIED_STDIO_COMMANDS.has(commandName)) {
    throw new Error(`MCP stdio command \`${commandName}\` is not allowed.`);
  }

  const allowed = getStdioCommandAllowlist();
  if (!allowed.has(commandName)) {
    const allowedDisplay = [...allowed].sort().join(", ");
    throw new Error(
      `MCP stdio command \`${commandName}\` is not allowed. ` +
      `Allowed commands: ${allowedDisplay}. ` +
      `Set ${STDIO_ALLOWLIST_ENV} to override this list if you trust another launcher.`
    );
  }

  validateStdioArgs(commandName, cfg.args);

  const env = cfg.env;
  if (env != null && typeof env !== "object") {
    throw new Error("MCP stdio env must be an object.");
  }
  if (env && typeof env === "object") {
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof key !== "string" || typeof value !== "string") {
        throw new Error("MCP stdio env keys and values must be strings.");
      }
    }
  }
}

/**
 * Merge environment variables, handling Windows case-insensitivity.
 */
function mergeEnvironmentVariables(env: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = { ...env };
  const userKeysLower = new Map<string, string>();
  for (const k of Object.keys(merged)) {
    userKeysLower.set(k.toLowerCase(), k);
  }

  for (const [sysKey, sysValue] of Object.entries(process.env)) {
    if (sysValue === undefined) continue;
    if (!userKeysLower.has(sysKey.toLowerCase())) {
      merged[sysKey] = sysValue;
    }
  }

  return merged;
}

/**
 * Prepare stdio environment for Windows subprocess resolution.
 */
function prepareStdioEnv(config: Record<string, unknown>): Record<string, unknown> {
  if (process.platform !== "win32") return config;
  const prepared = { ...config };
  const env = { ...((prepared.env as Record<string, string>) ?? {}) };
  prepared.env = mergeEnvironmentVariables(env);
  return prepared;
}

// ---- MCP Client ----

export class MCPClient {
  session: MCPClientSession | null = null;
  name: string | null = null;
  active = true;
  tools: MCPToolDefinition[] = [];
  serverErrLogs: string[] = [];

  private mcpServerConfig: Record<string, unknown> | null = null;
  private serverName: string | null = null;
  private reconnectLock = false;
  private reconnecting = false;

  /**
   * Connect to an MCP server.
   *
   * If `url` parameter exists:
   *   1. When transport is `streamable_http`, use Streamable HTTP connection.
   *   2. When transport is `sse`, use SSE connection.
   *   3. If not specified, default to SSE connection.
   *
   * Otherwise, use stdio transport.
   */
  async connectToServer(
    config: Record<string, unknown>,
    name: string
  ): Promise<void> {
    this.mcpServerConfig = config;
    this.serverName = name;

    const cfg = prepareConfig({ ...config });

    if ("url" in cfg) {
      // HTTP-based transport (SSE or Streamable HTTP)
      await this.connectHttpTransport(cfg, name);
    } else {
      // Stdio transport
      validateMcpStdioConfig(cfg);
      const preparedCfg = prepareStdioEnv(cfg);
      await this.connectStdioTransport(preparedCfg, name);
    }

    if (this.session) {
      await this.session.initialize();
    }
  }

  private async connectHttpTransport(
    cfg: Record<string, unknown>,
    _name: string
  ): Promise<void> {
    const url = cfg.url as string;
    const headers = (cfg.headers as Record<string, string>) ?? {};
    const timeout = (cfg.timeout as number) ?? 30;
    const sseReadTimeout = (cfg.sse_read_timeout as number) ?? 300;

    // Quick test connection
    const [success, error] = await quickTestMcpConnection(cfg);
    if (!success) {
      throw new Error(error);
    }

    // Determine transport type
    const transportType =
      (cfg.transport as string) ?? (cfg.type as string) ?? "streamable_http";

    // Create session based on transport type
    // The actual session creation depends on @modelcontextprotocol/sdk
    // This provides a structured approach for integration
    try {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

      if (transportType === "streamable_http") {
        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        const transport = new StreamableHTTPClientTransport(
          new URL(url) as any,
          { headers } as any,
        );
        const client = new Client(
          { name: `agent-mcp-${_name}`, version: "1.0.0" },
          { capabilities: {} }
        );
        await client.connect(transport);
        this.session = wrapMcpClientAsSession(client as any);
      } else {
        // SSE transport
        const { SSEClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/sse.js"
        );
        const transport = new SSEClientTransport(
          new URL(url) as any,
          { headers } as any,
        );
        const client = new Client(
          { name: `agent-mcp-${_name}`, version: "1.0.0" },
          { capabilities: {} }
        );
        await client.connect(transport);
        this.session = wrapMcpClientAsSession(client as any);
      }
    } catch (e) {
      throw new Error(
        `Failed to connect to MCP server via HTTP: ${e}. ` +
        `Make sure @modelcontextprotocol/sdk is installed.`
      );
    }
  }

  private async connectStdioTransport(
    cfg: Record<string, unknown>,
    _name: string
  ): Promise<void> {
    try {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/stdio.js"
      );

      const command = cfg.command as string;
      const args = (cfg.args as string[]) ?? [];
      const env = cfg.env as Record<string, string> | undefined;

      const transport = new StdioClientTransport({
        command,
        args,
        env: env ?? undefined,
      });

      const client = new Client(
        { name: `agent-mcp-${_name}`, version: "1.0.0" },
        { capabilities: {} }
      );
      await client.connect(transport);
      this.session = wrapMcpClientAsSession(client as any);
    } catch (e) {
      throw new Error(
        `Failed to connect to MCP server via stdio: ${e}. ` +
        `Make sure @modelcontextprotocol/sdk is installed.`
      );
    }
  }

  async listToolsAndSave(): Promise<{ tools: MCPToolDefinition[] }> {
    if (!this.session) throw new Error("MCP Client is not initialized");
    const response = await this.session.listTools();
    this.tools = response.tools;
    return response;
  }

  async callToolWithReconnect(
    toolName: string,
    args: Record<string, unknown>,
    readTimeoutSeconds: number
  ): Promise<CallToolResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (!this.session) throw new Error("MCP session not available");
        return await this.session.callTool({
          name: toolName,
          arguments: args,
          readTimeoutSeconds,
        });
      } catch (e) {
        if (isClosedResourceError(e)) {
          await this.reconnect();
          continue;
        }
        throw e;
      }
    }
    throw new Error("MCP tool call failed after reconnection");
  }

  private async reconnect(): Promise<void> {
    if (this.reconnectLock) {
      // Wait for the ongoing reconnection to complete
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!this.reconnecting) {
            resolve();
          } else {
            setTimeout(check, 50);
          }
        };
        check();
      });
      return;
    }

    this.reconnectLock = true;
    this.reconnecting = true;

    try {
      // Save old session for later cleanup
      if (this.session) {
        const oldSession = this.session;
        // Close the old session asynchronously to prevent oldSessions from growing unboundedly
        oldSession.close().catch(() => { /* ignore errors during close */ });
      }

      this.session = null;

      if (this.mcpServerConfig && this.serverName) {
        await this.connectToServer(this.mcpServerConfig, this.serverName);
        await this.listToolsAndSave();
      }
    } finally {
      this.reconnectLock = false;
      this.reconnecting = false;
    }
  }

  async close(): Promise<void> {
    // Close current session
    if (this.session) {
      try {
        await this.session.close();
      } catch {
        // ignore errors during close
      }
      this.session = null;
    }
  }
}

// ---- Helper: Wrap MCP SDK Client as MCPClientSession ----

interface McpSdkClient {
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<CallToolResult>;
  close(): Promise<void>;
}

function wrapMcpClientAsSession(client: McpSdkClient): MCPClientSession {
  return {
    async initialize(): Promise<void> {
      // Client is already connected/initialized after connect()
    },
    async listTools(): Promise<{ tools: MCPToolDefinition[] }> {
      const result = await client.listTools();
      return {
        tools: result.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      };
    },
    async callTool(params: {
      name: string;
      arguments: Record<string, unknown>;
      readTimeoutSeconds?: number;
    }): Promise<CallToolResult> {
      return await client.callTool({
        name: params.name,
        arguments: params.arguments,
      });
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}

// ---- Quick Connection Test ----

export async function quickTestMcpConnection(
  cfg: Record<string, unknown>
): Promise<[boolean, string]> {
  const url = cfg.url as string;
  const headers = (cfg.headers as Record<string, string>) ?? {};
  const timeout = (cfg.timeout as number) ?? 10;

  const transportType =
    (cfg.transport as string) ?? (cfg.type as string) ?? "streamable_http";

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

    if (transportType === "streamable_http") {
      const testPayload = {
        jsonrpc: "2.0",
        method: "initialize",
        id: 0,
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      };
      const response = await fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(testPayload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (response.ok) return [true, ""];
      return [false, `HTTP ${response.status}: ${response.statusText}`];
    } else {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          ...headers,
          Accept: "text/event-stream",
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (response.ok) return [true, ""];
      return [false, `HTTP ${response.status}: ${response.statusText}`];
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return [false, `Connection timeout: ${timeout} seconds`];
    }
    return [false, String(e)];
  }
}
