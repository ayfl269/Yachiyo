/**
 * SQLite store for adapter configurations.
 * Persists adapter configs to config.db so they survive restarts.
 *
 * WARNING (#56): adapter configs (including secrets such as appSecret /
 * accessToken / bot_token) are stored as PLAINTEXT JSON in the `adapters`
 * table. There is currently no at-rest encryption for these fields. Anyone
 * with read access to the database file (or file-level backups) can recover
 * all platform credentials. Until this is migrated to the encrypted secret
 * storage used elsewhere, restrict file permissions on the data directory
 * and treat DB dumps/backups as sensitive.
 */

import type Database from "better-sqlite3";
import type { Migration } from "@yachiyo/common/database.js";
import type { AdapterConfigBase } from "./config.js";

// ── Migrations ──

export const ADAPTER_MIGRATIONS: Migration[] = [
  {
    version: 5,
    name: "adapters_initial",
    up: `
      CREATE TABLE IF NOT EXISTS adapters (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        config JSON NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
];

// ── Database row type ──

interface AdapterRow {
  id: string;
  type: string;
  config: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

// ── SqliteAdapterStore ──

export class SqliteAdapterStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Parse a config JSON column with tolerance for corrupted rows */
  private parseConfigRow(row: AdapterRow, context: string): AdapterConfigBase | null {
    try {
      const config = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
      if (!config || typeof config !== "object") throw new Error("config is not an object");
      return { ...config, id: row.id, type: row.type, enabled: row.enabled === 1 };
    } catch (e) {
      console.error(`[SqliteAdapterStore] Skipping corrupted adapter row (${context}, id=${row.id}):`, e);
      return null;
    }
  }

  /** Load all adapter configs from database */
  loadAll(): AdapterConfigBase[] {
    const rows = this.db.prepare("SELECT id, type, config, enabled, created_at, updated_at FROM adapters ORDER BY created_at ASC").all() as AdapterRow[];
    const results: AdapterConfigBase[] = [];
    for (const row of rows) {
      const config = this.parseConfigRow(row, "loadAll");
      if (config) results.push(config);
    }
    return results;
  }

  /** Save an adapter config (insert or replace) */
  save(adapterConfig: AdapterConfigBase): void {
    const id = adapterConfig.id;
    const type = adapterConfig.type;
    const config = JSON.stringify(adapterConfig);
    const enabled = adapterConfig.enabled !== false ? 1 : 0;

    this.db.prepare(`
      INSERT OR REPLACE INTO adapters (id, type, config, enabled, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(id, type, config, enabled);
  }

  /** Delete an adapter config by id */
  delete(id: string): void {
    this.db.prepare("DELETE FROM adapters WHERE id = ?").run(id);
  }

  /** Get a single adapter config */
  get(id: string): AdapterConfigBase | null {
    const row = this.db.prepare("SELECT id, type, config, enabled, created_at, updated_at FROM adapters WHERE id = ?").get(id) as AdapterRow | undefined;
    if (!row) return null;
    return this.parseConfigRow(row, "get");
  }
}
