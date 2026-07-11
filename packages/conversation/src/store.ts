import type { ConversationRecord } from "./manager.js";

/** Lightweight conversation metadata (without the heavy history JSON). */
export interface ConversationMetadata {
  id: string;
  unifiedMsgOrigin: string;
  personaId: string | null;
  platformId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  tokenUsage: number | null;
}

export interface PlatformMessageHistory {
  id: string;
  platformId: string;
  userId: string;
  senderId: string;
  senderName: string;
  content: string;
  llmCheckpointId: string | null;
  createdAt: Date;
}

export interface WebchatThread {
  id: string;
  sessionId: string;
  title: string;
  createdAt: Date;
}

export interface Attachment {
  id: string;
  url: string;
  name: string;
  size: number;
  type: string;
  createdAt: Date;
}

export interface ApiKey {
  id: string;
  keyHash: string;
  keyPrefix: string;
  name: string;
  scopes: string[] | null;
  createdBy: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface Preference {
  key: string;
  value: string;
  namespace: string;
}

export interface CommandConfig {
  commandName: string;
  config: Record<string, unknown>;
}

export interface PlatformSession {
  id: string;
  platformId: string;
  sessionId: string;
  providerId: string | null;
  personaId: string | null;
  config: Record<string, unknown>;
}

export interface PlatformStats {
  id: string;
  platformId: string;
  eventType: string;
  timestamp: Date;
  metadata: Record<string, unknown>;
}

export interface ProviderStat {
  id: string;
  providerId: string;
  model: string;
  tokenInputOther: number;
  tokenInputCached: number;
  tokenOutput: number;
  startTime: number;
  endTime: number;
  timeToFirstToken: number;
  createdAt: Date;
}

export abstract class ConversationStore {
  abstract initialize(): Promise<void>;
  async close(): Promise<void> {}

  // === Conversation ===
  abstract createConversation(conversation: ConversationRecord): Promise<void>;
  abstract getConversationById(id: string): Promise<ConversationRecord | null>;
  abstract getAllConversations(): Promise<ConversationRecord[]>;
  /** Like getAllConversations but omits the heavy history JSON field. */
  abstract getAllConversationMetadata(): Promise<ConversationMetadata[]>;
  abstract getFilteredConversations(options: {
    page?: number;
    pageSize?: number;
    platformIds?: string[];
    searchQuery?: string;
  }): Promise<[ConversationRecord[], number]>;
  abstract updateConversation(id: string, updates: Partial<ConversationRecord>): Promise<void>;
  abstract deleteConversation(id: string): Promise<void>;

  /**
   * Search conversations by content (title + message history).
   * Returns matching conversation IDs with context snippets.
   */
  abstract searchConversationsByContent(
    query: string,
    options: { platformIds?: string[]; limit?: number; offset?: number },
  ): Promise<{ conversationId: string; titleMatched: boolean; contentMatched: boolean; snippet: string }[]>;

  // === Platform Message History ===
  abstract insertPlatformMessageHistory(record: PlatformMessageHistory): Promise<void>;
  abstract getPlatformMessageHistory(options: {
    platformId: string;
    userId: string;
    limit?: number;
  }): Promise<PlatformMessageHistory[]>;
  abstract getMessageCount(options?: { since?: Date }): Promise<number>;

  // === WebChat Thread ===
  abstract createWebchatThread(thread: WebchatThread): Promise<void>;
  abstract getWebchatThread(threadId: string): Promise<WebchatThread | null>;
  abstract deleteWebchatThread(threadId: string): Promise<void>;

  // === Attachment ===
  abstract insertAttachment(attachment: Attachment): Promise<void>;
  abstract getAttachment(id: string): Promise<Attachment | null>;

  // === API Key ===
  abstract createApiKey(key: ApiKey): Promise<void>;
  abstract listApiKeys(): Promise<ApiKey[]>;
  abstract getApiKeyByHash(keyHash: string): Promise<ApiKey | null>;
  abstract revokeApiKey(keyId: string): Promise<void>;

  // === Preference ===
  abstract insertOrUpdatePreference(preference: Preference): Promise<void>;
  abstract getPreference(key: string): Promise<Preference | null>;
  abstract removePreference(key: string): Promise<void>;

