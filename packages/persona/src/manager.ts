import type { Message } from "@yachiyo/agent/message.js";
import { readFile, writeFile, mkdir, rename, unlink } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";

export interface Personality {
  prompt: string;
  name: string;
  beginDialogs: Message[];
  moodImitationDialogs: Message[];
  tools: string[] | null;
  skills: string[] | null;
  customErrorMessage: string | null;
}

export interface PersonaFolder {
  id: string;
  name: string;
  parentId: string | null;
  description?: string;
  sortOrder: number;
}

interface PersonaStoreData {
  personas: Record<string, Personality>;
  folders: Record<string, PersonaFolder>;
}

export abstract class PersonaStore {
  abstract getPersona(personaId: string): Promise<Personality | null>;
  abstract setPersona(personaId: string, persona: Personality): Promise<void>;
  abstract deletePersona(personaId: string): Promise<boolean>;
  abstract getAllPersonas(): Promise<Map<string, Personality>>;
  abstract getFolder(folderId: string): Promise<PersonaFolder | null>;
  abstract setFolder(folderId: string, folder: PersonaFolder): Promise<void>;
  abstract deleteFolder(folderId: string): Promise<boolean>;
  abstract getAllFolders(): Promise<Map<string, PersonaFolder>>;
}

export class InMemoryPersonaStore extends PersonaStore {
  private personas: Map<string, Personality> = new Map();
  private folders: Map<string, PersonaFolder> = new Map();

  async getPersona(personaId: string): Promise<Personality | null> {
    return this.personas.get(personaId) ?? null;
  }

  async setPersona(personaId: string, persona: Personality): Promise<void> {
    this.personas.set(personaId, persona);
  }

  async deletePersona(personaId: string): Promise<boolean> {
    return this.personas.delete(personaId);
  }

  async getAllPersonas(): Promise<Map<string, Personality>> {
    return new Map(this.personas);
  }

  async getFolder(folderId: string): Promise<PersonaFolder | null> {
    return this.folders.get(folderId) ?? null;
  }

  async setFolder(folderId: string, folder: PersonaFolder): Promise<void> {
    this.folders.set(folderId, folder);
  }

  async deleteFolder(folderId: string): Promise<boolean> {
    return this.folders.delete(folderId);
  }

  async getAllFolders(): Promise<Map<string, PersonaFolder>> {
    return new Map(this.folders);
  }
}

export class FilePersonaStore extends PersonaStore {
  private filePath: string;
  private data: PersonaStoreData = { personas: {}, folders: {} };
  private dirty: boolean = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private writeDelay: number;
  /**
   * Monotonic revision bumped on every mutation. `flush()` snapshots it before
   * the async write and only clears `dirty` when the revision is unchanged
   * afterwards, so a mutation that lands mid-write is not marked clean (which
   * previously let `close()` skip persisting the last change).
   */
  private revision: number = 0;
  /** In-flight flush, awaited by close() so a write cannot be lost on shutdown. */
  private inFlightFlush: Promise<void> | null = null;

  constructor(filePath: string, writeDelay = 500) {
    super();
    this.filePath = filePath;
    this.writeDelay = writeDelay;
  }

  async init(): Promise<void> {
    if (existsSync(this.filePath)) {
      const raw = await readFile(this.filePath, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        // Corrupt file: start fresh rather than crash on every startup.
        console.error(`FilePersonaStore: failed to parse ${this.filePath}, starting empty:`, e);
        parsed = null;
      }
      // Shape validation/normalization: a hand-edited or partially corrupted
      // file must not leave `personas`/`folders` undefined or non-object
      // (every get/set below would throw).
      const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
      const asRecord = (v: unknown): Record<string, unknown> =>
        v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
      this.data = {
        personas: asRecord(obj.personas) as PersonaStoreData["personas"],
        folders: asRecord(obj.folders) as PersonaStoreData["folders"],
      };
      // `deletePersona("constructor")` style probes must not report inherited
      // properties, and lookups must not see them either. Strip any inherited
      // keys by copying own enumerable properties (also drops __proto__).
      this.data.personas = { ...this.data.personas };
      this.data.folders = { ...this.data.folders };
    } else {
      this.data = { personas: {}, folders: {} };
      await this.flush();
    }
  }

