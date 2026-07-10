/**
 * Proxy management tool: allows the agent to inspect, enable, disable, and
 * test the proxy configuration at runtime.
 *
 * This tool affects all network operations performed by the agent:
 *  - web_fetch_tool, http_request_tool (via undici global dispatcher)
 *  - Web search providers (via global fetch)
 *  - Browser automation tools (Playwright, via proxy option in chromium.launch)
 *
 * The tool uses the singleton `proxyManager` so changes take effect
 * immediately across all network code.
 */

import { createFunctionTool, type FunctionTool } from "./tool.js";
import type { CallToolResult } from "./types.js";
import { proxyManager } from "./proxy-manager.js";

// ── Context type ──

/**
 * Minimal context for the proxy tool. No runtime dependencies are needed
 * because proxyManager is a singleton accessed directly.
 */
export interface ProxyToolContext {
  /** Reserved for future use (e.g. permission checks). */
  event?: {
    unifiedMsgOrigin?: string;
  };
}

// ── Tool factory ──

export function createProxyTool(): FunctionTool<ProxyToolContext> {
  return createFunctionTool<ProxyToolContext>({
    name: "proxy_manage",
    description:
      "Inspect, enable, disable, or test the proxy configuration for all network operations " +
      "(web_fetch, http_request, web_search, browser tools). " +
      "Use action 'get' to check current status, 'set' to enable/update a proxy URL, " +
      "'disable' to turn off the proxy (use direct connection), " +
      "or 'test' to verify connectivity through the current proxy. " +
      "Changes take effect immediately for all subsequent network requests.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get", "set", "disable", "test"],
          description:
            "The action to perform: " +
            "'get' = show current proxy status; " +
            "'set' = enable or update the proxy URL (requires 'url' parameter); " +
            "'disable' = turn off the proxy and use direct connection; " +
            "'test' = test connectivity through the current proxy.",
        },
        url: {
          type: "string",
          description:
            "The proxy URL for action 'set'. " +
            "Supported schemes: http://, https://, socks5://, socks4://. " +
            "Example: 'http://127.0.0.1:7890' or 'socks5://127.0.0.1:1080'. " +
            "If no scheme is given, http:// is assumed.",
        },
        test_url: {
          type: "string",
          description:
            "Optional: URL to test connectivity for action 'test'. " +
            "Defaults to https://httpbin.org/get.",
        },
        timeout: {
          type: "integer",
          description: "Timeout in seconds for action 'test'. Default: 10.",
          minimum: 1,
          maximum: 60,
        },
      },
      required: ["action"],
    },
    active: true,
    handler: async (...args: unknown[]): Promise<CallToolResult> => {
      const action = String(args[1] ?? "").trim();
      const url = args[2] != null ? String(args[2]).trim() : undefined;
      const testUrl = args[3] != null ? String(args[3]).trim() : undefined;
      const timeout = args[4] != null ? Number(args[4]) : 10;

      switch (action) {
        case "get": {
          return handleGet();
        }
        case "set": {
          return handleSet(url);
        }
        case "disable": {
          return handleDisable();
        }
        case "test": {
          return handleTest(testUrl, timeout);
        }
        default:
          return {
            content: [{ type: "text", text: `error: Unknown action '${action}'. Supported actions: get, set, disable, test.` }],
            isError: true,
          };
      }
    },
  });
}

// ── Action handlers ──

function handleGet(): CallToolResult {
  const status = proxyManager.getStatus();
  const lines: string[] = [
    "Current proxy status:",
    `  Enabled: ${status.enabled ? "yes" : "no"}`,
    `  URL: ${status.url ?? "(none — direct connection)"}`,
    `  Source: ${status.source}`,
    "",
    "Notes:",
    "  - When enabled, all fetch() calls and Playwright browser launches route through this proxy.",
    "  - Use action 'set' with a 'url' parameter to enable or change the proxy.",
    "  - Use action 'disable' to turn off the proxy.",
    "  - Use action 'test' to verify connectivity.",
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleSet(url: string | undefined): Promise<CallToolResult> {
  if (!url) {
    return {
      content: [{ type: "text", text: "error: The 'url' parameter is required for action 'set'. Example: http://127.0.0.1:7890" }],
      isError: true,
    };
  }

  // Basic URL validation
  try {
    // Allow scheme-less URLs (http:// is prepended by the manager)
    const normalized = /^[a-z]+:\/\//i.test(url) ? url : `http://${url}`;
    new URL(normalized);
  } catch {
    return {
      content: [{ type: "text", text: `error: Invalid proxy URL '${url}'. Expected format: http://host:port or socks5://host:port` }],
      isError: true,
    };
  }

  await proxyManager.enable(url);
  const status = proxyManager.getStatus();

  const lines: string[] = [
    "Proxy enabled successfully.",
    `  URL: ${status.url}`,
    "",
    "The proxy is now active for:",
    "  - All fetch() requests (web_fetch, http_request, web_search)",
    "  - Playwright browser tools (browser_navigate, etc.)",
    "",
    "Note: If a browser was already open, it has been closed and will relaunch with the proxy on next use.",
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleDisable(): Promise<CallToolResult> {
  const wasEnabled = proxyManager.enabled;
  await proxyManager.disable();

  const lines: string[] = [
    wasEnabled ? "Proxy disabled. Direct connection is now active." : "Proxy was already disabled. No changes made.",
    "",
    "All subsequent network requests will use a direct connection (no proxy).",
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleTest(testUrl: string | undefined, timeoutSec: number): Promise<CallToolResult> {
  const status = proxyManager.getStatus();
  const timeoutMs = Math.min(Math.max(timeoutSec, 1), 60) * 1000;

  const lines: string[] = [
    "Testing connectivity...",
    `  Proxy: ${status.enabled ? status.url : "(disabled — direct connection)"}`,
    `  Test URL: ${testUrl ?? "https://httpbin.org/get"}`,
    `  Timeout: ${timeoutMs / 1000}s`,
    "",
  ];

  const result = await proxyManager.testProxy(testUrl, timeoutMs);

  if (result.ok) {
    lines.push(`Result: SUCCESS`);
    lines.push(`  Status: ${result.statusCode}`);
    lines.push(`  Elapsed: ${result.elapsedMs}ms`);
  } else {
    lines.push(`Result: FAILED`);
    if (result.statusCode) {
      lines.push(`  Status: ${result.statusCode}`);
    }
    lines.push(`  Elapsed: ${result.elapsedMs}ms`);
    lines.push(`  Error: ${result.error}`);
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: !result.ok,
  };
}