  // === Command Config ===
  abstract getCommandConfig(commandName: string): Promise<CommandConfig | null>;
  abstract upsertCommandConfig(config: CommandConfig): Promise<void>;

  // === Platform Session ===
  abstract createPlatformSession(session: PlatformSession): Promise<void>;
  abstract getPlatformSession(sessionId: string): Promise<PlatformSession | null>;
  abstract updatePlatformSession(sessionId: string, updates: Partial<PlatformSession>): Promise<void>;

  // === Stats ===
  abstract insertProviderStat(stat: ProviderStat): Promise<void>;
  abstract insertPlatformStats(stat: PlatformStats): Promise<void>;
  abstract getProviderStats(options?: {
    since?: Date;
    limit?: number;
  }): Promise<ProviderStat[]>;

  // === Session Conversations ===
  abstract setSessionConversation(umo: string, conversationId: string): Promise<void>;
  abstract getSessionConversation(umo: string): Promise<string | null>;
  abstract deleteSessionConversation(umo: string): Promise<void>;
}

// In-memory implementation for development/testing
export class InMemoryConversationStore extends ConversationStore {
  private conversations: Map<string, ConversationRecord> = new Map();
  private platformMessageHistory: PlatformMessageHistory[] = [];
  private webchatThreads: Map<string, WebchatThread> = new Map();
  private attachments: Map<string, Attachment> = new Map();
  private apiKeys: Map<string, ApiKey> = new Map();
  private preferences: Map<string, Preference> = new Map();
  private commandConfigs: Map<string, CommandConfig> = new Map();
  private platformSessions: Map<string, PlatformSession> = new Map();
  private providerStats: ProviderStat[] = [];
  private platformStatsArr: PlatformStats[] = [];
  private sessionConversationsMap: Map<string, string> = new Map();

  async initialize(): Promise<void> {}

