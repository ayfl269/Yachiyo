import type { ContextWrapper, CallToolResult } from "./types.js";

// Tool schema
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema Draft 2020-12
}

// Tool execution result
export type ToolExecResult = string | CallToolResult;

// Handler function types
export type ToolHandler<TContext = unknown> = (
  event: unknown,
  ...args: unknown[]
) => Promise<ToolExecResult | null> | AsyncGenerator<ToolExecResult | string | null, void, unknown>;

// Function tool
export interface FunctionTool<TContext = unknown> extends ToolSchema {
  handler?: ToolHandler<TContext>;
  handlerModulePath?: string;
  active: boolean;
  isBackgroundTask: boolean;
  call(context: ContextWrapper<TContext>, ...kwargs: unknown[]): Promise<ToolExecResult>;
}

/**
 * Create a FunctionTool instance.
 */
export function createFunctionTool<TContext = unknown>(
  options: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    handler?: ToolHandler<TContext>;
    handlerModulePath?: string;
    active?: boolean;
    isBackgroundTask?: boolean;
    call?: (context: ContextWrapper<TContext>, ...kwargs: unknown[]) => Promise<ToolExecResult>;
  }
): FunctionTool<TContext> {
  const tool: FunctionTool<TContext> = {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    handler: options.handler,
    handlerModulePath: options.handlerModulePath,
    active: options.active ?? true,
    isBackgroundTask: options.isBackgroundTask ?? false,
    call: options.call ?? (async () => {
      throw new Error("FunctionTool.call() must be implemented by subclasses or set a handler.");
    }),
  };
  return tool;
}

// ToolSet - collection of function tools
export class ToolSet {
  tools: FunctionTool[] = [];

  constructor(tools?: FunctionTool[]) {
    if (tools) this.tools = [...tools];
  }

  empty(): boolean {
    return this.tools.length === 0;
  }

  addTool(tool: FunctionTool): void {
    for (let i = 0; i < this.tools.length; i++) {
      if (this.tools[i].name === tool.name) {
        const existingActive = this.tools[i].active ?? true;
        const newActive = tool.active ?? true;
        // Overwrite if new tool is active, or if existing tool is not active
        if (newActive || !existingActive) {
          this.tools[i] = tool;
        }
        return;
      }
    }
    this.tools.push(tool);
  }

  removeTool(name: string): void {
    this.tools = this.tools.filter((tool) => tool.name !== name);
  }

  getTool(name: string): FunctionTool | undefined {
    return this.tools.find((tool) => tool.name === name);
  }

  names(): string[] {
    return this.tools.map((tool) => tool.name);
  }

  merge(other: ToolSet): void {
    for (const tool of other.tools) {
      this.addTool(tool);
    }
  }

  /**
   * Return a light tool set with only name/description (no parameters).
   */
  getLightToolSet(): ToolSet {
    const lightTools: FunctionTool[] = [];
    for (const tool of this.tools) {
      if (!tool.active) continue;
      lightTools.push(
        createFunctionTool({
          name: tool.name,
          parameters: { type: "object", properties: {} },
          description: tool.description,
          handler: undefined,
        })
      );
    }
    return new ToolSet(lightTools);
  }

  /**
   * Return a tool set with name/parameters only (no description).
   */
  getParamOnlyToolSet(): ToolSet {
    const paramTools: FunctionTool[] = [];
    for (const tool of this.tools) {
      if (!tool.active) continue;
      const params = tool.parameters
        ? structuredClone(tool.parameters)
        : { type: "object", properties: {} };
      paramTools.push(
        createFunctionTool({
          name: tool.name,
          parameters: params,
          description: "",
          handler: undefined,
        })
      );
    }
    return new ToolSet(paramTools);
  }

