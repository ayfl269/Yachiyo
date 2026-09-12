/**
 * Conversation search tool: search past conversation sessions by keyword.
 *
 * Searches both conversation titles and full message history (user + assistant
 * messages). Returns matching conversations with excerpts showing the matched
 * text in context, sorted by most recently updated.
 *
 * The tool accepts a ConversationStore (SQLite or in-memory) as a dependency,
 * injected at creation time via createConversationSearchTool().
 */

import { createFunctionTool, type FunctionTool } from "./tool.js";
import type { CallToolResult } from "./types.js";

// ── Context type ──

export interface ConversationSearchToolContext {
  /** The unifiedMsgOrigin of the current session (used for default filtering). */
  event?: {
    unifiedMsgOrigin?: string;
  };
}

// ── Options ──

/**
 * Minimal store interface for conversation search. Defined locally to avoid
 * a circular dependency between the agent and conversation packages.
 * The concrete ConversationStore structurally satisfies this interface.
 */
export interface ConversationSearchStore {
  getFilteredConversations(options: {
    page?: number;
    pageSize?: number;
    platformIds?: string[];
    searchQuery?: string;
  }): Promise<[ConversationRecord[], number]>;
  getConversationById(id: string): Promise<ConversationRecord | null>;
  searchConversationsByContent(
    query: string,
    options: { platformIds?: string[]; limit?: number; offset?: number },
  ): Promise<{ conversationId: string; titleMatched: boolean; contentMatched: boolean; snippet: string }[]>;
}

/** Minimal conversation record shape needed by the search tool. */
export interface ConversationRecord {
  id: string;
  unifiedMsgOrigin: string;
  personaId: string | null;
  history: string;
  platformId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  tokenUsage: number | null;
}

export interface ConversationIndexItem {
  id?: number;
  title: string;
  topics: string[];
  summary?: string;
  conversationId?: string;
  startTime?: string | null;
  endTime?: string | null;
  messageCount?: number;
  createdAt?: string;
}

export interface MemoryIndexStore {
  searchConversationIndices(query: string, limit?: number): ConversationIndexItem[];
}

export interface CreateConversationSearchToolOptions {
  /** A store that supports getFilteredConversations (e.g. ConversationStore). */
  store: ConversationSearchStore;
  /** Optional memory store with high-level conversation indices and summaries. */
  memoryStore?: MemoryIndexStore;
}

// ── Types ──

interface HistoryMessage {
  role: string;
  content: string;
}

// ── Helpers ──

/** Parse the history JSON string into an array of messages. */
function parseHistory(historyJson: string): HistoryMessage[] {
  try {
    const parsed = JSON.parse(historyJson);
    if (Array.isArray(parsed)) return parsed as HistoryMessage[];
  } catch {
    // ignore parse errors
  }
  return [];
}

/** Format a date for display. */
function formatDate(date: Date): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// ── Tool factory ──

export function createConversationSearchTool(
  options: CreateConversationSearchToolOptions,
): FunctionTool<ConversationSearchToolContext> {
  const { store, memoryStore } = options;

  return createFunctionTool<ConversationSearchToolContext>({
    name: "search_conversations",
    description:
      "Search past conversation sessions by keyword. Searches conversation memory indices (summaries, topics) " +
      "as well as the full content of past messages. " +
      "Returns matching conversations with summaries and matched text in context. " +
      "Use this to find previous discussions about a topic, recall past decisions, or locate information from earlier sessions.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The search keyword or phrase to look for. Case-insensitive. " +
            "Matches against conversation titles, topics, summaries, and message content.",
        },
        platform_id: {
          type: "string",
          description: "Optional: filter to conversations from a specific platform (e.g. 'webchat', 'telegram').",
        },
        limit: {
          type: "integer",
          description: "Maximum number of conversations to return. Default: 10. Max: 50.",
          minimum: 1,
          maximum: 50,
          default: 10,
        },
        include_excerpts: {
          type: "boolean",
          description:
            "Whether to include message excerpts showing the matched text in context. " +
            "Set to false for a compact result list (titles only). Default: true.",
          default: true,
        },
      },
      required: ["query"],
    },
    active: true,
    handler: async (...args: unknown[]): Promise<CallToolResult> => {
      // Arguments are positional: (query, platform_id?, limit?, include_excerpts?)
      const query = String(args[0] ?? "").trim();
      const platformId = args[1] != null && args[1] !== "" ? String(args[1]) : undefined;
      const limit = args[2] != null ? Math.min(50, Math.max(1, Number(args[2]))) : 10;
      const includeExcerpts = args[3] != null ? Boolean(args[3]) : true;

      if (!query) {
        return {
          content: [{ type: "text", text: "error: 'query' parameter is required and must not be empty." }],
          isError: true,
        };
      }

      try {
        const platformIds = platformId ? [platformId] : undefined;

        // 1. Search high-level conversation memory indices (summaries, topics) if memoryStore provided
        let indexResults: ConversationIndexItem[] = [];
        if (memoryStore) {
          try {
            indexResults = memoryStore.searchConversationIndices(query, limit);
          } catch (e) {
            console.warn("[ConversationSearchTool] Failed to search memory indices:", e);
          }
        }

        // 2. Use FTS5 search to find matching conversations by title and message content
        const ftsResults = await store.searchConversationsByContent(query, { platformIds, limit });

        if (indexResults.length === 0 && ftsResults.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No conversations found matching "${query}".` +
                (platformId ? ` (filtered by platform: ${platformId})` : ""),
            }],
          };
        }

        const lines: string[] = [];

        // Section A: High-level Conversation Indices
        if (indexResults.length > 0) {
          lines.push(`=== 📑 会话记忆索引 (Memory Indices: ${indexResults.length}) ===`);
          for (let i = 0; i < indexResults.length; i++) {
            const idx = indexResults[i];
            lines.push(`[索引 ${i + 1}] ${idx.title || "(无标题)"}`);
            if (idx.conversationId) lines.push(`   会话ID: ${idx.conversationId}`);
            if (idx.topics && idx.topics.length > 0) lines.push(`   主题标签: ${idx.topics.join(", ")}`);
            if (idx.summary) lines.push(`   摘要: ${idx.summary}`);
            if (idx.startTime || idx.endTime) {
              lines.push(`   时间范围: ${idx.startTime || "未知"} ~ ${idx.endTime || "进行中"}`);
            }
            lines.push("");
          }
        }

        // Section B: Message Content Matches
        if (ftsResults.length > 0) {
          lines.push(`=== 💬 对话原文匹配 (Message Matches: ${ftsResults.length}) ===`);
          for (let i = 0; i < ftsResults.length; i++) {
            const result = ftsResults[i];
            const conv = await store.getConversationById(result.conversationId);
            if (!conv) continue;

            const matchTypes: string[] = [];
            if (result.titleMatched) matchTypes.push("title");
            if (result.contentMatched) matchTypes.push("content");
            const msgCount = parseHistory(conv.history).length;

            lines.push(`── ${i + 1}. ${conv.title || "(untitled)"} ──`);
            lines.push(`   ID: ${conv.id}`);
            lines.push(`   Platform: ${conv.platformId || "unknown"}`);
            lines.push(`   Messages: ${msgCount}`);
            lines.push(`   Updated: ${formatDate(conv.updatedAt)}`);
            lines.push(`   Matched: ${matchTypes.join(", ")}`);

            if (includeExcerpts && result.snippet) {
              lines.push("   Excerpt:");
              lines.push(`   >>> ${result.snippet}`);
            }
            lines.push("");
          }
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `error: Search failed: ${msg}` }],
          isError: true,
        };
      }
    },
  });
}
