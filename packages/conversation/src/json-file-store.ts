import { ConversationStore, type ConversationMetadata, type PlatformMessageHistory, type WebchatThread, type Attachment, type ApiKey, type Preference, type CommandConfig, type PlatformSession, type ProviderStat } from "./store.js";
import type { ConversationRecord } from "./manager.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";

interface SerializedConversationRecord {
  id: string;
  unifiedMsgOrigin: string;
  personaId: string | null;
  history: string;
  platformId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  tokenUsage: number | null;
}

function serializeRecord(record: ConversationRecord): SerializedConversationRecord {
  return {
    id: record.id,
    unifiedMsgOrigin: record.unifiedMsgOrigin,
    personaId: record.personaId,
    history: record.history,
    platformId: record.platformId,
    title: record.title,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    tokenUsage: record.tokenUsage,
  };
}

function deserializeRecord(data: SerializedConversationRecord): ConversationRecord {
  return {
    id: data.id,
    unifiedMsgOrigin: data.unifiedMsgOrigin,
    personaId: data.personaId,
    history: data.history,
    platformId: data.platformId,
    title: data.title,
    createdAt: new Date(data.createdAt),
    updatedAt: new Date(data.updatedAt),
    tokenUsage: data.tokenUsage,
  };
}

export class JsonFileConversationStore extends ConversationStore {
  private dataDir: string;
  private cache: Map<string, ConversationRecord> = new Map();
  private dirty: Set<string> = new Set();
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  private platformMessageHistory: PlatformMessageHistory[] = [];
  private webchatThreads: Map<string, WebchatThread> = new Map();
  private attachments: Map<string, Attachment> = new Map();
  private apiKeys: Map<string, ApiKey> = new Map();
  private preferences: Map<string, Preference> = new Map();
  private commandConfigs: Map<string, CommandConfig> = new Map();
  private platformSessions: Map<string, PlatformSession> = new Map();
  private providerStats: ProviderStat[] = [];
  private platformStats: import("./store.js").PlatformStats[] = [];
  private sessionConversations: Map<string, string> = new Map();

  private auxDirty: boolean = false;

  constructor(dataDir: string = "./data/conversations") {
    super();
    this.dataDir = dataDir;
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    this.loadAll();
    this.loadAux();
    this.saveTimer = setInterval(() => this.flush(), 30_000);
  }

  private loadAll(): void {
    if (!existsSync(this.dataDir)) return;
    const files = readdirSync(this.dataDir).filter(f => f.endsWith(".json") && !f.startsWith("_"));
    for (const file of files) {
      try {
        const raw = readFileSync(join(this.dataDir, file), "utf-8");
        const data: SerializedConversationRecord = JSON.parse(raw);
        const record = deserializeRecord(data);
        this.cache.set(record.id, record);
      } catch {
        // skip corrupted files
      }
    }
  }

  private loadAux(): void {
    const auxPath = this.getAuxFilePath();
    if (!existsSync(auxPath)) return;
    try {
      const raw = readFileSync(auxPath, "utf-8");
      const data = JSON.parse(raw) as SerializedAuxData;
      this.platformMessageHistory = (data.platformMessageHistory ?? []).map(deserializePlatformMessageHistory);
      this.webchatThreads = new Map((data.webchatThreads ?? []).map((t: WebchatThread) => [t.id, t]));
      this.attachments = new Map((data.attachments ?? []).map((a: Attachment) => [a.id, a]));
      this.apiKeys = new Map((data.apiKeys ?? []).map((k: ApiKey) => [k.id, k]));
      this.preferences = new Map((data.preferences ?? []).map((p: Preference) => [p.key, p]));
      this.commandConfigs = new Map((data.commandConfigs ?? []).map((c: CommandConfig) => [c.commandName, c]));
      this.platformSessions = new Map((data.platformSessions ?? []).map((s: PlatformSession) => [s.id, s]));
      this.providerStats = data.providerStats ?? [];
    } catch {
      // skip corrupted aux file
    }
  }

  private getFilePath(id: string): string {
    return join(this.dataDir, `${id}.json`);
  }

  private getAuxFilePath(): string {
    return join(this.dataDir, "_aux.json");
  }

  private markDirty(id: string): void {
    this.dirty.add(id);
  }

