/**
 * SQLite implementation of ConversationStore.
 *
 * Manages tables: conversations, platform_message_history, webchat_threads,
 * attachments, api_keys, platform_sessions, platform_stats, provider_stats,
 * session_conversations, preferences, command_configs.
 */

import type Database from "better-sqlite3";
import type { ConversationRecord } from "./manager.js";
import {
  ConversationStore,
  type PlatformMessageHistory,
  type WebchatThread,
  type Attachment,
  type ApiKey,
  type Preference,
  type CommandConfig,
  type PlatformSession,
  type PlatformStats,
  type ProviderStat,
} from "./store.js";
import type { Migration } from "@yachiyo/common/database.js";

// ── Migrations ──

export const CHAT_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: `
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        unified_msg_origin TEXT NOT NULL,
        persona_id TEXT,
        history TEXT NOT NULL DEFAULT '[]',
        platform_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        token_usage INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_message_history (
        id TEXT PRIMARY KEY,
        platform_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        llm_checkpoint_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webchat_threads (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        scopes JSON,
        created_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS platform_sessions (
        id TEXT PRIMARY KEY,
        platform_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        provider_id TEXT,
        persona_id TEXT,
        config JSON NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS platform_stats (
        id TEXT PRIMARY KEY,
        platform_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        metadata JSON NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS provider_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        token_input_other INTEGER NOT NULL DEFAULT 0,
        token_input_cached INTEGER NOT NULL DEFAULT 0,
        token_output INTEGER NOT NULL DEFAULT 0,
        start_time REAL NOT NULL DEFAULT 0.0,
        end_time REAL NOT NULL DEFAULT 0.0,
        time_to_first_token REAL NOT NULL DEFAULT 0.0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_conversations (
        unified_msg_origin TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        namespace TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS command_configs (
        command_name TEXT PRIMARY KEY,
        config JSON NOT NULL DEFAULT '{}'
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_conversations_platform
        ON conversations(platform_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_conversations_persona
        ON conversations(persona_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_umo
        ON conversations(unified_msg_origin);
      CREATE INDEX IF NOT EXISTS idx_pmh_platform_user
        ON platform_message_history(platform_id, user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_provider_stats_provider
        ON provider_stats(provider_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_platform_stats_platform
        ON platform_stats(platform_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash
        ON api_keys(key_hash);
    `,
  },
];

// ── SqliteConversationStore ──

