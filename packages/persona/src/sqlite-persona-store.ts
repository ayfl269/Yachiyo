/**
 * SQLite implementation of PersonaStore.
 *
 * Persists personas and persona folders to config.db.
 */

import type Database from "better-sqlite3";
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

// ── SqlitePersonaStore ──

export class SqlitePersonaStore extends PersonaStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    super();
    this.db = db;
  }

  async getPersona(personaId: string): Promise<Personality | null> {
    const row = this.db.prepare("SELECT * FROM personas WHERE id = ?").get(personaId) as any;
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
    const rows = this.db.prepare("SELECT * FROM personas").all() as any[];
    const map = new Map<string, Personality>();
    for (const row of rows) {
      map.set(row.id, this.rowToPersonality(row));
    }
    return map;
  }

  async getFolder(folderId: string): Promise<PersonaFolder | null> {
    const row = this.db.prepare("SELECT * FROM persona_folders WHERE id = ?").get(folderId) as any;
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
    const rows = this.db.prepare("SELECT * FROM persona_folders ORDER BY sort_order").all() as any[];
    const map = new Map<string, PersonaFolder>();
    for (const row of rows) {
      map.set(row.id, this.rowToFolder(row));
    }
    return map;
  }

  // ── Helpers ──

  private rowToPersonality(row: any): Personality {
    return {
      name: row.name,
      prompt: row.prompt,
      beginDialogs: row.begin_dialogs ? JSON.parse(row.begin_dialogs) : [],
      moodImitationDialogs: row.mood_imitation_dialogs ? JSON.parse(row.mood_imitation_dialogs) : [],
      tools: row.tools ? JSON.parse(row.tools) : null,
      skills: row.skills ? JSON.parse(row.skills) : null,
      customErrorMessage: row.custom_error_message,
    };
  }

  private rowToFolder(row: any): PersonaFolder {
    return {
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
      description: row.description ?? undefined,
      sortOrder: row.sort_order,
    };
  }
}