  private markAuxDirty(): void {
    this.auxDirty = true;
  }

  flush(): void {
    for (const id of this.dirty) {
      const record = this.cache.get(id);
      if (!record) continue;
      try {
        const dir = this.dataDir;
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(this.getFilePath(id), JSON.stringify(serializeRecord(record), null, 2), "utf-8");
      } catch {
        // log and continue
      }
    }
    this.dirty.clear();

    if (this.auxDirty) {
      try {
        const dir = this.dataDir;
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(this.getAuxFilePath(), JSON.stringify(this.serializeAuxData(), null, 2), "utf-8");
        this.auxDirty = false;
      } catch {
        // log and continue
      }
    }
  }

  private serializeAuxData(): SerializedAuxData {
    return {
      platformMessageHistory: this.platformMessageHistory.map(serializePlatformMessageHistory),
      webchatThreads: [...this.webchatThreads.values()],
      attachments: [...this.attachments.values()],
      apiKeys: [...this.apiKeys.values()],
      preferences: [...this.preferences.values()],
      commandConfigs: [...this.commandConfigs.values()],
      platformSessions: [...this.platformSessions.values()],
      providerStats: this.providerStats,
    };
  }

  async close(): Promise<void> {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    this.flush();
  }

  async createConversation(conversation: ConversationRecord): Promise<void> {
    this.cache.set(conversation.id, conversation);
    this.markDirty(conversation.id);
  }

  async getConversationById(id: string): Promise<ConversationRecord | null> {
    return this.cache.get(id) ?? null;
  }

  async getAllConversations(): Promise<ConversationRecord[]> {
    return [...this.cache.values()];
  }

  async getAllConversationMetadata(): Promise<ConversationMetadata[]> {
    return [...this.cache.values()].map((c) => ({
      id: c.id,
      unifiedMsgOrigin: c.unifiedMsgOrigin,
      personaId: c.personaId,
      platformId: c.platformId,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      tokenUsage: c.tokenUsage,
    }));
  }

  async getFilteredConversations(options: {
    page?: number;
    pageSize?: number;
    platformIds?: string[];
    searchQuery?: string;
  }): Promise<[ConversationRecord[], number]> {
    let results = [...this.cache.values()];
    if (options.platformIds?.length) {
      results = results.filter(c => options.platformIds!.includes(c.platformId));
    }
    if (options.searchQuery) {
      const q = options.searchQuery.toLowerCase();
      results = results.filter(c => c.title.toLowerCase().includes(q) || c.unifiedMsgOrigin.toLowerCase().includes(q));
    }
    const total = results.length;
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;
    const start = (page - 1) * pageSize;
    return [results.slice(start, start + pageSize), total];
  }

  async updateConversation(id: string, updates: Partial<ConversationRecord>): Promise<void> {
    const conv = this.cache.get(id);
    if (conv) {
      Object.assign(conv, updates, { updatedAt: new Date() });
      this.markDirty(id);
    }
  }