export class SqliteConversationStore extends ConversationStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    super();
    this.db = db;
  }

  async initialize(): Promise<void> {
    // Migrations are applied externally via DatabaseManager.migrate()
  }

  async close(): Promise<void> {
    // Database lifecycle managed by DatabaseManager
  }

  // === Conversation ===

  async createConversation(conversation: ConversationRecord): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO conversations
        (id, unified_msg_origin, persona_id, history, platform_id, title, token_usage, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversation.id,
      conversation.unifiedMsgOrigin,
      conversation.personaId,
      conversation.history,
      conversation.platformId,
      conversation.title,
      conversation.tokenUsage,
      conversation.createdAt.toISOString(),
      conversation.updatedAt.toISOString(),
    );
  }

  async getConversationById(id: string): Promise<ConversationRecord | null> {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as any;
    return row ? this.rowToConversation(row) : null;
  }

  async getAllConversations(): Promise<ConversationRecord[]> {
    const rows = this.db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC").all() as any[];
    return rows.map((r) => this.rowToConversation(r));
  }

  async getFilteredConversations(options: {
    page?: number;
    pageSize?: number;
    platformIds?: string[];
    searchQuery?: string;
  }): Promise<[ConversationRecord[], number]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.platformIds?.length) {
      const placeholders = options.platformIds.map(() => "?").join(",");
      conditions.push(`platform_id IN (${placeholders})`);
      params.push(...options.platformIds);
    }

    if (options.searchQuery) {
      conditions.push("(title LIKE ? OR unified_msg_origin LIKE ?)");
      const like = `%${options.searchQuery}%`;
      params.push(like, like);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Count total
    const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM conversations ${where}`).get(...params) as any;
    const total: number = countRow?.cnt ?? 0;

    // Paginate
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    const rows = this.db.prepare(
      `SELECT * FROM conversations ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset) as any[];

    return [rows.map((r) => this.rowToConversation(r)), total];
  }

  async updateConversation(id: string, updates: Partial<ConversationRecord>): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.unifiedMsgOrigin !== undefined) { setClauses.push("unified_msg_origin = ?"); params.push(updates.unifiedMsgOrigin); }
    if (updates.personaId !== undefined) { setClauses.push("persona_id = ?"); params.push(updates.personaId); }
    if (updates.history !== undefined) { setClauses.push("history = ?"); params.push(updates.history); }
    if (updates.platformId !== undefined) { setClauses.push("platform_id = ?"); params.push(updates.platformId); }
    if (updates.title !== undefined) { setClauses.push("title = ?"); params.push(updates.title); }
    if (updates.tokenUsage !== undefined) { setClauses.push("token_usage = ?"); params.push(updates.tokenUsage); }

    // Always update timestamp
    setClauses.push("updated_at = ?");
    params.push(updates.updatedAt?.toISOString() ?? new Date().toISOString());

    if (setClauses.length === 0) return;
    params.push(id);

    this.db.prepare(`UPDATE conversations SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);
  }

  async deleteConversation(id: string): Promise<void> {
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  }

  // === Platform Message History ===

  async insertPlatformMessageHistory(record: PlatformMessageHistory): Promise<void> {
    this.db.prepare(`
      INSERT INTO platform_message_history
        (id, platform_id, user_id, sender_id, sender_name, content, llm_checkpoint_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.platformId,
      record.userId,
      record.senderId,
      record.senderName,
      record.content,
      record.llmCheckpointId,
      record.createdAt.toISOString(),
    );
  }

  async getPlatformMessageHistory(options: {
    platformId: string;
    userId: string;
    limit?: number;
  }): Promise<PlatformMessageHistory[]> {
    const limit = options.limit ?? 100;
    const rows = this.db.prepare(`
      SELECT * FROM platform_message_history
      WHERE platform_id = ? AND user_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(options.platformId, options.userId, limit) as any[];

    return rows.reverse().map((r) => ({
      id: r.id,
      platformId: r.platform_id,
      userId: r.user_id,
      senderId: r.sender_id,
      senderName: r.sender_name,
      content: r.content,
      llmCheckpointId: r.llm_checkpoint_id,
      createdAt: new Date(r.created_at),
    }));
  }

  async getMessageCount(options?: { since?: Date }): Promise<number> {
    if (options?.since) {
      const row = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM conversations, json_each(history) WHERE json_extract(value, '$.role') = 'user' AND updated_at >= ?`
      ).get(options.since.toISOString()) as any;
      return row?.cnt ?? 0;
    }
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM conversations, json_each(history) WHERE json_extract(value, '$.role') = 'user'`
    ).get() as any;
    return row?.cnt ?? 0;
  }

  // === WebChat Thread ===

  async createWebchatThread(thread: WebchatThread): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO webchat_threads (id, session_id, title, created_at)
      VALUES (?, ?, ?, ?)
    `).run(thread.id, thread.sessionId, thread.title, thread.createdAt.toISOString());
  }

  async getWebchatThread(threadId: string): Promise<WebchatThread | null> {
    const row = this.db.prepare("SELECT * FROM webchat_threads WHERE id = ?").get(threadId) as any;
    if (!row) return null;
    return { id: row.id, sessionId: row.session_id, title: row.title, createdAt: new Date(row.created_at) };
  }

  async deleteWebchatThread(threadId: string): Promise<void> {
    this.db.prepare("DELETE FROM webchat_threads WHERE id = ?").run(threadId);
  }

  // === Attachment ===

  async insertAttachment(attachment: Attachment): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO attachments (id, url, name, size, type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(attachment.id, attachment.url, attachment.name, attachment.size, attachment.type, attachment.createdAt.toISOString());
  }

  async getAttachment(id: string): Promise<Attachment | null> {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as any;
    if (!row) return null;
    return { id: row.id, url: row.url, name: row.name, size: row.size, type: row.type, createdAt: new Date(row.created_at) };
  }

  // === API Key ===

  async createApiKey(key: ApiKey): Promise<void> {
    this.db.prepare(`
      INSERT INTO api_keys
        (id, key_hash, key_prefix, name, scopes, created_by, created_at, last_used_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      key.id,
      key.keyHash,
      key.keyPrefix,
      key.name,
      key.scopes ? JSON.stringify(key.scopes) : null,
      key.createdBy,
      key.createdAt.toISOString(),
      key.lastUsedAt?.toISOString() ?? null,
      key.expiresAt?.toISOString() ?? null,
      key.revokedAt?.toISOString() ?? null,
    );
  }

  async listApiKeys(): Promise<ApiKey[]> {
    const rows = this.db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all() as any[];
    return rows.map((r) => this.rowToApiKey(r));
  }

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | null> {
    const row = this.db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(keyHash) as any;
    return row ? this.rowToApiKey(row) : null;
  }

  async revokeApiKey(keyId: string): Promise<void> {
    this.db.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?").run(keyId);
  }

  // === Preference ===

  async insertOrUpdatePreference(preference: Preference): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO preferences (key, value, namespace) VALUES (?, ?, ?)
    `).run(preference.key, preference.value, preference.namespace);
  }

  async getPreference(key: string): Promise<Preference | null> {
    const row = this.db.prepare("SELECT * FROM preferences WHERE key = ?").get(key) as any;
    if (!row) return null;
    return { key: row.key, value: row.value, namespace: row.namespace };
  }

  async removePreference(key: string): Promise<void> {
    this.db.prepare("DELETE FROM preferences WHERE key = ?").run(key);
  }

  // === Command Config ===

  async getCommandConfig(commandName: string): Promise<CommandConfig | null> {
    const row = this.db.prepare("SELECT * FROM command_configs WHERE command_name = ?").get(commandName) as any;
    if (!row) return null;
    return { commandName: row.command_name, config: JSON.parse(row.config) };
  }

  async upsertCommandConfig(config: CommandConfig): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO command_configs (command_name, config) VALUES (?, ?)
    `).run(config.commandName, JSON.stringify(config.config));
  }

  // === Platform Session ===

  async createPlatformSession(session: PlatformSession): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO platform_sessions
        (id, platform_id, session_id, provider_id, persona_id, config)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.platformId,
      session.sessionId,
      session.providerId,
      session.personaId,
      JSON.stringify(session.config),
    );
  }

  async getPlatformSession(sessionId: string): Promise<PlatformSession | null> {
    const row = this.db.prepare("SELECT * FROM platform_sessions WHERE session_id = ?").get(sessionId) as any;
    if (!row) return null;
    return {
      id: row.id,
      platformId: row.platform_id,
      sessionId: row.session_id,
      providerId: row.provider_id,
      personaId: row.persona_id,
      config: JSON.parse(row.config),
    };
  }

  async updatePlatformSession(sessionId: string, updates: Partial<PlatformSession>): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.providerId !== undefined) { setClauses.push("provider_id = ?"); params.push(updates.providerId); }
    if (updates.personaId !== undefined) { setClauses.push("persona_id = ?"); params.push(updates.personaId); }
    if (updates.config !== undefined) { setClauses.push("config = ?"); params.push(JSON.stringify(updates.config)); }

    if (setClauses.length === 0) return;
    params.push(sessionId);

    this.db.prepare(`UPDATE platform_sessions SET ${setClauses.join(", ")} WHERE session_id = ?`).run(...params);
  }

  // === Stats ===

  async insertProviderStat(stat: ProviderStat): Promise<void> {
    this.db.prepare(`
      INSERT INTO provider_stats
        (provider_id, model, token_input_other, token_input_cached, token_output,
         start_time, end_time, time_to_first_token, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      stat.providerId,
      stat.model,
      stat.tokenInputOther,
      stat.tokenInputCached,
      stat.tokenOutput,
      stat.startTime,
      stat.endTime,
      stat.timeToFirstToken,
      stat.createdAt.toISOString(),
    );
  }

  async insertPlatformStats(stat: PlatformStats): Promise<void> {
    this.db.prepare(`
      INSERT INTO platform_stats (id, platform_id, event_type, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      stat.id,
      stat.platformId,
      stat.eventType,
      stat.timestamp.toISOString(),
      JSON.stringify(stat.metadata),
    );
  }

  async getProviderStats(options?: { since?: Date; limit?: number }): Promise<ProviderStat[]> {
    const limit = options?.limit ?? 1000;
    const rows = options?.since
      ? this.db.prepare(`
        SELECT * FROM provider_stats
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(options.since.toISOString(), limit)
      : this.db.prepare(`
        SELECT * FROM provider_stats
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit);
    return (rows as any[]).map(row => this.rowToProviderStat(row));
  }

  // === Session Conversations ===

  async setSessionConversation(umo: string, conversationId: string): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO session_conversations
        (unified_msg_origin, conversation_id, updated_at)
      VALUES (?, ?, datetime('now'))
    `).run(umo, conversationId);
  }

  async getSessionConversation(umo: string): Promise<string | null> {
    const row = this.db.prepare(
      "SELECT conversation_id FROM session_conversations WHERE unified_msg_origin = ?"
    ).get(umo) as any;
    return row?.conversation_id ?? null;
  }

  async deleteSessionConversation(umo: string): Promise<void> {
    this.db.prepare("DELETE FROM session_conversations WHERE unified_msg_origin = ?").run(umo);
  }

  // ── Row Mapping Helpers ──

  private rowToProviderStat(row: any): ProviderStat {
    return {
      id: row.id,
      providerId: row.provider_id,
      model: row.model,
      tokenInputOther: row.token_input_other,
      tokenInputCached: row.token_input_cached,
      tokenOutput: row.token_output,
      startTime: row.start_time,
      endTime: row.end_time,
      timeToFirstToken: row.time_to_first_token,
      createdAt: new Date(row.created_at),
    };
  }

  private rowToConversation(row: any): ConversationRecord {
    return {
      id: row.id,
      unifiedMsgOrigin: row.unified_msg_origin,
      personaId: row.persona_id,
      history: row.history,
      platformId: row.platform_id,
      title: row.title,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      tokenUsage: row.token_usage,
    };
  }

  private rowToApiKey(row: any): ApiKey {
    return {
      id: row.id,
      keyHash: row.key_hash,
      keyPrefix: row.key_prefix,
      name: row.name,
      scopes: row.scopes ? JSON.parse(row.scopes) : null,
      createdBy: row.created_by,
      createdAt: new Date(row.created_at),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
      revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    };
  }
}
