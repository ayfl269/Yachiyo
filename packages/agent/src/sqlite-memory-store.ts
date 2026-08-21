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

/** Memory lifecycle status. Superseded memories are kept for audit/rollback
 *  but excluded from all read paths (recall/search/list/injection). */
export type MemoryStatus = "active" | "superseded";

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
  /** Stable numeric id (primary key). Key may be renamed; id never changes. */
  id?: number;
  status?: MemoryStatus;
  /** Content version — bumped on every content change. */
  memoryVersion?: number;
  /** Version at the last successful long-term consolidation. memory_version > consolidated_version ⇒ dirty. */
  consolidatedVersion?: number;
}

/** A dirty long-term memory pending consolidation, with retry bookkeeping. */
export interface DirtyMemory extends MemoryEntry {
  id: number;
  memoryVersion: number;
  consolidatedVersion: number;
  status: MemoryStatus;
  consolidationRetryCount: number;
  consolidationNextRetryAt: string | null;
}

/** Search hit with cosine similarity (embedding mode). */
export interface SimilarMemoryHit {
  entry: MemoryEntry;
  similarity: number;
}

/** Cached embedding for a memory, keyed by memory id. */
export interface MemoryEmbeddingRow {
  memoryId: number;
  embedding: Buffer;
  model: string;
  dim: number;
  contentHash: string;
}

