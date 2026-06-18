import type { ContextWrapper, CallToolResult } from "./types.js";
import { createFunctionTool, type FunctionTool } from "./tool.js";
import type { MCPClient, MCPToolDefinition } from "./mcp-client.js";

export interface MCPToolInstance<TContext = unknown> extends FunctionTool<TContext> {
  mcpTool: MCPToolDefinition;
  mcpClient: MCPClient;
  mcpServerName: string;
}

/**
 * Create an MCPTool - a FunctionTool that delegates execution to an MCP server.
 */
export function createMCPTool<TContext = unknown>(
  mcpTool: MCPToolDefinition,
  mcpClient: MCPClient,
  mcpServerName: string
): MCPToolInstance<TContext> {
  const tool = createFunctionTool<TContext>({
    name: mcpTool.name,
    description: mcpTool.description ?? "",
    parameters: normalizeMcpInputSchema(mcpTool.inputSchema ?? { type: "object", properties: {} }),
    active: true,
    isBackgroundTask: false,
    async call(runContext: ContextWrapper<TContext>, ...kwargs: unknown[]): Promise<CallToolResult> {
      // Collect all kwargs into a single arguments object
      const args: Record<string, unknown> = {};
      for (const kw of kwargs) {
        if (typeof kw === "object" && kw !== null) {
          Object.assign(args, kw);
        }
      }

      return await mcpClient.callToolWithReconnect(
        mcpTool.name,
        args,
        runContext.toolCallTimeout
      );
    },
  });

  return Object.assign(tool, {
    mcpTool,
    mcpClient,
    mcpServerName,
  });
}

/**
 * Normalize common non-standard MCP JSON Schema variants.
 *
 * Some MCP servers incorrectly mark required properties with a boolean
 * `required: true` on the property schema itself. Draft 2020-12 requires the
 * parent object to declare `required` as an array of property names instead.
 * We lift those booleans to the parent object so the schema remains usable.
 */
export function normalizeMcpInputSchema(
  schema: Record<string, unknown>
): Record<string, unknown> {
  return _normalize(structuredClone(schema)) as Record<string, unknown>;
}

function _normalize(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => _normalize(item));
  }

  if (typeof node !== "object" || node === null) {
    return node;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    normalized[key] = _normalize(value);
  }

  const properties = normalized.properties as Record<string, unknown> | undefined;
  if (properties && typeof properties === "object") {
    const originalProperties = (node as Record<string, unknown>).properties as Record<string, unknown> | undefined;
    const required = normalized.required as string[] | undefined;
    const requiredList: string[] = required ? [...required] : [];

    for (const [propName, propSchema] of Object.entries(properties)) {
      if (typeof propSchema !== "object" || propSchema === null) continue;

      const originalPropSchema = (originalProperties?.[propName] ?? {}) as Record<string, unknown>;
      const propRequired = originalPropSchema.required;

      if (typeof propRequired === "boolean") {
        const normalizedProp = propSchema as Record<string, unknown>;
        if (normalizedProp.required === propRequired) {
          delete normalizedProp.required;
        }
        if (propRequired) {
          requiredList.push(propName);
        }
      }
    }

    if (requiredList.length > 0) {
      normalized.required = [...new Set(requiredList)];
    } else if (Array.isArray(required)) {
      delete normalized.required;
    }
  }

  return normalized;
}