  async createConversation(conversation: ConversationRecord): Promise<void> {
    this.conversations.set(conversation.id, conversation);
  }
  async getConversationById(id: string): Promise<ConversationRecord | null> {
    return this.conversations.get(id) ?? null;
  }
  async getAllConversations(): Promise<ConversationRecord[]> {
    return [...this.conversations.values()];
  }
  async getAllConversationMetadata(): Promise<ConversationMetadata[]> {
    return [...this.conversations.values()].map((c) => ({
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
    page?: number; pageSize?: number; platformIds?: string[]; searchQuery?: string;
  }): Promise<[ConversationRecord[], number]> {
    let results = [...this.conversations.values()];
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
    const conv = this.conversations.get(id);
    if (conv) Object.assign(conv, updates, { updatedAt: new Date() });
  }
  async deleteConversation(id: string): Promise<void> { this.conversations.delete(id); }

  async searchConversationsByContent(
    query: string,
    options: { platformIds?: string[]; limit?: number; offset?: number },
  ): Promise<{ conversationId: string; titleMatched: boolean; contentMatched: boolean; snippet: string }[]> {
    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;
    const lowerQuery = query.toLowerCase();

    let results = [...this.conversations.values()];
    if (options.platformIds?.length) {
      results = results.filter((c) => options.platformIds!.includes(c.platformId));
    }

    const matches: { conversationId: string; titleMatched: boolean; contentMatched: boolean; snippet: string; updatedAt: Date }[] = [];

    for (const conv of results) {
      const titleMatched = conv.title.toLowerCase().includes(lowerQuery);
      let contentMatched = false;
      let snippet = "";

      try {
        const messages = JSON.parse(conv.history);
        if (Array.isArray(messages)) {
          for (const msg of messages) {
            const content = typeof msg.content === "string" ? msg.content : "";
            if (content.toLowerCase().includes(lowerQuery)) {
              contentMatched = true;
              if (!snippet) {
                const idx = content.toLowerCase().indexOf(lowerQuery);
                const start = Math.max(0, idx - 40);
                const end = Math.min(content.length, idx + lowerQuery.length + 40);
                const prefix = start > 0 ? "..." : "";
                const suffix = end < content.length ? "..." : "";
                snippet = prefix + content.slice(start, end) + suffix;
              }
            }
          }
        }
      } catch {
        // ignore parse errors
      }

      if (titleMatched || contentMatched) {
        matches.push({ conversationId: conv.id, titleMatched, contentMatched, snippet, updatedAt: conv.updatedAt });
      }
    }

    matches.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return matches.slice(offset, offset + limit).map(({ conversationId, titleMatched, contentMatched, snippet }) => ({
      conversationId,
      titleMatched,
      contentMatched,
      snippet,
    }));
  }
  async insertPlatformMessageHistory(record: PlatformMessageHistory): Promise<void> {
    this.platformMessageHistory.push(record);
  }
  async getPlatformMessageHistory(options: { platformId: string; userId: string; limit?: number; }): Promise<PlatformMessageHistory[]> {
    let results = this.platformMessageHistory.filter(r => r.platformId === options.platformId && r.userId === options.userId);
    if (options.limit) results = results.slice(-options.limit);
    return results;
  }
  async createWebchatThread(thread: WebchatThread): Promise<void> { this.webchatThreads.set(thread.id, thread); }
  async getWebchatThread(threadId: string): Promise<WebchatThread | null> { return this.webchatThreads.get(threadId) ?? null; }
  async deleteWebchatThread(threadId: string): Promise<void> { this.webchatThreads.delete(threadId); }
  async insertAttachment(attachment: Attachment): Promise<void> { this.attachments.set(attachment.id, attachment); }
  async getAttachment(id: string): Promise<Attachment | null> { return this.attachments.get(id) ?? null; }
  async createApiKey(key: ApiKey): Promise<void> { this.apiKeys.set(key.id, key); }
  async listApiKeys(): Promise<ApiKey[]> { return [...this.apiKeys.values()]; }
  async getApiKeyByHash(keyHash: string): Promise<ApiKey | null> {
    for (const k of this.apiKeys.values()) {
      if (k.keyHash === keyHash) return k;
    }
    return null;
  }
  async revokeApiKey(keyId: string): Promise<void> {
    const k = this.apiKeys.get(keyId);
    if (k) k.revokedAt = new Date();
  }
  async insertOrUpdatePreference(preference: Preference): Promise<void> { this.preferences.set(preference.key, preference); }
  async getPreference(key: string): Promise<Preference | null> { return this.preferences.get(key) ?? null; }
  async removePreference(key: string): Promise<void> { this.preferences.delete(key); }
  async getCommandConfig(commandName: string): Promise<CommandConfig | null> { return this.commandConfigs.get(commandName) ?? null; }
  async upsertCommandConfig(config: CommandConfig): Promise<void> { this.commandConfigs.set(config.commandName, config); }
  async createPlatformSession(session: PlatformSession): Promise<void> { this.platformSessions.set(session.id, session); }
  async getPlatformSession(sessionId: string): Promise<PlatformSession | null> { return this.platformSessions.get(sessionId) ?? null; }
  async updatePlatformSession(sessionId: string, updates: Partial<PlatformSession>): Promise<void> {
    const s = this.platformSessions.get(sessionId);
    if (s) Object.assign(s, updates);
  }
  async insertProviderStat(stat: ProviderStat): Promise<void> { this.providerStats.push(stat); }
  async insertPlatformStats(stat: PlatformStats): Promise<void> { this.platformStatsArr.push(stat); }
  async getMessageCount(options?: { since?: Date }): Promise<number> {
    if (options?.since) {
      return this.platformMessageHistory.filter(m => m.createdAt >= options.since!).length;
    }
    return this.platformMessageHistory.length;
  }
  async getProviderStats(options?: { since?: Date; limit?: number }): Promise<ProviderStat[]> {
    let result = [...this.providerStats];
    if (options?.since) {
      result = result.filter(s => s.createdAt >= options.since!);
    }
    result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    if (options?.limit) result = result.slice(0, options.limit);
    return result;
  }

  // === Session Conversations ===
  async setSessionConversation(umo: string, conversationId: string): Promise<void> {
    this.sessionConversationsMap.set(umo, conversationId);
  }
  async getSessionConversation(umo: string): Promise<string | null> {
    return this.sessionConversationsMap.get(umo) ?? null;
  }
  async deleteSessionConversation(umo: string): Promise<void> {
    this.sessionConversationsMap.delete(umo);
  }
}
