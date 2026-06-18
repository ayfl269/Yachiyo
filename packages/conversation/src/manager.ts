import { generateId } from "@yachiyo/common/id-generator.js";
import type { ConversationStore, ProviderStat } from "./store.js";
import type { MemoryConsolidator } from "@yachiyo/agent/memory-consolidator.js";

export interface ConversationRecord {
  id: string;
  unifiedMsgOrigin: string;
  personaId: string | null;
  history: string;
  platformId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  tokenUsage: number | null;
}

export class ConversationManager {
  private store: ConversationStore | null;
  private memoryConsolidator: MemoryConsolidator | null = null;

  constructor(store?: ConversationStore) {
    this.store = store ?? null;
  }

  setMemoryConsolidator(consolidator: MemoryConsolidator): void {
    this.memoryConsolidator = consolidator;
  }

  async initialize(): Promise<void> {
    if (this.store) {
      await this.store.initialize();
    }
  }

  async close(): Promise<void> {
    if (this.store) {
      await this.store.close();
    }
  }

  async newConversation(umo: string, options?: {
    platformId?: string;
    title?: string;
    personaId?: string;
  }): Promise<string> {
    // Archive short-term memories from the previous session before creating a new one
    if (this.memoryConsolidator) {
      try {
        const oldConvId = this.store ? await this.store.getSessionConversation(umo) : null;
        if (oldConvId) {
          const archiveResult = this.memoryConsolidator.archiveSession(umo);
          if (archiveResult.promoted > 0 || archiveResult.deleted > 0) {
            console.log(`[ConversationManager] Archived short-term memories for session ${umo}: promoted=${archiveResult.promoted}, deleted=${archiveResult.deleted}`);
          }
        }
      } catch (e) {
        console.error("[ConversationManager] Failed to archive short-term memories:", e);
      }
    }

    const conversationId = generateId();
    const conversation: ConversationRecord = {
      id: conversationId,
      unifiedMsgOrigin: umo,
      personaId: options?.personaId ?? null,
      history: "[]",
      platformId: options?.platformId ?? "",
      title: options?.title ?? "",
      createdAt: new Date(),
      updatedAt: new Date(),
      tokenUsage: null,
    };
    if (this.store) {
      await this.store.createConversation(conversation);
      await this.store.setSessionConversation(umo, conversationId);
    }
    return conversationId;
  }

  async switchConversation(umo: string, conversationId: string): Promise<void> {
    if (this.store) {
      const conv = await this.store.getConversationById(conversationId);
      if (!conv) {
        throw new Error(`Conversation ${conversationId} not found`);
      }
      await this.store.setSessionConversation(umo, conversationId);
    }
  }

  async deleteConversation(umo: string, conversationId?: string): Promise<void> {
    if (!this.store) return;
    const cid = conversationId ?? await this.store.getSessionConversation(umo);
    if (!cid) return;

    await this.store.deleteConversation(cid);

    const currentSession = await this.store.getSessionConversation(umo);
    if (currentSession === cid) {
      await this.store.deleteSessionConversation(umo);
    }
  }

  async getCurrConversationId(umo: string): Promise<string | null> {
    if (!this.store) return null;
    return this.store.getSessionConversation(umo);
  }

  async getConversation(umo: string, conversationId: string): Promise<ConversationRecord | null> {
    if (!this.store) return null;
    return this.store.getConversationById(conversationId);
  }

  async updateConversation(umo: string, conversationId: string, options: {
    history?: string;
    title?: string;
    personaId?: string;
    tokenUsage?: number;
  }): Promise<void> {
    if (!this.store) return;
    await this.store.updateConversation(conversationId, {
      ...options,
      updatedAt: new Date(),
    });
  }

  async addMessagePair(umo: string, userMessage: string, assistantMessage: string): Promise<void> {
    if (!this.store) return;

    let conversationId = await this.store.getSessionConversation(umo);
    if (!conversationId) {
      conversationId = await this.newConversation(umo);
    }
    const conv = await this.store.getConversationById(conversationId);
    if (!conv) return;

    let history: unknown[];
    try {
      history = JSON.parse(conv.history);
    } catch {
      history = [];
    }
    if (!Array.isArray(history)) history = [];
    history.push({ role: "user", content: userMessage });
    history.push({ role: "assistant", content: assistantMessage });

    await this.store.updateConversation(conversationId, {
      history: JSON.stringify(history),
      updatedAt: new Date(),
    });
  }

  async recordProviderStat(stat: ProviderStat): Promise<void> {
    if (!this.store) return;
    await this.store.insertProviderStat(stat);
  }

  async getProviderStats(options?: { since?: Date; limit?: number }): Promise<ProviderStat[]> {
    if (!this.store) return [];
    return this.store.getProviderStats(options);
  }

  async getMessageCount(options?: { since?: Date }): Promise<number> {
    if (!this.store) return 0;
    return this.store.getMessageCount(options);
  }
}

