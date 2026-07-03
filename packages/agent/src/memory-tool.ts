/**
 * Memory tool: cross-session persistent memory storage with layered architecture.
 * Supports SQLite (with FTS5 search) or JSON file for persistence.
 *
 * Memory types:
 * - short_term: current session context, auto-archived on session end
 * - long_term: persistent important info, cross-session retention
 * - persona: behavior preferences bound to a specific Persona
 * - user_profile: user preferences, habits, personal info
 *
 * Conversation indices are stored separately in conversation_indices table.
 */

import { createFunctionTool, type FunctionTool } from "./tool.js";
import type { ContextWrapper, CallToolResult } from "./types.js";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import type { SqliteMemoryStore, MemoryType, MemoryScope } from "./sqlite-memory-store.js";
import type { MemoryConsolidator } from "./memory-consolidator.js";

// ── Context type ──

export interface MemoryToolContext {
  event?: {
    unifiedMsgOrigin?: string;
    personaId?: string;
  };
  providerSettings?: {
    memory_file_path?: string;
  };
}

function getToolContext(_ctx: unknown): MemoryToolContext {
  const wrapper = _ctx as ContextWrapper<MemoryToolContext> | undefined;
  return wrapper?.context ?? ({} as MemoryToolContext);
}

// ── JSON file store (legacy) ──

interface MemoryEntry {
  key: string;
  value: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

interface MemoryStore {
  entries: Record<string, MemoryEntry>;
}

async function loadStore(filePath: string): Promise<MemoryStore> {
  if (!existsSync(filePath)) {
    return { entries: {} };
  }
  try {
    const data = await readFile(filePath, "utf-8");
    return JSON.parse(data) as MemoryStore;
  } catch {
    return { entries: {} };
  }
}

async function saveStore(filePath: string, store: MemoryStore): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(store, null, 2), "utf-8");
}

function getMemoryFilePath(context: MemoryToolContext, workspaceRoot?: string): string {
  return context.providerSettings?.memory_file_path
    ?? join(workspaceRoot ?? process.cwd(), ".agent", "memory.json");
}

// ── Memory Tool ──

export interface CreateMemoryToolOptions {
  workspaceRoot?: string;
  sqliteStore?: SqliteMemoryStore;
  consolidator?: MemoryConsolidator;
}

export function createMemoryTool(optionsOrRoot?: string | CreateMemoryToolOptions): FunctionTool<MemoryToolContext> {
  const options: CreateMemoryToolOptions = typeof optionsOrRoot === "string"
    ? { workspaceRoot: optionsOrRoot }
    : optionsOrRoot ?? {};

  const sqliteStore = options.sqliteStore;
  const consolidator = options.consolidator;
  const workspaceRoot = options.workspaceRoot;

  return createFunctionTool<MemoryToolContext>({
    name: "memory_tool",
    description:
      "Persistent layered memory storage across sessions. " +
      "Memory types: short_term (session-scoped, auto-archived), long_term (persistent), " +
      "persona (bound to a Persona), user_profile (user preferences). " +
      "Actions: save, recall, search, delete, list, clear, consolidate, stats.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action to perform.",
          enum: ["save", "recall", "search", "delete", "list", "clear", "consolidate", "stats"],
        },
        key: { type: "string", description: "Memory key (for save/recall/delete)." },
        value: { type: "string", description: "Memory value (for save action)." },
        tags: { type: "array", description: "Tags for categorization (for save/search).", items: { type: "string" } },
        query: { type: "string", description: "Search query to match against keys, values, and tags (for search action)." },
        limit: { type: "integer", description: "Maximum number of results for search/list. Default: 20.", minimum: 1, default: 20 },
        memory_type: {
          type: "string",
          description: "Memory type filter. One of: short_term, long_term, persona, user_profile.",
          enum: ["short_term", "long_term", "persona", "user_profile"],
        },
        scope: {
          type: "string",
          description: "Memory scope. One of: global (shared across all sessions), persona (isolated per character).",
          enum: ["global", "persona"],
        },
        scope_id: {
          type: "string",
          description: "Scope identifier (only meaningful when scope is 'persona'; otherwise leave empty).",
        },
        priority: {
          type: "integer",
          description: "Memory priority (0-10, higher = more important). Default: 0.",
          minimum: 0,
          maximum: 10,
        },
      },
      required: ["action"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const action = String(args[0] ?? "");
      const key = args[1] != null ? String(args[1]) : undefined;
      const value = args[2] != null ? String(args[2]) : undefined;
      const tags = (args[3] as string[]) ?? undefined;
      const query = args[4] != null ? String(args[4]) : undefined;
      const limit = args[5] != null ? Number(args[5]) : 20;
      const memoryType = args[6] != null ? String(args[6]) as MemoryType : undefined;
      const scope = args[7] != null ? String(args[7]) as MemoryScope : undefined;
      const scopeId = args[8] != null ? String(args[8]) : undefined;
      const priority = args[9] != null ? Number(args[9]) : undefined;
      const context = getToolContext(_ctx);

      try {
        // Use SQLite store if available
        if (sqliteStore) {
          return handleSqliteAction(sqliteStore, consolidator ?? null, action, key, value, tags, query, limit, memoryType, scope, scopeId, priority, context);
        }

        // Fallback to JSON file store
        const filePath = getMemoryFilePath(context, workspaceRoot);
        return await handleJsonAction(filePath, action, key, value, tags, query, limit);
      } catch (e) {
        return { content: [{ type: "text", text: `error: Memory operation failed: ${e}` }], isError: true };
      }
    },
  });
}