  async deleteConversation(id: string): Promise<void> {
    this.cache.delete(id);
    this.dirty.delete(id);
    try {
      const filePath = this.getFilePath(id);
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch {
    }
  }

  async insertPlatformMessageHistory(record: PlatformMessageHistory): Promise<void> {
    this.platformMessageHistory.push(record);
    this.markAuxDirty();
  }

  async getPlatformMessageHistory(options: { platformId: string; userId: string; limit?: number }): Promise<PlatformMessageHistory[]> {
    let results = this.platformMessageHistory.filter(r => r.platformId === options.platformId && r.userId === options.userId);
    if (options.limit) results = results.slice(-options.limit);
    return results;
  }

  async getMessageCount(options?: { since?: Date }): Promise<number> {
    if (options?.since) {
      return this.platformMessageHistory.filter(r => r.createdAt >= options.since!).length;
    }
    return this.platformMessageHistory.length;
  }

  async createWebchatThread(thread: WebchatThread): Promise<void> {
    this.webchatThreads.set(thread.id, thread);
    this.markAuxDirty();
  }

  async getWebchatThread(threadId: string): Promise<WebchatThread | null> {
    return this.webchatThreads.get(threadId) ?? null;
  }

  async deleteWebchatThread(threadId: string): Promise<void> {
    this.webchatThreads.delete(threadId);
    this.markAuxDirty();
  }

  async insertAttachment(attachment: Attachment): Promise<void> {
    this.attachments.set(attachment.id, attachment);
    this.markAuxDirty();
  }

  async getAttachment(id: string): Promise<Attachment | null> {
    return this.attachments.get(id) ?? null;
  }

  async createApiKey(key: ApiKey): Promise<void> {
    this.apiKeys.set(key.id, key);
    this.markAuxDirty();
  }

  async listApiKeys(): Promise<ApiKey[]> {
    return [...this.apiKeys.values()];
  }

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | null> {
    for (const k of this.apiKeys.values()) {
      if (k.keyHash === keyHash) return k;
    }
    return null;
  }

  async revokeApiKey(keyId: string): Promise<void> {
    const k = this.apiKeys.get(keyId);
    if (k) {
      k.revokedAt = new Date();
      this.markAuxDirty();
    }
  }

  async insertOrUpdatePreference(preference: Preference): Promise<void> {
    this.preferences.set(preference.key, preference);
    this.markAuxDirty();
  }

  async getPreference(key: string): Promise<Preference | null> {
    return this.preferences.get(key) ?? null;
  }

  async removePreference(key: string): Promise<void> {
    this.preferences.delete(key);
    this.markAuxDirty();
  }

  async getCommandConfig(commandName: string): Promise<CommandConfig | null> {
    return this.commandConfigs.get(commandName) ?? null;
  }

  async upsertCommandConfig(config: CommandConfig): Promise<void> {
    this.commandConfigs.set(config.commandName, config);
    this.markAuxDirty();
  }

  async createPlatformSession(session: PlatformSession): Promise<void> {
    this.platformSessions.set(session.id, session);
    this.markAuxDirty();
  }

  async getPlatformSession(sessionId: string): Promise<PlatformSession | null> {
    return this.platformSessions.get(sessionId) ?? null;
  }

  async updatePlatformSession(sessionId: string, updates: Partial<PlatformSession>): Promise<void> {
    const s = this.platformSessions.get(sessionId);
    if (s) {
      Object.assign(s, updates);
      this.markAuxDirty();
    }
  }

  async insertProviderStat(stat: ProviderStat): Promise<void> {
    this.providerStats.push(stat);
    this.markAuxDirty();
  }

  async insertPlatformStats(stat: import("./store.js").PlatformStats): Promise<void> {
    this.platformStats.push(stat);
    this.markAuxDirty();
  }

  async getProviderStats(options?: { since?: Date; limit?: number }): Promise<ProviderStat[]> {
    let stats = [...this.providerStats];
    if (options?.since) {
      stats = stats.filter(s => new Date(s.createdAt) >= options.since!);
    }
    if (options?.limit) {
      stats = stats.slice(-options.limit);
    }
    return stats;
  }

  async setSessionConversation(umo: string, conversationId: string): Promise<void> {
    this.sessionConversations.set(umo, conversationId);
    this.markAuxDirty();
  }

  async getSessionConversation(umo: string): Promise<string | null> {
    return this.sessionConversations.get(umo) ?? null;
  }

  async deleteSessionConversation(umo: string): Promise<void> {
    this.sessionConversations.delete(umo);
    this.markAuxDirty();
  }
}

interface SerializedAuxData {
  platformMessageHistory: ReturnType<typeof serializePlatformMessageHistory>[];
  webchatThreads: WebchatThread[];
  attachments: Attachment[];
  apiKeys: ApiKey[];
  preferences: Preference[];
  commandConfigs: CommandConfig[];
  platformSessions: PlatformSession[];
  providerStats: ProviderStat[];
}

function serializePlatformMessageHistory(record: PlatformMessageHistory): Record<string, unknown> {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
  };
}

function deserializePlatformMessageHistory(data: Record<string, unknown>): PlatformMessageHistory {
  return {
    id: data.id as string,
    platformId: data.platformId as string,
    userId: data.userId as string,
    senderId: data.senderId as string,
    senderName: data.senderName as string,
    content: data.content as string,
    llmCheckpointId: data.llmCheckpointId as string | null,
    createdAt: new Date(data.createdAt as string),
  };
}
