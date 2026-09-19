/**
 * SQLite implementation of PersonaStore.
 *
 * Persists personas and persona folders to config.db.
 */

import type Database from "better-sqlite3";
import type { Message } from "@yachiyo/agent/message.js";
import { PersonaStore, type Personality, type PersonaFolder } from "./manager.js";
import type { Migration } from "@yachiyo/common/database.js";

// ── Migrations ──

export const PERSONA_MIGRATIONS: Migration[] = [
  {
    version: 4,
    name: "personas_initial",
    up: `
      CREATE TABLE IF NOT EXISTS personas (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL DEFAULT '',
        begin_dialogs JSON,
        mood_imitation_dialogs JSON,
        tools JSON,
        skills JSON,
        custom_error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS persona_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        parent_id TEXT,
        description TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
];

// ── Database row types ──

interface PersonaRow {
  id: string;
  name: string;
  prompt: string;
  begin_dialogs: string | null;
  mood_imitation_dialogs: string | null;
  tools: string | null;
  skills: string | null;
  custom_error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface PersonaFolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  description: string | null;
  sort_order: number;
  created_at: string;
}

// ── SqlitePersonaStore ──

export class SqlitePersonaStore extends PersonaStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    super();
    this.db = db;
  }

  async getPersona(personaId: string): Promise<Personality | null> {
    const row = this.db.prepare("SELECT id, name, prompt, begin_dialogs, mood_imitation_dialogs, tools, skills, custom_error_message, created_at, updated_at FROM personas WHERE id = ?").get(personaId) as PersonaRow | undefined;
    return row ? this.rowToPersonality(row) : null;
  }

  async setPersona(personaId: string, persona: Personality): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO personas
        (id, name, prompt, begin_dialogs, mood_imitation_dialogs, tools, skills, custom_error_message, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      personaId,
      persona.name,
      persona.prompt,
      JSON.stringify(persona.beginDialogs),
      JSON.stringify(persona.moodImitationDialogs),
      persona.tools ? JSON.stringify(persona.tools) : null,
      persona.skills ? JSON.stringify(persona.skills) : null,
      persona.customErrorMessage,
    );
  }

  async deletePersona(personaId: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM personas WHERE id = ?").run(personaId);
    return result.changes > 0;
  }

  async getAllPersonas(): Promise<Map<string, Personality>> {
    const rows = this.db.prepare("SELECT id, name, prompt, begin_dialogs, mood_imitation_dialogs, tools, skills, custom_error_message, created_at, updated_at FROM personas").all() as PersonaRow[];
    const map = new Map<string, Personality>();
    for (const row of rows) {
      map.set(row.id, this.rowToPersonality(row));
    }
    return map;
  }

  async getFolder(folderId: string): Promise<PersonaFolder | null> {
    const row = this.db.prepare("SELECT id, name, parent_id, description, sort_order, created_at FROM persona_folders WHERE id = ?").get(folderId) as PersonaFolderRow | undefined;
    return row ? this.rowToFolder(row) : null;
  }

  async setFolder(folderId: string, folder: PersonaFolder): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO persona_folders (id, name, parent_id, description, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `).run(folderId, folder.name, folder.parentId, folder.description ?? null, folder.sortOrder);
  }

  async deleteFolder(folderId: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM persona_folders WHERE id = ?").run(folderId);
    return result.changes > 0;
  }

  async getAllFolders(): Promise<Map<string, PersonaFolder>> {
    const rows = this.db.prepare("SELECT id, name, parent_id, description, sort_order, created_at FROM persona_folders ORDER BY sort_order").all() as PersonaFolderRow[];
    const map = new Map<string, PersonaFolder>();
    for (const row of rows) {
      map.set(row.id, this.rowToFolder(row));
    }
    return map;
  }

  // ── Helpers ──

  private rowToPersonality(row: PersonaRow): Personality {
    return {
      name: row.name,
      prompt: row.prompt,
      beginDialogs: this.parseJsonArray<Message>(row.begin_dialogs, "begin_dialogs"),
      moodImitationDialogs: this.parseJsonArray<Message>(row.mood_imitation_dialogs, "mood_imitation_dialogs"),
      tools: this.parseStringArray(row.tools, "tools"),
      skills: this.parseStringArray(row.skills, "skills"),
      customErrorMessage: row.custom_error_message,
    };
  }

  /**
   * Parse a JSON column, degrading to null on corruption instead of throwing
   * (one bad row previously made getPersona/getAllPersonas fail, breaking all
   * persona loading).
   */
  private parseJson(raw: string | null, field: string): unknown {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.warn(`[SqlitePersonaStore] Failed to parse persona.${field}; ignoring:`, e);
      return null;
    }
  }

  /** Like parseJson but coerces to an array (defaults to [] on corruption). */
  private parseJsonArray<T>(raw: string | null, field: string): T[] {
    const parsed = this.parseJson(raw, field);
    return Array.isArray(parsed) ? parsed as T[] : [];
  }

  /** Parse a JSON string-array column, defaulting to null on corruption. */
  private parseStringArray(raw: string | null, field: string): string[] | null {
    const parsed = this.parseJson(raw, field);
    return Array.isArray(parsed) ? parsed as string[] : null;
  }

  private rowToFolder(row: PersonaFolderRow): PersonaFolder {
    return {
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
      description: row.description ?? undefined,
      sortOrder: row.sort_order,
    };
  }
}
