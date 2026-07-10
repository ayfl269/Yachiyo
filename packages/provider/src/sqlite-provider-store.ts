/**
 * SQLite store for Provider configurations.
 *
 * Persists provider configs and MCP server configs to config.db,
 * enabling cross-restart persistence of runtime-loaded providers.
 */

import type Database from "better-sqlite3";
import type { Migration } from "@yachiyo/common/database.js";
import { encryptSecret, decryptSecret } from "@yachiyo/common/secret-crypto.js";

/**
 * Field names inside `provider_configs.config` JSON that hold secrets.
 *
 * This list MUST stay in sync with `ProviderManager.SECRET_KEYS` in `manager.ts`.
 * Both lists are kept duplicated (rather than shared) to avoid a circular import
 * between `manager.ts` and this store module. When you update one, update the other.
 */
const SECRET_FIELDS = [
  "apiKey", "api_key",
  "apiSecret", "api_secret",
  "secretKey", "secret_key",
  "secret",
  "token",
  "accessToken", "access_token",
  "refreshToken", "refresh_token",
  "password", "passwd",
  "key",
] as const;

// ── Migrations ──

export const PROVIDER_CONFIG_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "provider_configs_initial",
    up: `
      CREATE TABLE IF NOT EXISTS provider_configs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        config JSON NOT NULL DEFAULT '{}',
        is_default INTEGER NOT NULL DEFAULT 0,
        is_fallback INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_server_configs (
        server_name TEXT PRIMARY KEY,
        config JSON NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_provider_configs_default
        ON provider_configs(is_default) WHERE is_default = 1;
    `,
  },
  {
    version: 2,
    name: "provider_sources_table",
    up: `
      CREATE TABLE IF NOT EXISTS provider_sources (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        provider TEXT NOT NULL,
        key TEXT NOT NULL DEFAULT '',
        api_base TEXT NOT NULL DEFAULT '',
        enable INTEGER NOT NULL DEFAULT 1,
        extra_config JSON NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
];

// ── Store Types ──

export interface StoredProviderConfig {
  id: string;
  type: string;
  config: Record<string, unknown>;
  isDefault: boolean;
  isFallback: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMcpServerConfig {
  serverName: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface StoredProviderSource {
  id: string;
  type: string;
  provider_type: string;
  provider: string;
  key: string;
  api_base: string;
  enable: boolean;
  extra_config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ── Database row types ──

interface ProviderConfigRow {
  id: string;
  type: string;
  config: string;
  is_default: number;
  is_fallback: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface McpServerConfigRow {
  server_name: string;
  config: string;
  created_at: string;
  updated_at: string;
}

interface ProviderSourceRow {
  id: string;
  type: string;
  provider_type: string;
  provider: string;
  key: string;
  api_base: string;
  enable: number;
  extra_config: string;
  created_at: string;
  updated_at: string;
}

interface IdRow {
  id: string;
}

// ── SqliteProviderStore ──

export class SqliteProviderStore {
  private db: Database.Database;
  private encKey: Buffer | undefined;

  constructor(db: Database.Database, encryptionKey?: Buffer) {
    this.db = db;
    this.encKey = encryptionKey;
  }

  // ── Secret encryption helpers ──

  private encryptConfigSecrets(config: Record<string, unknown>): Record<string, unknown> {
    if (!this.encKey) return config;
    const out: Record<string, unknown> = { ...config };
    for (const field of SECRET_FIELDS) {
      const v = out[field];
      if (typeof v === "string" && v.length > 0) {
        out[field] = encryptSecret(v, this.encKey);
      }
    }
    return out;
  }

  private decryptConfigSecrets(config: Record<string, unknown>): Record<string, unknown> {
    if (!this.encKey) return config;
    const out: Record<string, unknown> = { ...config };
    for (const field of SECRET_FIELDS) {
      const v = out[field];
      if (typeof v === "string" && v.length > 0) {
        out[field] = decryptSecret(v, this.encKey);
      }
    }
    return out;
  }

  private encryptKey(key: string): string {
    if (!this.encKey || !key) return key;
    return encryptSecret(key, this.encKey);
  }

  private decryptKey(key: string): string {
    if (!this.encKey || !key) return key;
    return decryptSecret(key, this.encKey);
  }

  // === Provider Config ===

  saveProviderConfig(config: StoredProviderConfig): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO provider_configs
        (id, type, config, is_default, is_fallback, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      config.id,
      config.type,
      JSON.stringify(this.encryptConfigSecrets(config.config)),
      config.isDefault ? 1 : 0,
      config.isFallback ? 1 : 0,
      config.sortOrder,
      config.createdAt,
      config.updatedAt,
    );
  }

  getProviderConfig(id: string): StoredProviderConfig | null {
    const row = this.db.prepare("SELECT * FROM provider_configs WHERE id = ?").get(id) as ProviderConfigRow | undefined;
    return row ? this.rowToProviderConfig(row) : null;
  }

  getAllProviderConfigs(): StoredProviderConfig[] {
    const rows = this.db.prepare("SELECT * FROM provider_configs ORDER BY sort_order, created_at").all() as ProviderConfigRow[];
    return rows.map((r) => this.rowToProviderConfig(r));
  }

  deleteProviderConfig(id: string): void {
    this.db.prepare("DELETE FROM provider_configs WHERE id = ?").run(id);
  }

  setDefaultProvider(id: string): void {
    this.db.transaction(() => {
      // Clear all defaults
      this.db.prepare("UPDATE provider_configs SET is_default = 0").run();
      // Set new default
      this.db.prepare("UPDATE provider_configs SET is_default = 1 WHERE id = ?").run(id);
    })();
  }

  getDefaultProviderId(): string | null {
    const row = this.db.prepare("SELECT id FROM provider_configs WHERE is_default = 1 LIMIT 1").get() as IdRow | undefined;
    return row?.id ?? null;
  }

  setFallbackProviders(ids: string[]): void {
    this.db.transaction(() => {
      // Clear all fallbacks
      this.db.prepare("UPDATE provider_configs SET is_fallback = 0").run();
      // Set new fallbacks
      const stmt = this.db.prepare("UPDATE provider_configs SET is_fallback = 1 WHERE id = ?");
      for (const id of ids) {
        stmt.run(id);
      }
    })();
  }

  getFallbackProviderIds(): string[] {
    const rows = this.db.prepare("SELECT id FROM provider_configs WHERE is_fallback = 1 ORDER BY sort_order").all() as IdRow[];
    return rows.map((r) => r.id);
  }

  // === MCP Server Config ===

  saveMcpServerConfig(config: StoredMcpServerConfig): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO mcp_server_configs
        (server_name, config, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(
      config.serverName,
      JSON.stringify(config.config),
      config.createdAt,
      config.updatedAt,
    );
  }

  getAllMcpServerConfigs(): StoredMcpServerConfig[] {
    const rows = this.db.prepare("SELECT * FROM mcp_server_configs").all() as McpServerConfigRow[];
    return rows.map((r) => ({
      serverName: r.server_name,
      config: JSON.parse(r.config),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  getMcpServerConfigMap(): Record<string, Record<string, unknown>> {
    const configs = this.getAllMcpServerConfigs();
    const map: Record<string, Record<string, unknown>> = {};
    for (const c of configs) {
      map[c.serverName] = c.config;
    }
    return map;
  }

  deleteMcpServerConfig(serverName: string): void {
    this.db.prepare("DELETE FROM mcp_server_configs WHERE server_name = ?").run(serverName);
  }

  // === Provider Source ===

  private ensureProviderSourcesTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_sources (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        provider TEXT NOT NULL,
        key TEXT NOT NULL DEFAULT '',
        api_base TEXT NOT NULL DEFAULT '',
        enable INTEGER NOT NULL DEFAULT 1,
        extra_config JSON NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  saveProviderSource(source: StoredProviderSource): void {
    this.ensureProviderSourcesTable();
    this.db.prepare(`
      INSERT OR REPLACE INTO provider_sources
        (id, type, provider_type, provider, key, api_base, enable, extra_config, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      source.id,
      source.type,
      source.provider_type,
      source.provider,
      this.encryptKey(source.key),
      source.api_base,
      source.enable ? 1 : 0,
      JSON.stringify(source.extra_config),
      source.createdAt,
      source.updatedAt,
    );
  }

  getProviderSource(id: string): StoredProviderSource | null {
    this.ensureProviderSourcesTable();
    const row = this.db.prepare("SELECT * FROM provider_sources WHERE id = ?").get(id) as ProviderSourceRow | undefined;
    return row ? this.rowToProviderSource(row) : null;
  }

  getAllProviderSources(): StoredProviderSource[] {
    this.ensureProviderSourcesTable();
    const rows = this.db.prepare("SELECT * FROM provider_sources ORDER BY created_at").all() as ProviderSourceRow[];
    return rows.map((r) => this.rowToProviderSource(r));
  }

  deleteProviderSource(id: string): void {
    this.ensureProviderSourcesTable();
    this.db.prepare("DELETE FROM provider_sources WHERE id = ?").run(id);
  }

  private rowToProviderSource(row: ProviderSourceRow): StoredProviderSource {
    return {
      id: row.id,
      type: row.type,
      provider_type: row.provider_type,
      provider: row.provider,
      key: this.decryptKey(row.key),
      api_base: row.api_base,
      enable: row.enable === 1,
      extra_config: JSON.parse(row.extra_config),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ── Helpers ──

  private rowToProviderConfig(row: ProviderConfigRow): StoredProviderConfig {
    return {
      id: row.id,
      type: row.type,
      config: this.decryptConfigSecrets(JSON.parse(row.config)),
      isDefault: row.is_default === 1,
      isFallback: row.is_fallback === 1,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