/** Result of an atomic long-term merge commit. */
export interface LongTermMergeResult {
  ok: boolean;
  reason?: "version_conflict" | "key_conflict" | "not_found";
  targetId?: number;
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
  {
    version: 5,
    name: "memory_long_term_consolidation",
    // Rebuild the memories table to add a stable `id` primary key plus
    // dirty-tracking / lifecycle columns. SQLite cannot ALTER TABLE ADD a
    // PRIMARY KEY column, so this is a full table rebuild.
    //
    // Order matters with foreign_keys=ON:
    //  1. Backup tags (plain table, no FK).
    //  2. Drop memory_tags first — its ON DELETE CASCADE FK would otherwise
    //     wipe the tag rows when the implicit DELETE on DROP TABLE memories
    //     fires FK actions.
    //  3. Drop the FTS table before the rename so the rename never has to
    //     reparse a virtual table whose content= target is temporarily gone.
    //  4. Existing long_term rows are initialized as dirty (version 1,
    //     consolidated 0) so the first job run performs one full pass over
    //     existing memories; other types start clean.
    up: `
      CREATE TABLE memory_tags_backup AS SELECT memory_key, tag FROM memory_tags;

      DROP TABLE memory_tags;
      DROP TABLE IF EXISTS memories_fts;

      CREATE TABLE memories_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT 'long_term',
        scope TEXT NOT NULL DEFAULT 'global',
        scope_id TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 0,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        expires_at TEXT,
        memory_version INTEGER NOT NULL DEFAULT 0,
        consolidated_version INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        superseded_by INTEGER,
        consolidation_retry_count INTEGER NOT NULL DEFAULT 0,
        consolidation_next_retry_at TEXT,
        consolidation_last_error TEXT
      );

      INSERT INTO memories_new (
        key, value, created_at, updated_at, memory_type, scope, scope_id,
        priority, access_count, last_accessed_at, expires_at,
        memory_version, consolidated_version
      )
      SELECT
        key, value, created_at, updated_at, memory_type, scope, scope_id,
        priority, access_count, last_accessed_at, expires_at,
        1,
        CASE WHEN memory_type = 'long_term' THEN 0 ELSE 1 END
      FROM memories;

      DROP TABLE memories;
      ALTER TABLE memories_new RENAME TO memories;

      CREATE TABLE memory_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_key TEXT NOT NULL,
        tag TEXT NOT NULL,
        FOREIGN KEY (memory_key) REFERENCES memories(key) ON DELETE CASCADE,
        UNIQUE(memory_key, tag)
      );

      INSERT INTO memory_tags (memory_key, tag) SELECT memory_key, tag FROM memory_tags_backup;
      DROP TABLE memory_tags_backup;

      CREATE VIRTUAL TABLE memories_fts USING fts5(
        key, value, content=memories, content_rowid=rowid
      );

      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, key, value) VALUES (NEW.rowid, NEW.key, NEW.value);
      END;

      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, key, value) VALUES('delete', OLD.rowid, OLD.key, OLD.value);
      END;

      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, key, value) VALUES('delete', OLD.rowid, OLD.key, OLD.value);
        INSERT INTO memories_fts(rowid, key, value) VALUES (NEW.rowid, NEW.key, NEW.value);
      END;

      INSERT INTO memories_fts(memories_fts) VALUES('rebuild');

      CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_id);
      CREATE INDEX IF NOT EXISTS idx_memories_type_scope ON memories(memory_type, scope, scope_id);
      CREATE INDEX IF NOT EXISTS idx_memories_priority ON memories(priority DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
      CREATE INDEX IF NOT EXISTS idx_memories_dirty ON memories(memory_version, consolidated_version) WHERE memory_version > consolidated_version;
      CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
      CREATE INDEX IF NOT EXISTS idx_memory_tags_memory ON memory_tags(memory_key);
    `,
  },
  {
    version: 6,
    name: "memory_embeddings",
    up: `
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id INTEGER PRIMARY KEY,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model ON memory_embeddings(model, dim);
    `,
  },
  {
    version: 7,
    name: "memory_ltm_schema_repair",
    // Repair migration: an intermediate development build applied a
    // different v5/v6 script shape (recorded versions 5 and 6 but left the
    // pre-LTM schema). Databases where v5/v6 ran with the final script are
    // already correct — detect and no-op there. Pure SQL cannot introspect
    // columns, hence the function form. Runs inside DatabaseManager's
    // transaction.
    up: (db) => {
      const memoryCols = (db.prepare("PRAGMA table_info(memories)").all() as { name: string }[])
        .map((c) => c.name);

      if (!memoryCols.includes("id")) {
        // Old shape: no id primary key / version columns. Rebuild the table
        // (same target schema as v5). Existing rows are preserved; legacy
        // junk columns (source_memory_ids, generated_by, ...) are dropped.
        // superseded_by from the legacy schema referenced keys, not ids —
        // reset it; such rows are excluded from all read paths anyway.
        // Existing long_term rows are initialized dirty for a first full pass.
        db.exec(`
          CREATE TABLE memory_tags_backup AS SELECT memory_key, tag FROM memory_tags;
          DROP TABLE memory_tags;
          DROP TABLE IF EXISTS memories_fts;

          CREATE TABLE memories_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL UNIQUE,
            value TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            memory_type TEXT NOT NULL DEFAULT 'long_term',
            scope TEXT NOT NULL DEFAULT 'global',
            scope_id TEXT NOT NULL DEFAULT '',
            priority INTEGER NOT NULL DEFAULT 0,
            access_count INTEGER NOT NULL DEFAULT 0,
            last_accessed_at TEXT,
            expires_at TEXT,
            memory_version INTEGER NOT NULL DEFAULT 0,
            consolidated_version INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active',
            superseded_by INTEGER,
            consolidation_retry_count INTEGER NOT NULL DEFAULT 0,
            consolidation_next_retry_at TEXT,
            consolidation_last_error TEXT
          );

          INSERT INTO memories_new (
            key, value, created_at, updated_at, memory_type, scope, scope_id,
            priority, access_count, last_accessed_at, expires_at,
            memory_version, consolidated_version, status
          )
          SELECT
            key, value, created_at, updated_at, memory_type, scope, scope_id,
            priority, access_count, last_accessed_at, expires_at,
            1,
            CASE WHEN memory_type = 'long_term' THEN 0 ELSE 1 END,
            status
          FROM memories;

          DROP TABLE memories;
          ALTER TABLE memories_new RENAME TO memories;

          CREATE TABLE memory_tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_key TEXT NOT NULL,
            tag TEXT NOT NULL,
            FOREIGN KEY (memory_key) REFERENCES memories(key) ON DELETE CASCADE,
            UNIQUE(memory_key, tag)
          );

          INSERT INTO memory_tags (memory_key, tag) SELECT memory_key, tag FROM memory_tags_backup;
          DROP TABLE memory_tags_backup;

          CREATE VIRTUAL TABLE memories_fts USING fts5(
            key, value, content=memories, content_rowid=rowid
          );

          CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
            INSERT INTO memories_fts(rowid, key, value) VALUES (NEW.rowid, NEW.key, NEW.value);
          END;

          CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, key, value) VALUES('delete', OLD.rowid, OLD.key, OLD.value);
          END;

          CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, key, value) VALUES('delete', OLD.rowid, OLD.key, OLD.value);
            INSERT INTO memories_fts(rowid, key, value) VALUES (NEW.rowid, NEW.key, NEW.value);
          END;

          INSERT INTO memories_fts(memories_fts) VALUES('rebuild');

          CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
          CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
          CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_id);
          CREATE INDEX IF NOT EXISTS idx_memories_type_scope ON memories(memory_type, scope, scope_id);
          CREATE INDEX IF NOT EXISTS idx_memories_priority ON memories(priority DESC);
          CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);
          CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
          CREATE INDEX IF NOT EXISTS idx_memories_dirty ON memories(memory_version, consolidated_version) WHERE memory_version > consolidated_version;
          CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
          CREATE INDEX IF NOT EXISTS idx_memory_tags_memory ON memory_tags(memory_key);
        `);
      }

      // Legacy memory_embeddings shape (memory_key primary key) from the
      // intermediate build: rebuild with the final schema. Embeddings are a
      // pure cache — dropping rows is safe (recomputed on next job run).
      const embCols = (db.prepare("PRAGMA table_info(memory_embeddings)").all() as { name: string }[])
        .map((c) => c.name);
      if (embCols.length > 0 && !embCols.includes("memory_id")) {
        db.exec(`
          DROP TABLE memory_embeddings;

          CREATE TABLE memory_embeddings (
            memory_id INTEGER PRIMARY KEY,
            embedding BLOB NOT NULL,
            model TEXT NOT NULL,
            dim INTEGER NOT NULL,
            content_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model ON memory_embeddings(model, dim);
        `);
      }
    },
  },
];