  async close(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    // Wait for any in-flight flush before deciding whether another is needed;
    // otherwise close() could race the flush and observe a stale `dirty=false`.
    if (this.inFlightFlush) {
      try { await this.inFlightFlush; } catch { /* logged by flush caller */ }
    }
    if (this.dirty) {
      await this.flush();
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.dirty = true;
    this.revision++;
    this.writeTimer = setTimeout(() => {
      this.flush().catch((e) => console.error("FilePersonaStore flush error:", e));
    }, this.writeDelay);
  }

  private async flush(): Promise<void> {
    // Snapshot the revision and payload before the async write. If a mutation
    // arrives while writing, `this.revision` advances and we must keep `dirty`
    // set so the change is written by the next scheduled/close flush.
    const snapshotRevision = this.revision;
    const payload = JSON.stringify(this.data, null, 2);
    const run = (async () => {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      // Atomic write: write to a temp file in the same directory, then rename
      // over the target. A crash mid-write previously left a truncated JSON
      // file behind (bricking the store on every later startup); rename is
      // atomic within a filesystem.
      const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmpPath, payload, "utf-8");
      try {
        await rename(tmpPath, this.filePath);
      } catch (e) {
        // Best-effort cleanup of the orphaned temp file if rename failed.
        try { await unlink(tmpPath); } catch { /* ignore */ }
        throw e;
      }
      if (this.revision === snapshotRevision) {
        this.dirty = false;
      }
    })();
    this.inFlightFlush = run;
    try {
      await run;
    } finally {
      if (this.inFlightFlush === run) this.inFlightFlush = null;
    }
  }

  async getPersona(personaId: string): Promise<Personality | null> {
    // hasOwnProperty guard: without it getPersona("constructor") returns the
    // inherited Object constructor instead of null.
    if (!Object.prototype.hasOwnProperty.call(this.data.personas, personaId)) return null;
    return this.data.personas[personaId];
  }

  async setPersona(personaId: string, persona: Personality): Promise<void> {
    this.data.personas[personaId] = persona;
    this.scheduleWrite();
  }

  async deletePersona(personaId: string): Promise<boolean> {
    // `in` would match inherited properties (e.g. deletePersona("constructor")
    // reported true while deleting nothing) — use own-property checks.
    if (!Object.prototype.hasOwnProperty.call(this.data.personas, personaId)) return false;
    delete this.data.personas[personaId];
    this.scheduleWrite();
    return true;
  }

  async getAllPersonas(): Promise<Map<string, Personality>> {
    return new Map(Object.entries(this.data.personas));
  }

  async getFolder(folderId: string): Promise<PersonaFolder | null> {
    if (!Object.prototype.hasOwnProperty.call(this.data.folders, folderId)) return null;
    return this.data.folders[folderId];
  }

  async setFolder(folderId: string, folder: PersonaFolder): Promise<void> {
    this.data.folders[folderId] = folder;
    this.scheduleWrite();
  }

  async deleteFolder(folderId: string): Promise<boolean> {
    if (!Object.prototype.hasOwnProperty.call(this.data.folders, folderId)) return false;
    delete this.data.folders[folderId];
    this.scheduleWrite();
    return true;
  }

  async getAllFolders(): Promise<Map<string, PersonaFolder>> {
    return new Map(Object.entries(this.data.folders));
  }
}

export class PersonaManager {
  private store: PersonaStore;

  constructor(store?: PersonaStore) {
    this.store = store ?? new InMemoryPersonaStore();
  }

  async getPersona(personaId: string): Promise<Personality | null> {
    return this.store.getPersona(personaId);
  }

  async registerPersona(personaId: string, persona: Personality): Promise<void> {
    await this.store.setPersona(personaId, persona);
  }

  async getDefaultPersona(): Promise<Personality | null> {
    return this.store.getPersona("default");
  }

  async resolveSelectedPersona(personaId: string | null): Promise<Personality | null> {
    if (personaId) {
      const persona = await this.getPersona(personaId);
      if (persona) return persona;
    }
    return this.getDefaultPersona();
  }

  async createPersona(personaId: string, persona: Personality): Promise<void> {
    await this.registerPersona(personaId, persona);
  }

  async updatePersona(personaId: string, updates: Partial<Personality>): Promise<void> {
    const existing = await this.store.getPersona(personaId);
    if (!existing) return;
    await this.store.setPersona(personaId, { ...existing, ...updates });
  }

  async deletePersona(personaId: string): Promise<boolean> {
    return this.store.deletePersona(personaId);
  }

  async getAllPersonas(): Promise<Map<string, Personality>> {
    return this.store.getAllPersonas();
  }

  async createFolder(folder: PersonaFolder): Promise<void> {
    await this.store.setFolder(folder.id, folder);
  }

  async getFolder(folderId: string): Promise<PersonaFolder | null> {
    return this.store.getFolder(folderId);
  }

  async deleteFolder(folderId: string): Promise<boolean> {
    return this.store.deleteFolder(folderId);
  }

  async getAllFolders(): Promise<Map<string, PersonaFolder>> {
    return this.store.getAllFolders();
  }
}

export class PersonaService extends PersonaManager {}
