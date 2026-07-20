/**
 * SQLite-backed memory store with FTS5 full-text search.
 *
 * Supports layered memory architecture:
 * - short_term: current session context, auto-archived on session end
 * - long_term: persistent important info, cross-session retention
 * - persona: behavior preferences and knowledge bound to a specific Persona
 * - user_profile: user preferences, habits, personal info summary
 *
 * Conversation indices are stored in a separate `conversation_indices` table
 * with structured fields (title, topics, conversation_id, timestamp).
 *
 * Memory consolidation: dedup, merge, decay, priority sorting, aging.
 */

import type Database from "better-sqlite3";
import { escapeLike, type Migration } from "@yachiyo/common/database.js";

// ── Types ──

export type MemoryType = "short_term" | "long_term" | "persona" | "user_profile";

export type MemoryScope = "global" | "persona";

export interface MemoryEntry {
  key: string;
  value: string;
  tags: string[];
  memoryType: MemoryType;
  scope: MemoryScope;
  scopeId: string;
  priority: number;
  accessCount: number;
  lastAccessedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryStats {
  total: number;
  byType: Record<MemoryType, number>;
  byScope: Record<MemoryScope, number>;
}

export interface ConversationIndexEntry {
  id: number;
  title: string;
  topics: string[];
  conversationId: string;
  timestamp: string;
  createdAt: string;
}

// ── Migrations ──

export const MEMORY_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "memory_initial",
    up: `
      CREATE TABLE IF NOT EXISTS memories (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_key TEXT NOT NULL,
        tag TEXT NOT NULL,
        FOREIGN KEY (memory_key) REFERENCES memories(key) ON DELETE CASCADE,
        UNIQUE(memory_key, tag)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        key, value, content=memories, content_rowid=rowid
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, key, value) VALUES (NEW.rowid, NEW.key, NEW.value);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, key, value) VALUES('delete', OLD.rowid, OLD.key, OLD.value);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, key, value) VALUES('delete', OLD.rowid, OLD.key, OLD.value);
        INSERT INTO memories_fts(rowid, key, value) VALUES (NEW.rowid, NEW.key, NEW.value);
      END;

      CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
      CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
      CREATE INDEX IF NOT EXISTS idx_memory_tags_memory ON memory_tags(memory_key);
    `,
  },
  {
    version: 2,
    name: "memory_layered_architecture",
    up: `
      -- Add new columns to memories table
      ALTER TABLE memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'long_term';
      ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
      ALTER TABLE memories ADD COLUMN scope_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE memories ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memories ADD COLUMN last_accessed_at TEXT;
      ALTER TABLE memories ADD COLUMN expires_at TEXT;

      -- Indexes for layered queries
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_id);
      CREATE INDEX IF NOT EXISTS idx_memories_type_scope ON memories(memory_type, scope, scope_id);
      CREATE INDEX IF NOT EXISTS idx_memories_priority ON memories(priority DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);
    `,
  },
  {
    version: 3,
    name: "memory_conversation_indices",
    up: `
      -- Separate table for conversation history indices (not memory content)
      CREATE TABLE IF NOT EXISTS conversation_indices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL DEFAULT '',
        topics TEXT NOT NULL DEFAULT '[]',
        conversation_id TEXT NOT NULL DEFAULT '',
        timestamp TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_conv_indices_timestamp ON conversation_indices(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_conv_indices_conversation ON conversation_indices(conversation_id);

      -- Migrate existing history_index memories to the new table
      INSERT OR IGNORE INTO conversation_indices (title, topics, conversation_id, timestamp, created_at)
        SELECT
          COALESCE(json_extract(value, '$.title'), ''),
          COALESCE(json_extract(value, '$.topics'), '[]'),
          COALESCE(json_extract(value, '$.conversation_id'), ''),
          COALESCE(json_extract(value, '$.timestamp'), datetime('now')),
          updated_at
        FROM memories
        WHERE memory_type = 'history_index';

      -- Remove migrated history_index entries from memories table
      DELETE FROM memories WHERE memory_type = 'history_index';
    `,
  },
  {
    version: 4,
    name: "memory_simplify_scopes",
    up: `
      -- Single-user design: collapse session/user scopes into global.
      -- short_term conversation records now live in global scope (the
      -- session id stays embedded in the key for archiveSession lookups).
      UPDATE memories SET scope = 'global', scope_id = '' WHERE scope IN ('session', 'user');
    `,
  },
];