// ── Row Types ──

/** Shared column list for SELECTs on the memories table. */
const MEMORY_COLUMNS =
  "id, key, value, created_at, updated_at, memory_type, scope, scope_id, " +
  "priority, access_count, last_accessed_at, expires_at, " +
  "memory_version, consolidated_version, status, superseded_by";

/** Same columns, prefixed for joined queries (alias `m`). */
const MEMORY_COLUMNS_M =
  "m.id, m.key, m.value, m.created_at, m.updated_at, m.memory_type, m.scope, m.scope_id, " +
  "m.priority, m.access_count, m.last_accessed_at, m.expires_at, " +
  "m.memory_version, m.consolidated_version, m.status, m.superseded_by";

/** Row type for the memories table. */
interface MemoryRow {
  id: number;
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
  memory_version: number;
  consolidated_version: number;
  status: MemoryStatus;
  superseded_by: number | null;
}

/** Row type for the dirty-memory query. */
interface DirtyMemoryRow extends MemoryRow {
  consolidation_retry_count: number;
  consolidation_next_retry_at: string | null;
}

/** Row type for SELECT in save() (content-change detection). */
interface MemorySaveRow {
  id: number;
  value: string;
  priority: number;
  memory_type: MemoryType;
  scope: MemoryScope;
  scope_id: string;
  expires_at: string | null;
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
   *
   * Dirty tracking: new rows start at memory_version=1 / consolidated_version=0
   * (dirty). On update, memory_version is bumped ONLY when content actually
   * changed (value / tags / priority / type / scope / expires). Access-stat
   * updates via recall/search never bump the version.
   *
   * The old INSERT OR REPLACE is replaced by an explicit insert/update split:
   * REPLACE deletes + re-inserts the row, which would change the rowid — and
   * the rowid is now the stable `id` referenced by superseded_by and
   * memory_embeddings.
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
      const existing = this.db.prepare(`
        SELECT id, value, priority, memory_type, scope, scope_id, expires_at FROM memories WHERE key = ?
      `).get(key) as MemorySaveRow | undefined;

