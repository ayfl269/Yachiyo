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

export interface CreateConversationSearchToolOptions {
  /** A store that supports getFilteredConversations (e.g. ConversationStore). */
  store: ConversationSearchStore;
}

// ── Types ──

interface HistoryMessage {
  role: string;
  content: string;
}

interface SearchMatch {
  conversation: ConversationRecord;
  titleMatched: boolean;
  /** Messages that contain the query, with surrounding context. */
  messageExcerpts: MessageExcerpt[];
}

interface MessageExcerpt {
  role: string;
  /** A snippet of the message content around the match, or the full message if short. */
  snippet: string;
  /** True if this message directly contains the query. */
  matched: boolean;
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

/**
 * Create a text snippet around the first occurrence of `query` in `text`.
 * Returns the full text if it's shorter than the snippet window.
 */
function makeSnippet(text: string, query: string, contextChars = 100): string {
  const trimmed = text.trim();
  if (trimmed.length <= contextChars * 2 + 20) return trimmed;

  const lowerText = trimmed.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);

  if (idx === -1) {
    // No match in this message — return beginning
    return trimmed.slice(0, contextChars) + "...";
  }

  const start = Math.max(0, idx - contextChars);
  const end = Math.min(trimmed.length, idx + query.length + contextChars);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < trimmed.length ? "..." : "";
  return prefix + trimmed.slice(start, end) + suffix;
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
  const { store } = options;

  return createFunctionTool<ConversationSearchToolContext>({
    name: "search_conversations",
    description:
      "Search past conversation sessions by keyword. Searches both conversation titles " +
      "and the full content of all messages (user and assistant) within each conversation. " +
      "Returns matching conversations with excerpts showing the matched text in context, " +
      "sorted by most recently updated. Use this to find previous discussions about a topic, " +
      "recall past decisions, or locate information from earlier sessions.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The search keyword or phrase to look for. Case-insensitive. " +
            "Matches against conversation titles and message content.",
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
        // Fetch conversations, optionally filtered by platform.
        // Use getFilteredConversations with a large page size to get all conversations,
        // then search through history content in JavaScript.
        const platformIds = platformId ? [platformId] : undefined;

        // Fetch in pages to avoid loading everything at once if there are many conversations.
        const allMatches: SearchMatch[] = [];
        const pageSize = 100;
        let page = 1;
        let total = Infinity;

        while (allMatches.length < limit && page <= Math.ceil(total / pageSize) + 1) {
          const [conversations, totalCount] = await store.getFilteredConversations({
            page,
            pageSize,
            platformIds,
          });
          total = totalCount;

          for (const conv of conversations) {
            const titleMatched = conv.title.toLowerCase().includes(query.toLowerCase());

            // Search through message history
            const messages = parseHistory(conv.history);
            const messageExcerpts: MessageExcerpt[] = [];
            let contentMatched = false;

            if (includeExcerpts) {
              // Collect excerpts: include matched messages + their immediate context
              for (let i = 0; i < messages.length; i++) {
                const msg = messages[i];
                const isMatch = msg.content.toLowerCase().includes(query.toLowerCase());

                if (isMatch) {
                  contentMatched = true;
                  messageExcerpts.push({
                    role: msg.role,
                    snippet: makeSnippet(msg.content, query),
                    matched: true,
                  });
                  // Also include the previous message for context (if not already matched)
                  if (i > 0 && !messages[i - 1].content.toLowerCase().includes(query.toLowerCase())) {
                    messageExcerpts.push({
                      role: messages[i - 1].role,
                      snippet: makeSnippet(messages[i - 1].content, query),
                      matched: false,
                    });
                  }
                }
              }
            } else {
              // Just check if any message matches, no excerpts
              contentMatched = messages.some(
                (m) => m.content.toLowerCase().includes(query.toLowerCase()),
              );
            }

            if (titleMatched || contentMatched) {
              allMatches.push({
                conversation: conv,
                titleMatched,
                messageExcerpts: includeExcerpts
                  ? messageExcerpts.slice(0, 5) // Limit to 5 excerpts per conversation
                  : [],
              });
            }

            if (allMatches.length >= limit) break;
          }

          if (allMatches.length >= limit) break;
          page++;

          // Safety: don't scan more than 10 pages (1000 conversations)
          if (page > 10) break;
        }

        if (allMatches.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No conversations found matching "${query}".` +
                (platformId ? ` (filtered by platform: ${platformId})` : ""),
            }],
          };
        }

        // Format results
        const lines: string[] = [];
        lines.push(`Found ${allMatches.length} conversation(s) matching "${query}":`);
        lines.push("");

        for (let i = 0; i < allMatches.length; i++) {
          const match = allMatches[i];
          const conv = match.conversation;
          const matchTypes: string[] = [];
          if (match.titleMatched) matchTypes.push("title");
          if (match.messageExcerpts.length > 0 || !includeExcerpts) matchTypes.push("content");
          const msgCount = parseHistory(conv.history).length;

          lines.push(`── ${i + 1}. ${conv.title || "(untitled)"} ──`);
          lines.push(`   ID: ${conv.id}`);
          lines.push(`   Platform: ${conv.platformId || "unknown"}`);
          lines.push(`   Messages: ${msgCount}`);
          lines.push(`   Updated: ${formatDate(conv.updatedAt)}`);
          lines.push(`   Matched: ${matchTypes.join(", ")}`);

          if (includeExcerpts && match.messageExcerpts.length > 0) {
            lines.push("   Excerpts:");
            for (const excerpt of match.messageExcerpts) {
              const marker = excerpt.matched ? ">>>" : "   ";
              lines.push(`   ${marker} [${excerpt.role}] ${excerpt.snippet}`);
            }
          }
          lines.push("");
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