// ── Row Types ──

/** Row type for the memories table. */
interface MemoryRow {
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
  memory_type: MemoryType;
  scope: MemoryScope;
  scope_id: string;
  priority: number;
  access_count: number;
  last_accessed_at: string | null;
  expires_at: string | null;
}

/** Row type for SELECT created_at, access_count FROM memories. */
interface MemoryAccessRow {
  created_at: string;
  access_count: number;
}

/** Row type for SELECT key, created_at FROM memories. */
interface MemoryKeyDateRow {
  key: string;
  created_at: string;
}

/** Row type for SELECT key FROM memories / memories_fts. */
interface MemoryKeyRow {
  key: string;
}

/** Row type for SELECT memory_key FROM memory_tags. */
interface MemoryTagKeyRow {
  memory_key: string;
}

/** Row type for the conversation_indices table. */
interface ConversationIndexRow {
  id: number;
  title: string;
  topics: string;
  conversation_id: string;
  timestamp: string;
  created_at: string;
}

/** Row type for COUNT(*) as cnt queries. */
interface CountRow {
  cnt: number;
}

// ── SqliteMemoryStore ──

export class SqliteMemoryStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Run `fn` inside a single SQLite transaction.
   *
   * `better-sqlite3` is synchronous, so without a transaction every
   * statement triggers its own implicit commit (and an `fsync`). For
   * batch operations like MemoryConsolidator.deduplicate — which issues
   * thousands of SELECTs against `list` and `findSimilar` — that fsync
   * per statement dominates runtime and blocks the event loop for
   * seconds at a time.
   *
   * Wrapping the batch in one transaction eliminates the per-statement
   * fsync and reduces total time by ~10-50x.
   *
   * Nested calls become SAVEPOINTs automatically (better-sqlite3 semantics),
   * so callers don't need to worry about being inside an outer transaction.
   */
  withTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── Core CRUD ──

  /**
   * Save or update a memory entry.
   */
  save(key: string, value: string, tags?: string[], options?: {
    memoryType?: MemoryType;
    scope?: MemoryScope;
    scopeId?: string;
    priority?: number;
    expiresAt?: string | null;
    source?: string;
  }): void {
    const now = new Date().toISOString();
    const memoryType = options?.memoryType ?? "long_term";
    const scope = options?.scope ?? "global";
    const scopeId = options?.scopeId ?? "";
    const priority = options?.priority ?? 0;
    const expiresAt = options?.expiresAt ?? null;

    this.db.transaction(() => {
      const existing = this.db.prepare("SELECT created_at, access_count FROM memories WHERE key = ?").get(key) as MemoryAccessRow;
      const createdAt = existing?.created_at ?? now;
      const accessCount = existing?.access_count ?? 0;

      this.db.prepare(`
        INSERT OR REPLACE INTO memories (key, value, created_at, updated_at, memory_type, scope, scope_id, priority, access_count, last_accessed_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(key, value, createdAt, now, memoryType, scope, scopeId, priority, accessCount, now, expiresAt);

      if (tags !== undefined) {
        this.db.prepare("DELETE FROM memory_tags WHERE memory_key = ?").run(key);
        const insertTag = this.db.prepare("INSERT OR IGNORE INTO memory_tags (memory_key, tag) VALUES (?, ?)");
        for (const tag of tags) {
          insertTag.run(key, tag);
        }
      }
    })();
  }

  /**
   * Recall a memory by key. Increments access_count.
   */
  recall(key: string): MemoryEntry | null {
    const row = this.db.prepare("SELECT key, value, created_at, updated_at, memory_type, scope, scope_id, priority, access_count, last_accessed_at, expires_at FROM memories WHERE key = ?").get(key) as MemoryRow;
    if (!row) return null;

    // Update access stats
    this.db.prepare(`
      UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE key = ?
    `).run(new Date().toISOString(), key);

    // Re-read to get updated access_count
    const updatedRow = this.db.prepare("SELECT key, value, created_at, updated_at, memory_type, scope, scope_id, priority, access_count, last_accessed_at, expires_at FROM memories WHERE key = ?").get(key) as MemoryRow;
    return this.rowToEntry(updatedRow);
  }

  /**
   * Search memories using FTS5 full-text search + tag matching.
   */
  search(query: string, limit: number = 20, options?: {
    memoryType?: MemoryType;
    scope?: MemoryScope;
    scopeId?: string;
  }): MemoryEntry[] {
    const ftsQuery = this.sanitizeFtsQuery(query);
    let keys: string[] = [];

    if (ftsQuery) {
      try {
        const ftsRows = this.db.prepare(`
          SELECT key FROM memories_fts WHERE memories_fts MATCH ? LIMIT ?
        `).all(ftsQuery, limit * 2) as MemoryKeyRow[];
        keys = ftsRows.map((r) => r.key);
      } catch {
        // FTS query syntax error, fall through to LIKE
      }
    }

    // Also search in tags
    const tagRows = this.db.prepare(`
      SELECT DISTINCT memory_key FROM memory_tags WHERE tag LIKE ? ESCAPE '\\' LIMIT ?
    `).all(`%${escapeLike(query)}%`, limit) as MemoryTagKeyRow[];
    for (const r of tagRows) {
      if (!keys.includes(r.memory_key)) {
        keys.push(r.memory_key);
      }
    }

    // If FTS found nothing, fall back to LIKE search
    if (keys.length === 0) {
      const escapedQuery = escapeLike(query);
      const likeRows = this.db.prepare(`
        SELECT key FROM memories WHERE key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\' LIMIT ?
      `).all(`%${escapedQuery}%`, `%${escapedQuery}%`, limit) as MemoryKeyRow[];
      keys = likeRows.map((r) => r.key);
    }

    if (keys.length === 0) return [];

    // Apply type/scope filters
    let whereClause = " AND key NOT LIKE 'system_%'";
    const params: unknown[] = [];
    if (options?.memoryType) {
      whereClause += " AND memory_type = ?";
      params.push(options.memoryType);
    }
    if (options?.scope) {
      whereClause += " AND scope = ?";
      params.push(options.scope);
    }
    if (options?.scopeId) {
      whereClause += " AND scope_id = ?";
      params.push(options.scopeId);
    }

    const placeholders = keys.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT key, value, created_at, updated_at, memory_type, scope, scope_id, priority, access_count, last_accessed_at, expires_at FROM memories WHERE key IN (${placeholders})${whereClause} ORDER BY priority DESC, updated_at DESC LIMIT ?
    `).all(...keys, ...params, limit) as MemoryRow[];

    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * Delete a memory by key.
   */
  delete(key: string): boolean {
    const result = this.db.prepare("DELETE FROM memories WHERE key = ?").run(key);
    return result.changes > 0;
  }

  /**
   * List memories, ordered by most recently updated.
   */
  list(limit: number = 20, options?: {
    memoryType?: MemoryType;
    scope?: MemoryScope;
    scopeId?: string;
  }): MemoryEntry[] {
    let whereClause = " AND key NOT LIKE 'system_%'";
    const params: unknown[] = [];

    if (options?.memoryType) {
      whereClause += " AND memory_type = ?";
      params.push(options.memoryType);
    }
    if (options?.scope) {
      whereClause += " AND scope = ?";
      params.push(options.scope);
    }
    if (options?.scopeId) {
      whereClause += " AND scope_id = ?";
      params.push(options.scopeId);
    }

    const rows = this.db.prepare(`
      SELECT key, value, created_at, updated_at, memory_type, scope, scope_id, priority, access_count, last_accessed_at, expires_at FROM memories WHERE 1=1${whereClause} ORDER BY priority DESC, updated_at DESC LIMIT ?
    `).all(...params, limit) as MemoryRow[];

    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * Count total memories.
   */
  count(options?: {
    memoryType?: MemoryType;
    scope?: MemoryScope;
    scopeId?: string;
  }): number {
    let whereClause = " AND key NOT LIKE 'system_%'";
    const params: unknown[] = [];

    if (options?.memoryType) {
      whereClause += " AND memory_type = ?";
      params.push(options.memoryType);
    }
    if (options?.scope) {
      whereClause += " AND scope = ?";
      params.push(options.scope);
    }
    if (options?.scopeId) {
      whereClause += " AND scope_id = ?";
      params.push(options.scopeId);
    }

    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM memories WHERE 1=1${whereClause}`).get(...params) as CountRow;
    return row?.cnt ?? 0;
  }

  /**
   * Clear all user-visible memories. Preserves internal `system_*` keys
   * (e.g. `system_last_consolidate_time`) so consolidation bookkeeping
   * survives a user-initiated "clear all" action.
   */
  clear(): number {
    const countBefore = this.count();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM memory_tags WHERE memory_key NOT LIKE 'system_%'").run();
      this.db.prepare("DELETE FROM memories WHERE key NOT LIKE 'system_%'").run();
    })();
    return countBefore;
  }

  // ── Layered Memory Operations ──

  /**
   * Get memory statistics by type and scope.
   */
  stats(): MemoryStats {
    const total = this.count();

    const byType = {} as Record<MemoryType, number>;
    const types: MemoryType[] = ["short_term", "long_term", "persona", "user_profile"];
    for (const t of types) {
      byType[t] = this.count({ memoryType: t });
    }

    const byScope = {} as Record<MemoryScope, number>;
    const scopes: MemoryScope[] = ["global", "persona"];
    for (const s of scopes) {
      byScope[s] = this.count({ scope: s });
    }

    return { total, byType, byScope };
  }

  /**
   * Archive short-term memories (promote to long_term or delete).
   * Called when a session ends.
   */
  archiveShortTermMemories(scopeId: string, options?: {
    promoteToLongTerm?: boolean;
    maxAge?: number; // ms, delete if older than this
  }): { promoted: number; deleted: number } {
    const promoteToLongTerm = options?.promoteToLongTerm ?? true;
    const maxAge = options?.maxAge;
    const now = new Date();

    let promoted = 0;
    let deleted = 0;

    this.db.transaction(() => {
      // Find short_term memories for this session by key prefix.
      // Key format: short_term_${umo}_${timestamp}_{user|assistant}
      // (scope is now global for all memories; the session id lives in the key.)
      const prefix = `short_term_${scopeId}_`;
      const query = `SELECT key, created_at FROM memories WHERE memory_type = 'short_term' AND key LIKE ? ESCAPE '\\'`;
      const params: unknown[] = [escapeLike(prefix) + "%"];

      const rows = this.db.prepare(query).all(...params) as MemoryKeyDateRow[];

      for (const row of rows) {
        // Check age-based deletion
        if (maxAge) {
          const age = now.getTime() - new Date(row.created_at).getTime();
          if (age > maxAge) {
            this.db.prepare("DELETE FROM memories WHERE key = ?").run(row.key);
            deleted++;
            continue;
          }
        }

        if (promoteToLongTerm) {
          // Promote to long_term with global scope
          this.db.prepare(`
            UPDATE memories SET memory_type = 'long_term', scope = 'global', scope_id = '', updated_at = ?
            WHERE key = ?
          `).run(now.toISOString(), row.key);
          promoted++;
        } else {
          this.db.prepare("DELETE FROM memories WHERE key = ?").run(row.key);
          deleted++;
        }
      }
    })();

    return { promoted, deleted };
  }

  /**
   * Delete expired memories.
   */
  deleteExpired(): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      "DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?"
    ).run(now);
    return result.changes;
  }

  /**
   * Apply memory aging: demote low-access long_term memories.
   * Memories with access_count below threshold and older than maxAge get deprioritized or archived.
   */
  applyAging(options?: {
    accessThreshold?: number;
    maxAgeDays?: number;
    demotePriority?: number;
  }): { demoted: number; archived: number } {
    const accessThreshold = options?.accessThreshold ?? 1;
    const maxAgeDays = options?.maxAgeDays ?? 90;
    const demotePriority = options?.demotePriority ?? -1;

    const cutoffDate = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
    let demoted = 0;
    let archived = 0;

    this.db.transaction(() => {
      // Demote: lower priority of rarely accessed long_term memories
      const demoteResult = this.db.prepare(`
        UPDATE memories SET priority = ?, updated_at = ?
        WHERE memory_type = 'long_term'
          AND access_count < ?
          AND updated_at < ?
          AND priority > ?
      `).run(demotePriority, new Date().toISOString(), accessThreshold, cutoffDate, demotePriority);
      demoted = demoteResult.changes;

      // Archive: delete very old, inactive, lowest-priority memories
      const archiveCutoff = new Date(Date.now() - maxAgeDays * 2 * 86400000).toISOString();
      const archiveResult = this.db.prepare(`
        DELETE FROM memories
        WHERE memory_type = 'long_term'
          AND priority <= ?
          AND (
            (last_accessed_at IS NOT NULL AND last_accessed_at < ?)
            OR
            (last_accessed_at IS NULL AND created_at < ?)
          )
      `).run(demotePriority, archiveCutoff, archiveCutoff);
      archived = archiveResult.changes;
    })();

    return { demoted, archived };
  }

  /**
   * Find similar memories by key prefix or tag overlap (for dedup/merge).
   */
  findSimilar(key: string, tags: string[], limit: number = 5): MemoryEntry[] {
    const similarKeys = new Set<string>();
    const results: MemoryEntry[] = [];

    // 1. Find by key prefix similarity
    const prefix = key.split("_").slice(0, -1).join("_");
    if (prefix) {
      const prefixRows = this.db.prepare(`
        SELECT key, value, created_at, updated_at, memory_type, scope, scope_id, priority, access_count, last_accessed_at, expires_at FROM memories WHERE key LIKE ? ESCAPE '\\' AND key != ? AND key NOT LIKE 'system_%' LIMIT ?
      `).all(`${escapeLike(prefix)}%`, key, limit) as MemoryRow[];
      for (const r of prefixRows) {
        if (!similarKeys.has(r.key)) {
          similarKeys.add(r.key);
          results.push(this.rowToEntry(r));
        }
      }
    }

    // 2. Find by tag overlap if limit not reached
    if (results.length < limit && tags.length > 0) {
      const tagPlaceholders = tags.map(() => "?").join(",");
      const tagRows = this.db.prepare(`
        SELECT m.key, m.value, m.created_at, m.updated_at, m.memory_type, m.scope, m.scope_id, m.priority, m.access_count, m.last_accessed_at, m.expires_at FROM memories m
        JOIN memory_tags mt ON m.key = mt.memory_key
        WHERE mt.tag IN (${tagPlaceholders}) AND m.key != ? AND m.key NOT LIKE 'system_%'
        GROUP BY m.key
        ORDER BY COUNT(mt.tag) DESC
        LIMIT ?
      `).all(...tags, key, limit - results.length) as MemoryRow[];
      for (const r of tagRows) {
        if (!similarKeys.has(r.key)) {
          similarKeys.add(r.key);
          results.push(this.rowToEntry(r));
        }
      }
    }

    return results;
  }

  /**
   * Merge a memory into an existing one (combines values and tags).
   * Reads rows directly (instead of `recall`) to avoid inflating
   * `access_count` as a side effect of the merge.
   */
  merge(targetKey: string, sourceKey: string, mergedValue: string): boolean {
    const targetRow = this.db.prepare("SELECT key, value, created_at, updated_at, memory_type, scope, scope_id, priority, access_count, last_accessed_at, expires_at FROM memories WHERE key = ?").get(targetKey) as MemoryRow | undefined;
    const sourceRow = this.db.prepare("SELECT key, value, created_at, updated_at, memory_type, scope, scope_id, priority, access_count, last_accessed_at, expires_at FROM memories WHERE key = ?").get(sourceKey) as MemoryRow | undefined;
    if (!targetRow || !sourceRow) return false;
    const target = this.rowToEntry(targetRow);
    const source = this.rowToEntry(sourceRow);

    this.db.transaction(() => {
      // Combine tags
      const mergedTags = [...new Set([...target.tags, ...source.tags])];
      this.db.prepare("DELETE FROM memory_tags WHERE memory_key = ?").run(targetKey);
      const insertTag = this.db.prepare("INSERT OR IGNORE INTO memory_tags (memory_key, tag) VALUES (?, ?)");
      for (const tag of mergedTags) {
        insertTag.run(targetKey, tag);
      }

      // Update value and priority (take max)
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE memories SET value = ?, priority = MAX(priority, ?), updated_at = ?, access_count = access_count + ?
        WHERE key = ?
      `).run(mergedValue, source.priority, now, source.accessCount, targetKey);

      // Delete source
      this.db.prepare("DELETE FROM memories WHERE key = ?").run(sourceKey);
    })();

    return true;
  }

  // ── Conversation Index Operations ──

  /**
   * Add a conversation index entry.
   */
  addConversationIndex(entry: {
    title: string;
    topics: string[];
    conversationId?: string;
    timestamp?: string;
  }): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO conversation_indices (title, topics, conversation_id, timestamp, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      entry.title,
      JSON.stringify(entry.topics),
      entry.conversationId ?? "",
      entry.timestamp ?? now,
      now,
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * List conversation indices, ordered by most recent first.
   */
  listConversationIndices(limit: number = 50): ConversationIndexEntry[] {
    const rows = this.db.prepare(`
      SELECT id, title, topics, conversation_id, timestamp, created_at FROM conversation_indices ORDER BY timestamp DESC LIMIT ?
    `).all(limit) as ConversationIndexRow[];
    return rows.map(r => this.rowToIndexEntry(r));
  }

  /**
   * Search conversation indices by topic or title.
   */
  searchConversationIndices(query: string, limit: number = 20): ConversationIndexEntry[] {
    const likeQuery = `%${escapeLike(query)}%`;
    const rows = this.db.prepare(`
      SELECT id, title, topics, conversation_id, timestamp, created_at FROM conversation_indices
      WHERE title LIKE ? ESCAPE '\\' OR topics LIKE ? ESCAPE '\\'
      ORDER BY timestamp DESC LIMIT ?
    `).all(likeQuery, likeQuery, limit) as ConversationIndexRow[];
    return rows.map(r => this.rowToIndexEntry(r));
  }

  /**
   * Delete a conversation index by id.
   */
  deleteConversationIndex(id: number): boolean {
    const result = this.db.prepare("DELETE FROM conversation_indices WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /**
   * Count conversation indices.
   */
  countConversationIndices(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM conversation_indices").get() as CountRow;
    return row?.cnt ?? 0;
  }

  // ── Helpers ──

  private rowToEntry(row: MemoryRow): MemoryEntry {
    const tags = this.db.prepare(
      "SELECT tag FROM memory_tags WHERE memory_key = ?"
    ).all(row.key) as { tag: string }[];

    return {
      key: row.key,
      value: row.value,
      tags: tags.map((t) => t.tag),
      memoryType: row.memory_type ?? "long_term",
      scope: row.scope ?? "global",
      scopeId: row.scope_id ?? "",
      priority: row.priority ?? 0,
      accessCount: row.access_count ?? 0,
      lastAccessedAt: row.last_accessed_at ?? null,
      expiresAt: row.expires_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Sanitize a query string for FTS5 MATCH syntax.
   * Wraps each word in quotes to avoid syntax errors from special characters.
   */
  private sanitizeFtsQuery(query: string): string {
    const words = query.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "";
    return words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
  }

  private rowToIndexEntry(row: ConversationIndexRow): ConversationIndexEntry {
    let topics: string[] = [];
    try {
      topics = JSON.parse(row.topics ?? "[]");
    } catch { /* keep empty */ }
    return {
      id: row.id,
      title: row.title ?? "",
      topics,
      conversationId: row.conversation_id ?? "",
      timestamp: row.timestamp,
      createdAt: row.created_at,
    };
  }
}
