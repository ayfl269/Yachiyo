/**
 * SQLite store for adapter configurations.
 * Persists adapter configs to config.db so they survive restarts.
 */

import type Database from "better-sqlite3";
import type { Migration } from "@yachiyo/common/database.js";
import type { AdapterConfigBase } from "@yachiyo/platform/config.js";

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

// ── SqliteAdapterStore ──

export class SqliteAdapterStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Load all adapter configs from database */
  loadAll(): AdapterConfigBase[] {
    const rows = this.db.prepare("SELECT * FROM adapters ORDER BY created_at ASC").all() as any[];
    return rows.map(row => {
      const config = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
      return { ...config, id: row.id, type: row.type, enabled: row.enabled === 1 };
    });
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
    const row = this.db.prepare("SELECT * FROM adapters WHERE id = ?").get(id) as any;
    if (!row) return null;
    const config = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
    return { ...config, id: row.id, type: row.type, enabled: row.enabled === 1 };
  }
}
