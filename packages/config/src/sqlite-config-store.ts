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
    const row = this.db.prepare("SELECT config FROM agent_configs WHERE id = ?").get(id) as { config?: string } | undefined;
    if (!row) return null;
    return parseConfigJson(row.config, id);
  }

  getAllConfigs(): Map<string, AgentConfig> {
    const rows = this.db.prepare("SELECT id, config FROM agent_configs").all() as Array<{ id: string; config?: string }>;
    const map = new Map<string, AgentConfig>();
    for (const row of rows) {
      const parsed = parseConfigJson(row.config, row.id);
      if (parsed) map.set(row.id, parsed);
    }
    return map;
  }

  deleteConfig(id: string): void {
    this.db.prepare("DELETE FROM agent_configs WHERE id = ?").run(id);
  }
}

/**
 * Parse and shape-validate a config JSON blob read from SQLite.
 *
 * Returns `null` (with a warning log) when the blob is missing, not valid
 * JSON, or does not have the minimal shape of an `AgentConfig` (an object
 * with a string `id`). This prevents corrupted or partially-migrated rows
 * from propagating as `any` into pipeline code and crashing deep in
 * agent/provider initialization.
 */
function parseConfigJson(raw: string | undefined, rowId: string): AgentConfig | null {
  if (!raw) {
    console.warn(`[SqliteConfigStore] Config row "${rowId}" has empty config blob, skipping.`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`[SqliteConfigStore] Config row "${rowId}" is not valid JSON, skipping:`, e);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.warn(`[SqliteConfigStore] Config row "${rowId}" parsed to non-object, skipping.`);
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== "string") {
    console.warn(`[SqliteConfigStore] Config row "${rowId}" missing string "id" field, skipping.`);
    return null;
  }
  return parsed as AgentConfig;
}
