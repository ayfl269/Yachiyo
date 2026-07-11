/**
 * SQLite store for P2-tier config data:
 * - Unified KV preferences (replaces preferences + command_configs)
 * - Plugin stars and handlers
 * - Skills
 * - Adapter configs
 * - Disabled sessions
 * - Sub-agent tasks (audit table)
 *
 * All stored in config.db.
 */

import type Database from "better-sqlite3";
import type { StarMetadata } from "@yachiyo/common/plugin-types.js";
import type { SkillInfo } from "@yachiyo/common/skill-types.js";
import type { Migration } from "@yachiyo/common/database.js";

// ── Migrations ──

export const CONFIG_EXTRAS_MIGRATIONS: Migration[] = [
  {
    version: 3, // Version 1-2: provider, Version 4-6: persona/adapter/agent
    name: "config_extras_initial",
    up: `
      CREATE TABLE IF NOT EXISTS plugin_stars (
        module_path TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        author TEXT DEFAULT '',
        description TEXT DEFAULT '',
        short_desc TEXT DEFAULT '',
        version TEXT DEFAULT '',
        repo TEXT DEFAULT '',
        activated INTEGER NOT NULL DEFAULT 0,
        config JSON DEFAULT '{}',
        handler_full_names JSON DEFAULT '[]',
        display_name TEXT DEFAULT '',
        logo_path TEXT DEFAULT '',
        support_platforms JSON DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS plugin_handlers (
        handler_full_name TEXT PRIMARY KEY,
        handler_name TEXT NOT NULL DEFAULT '',
        handler_module_path TEXT NOT NULL DEFAULT '',
        event_type TEXT NOT NULL DEFAULT '',
        event_filters JSON DEFAULT '[]',
        description TEXT DEFAULT '',
        extras_configs JSON DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (handler_module_path) REFERENCES plugin_stars(module_path) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS skills (
        name TEXT PRIMARY KEY,
        description TEXT DEFAULT '',
        path TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        source_type TEXT DEFAULT '',
        source_label TEXT DEFAULT '',
        local_exists INTEGER NOT NULL DEFAULT 0,
        sandbox_exists INTEGER NOT NULL DEFAULT 0,
        plugin_name TEXT DEFAULT '',
        readonly INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS adapter_configs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        config JSON NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS disabled_sessions (
        unified_msg_origin TEXT PRIMARY KEY,
        disabled_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sub_agent_tasks (
        id TEXT PRIMARY KEY,
        parent_conversation_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        system_prompt TEXT,
        tools JSON,
        result TEXT,
        error TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 7,
    name: "session_whitelist",
    up: `
      CREATE TABLE IF NOT EXISTS whitelisted_sessions (
        unified_msg_origin TEXT PRIMARY KEY,
        added_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 8,
    name: "dashboard_users",
    up: `
      CREATE TABLE IF NOT EXISTS dashboard_users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        is_first_login INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 9,
    name: "dashboard_sessions",
    up: `
      CREATE TABLE IF NOT EXISTS dashboard_sessions (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        must_change INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expires_at ON dashboard_sessions(expires_at);
    `,
  },
];

// ── Database row types ──

interface PluginStarRow {
  module_path: string;
  name: string;
  author: string;
  description: string | null;
  short_desc: string | null;
  version: string | null;
  repo: string | null;
  activated: number;
  config: string | null;
  handler_full_names: string | null;
  display_name: string | null;
  logo_path: string | null;
  support_platforms: string | null;
}

interface SkillRow {
  name: string;
  description: string | null;
  path: string;
  active: number;
  source_type: string;
  source_label: string | null;
  local_exists: number;
  sandbox_exists: number;
  plugin_name: string | null;
  readonly: number;
}

// ── Plugin Store ──

export class SqlitePluginStore {
  constructor(private db: Database.Database) {}

  saveStar(metadata: StarMetadata): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO plugin_stars
        (module_path, name, author, description, short_desc, version, repo,
         activated, config, handler_full_names, display_name, logo_path, support_platforms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      metadata.modulePath, metadata.name, metadata.author, metadata.desc,
      metadata.shortDesc, metadata.version, metadata.repo,
      metadata.activated ? 1 : 0,
      JSON.stringify(metadata.config),
      JSON.stringify(metadata.handlerFullNames),
      metadata.displayName, metadata.logoPath,
      JSON.stringify(metadata.supportPlatforms),
    );
  }

  getAllStars(): StarMetadata[] {
    const rows = this.db.prepare("SELECT module_path, name, author, description, short_desc, version, repo, activated, config, handler_full_names, display_name, logo_path, support_platforms, created_at FROM plugin_stars").all() as PluginStarRow[];
    return rows.map((r) => this.rowToStar(r));
  }

  setStarActivated(modulePath: string, activated: boolean): void {
    this.db.prepare("UPDATE plugin_stars SET activated = ? WHERE module_path = ?")
      .run(activated ? 1 : 0, modulePath);
  }

  private rowToStar(row: PluginStarRow): StarMetadata {
    return {
      modulePath: row.module_path,
      name: row.name,
      author: row.author,
      desc: row.description ?? "",
      shortDesc: row.short_desc ?? "",
      version: row.version ?? "",
      repo: row.repo ?? "",
      activated: row.activated === 1,
      config: JSON.parse(row.config || "{}"),
      handlerFullNames: JSON.parse(row.handler_full_names || "[]"),
      displayName: row.display_name ?? "",
      logoPath: row.logo_path ?? "",
      supportPlatforms: JSON.parse(row.support_platforms || "[]"),
    };
  }
}

// ── Skill Store ──

export class SqliteSkillStore {
  constructor(private db: Database.Database) {}

  saveSkill(skill: SkillInfo): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO skills
        (name, description, path, active, source_type, source_label,
         local_exists, sandbox_exists, plugin_name, readonly)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      skill.name, skill.description, skill.path,
      skill.active ? 1 : 0, skill.sourceType, skill.sourceLabel,
      skill.localExists ? 1 : 0, skill.sandboxExists ? 1 : 0,
      skill.pluginName, skill.readonly ? 1 : 0,
    );
  }

  getAllSkills(): SkillInfo[] {
    const rows = this.db.prepare("SELECT name, description, path, active, source_type, source_label, local_exists, sandbox_exists, plugin_name, readonly, created_at FROM skills").all() as SkillRow[];
    return rows.map((r) => this.rowToSkill(r));
  }

  setSkillActive(name: string, active: boolean): void {
    this.db.prepare("UPDATE skills SET active = ? WHERE name = ?").run(active ? 1 : 0, name);
  }

  deleteSkill(name: string): void {
    this.db.prepare("DELETE FROM skills WHERE name = ?").run(name);
  }

  private rowToSkill(row: SkillRow): SkillInfo {
    return {
      name: row.name,
      description: row.description ?? "",
      path: row.path,
      active: row.active === 1,
      sourceType: row.source_type,
      sourceLabel: row.source_label ?? "",
      localExists: row.local_exists === 1,
      sandboxExists: row.sandbox_exists === 1,
      pluginName: row.plugin_name ?? "",
      readonly: row.readonly === 1,
    };
  }
}

// ── Session Disabled Store ──

export class SqliteSessionDisabledStore {
  constructor(private db: Database.Database) {}

  isDisabled(umo: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM disabled_sessions WHERE unified_msg_origin = ?"
    ).get(umo);
    return !!row;
  }

  disable(umo: string): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO disabled_sessions (unified_msg_origin) VALUES (?)"
    ).run(umo);
  }

  enable(umo: string): void {
    this.db.prepare("DELETE FROM disabled_sessions WHERE unified_msg_origin = ?").run(umo);
  }
}

// ── Session Whitelist Store ──

export class SqliteSessionWhitelistStore {
  constructor(private db: Database.Database) {}

  isWhitelisted(umo: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM whitelisted_sessions WHERE unified_msg_origin = ?"
    ).get(umo);
    return !!row;
  }

  add(umo: string): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO whitelisted_sessions (unified_msg_origin) VALUES (?)"
    ).run(umo);
  }

  remove(umo: string): void {
    this.db.prepare("DELETE FROM whitelisted_sessions WHERE unified_msg_origin = ?").run(umo);
  }

  listAll(): Array<{ unified_msg_origin: string; added_at: string }> {
    return this.db.prepare(
      "SELECT unified_msg_origin, added_at FROM whitelisted_sessions ORDER BY added_at DESC"
    ).all() as Array<{ unified_msg_origin: string; added_at: string }>;
  }
}
