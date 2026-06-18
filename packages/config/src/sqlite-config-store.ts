/**
 * SQLite store for Agent configuration.
 *
 * Persists AgentConfig instances to config.db.
 */

import type Database from "better-sqlite3";
import type { AgentConfig } from "./manager.js";
import type { Migration } from "@yachiyo/common/database.js";

// ── Migrations ──

export const CONFIG_MIGRATIONS: Migration[] = [
  {
    version: 6,
    name: "agent_configs_initial",
    up: `
      CREATE TABLE IF NOT EXISTS agent_configs (
        id TEXT PRIMARY KEY,
        config JSON NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
];

// ── SqliteConfigStore ──

export class SqliteConfigStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // === Agent Configs ===

  saveConfig(config: AgentConfig): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO agent_configs (id, config, created_at, updated_at)
      VALUES (?, ?, datetime('now'), datetime('now'))
    `).run(config.id, JSON.stringify(config));
  }

  getConfig(id: string): AgentConfig | null {
    const row = this.db.prepare("SELECT config FROM agent_configs WHERE id = ?").get(id) as any;
    return row ? JSON.parse(row.config) : null;
  }

  getAllConfigs(): Map<string, AgentConfig> {
    const rows = this.db.prepare("SELECT id, config FROM agent_configs").all() as any[];
    const map = new Map<string, AgentConfig>();
    for (const row of rows) {
      map.set(row.id, JSON.parse(row.config));
    }
    return map;
  }

  deleteConfig(id: string): void {
    this.db.prepare("DELETE FROM agent_configs WHERE id = ?").run(id);
  }
}