// ── SQLite Action Handler ──

function handleSqliteAction(
  store: SqliteMemoryStore,
  consolidator: MemoryConsolidator | null,
  action: string,
  key?: string,
  value?: string,
  tags?: string[],
  query?: string,
  limit: number = 20,
  memoryType?: MemoryType,
  scope?: MemoryScope,
  scopeId?: string,
  priority?: number,
  context?: MemoryToolContext,
): CallToolResult {
  switch (action) {
    case "save": {
      if (!key || !value) {
        return { content: [{ type: "text", text: "error: 'key' and 'value' are required for save action." }], isError: true };
      }
      // Auto-determine scope from context if not specified
      const resolvedScope = scope ?? (context?.event?.personaId ? "persona" : "global");
      const resolvedScopeId = scopeId ?? (context?.event?.personaId ?? "");
      store.save(key, value, tags, {
        memoryType: memoryType ?? "long_term",
        scope: resolvedScope,
        scopeId: resolvedScopeId,
        priority: priority ?? 0,
      });
      return { content: [{ type: "text", text: `Memory saved: "${key}" (type: ${memoryType ?? "long_term"}, scope: ${resolvedScope})` }] };
    }

    case "recall": {
      if (!key) {
        return { content: [{ type: "text", text: "error: 'key' is required for recall action." }], isError: true };
      }
      const entry = store.recall(key);
      if (!entry) {
        return { content: [{ type: "text", text: `Memory not found: "${key}"` }] };
      }
      const result = `Key: ${entry.key}\nValue: ${entry.value}\nType: ${entry.memoryType}\nScope: ${entry.scope}${entry.scopeId ? `/${entry.scopeId}` : ""}\nPriority: ${entry.priority}\nAccess Count: ${entry.accessCount}\nTags: ${entry.tags.join(", ") || "(none)"}\nCreated: ${entry.createdAt}\nUpdated: ${entry.updatedAt}`;
      return { content: [{ type: "text", text: result }] };
    }

    case "search": {
      const searchQuery = query ?? key ?? "";
      if (!searchQuery) {
        return { content: [{ type: "text", text: "error: 'query' or 'key' is required for search action." }], isError: true };
      }
      const matches = store.search(searchQuery, limit, {
        memoryType,
        scope,
        scopeId,
      });
      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No memories matching "${searchQuery}".` }] };
      }
      const formatted = matches
        .map((entry, i) => `${i + 1}. [${entry.key}] (${entry.memoryType}/${entry.scope}) ${entry.value.slice(0, 200)}${entry.value.length > 200 ? "..." : ""}\n   Tags: ${entry.tags.join(", ") || "(none)"} | Priority: ${entry.priority} | Updated: ${entry.updatedAt}`)
        .join("\n\n");
      return { content: [{ type: "text", text: `Found ${matches.length} result(s):\n\n${formatted}` }] };
    }

    case "delete": {
      if (!key) {
        return { content: [{ type: "text", text: "error: 'key' is required for delete action." }], isError: true };
      }
      const deleted = store.delete(key);
      if (!deleted) {
        return { content: [{ type: "text", text: `Memory not found: "${key}"` }], isError: true };
      }
      return { content: [{ type: "text", text: `Memory deleted: "${key}"` }] };
    }

    case "list": {
      const entries = store.list(limit, {
        memoryType,
        scope,
        scopeId,
      });
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No memories stored." }] };
      }
      const total = store.count({ memoryType, scope, scopeId });
      const formatted = entries
        .map((entry, i) => `${i + 1}. [${entry.key}] (${entry.memoryType}/${entry.scope}) ${entry.value.slice(0, 100)}${entry.value.length > 100 ? "..." : ""}\n   Tags: ${entry.tags.join(", ") || "(none)"} | Priority: ${entry.priority} | Updated: ${entry.updatedAt}`)
        .join("\n\n");
      return { content: [{ type: "text", text: `${entries.length} memory entries (total: ${total}):\n\n${formatted}` }] };
    }

    case "clear": {
      const count = store.clear();
      return { content: [{ type: "text", text: `Cleared ${count} memory entries.` }] };
    }

    case "consolidate": {
      if (!consolidator) {
        return { content: [{ type: "text", text: "error: Memory consolidator is not available." }], isError: true };
      }
      // Run consolidation asynchronously and return immediately
      consolidator.consolidate({ force: true }).then((result) => {
        console.log(`[MemoryTool] Manual consolidation complete:`, result);
      }).catch((e) => {
        console.error(`[MemoryTool] Manual consolidation failed:`, e);
      });
      return { content: [{ type: "text", text: "Memory consolidation triggered. Results will be logged." }] };
    }

    case "stats": {
      const stats = store.stats();
      const lines = [
        `Total memories: ${stats.total}`,
        ``,
        `By Type:`,
        ...Object.entries(stats.byType).map(([type, count]) => `  ${type}: ${count}`),
        ``,
        `By Scope:`,
        ...Object.entries(stats.byScope).map(([scope, count]) => `  ${scope}: ${count}`),
      ];
      if (consolidator) {
        const config = consolidator.getConfig();
        lines.push("", `Consolidation: ${config.enabled ? "enabled" : "disabled"}`, `  Interval: ${config.interval}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    default:
      return { content: [{ type: "text", text: `error: Unknown action: "${action}". Valid actions: save, recall, search, delete, list, clear, consolidate, stats.` }], isError: true };
  }
}

// ── JSON File Action Handler (legacy) ──

async function handleJsonAction(
  filePath: string,
  action: string,
  key?: string,
  value?: string,
  tags?: string[],
  query?: string,
  limit: number = 20,
): Promise<CallToolResult> {
  const store = await loadStore(filePath);
  const now = new Date().toISOString();

  switch (action) {
    case "save": {
      if (!key || !value) {
        return { content: [{ type: "text", text: "error: 'key' and 'value' are required for save action." }], isError: true };
      }
      const existing = store.entries[key];
      store.entries[key] = {
        key,
        value,
        tags: tags ?? existing?.tags ?? [],
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      await saveStore(filePath, store);
      return { content: [{ type: "text", text: `Memory saved: "${key}"` }] };
    }

    case "recall": {
      if (!key) {
        return { content: [{ type: "text", text: "error: 'key' is required for recall action." }], isError: true };
      }
      const entry = store.entries[key];
      if (!entry) {
        return { content: [{ type: "text", text: `Memory not found: "${key}"` }] };
      }
      const result = `Key: ${entry.key}\nValue: ${entry.value}\nTags: ${entry.tags.join(", ") || "(none)"}\nCreated: ${entry.created_at}\nUpdated: ${entry.updated_at}`;
      return { content: [{ type: "text", text: result }] };
    }

    case "search": {
      const searchQuery = query ?? key ?? "";
      if (!searchQuery) {
        return { content: [{ type: "text", text: "error: 'query' or 'key' is required for search action." }], isError: true };
      }
      const lowerQuery = searchQuery.toLowerCase();
      const matches = Object.values(store.entries).filter((entry) => {
        return entry.key.toLowerCase().includes(lowerQuery)
          || entry.value.toLowerCase().includes(lowerQuery)
          || entry.tags.some((t) => t.toLowerCase().includes(lowerQuery));
      }).slice(0, limit);

      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No memories matching "${searchQuery}".` }] };
      }

      const formatted = matches
        .map((entry, i) => `${i + 1}. [${entry.key}] ${entry.value.slice(0, 200)}${entry.value.length > 200 ? "..." : ""}\n   Tags: ${entry.tags.join(", ") || "(none)"} | Updated: ${entry.updated_at}`)
        .join("\n\n");

      return { content: [{ type: "text", text: `Found ${matches.length} result(s):\n\n${formatted}` }] };
    }

    case "delete": {
      if (!key) {
        return { content: [{ type: "text", text: "error: 'key' is required for delete action." }], isError: true };
      }
      if (!store.entries[key]) {
        return { content: [{ type: "text", text: `Memory not found: "${key}"` }], isError: true };
      }
      delete store.entries[key];
      await saveStore(filePath, store);
      return { content: [{ type: "text", text: `Memory deleted: "${key}"` }] };
    }

    case "list": {
      const entries = Object.values(store.entries)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, limit);

      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No memories stored." }] };
      }

      const formatted = entries
        .map((entry, i) => `${i + 1}. [${entry.key}] ${entry.value.slice(0, 100)}${entry.value.length > 100 ? "..." : ""}\n   Tags: ${entry.tags.join(", ") || "(none)"} | Updated: ${entry.updated_at}`)
        .join("\n\n");

      return { content: [{ type: "text", text: `${entries.length} memory entries (total: ${Object.keys(store.entries).length}):\n\n${formatted}` }] };
    }

    case "clear": {
      const count = Object.keys(store.entries).length;
      store.entries = {};
      await saveStore(filePath, store);
      return { content: [{ type: "text", text: `Cleared ${count} memory entries.` }] };
    }

    case "consolidate":
    case "stats":
      return { content: [{ type: "text", text: `error: "${action}" action requires SQLite store. Upgrade to SQLite for layered memory features.` }], isError: true };

    default:
      return { content: [{ type: "text", text: `error: Unknown action: "${action}". Valid actions: save, recall, search, delete, list, clear, consolidate, stats.` }], isError: true };
  }
}