  /**
   * Convert tools to OpenAI API function calling schema format.
   */
  openaiSchema(omitEmptyParameterField = false): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    for (const tool of this.tools) {
      const funcDef: Record<string, unknown> = {
        type: "function",
        function: { name: tool.name },
      };
      if (tool.description) {
        (funcDef.function as Record<string, unknown>).description = tool.description;
      }
      if (tool.parameters != null) {
        const props = (tool.parameters as Record<string, unknown>)?.properties;
        const hasProperties = props && Object.keys(props as Record<string, unknown>).length > 0;
        if (hasProperties || !omitEmptyParameterField) {
          // When properties are empty but we must include parameters, use minimal schema
          if (!hasProperties && !omitEmptyParameterField) {
            (funcDef.function as Record<string, unknown>).parameters = { type: "object", properties: {} };
          } else {
            (funcDef.function as Record<string, unknown>).parameters = tool.parameters;
          }
        }
      }
      result.push(funcDef);
    }
    return result;
  }

  /**
   * Convert tools to Anthropic API format.
   */
  anthropicSchema(): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    for (const tool of this.tools) {
      const inputSchema: Record<string, unknown> = { type: "object" };
      if (tool.parameters) {
        const params = tool.parameters as Record<string, unknown>;
        inputSchema.properties = (params.properties as Record<string, unknown>) ?? {};
        inputSchema.required = (params.required as string[]) ?? [];
      }
      const toolDef: Record<string, unknown> = {
        name: tool.name,
        input_schema: inputSchema,
      };
      if (tool.description) {
        toolDef.description = tool.description;
      }
      result.push(toolDef);
    }
    return result;
  }

  /**
   * Convert tools to Google GenAI API format.
   */
  googleSchema(): Record<string, unknown> {
    const tools: Record<string, unknown>[] = [];
    for (const tool of this.tools) {
      const d: Record<string, unknown> = { name: tool.name };
      if (tool.description) d.description = tool.description;
      if (tool.parameters) d.parameters = convertSchemaForGoogle(tool.parameters);
      tools.push(d);
    }
    const declarations: Record<string, unknown> = {};
    if (tools.length) declarations.functionDeclarations = tools;
    return declarations;
  }

  get length(): number {
    return this.tools.length;
  }

  [Symbol.iterator](): Iterator<FunctionTool> {
    return this.tools[Symbol.iterator]();
  }
}

/**
 * Convert JSON Schema to Gemini API format.
 */
function convertSchemaForGoogle(schema: Record<string, unknown>): Record<string, unknown> {
  const supportedTypes = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);
  const supportedFormats: Record<string, Set<string>> = {
    string: new Set(["enum", "date-time"]),
    integer: new Set(["int32", "int64"]),
    number: new Set(["float", "double"]),
  };
  const supportFields = new Set([
    "title", "description", "enum", "minimum", "maximum",
    "maxItems", "minItems", "nullable", "required",
  ]);

  if ("anyOf" in schema) {
    return { anyOf: ((schema.anyOf as Record<string, unknown>[]) || []).map((s) => convertSchemaForGoogle(s)) };
  }

  const result: Record<string, unknown> = {};
  const originType = schema.type as string | string[] | undefined;
  let targetType: string | undefined;

  if (Array.isArray(originType)) {
    targetType = originType.find((t) => t !== "null") || "string";
  } else {
    targetType = originType;
  }

  if (targetType && supportedTypes.has(targetType)) {
    result.type = targetType;
    if (typeof schema.format === "string" && supportedFormats[targetType]?.has(schema.format)) {
      result.format = schema.format;
    }
  } else {
    result.type = "null";
  }

  for (const key of supportFields) {
    if (key in schema) (result as Record<string, unknown>)[key] = schema[key];
  }

  if ("properties" in schema && typeof schema.properties === "object" && schema.properties !== null) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties as Record<string, unknown>)) {
      const propValue = convertSchemaForGoogle(value as Record<string, unknown>);
      delete (propValue as Record<string, unknown>).default;
      delete (propValue as Record<string, unknown>).additionalProperties;
      properties[key] = propValue;
    }
    if (Object.keys(properties).length > 0) {
      result.properties = properties;
    }
  }

  if (targetType === "array") {
    const itemsSchema = schema.items as Record<string, unknown> | undefined;
    if (itemsSchema && typeof itemsSchema === "object") {
      result.items = convertSchemaForGoogle(itemsSchema);
    } else {
      result.items = { type: "string" };
    }
  }

  return result;
}