      if (!existing) {
        this.db.prepare(`
          INSERT INTO memories (
            key, value, created_at, updated_at, memory_type, scope, scope_id,
            priority, access_count, last_accessed_at, expires_at,
            memory_version, consolidated_version, status
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, 0, 'active')
        `).run(key, value, now, now, memoryType, scope, scopeId, priority, now, expiresAt);
      } else {
        let contentChanged =
          existing.value !== value ||
          existing.priority !== priority ||
          existing.memory_type !== memoryType ||
          existing.scope !== scope ||
          existing.scope_id !== scopeId ||
          existing.expires_at !== expiresAt;

        if (tags !== undefined && !contentChanged) {
          const existingTags = new Set(
            (this.db.prepare("SELECT tag FROM memory_tags WHERE memory_key = ?").all(key) as { tag: string }[])
              .map((t) => t.tag),
          );
          const newTags = new Set(tags);
          contentChanged = existingTags.size !== newTags.size
            || [...newTags].some((t) => !existingTags.has(t));
        }

        this.db.prepare(`
          UPDATE memories SET
            value = ?, updated_at = ?, memory_type = ?, scope = ?, scope_id = ?,
            priority = ?, last_accessed_at = ?, expires_at = ?,
            memory_version = memory_version + ?,
            status = CASE WHEN ? = 1 THEN 'active' ELSE status END,
            superseded_by = CASE WHEN ? = 1 THEN NULL ELSE superseded_by END,
            consolidation_retry_count = CASE WHEN ? = 1 THEN 0 ELSE consolidation_retry_count END,
            consolidation_next_retry_at = CASE WHEN ? = 1 THEN NULL ELSE consolidation_next_retry_at END,
            consolidation_last_error = CASE WHEN ? = 1 THEN NULL ELSE consolidation_last_error END
          WHERE key = ?
        `).run(
          value, now, memoryType, scope, scopeId,
          priority, now, expiresAt,
          contentChanged ? 1 : 0,
          contentChanged ? 1 : 0,
          contentChanged ? 1 : 0,
          contentChanged ? 1 : 0,
          contentChanged ? 1 : 0,
          contentChanged ? 1 : 0,
          key,
        );
      }

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
   * Recall a memory by key. Increments access_count (never bumps memory_version).
   * Superseded memories are not returned — their content lives on in the merged row.
   */
  recall(key: string): MemoryEntry | null {
    const row = this.db.prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories WHERE key = ? AND status = 'active'`
    ).get(key) as MemoryRow | undefined;
    if (!row) return null;

    // Update access stats
    this.db.prepare(`
      UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE key = ?
    `).run(new Date().toISOString(), key);

    // Re-read to get updated access_count
    const updatedRow = this.db.prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories WHERE key = ? AND status = 'active'`
    ).get(key) as MemoryRow | undefined;
    return updatedRow ? this.rowToEntry(updatedRow) : null;
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
    let whereClause = " AND key NOT LIKE 'system_%' AND status = 'active'";
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
      SELECT ${MEMORY_COLUMNS} FROM memories WHERE key IN (${placeholders})${whereClause} ORDER BY priority DESC, updated_at DESC LIMIT ?
    `).all(...keys, ...params, limit) as MemoryRow[];

    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * Delete a memory by key. Also removes its cached embedding.
   */
  delete(key: string): boolean {
    const result = this.db.transaction(() => {
      this.db.prepare(`
        DELETE FROM memory_embeddings WHERE memory_id IN (SELECT id FROM memories WHERE key = ?)
      `).run(key);
      return this.db.prepare("DELETE FROM memories WHERE key = ?").run(key);
    })();
    return result.changes > 0;
  }

  /**
   * List memories, ordered by most recently updated. Active only.
   */
  list(limit: number = 20, options?: {
    memoryType?: MemoryType;
    scope?: MemoryScope;
    scopeId?: string;
  }): MemoryEntry[] {
    let whereClause = " AND key NOT LIKE 'system_%' AND status = 'active'";
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
      SELECT ${MEMORY_COLUMNS} FROM memories WHERE 1=1${whereClause} ORDER BY priority DESC, updated_at DESC LIMIT ?
    `).all(...params, limit) as MemoryRow[];

    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * Count memories. Counts active only by default; pass
   * `includeSuperseded: true` for bookkeeping that must match physical rows.
   */
  count(options?: {
    memoryType?: MemoryType;
    scope?: MemoryScope;
    scopeId?: string;
    includeSuperseded?: boolean;
  }): number {
    let whereClause = " AND key NOT LIKE 'system_%'";
    if (!options?.includeSuperseded) {
      whereClause += " AND status = 'active'";
    }
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
    const countBefore = this.count({ includeSuperseded: true });
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM memory_tags WHERE memory_key NOT LIKE 'system_%'").run();
      this.db.prepare(`
        DELETE FROM memory_embeddings WHERE memory_id IN (SELECT id FROM memories WHERE key NOT LIKE 'system_%')
      `).run();
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
          // Promote to long_term with global scope.
          // memory_type change ⇒ content change ⇒ bump version (dirty for LTM consolidation).
          this.db.prepare(`
            UPDATE memories SET memory_type = 'long_term', scope = 'global', scope_id = '', updated_at = ?,
              memory_version = memory_version + 1
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
   * Delete expired memories (and their cached embeddings).
   */
  deleteExpired(): number {
    const now = new Date().toISOString();
    const result = this.db.transaction(() => {
      this.db.prepare(
        "DELETE FROM memory_embeddings WHERE memory_id IN (SELECT id FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?)"
      ).run(now);
      return this.db.prepare(
        "DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?"
      ).run(now);
    })();
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
      // (aging is maintenance — it does NOT bump memory_version, so it never
      // re-dirties memories for the long-term consolidation job)
      const archiveCutoff = new Date(Date.now() - maxAgeDays * 2 * 86400000).toISOString();
      this.db.prepare(`
        DELETE FROM memory_embeddings
        WHERE memory_id IN (
          SELECT id FROM memories
          WHERE memory_type = 'long_term'
            AND priority <= ?
            AND (
              (last_accessed_at IS NOT NULL AND last_accessed_at < ?)
              OR
              (last_accessed_at IS NULL AND created_at < ?)
            )
        )
      `).run(demotePriority, archiveCutoff, archiveCutoff);
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
   * Active memories only — superseded rows are never merge candidates.
   */
  findSimilar(key: string, tags: string[], limit: number = 5): MemoryEntry[] {
    const similarKeys = new Set<string>();
    const results: MemoryEntry[] = [];

    // 1. Find by key prefix similarity
    const prefix = key.split("_").slice(0, -1).join("_");
    if (prefix) {
      const prefixRows = this.db.prepare(`
        SELECT ${MEMORY_COLUMNS} FROM memories WHERE key LIKE ? ESCAPE '\\' AND key != ? AND key NOT LIKE 'system_%' AND status = 'active' LIMIT ?
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
        SELECT ${MEMORY_COLUMNS_M} FROM memories m
        JOIN memory_tags mt ON m.key = mt.memory_key
        WHERE mt.tag IN (${tagPlaceholders}) AND m.key != ? AND m.key NOT LIKE 'system_%' AND m.status = 'active'
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
   *
   * The target's content changes, so its memory_version is bumped (dirty for
   * the long-term consolidation job); the source row is deleted along with
   * both cached embeddings.
   */
  merge(targetKey: string, sourceKey: string, mergedValue: string): boolean {
    const targetRow = this.db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE key = ?`).get(targetKey) as MemoryRow | undefined;
    const sourceRow = this.db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE key = ?`).get(sourceKey) as MemoryRow | undefined;
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

      // Update value and priority (take max); bump version (content changed)
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE memories SET value = ?, priority = MAX(priority, ?), updated_at = ?, access_count = access_count + ?,
          memory_version = memory_version + 1
        WHERE key = ?
      `).run(mergedValue, source.priority, now, source.accessCount, targetKey);

      // Delete source (and both cached embeddings — target content changed)
      this.db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ? OR memory_id = ?").run(sourceRow.id, targetRow.id);
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
      id: row.id,
      status: row.status ?? "active",
      memoryVersion: row.memory_version ?? 0,
      consolidatedVersion: row.consolidated_version ?? 0,
    };
  }

  private rowToDirtyMemory(row: DirtyMemoryRow): DirtyMemory {
    const entry = this.rowToEntry(row);
    return {
      ...entry,
      id: row.id,
      memoryVersion: row.memory_version,
      consolidatedVersion: row.consolidated_version,
      status: row.status,
      consolidationRetryCount: row.consolidation_retry_count ?? 0,
      consolidationNextRetryAt: row.consolidation_next_retry_at ?? null,
    };
  }

  // ── Long-Term Consolidation Support ──

  /**
   * Get dirty long-term memories (memory_version > consolidated_version),
   * oldest-updated first. Excludes system keys, non-long_term types, and
   * superseded rows.
   *
   * Retry gates:
   * - `maxRetries`: memories whose retry count reached this are benched
   *   (kept dirty but not picked up). This cap ALWAYS applies — not even
   *   a force run re-picks exhausted memories (their content change or
   *   resolution via another cluster's commit un-benches them).
   * - `next_retry_at`: memories scheduled for a later retry are skipped
   *   until that time passes (backoff), unless `ignoreRetryGate` (force
   *   run: retry now instead of waiting for the backoff schedule).
   */
  getDirtyLongTermMemories(limit: number, options?: {
    now?: string;
    maxRetries?: number;
    ignoreRetryGate?: boolean;
  }): DirtyMemory[] {
    const now = options?.now ?? new Date().toISOString();
    const maxRetries = options?.maxRetries ?? 3;
    const ignoreRetryGate = options?.ignoreRetryGate ?? false;

    let whereClause = `
      memory_type = 'long_term'
      AND status = 'active'
      AND key NOT LIKE 'system_%'
      AND memory_version > consolidated_version
      AND consolidation_retry_count < ?
    `;
    const params: unknown[] = [maxRetries];
    if (!ignoreRetryGate) {
      whereClause += " AND (consolidation_next_retry_at IS NULL OR consolidation_next_retry_at <= ?)";
      params.push(now);
    }

    const rows = this.db.prepare(`
      SELECT ${MEMORY_COLUMNS}, consolidation_retry_count, consolidation_next_retry_at
      FROM memories WHERE ${whereClause}
      ORDER BY updated_at ASC LIMIT ?
    `).all(...params, limit) as DirtyMemoryRow[];

    return rows.map((r) => this.rowToDirtyMemory(r));
  }

  /** Count dirty long-term memories (same filters as getDirtyLongTermMemories, ignoring retry gates). */
  countDirtyLongTermMemories(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM memories
      WHERE memory_type = 'long_term'
        AND status = 'active'
        AND key NOT LIKE 'system_%'
        AND memory_version > consolidated_version
    `).get() as CountRow;
    return row?.cnt ?? 0;
  }

  /** Active long-term memories (non-system), most recently updated first — the embedding candidate pool. */
  listActiveLongTermMemories(limit: number): MemoryEntry[] {
    const rows = this.db.prepare(`
      SELECT ${MEMORY_COLUMNS} FROM memories
      WHERE memory_type = 'long_term' AND status = 'active' AND key NOT LIKE 'system_%'
      ORDER BY updated_at DESC LIMIT ?
    `).all(limit) as MemoryRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /** Fetch a memory by stable id (any status). */
  getMemoryById(id: number): MemoryEntry | null {
    const row = this.db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined;
    return row ? this.rowToEntry(row) : null;
  }

  /**
   * Optimistically mark memories consolidated: consolidated_version is set to
   * the CURRENT memory_version only when the row's version still equals the
   * version observed when the decision was made. A row modified in the
   * meantime keeps its dirty state (candidate invalidation). Retry
   * bookkeeping is reset on success.
   */
  markConsolidated(ids: Array<{ id: number; version: number }>): number {
    return this.db.transaction(() => {
      const stmt = this.db.prepare(`
        UPDATE memories SET consolidated_version = memory_version,
          consolidation_retry_count = 0, consolidation_next_retry_at = NULL, consolidation_last_error = NULL
        WHERE id = ? AND memory_version = ? AND status = 'active'
      `);
      let changed = 0;
      for (const item of ids) {
        changed += stmt.run(item.id, item.version).changes;
      }
      return changed;
    })();
  }

  /** Record a consolidation failure for one memory with backoff schedule. */
  markConsolidationFailed(id: number, error: string, nextRetryAt: string | null): void {
    this.db.prepare(`
      UPDATE memories SET
        consolidation_retry_count = consolidation_retry_count + 1,
        consolidation_next_retry_at = ?,
        consolidation_last_error = ?
      WHERE id = ?
    `).run(nextRetryAt, error.slice(0, 500), id);
  }

  /** Read consolidation retry bookkeeping for one memory. */
  getConsolidationState(id: number): { retryCount: number; nextRetryAt: string | null; lastError: string | null } {
    const row = this.db.prepare(`
      SELECT consolidation_retry_count, consolidation_next_retry_at, consolidation_last_error
      FROM memories WHERE id = ?
    `).get(id) as
      | { consolidation_retry_count: number; consolidation_next_retry_at: string | null; consolidation_last_error: string | null }
      | undefined;
    if (!row) return { retryCount: 0, nextRetryAt: null, lastError: null };
    return {
      retryCount: row.consolidation_retry_count ?? 0,
      nextRetryAt: row.consolidation_next_retry_at ?? null,
      lastError: row.consolidation_last_error ?? null,
    };
  }

  /**
   * Atomically commit a long-term merge decision.
   *
   * - Optimistic version check: every source row must still be active with
   *   the exact version seen when the candidate was built; otherwise aborts
   *   with `version_conflict` (memories stay dirty — never overwrite newer data).
   * - Target selection: if `merged.key` matches one of the sources, that row is
   *   updated in place (stable id preserved); otherwise a new row is inserted
   *   (key_conflict abort if the key is already taken by an unrelated memory).
   * - Non-target sources become `superseded` (kept for audit, excluded from
   *   all read paths) instead of being deleted.
   * - The merged result is born clean (consolidated_version = memory_version).
   * - Cached embeddings of all involved rows are invalidated.
   */
  commitLongTermMerge(params: {
    sources: Array<{ id: number; version: number }>;
    merged: { key: string; value: string; tags: string[]; priority: number };
  }): LongTermMergeResult {
    return this.db.transaction((): LongTermMergeResult => {
      const { sources, merged } = params;
      if (sources.length < 2) return { ok: false, reason: "not_found" };

      // Load current rows and verify optimistic versions.
      const rows: MemoryRow[] = [];
      for (const src of sources) {
        const row = this.db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`).get(src.id) as MemoryRow | undefined;
        if (!row) return { ok: false, reason: "not_found" };
        if (row.status !== "active" || row.memory_version !== src.version) {
          return { ok: false, reason: "version_conflict" };
        }
        rows.push(row);
      }

      const now = new Date().toISOString();
      const sourceIds = rows.map((r) => r.id);

      // Target: reuse the source row whose key matches, else insert a new row.
      const targetRow = rows.find((r) => r.key === merged.key);
      let targetId: number;

      if (targetRow) {
        targetId = targetRow.id;
        this.db.prepare(`
          UPDATE memories SET
            value = ?, priority = ?, updated_at = ?,
            memory_version = memory_version + 1,
            consolidated_version = memory_version + 1,
            status = 'active', superseded_by = NULL,
            consolidation_retry_count = 0, consolidation_next_retry_at = NULL, consolidation_last_error = NULL
          WHERE id = ?
        `).run(merged.value, merged.priority, now, targetId);
      } else {
        // New key must not collide with any existing active memory (the UNIQUE
        // constraint on key covers superseded rows too).
        const collision = this.db.prepare("SELECT id FROM memories WHERE key = ?").get(merged.key) as { id: number } | undefined;
        if (collision) return { ok: false, reason: "key_conflict" };

        // Carry the scope of the first source (the job only clusters
        // same-scope memories, so all sources agree here).
        const insertResult = this.db.prepare(`
          INSERT INTO memories (
            key, value, created_at, updated_at, memory_type, scope, scope_id,
            priority, access_count, last_accessed_at, expires_at,
            memory_version, consolidated_version, status
          )
          VALUES (?, ?, ?, ?, 'long_term', ?, ?, ?, 0, ?, NULL, 1, 1, 'active')
        `).run(merged.key, merged.value, now, now, rows[0].scope, rows[0].scope_id, merged.priority, now);
        targetId = Number(insertResult.lastInsertRowid);
      }

      // Target tags
      this.db.prepare("DELETE FROM memory_tags WHERE memory_key = ?").run(merged.key);
      const insertTag = this.db.prepare("INSERT OR IGNORE INTO memory_tags (memory_key, tag) VALUES (?, ?)");
      for (const tag of merged.tags) {
        insertTag.run(merged.key, tag);
      }

      // Supersede the other sources (and reset their retry bookkeeping).
      const supersedeStmt = this.db.prepare(`
        UPDATE memories SET
          status = 'superseded', superseded_by = ?,
          consolidated_version = memory_version, updated_at = ?,
          consolidation_retry_count = 0, consolidation_next_retry_at = NULL, consolidation_last_error = NULL
        WHERE id = ?
      `);
      for (const id of sourceIds) {
        if (id !== targetId) supersedeStmt.run(targetId, now, id);
      }

      // Invalidate cached embeddings of every involved row.
      const allIds = [...sourceIds, targetId];
      const placeholders = allIds.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM memory_embeddings WHERE memory_id IN (${placeholders})`).run(...allIds);

      return { ok: true, targetId };
    })();
  }

  // ── Memory Embeddings ──

  /** Get the cached embedding for a memory (null when absent / model / dim / hash mismatch). */
  getMemoryEmbedding(memoryId: number, model: string, dim: number, contentHash: string): MemoryEmbeddingRow | null {
    const row = this.db.prepare(`
      SELECT memory_id, embedding, model, dim, content_hash FROM memory_embeddings
      WHERE memory_id = ? AND model = ? AND dim = ? AND content_hash = ?
    `).get(memoryId, model, dim, contentHash) as MemoryEmbeddingRow | undefined;
    return row ?? null;
  }

  /** Cache (or refresh) the embedding of a memory. */
  saveMemoryEmbedding(memoryId: number, embedding: number[] | Float32Array, model: string, dim: number, contentHash: string): void {
    const buffer = Buffer.from(Float32Array.from(embedding as number[]).buffer);
    this.db.prepare(`
      INSERT INTO memory_embeddings (memory_id, embedding, model, dim, content_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(memory_id) DO UPDATE SET
        embedding = excluded.embedding,
        model = excluded.model,
        dim = excluded.dim,
        content_hash = excluded.content_hash,
        updated_at = datetime('now')
    `).run(memoryId, buffer, model, dim, contentHash);
  }

  /**
   * Brute-force cosine similarity search over cached embeddings of active
   * long-term memories (non-system), filtered by model + dim. Embeddings from
   * a different model are silently skipped (stale until re-embedded).
   */
  searchSimilarLongTermMemories(
    queryEmbedding: number[],
    model: string,
    dim: number,
    options?: { limit?: number; threshold?: number; excludeMemoryId?: number; maxScan?: number },
  ): SimilarMemoryHit[] {
    const limit = options?.limit ?? 5;
    const threshold = options?.threshold ?? 0.75;
    const excludeId = options?.excludeMemoryId ?? -1;
    const maxScan = options?.maxScan ?? 1000;

    const rows = this.db.prepare(`
      SELECT me.memory_id, me.embedding, me.dim, ${MEMORY_COLUMNS_M}
      FROM memory_embeddings me
      JOIN memories m ON m.id = me.memory_id
      WHERE me.model = ? AND me.dim = ?
        AND m.memory_type = 'long_term' AND m.status = 'active' AND m.key NOT LIKE 'system_%'
      LIMIT ?
    `).all(model, dim, maxScan) as Array<MemoryRow & { memory_id: number; embedding: Buffer }>;

    const query = Float32Array.from(queryEmbedding);
    let queryNorm = 0;
    for (let i = 0; i < query.length; i++) queryNorm += query[i] * query[i];
    queryNorm = Math.sqrt(queryNorm);
    if (queryNorm === 0) return [];

    const hits: SimilarMemoryHit[] = [];
    for (const row of rows) {
      if (row.memory_id === excludeId) continue;
      const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      if (vec.length !== query.length) continue;
      let dot = 0;
      let norm = 0;
      for (let i = 0; i < vec.length; i++) {
        dot += vec[i] * query[i];
        norm += vec[i] * vec[i];
      }
      norm = Math.sqrt(norm);
      if (norm === 0) continue;
      const similarity = dot / (norm * queryNorm);
      if (similarity >= threshold) {
        hits.push({ entry: this.rowToEntry(row), similarity });
      }
    }

    hits.sort((a, b) => b.similarity - a.similarity);
    return hits.slice(0, limit);
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
