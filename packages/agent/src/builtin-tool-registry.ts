import type { FunctionTool } from "./tool.js";

type FunctionToolConstructor = (new (...args: any[]) => FunctionTool) & { toolName?: string };

export interface BuiltinToolConfigCondition {
  key: string;
  operator: "equals" | "in" | "truthy" | "custom";
  expected?: unknown;
  message: string;
  evaluate(config: Record<string, unknown>): boolean;
}

export interface BuiltinToolConfigRule {
  conditions: BuiltinToolConfigCondition[];
  evaluator?: (config: Record<string, unknown>) => boolean;
  evaluate(config: Record<string, unknown>): boolean;
}

const builtinToolClasses: Map<string, FunctionToolConstructor> = new Map();
const builtinToolConfigRules: Map<string, BuiltinToolConfigRule> = new Map();
let builtinToolsLoaded = false;

export function builtinTool(
  config?: { [toolName: string]: BuiltinToolConfigRule },
): (cls: FunctionToolConstructor) => FunctionToolConstructor {
  return (cls: FunctionToolConstructor) => {
    const name = cls.toolName ?? cls.name;
    builtinToolClasses.set(name, cls);
    if (config) {
      for (const [toolName, rule] of Object.entries(config)) {
        builtinToolConfigRules.set(toolName, rule);
      }
    }
    return cls;
  };
}

export function ensureBuiltinToolsLoaded(): void {
  if (builtinToolsLoaded) return;
  // Import all builtin tool modules to trigger @builtinTool decorators
  builtinToolsLoaded = true;
}

export function getBuiltinToolClass(name: string): FunctionToolConstructor | null {
  return builtinToolClasses.get(name) ?? null;
}

export function getBuiltinToolName(toolCls: FunctionToolConstructor): string | null {
  for (const [name, cls] of builtinToolClasses) {
    if (cls === toolCls) return name;
  }
  return null;
}

export function iterBuiltinToolClasses(): Iterable<FunctionToolConstructor> {
  return builtinToolClasses.values();
}

export function getBuiltinToolConfigRule(name: string): BuiltinToolConfigRule | null {
  return builtinToolConfigRules.get(name) ?? null;
}

export function getBuiltinToolConfigStatuses(
  toolName: string,
  configEntries: Record<string, unknown>[],
): Record<string, boolean> {
  const rule = builtinToolConfigRules.get(toolName);
  if (!rule) return {};
  const statuses: Record<string, boolean> = {};
  for (const config of configEntries) {
    const providerId = (config.id as string) ?? "unknown";
    statuses[providerId] = rule.evaluate(config);
  }
  return statuses;
}
