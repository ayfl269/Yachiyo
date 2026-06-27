import type { ProviderManager } from "@yachiyo/provider/manager.js";
import type { KnowledgeBase, KBDocument } from "./types.js";
import { generateId } from "@yachiyo/common/id-generator.js";
import { KnowledgeBaseUploadError } from "@yachiyo/common/errors.js";
import { KBHelper } from "./kb-helper.js";
import { InMemoryVectorStore } from "./stores/in-memory-vector-store.js";
import { SqliteKBMetadataStore } from "./stores/sqlite-kb-store.js";
import { TextChunker } from "./chunker.js";
import type { VectorStore } from "./vector-store.js";

export interface CreateKbOptions {
  name: string;
  description: string;
  emoji: string;
  embeddingProviderId: string;
  rerankProviderId?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  topKDense?: number;
  topKSparse?: number;
  topMFinal?: number;
}

export class KnowledgeBaseManager {
  private providerManager: ProviderManager;
  private kbs = new Map<string, KnowledgeBase>();
  private kbHelpers = new Map<string, KBHelper>();
  private vectorStore: VectorStore;
  private chunker: TextChunker;
  private metadataStore?: SqliteKBMetadataStore;

  constructor(providerManager: ProviderManager, vectorStore?: VectorStore) {
    this.providerManager = providerManager;
    this.vectorStore = vectorStore ?? new InMemoryVectorStore();
    this.chunker = new TextChunker();
  }

  setMetadataStore(store: SqliteKBMetadataStore): void {
    this.metadataStore = store;
  }

  async initialize(): Promise<void> {
    await this.vectorStore.initialize();

    if (this.metadataStore) {
      const savedKbs = this.metadataStore.getAllKbs();
      for (const kb of savedKbs) {
        this.kbs.set(kb.id, kb);

        const embeddingProvider = this.providerManager.embeddingInsts.find(
          (p) => p.providerConfig.id === kb.embeddingProviderId,
        );
        const rerankProvider = kb.rerankProviderId
          ? this.providerManager.rerankInsts.find(
              (p) => p.providerConfig.id === kb.rerankProviderId,
            ) ?? null
          : null;

        if (embeddingProvider) {
          const helper = new KBHelper(
            kb,
            embeddingProvider,
            rerankProvider,
            this.vectorStore,
            new TextChunker({ chunkSize: kb.chunkSize, chunkOverlap: kb.chunkOverlap }),
          );
          this.kbHelpers.set(kb.id, helper);
        }
      }
    }
  }

  async terminate(): Promise<void> {
    await this.vectorStore.close();
    this.kbs.clear();
    this.kbHelpers.clear();
  }

  async createKb(options: CreateKbOptions): Promise<KnowledgeBase> {
    const embeddingProvider = this.providerManager.embeddingInsts.find(
      (p) => p.providerConfig.id === options.embeddingProviderId,
    );
    if (!embeddingProvider) {
      throw new KnowledgeBaseUploadError({
        stage: "create",
        userMessage: `Embedding provider not found: ${options.embeddingProviderId}`,
      });
    }

    let rerankProvider = null;
    if (options.rerankProviderId) {
      rerankProvider = this.providerManager.rerankInsts.find(
        (p) => p.providerConfig.id === options.rerankProviderId,
      ) ?? null;
      if (!rerankProvider) {
        throw new KnowledgeBaseUploadError({
          stage: "create",
          userMessage: `Rerank provider not found: ${options.rerankProviderId}`,
        });
      }
    }

    const kb: KnowledgeBase = {
      id: generateId(),
      name: options.name,
      description: options.description,
      emoji: options.emoji,
      embeddingProviderId: options.embeddingProviderId,
      rerankProviderId: options.rerankProviderId ?? null,
      chunkSize: options.chunkSize ?? 500,
      chunkOverlap: options.chunkOverlap ?? 50,
      topKDense: options.topKDense ?? 10,
      topKSparse: options.topKSparse ?? 10,
      topMFinal: options.topMFinal ?? 5,
    };

    const helper = new KBHelper(
      kb,
      embeddingProvider,
      rerankProvider,
      this.vectorStore,
      new TextChunker({ chunkSize: kb.chunkSize, chunkOverlap: kb.chunkOverlap }),
    );

    this.kbs.set(kb.id, kb);
    this.kbHelpers.set(kb.id, helper);

    this.metadataStore?.saveKb(kb);

    return kb;
  }

  async uploadFromUrl(kbId: string, url: string, options?: { docName?: string }): Promise<void> {
    const helper = this.getKbHelper(kbId);
    await helper.uploadFromUrl(url, options);
  }

  async uploadText(kbId: string, text: string, docName: string): Promise<void> {
    const helper = this.getKbHelper(kbId);
    await helper.uploadText(text, docName);
  }

  async retrieve(
    query: string,
    kbNames: string[],
    topKFusion?: number,
    topMFinal?: number,
  ): Promise<string | null> {
    const helpers: KBHelper[] = [];
    for (const name of kbNames) {
      const kb = this.getKbByName(name);
      if (kb) {
        const helper = this.kbHelpers.get(kb.id);
        if (helper) helpers.push(helper);
      }
    }

    if (helpers.length === 0) return null;

    const topK = topKFusion ?? 10;
    const allResults: Array<{ chunkId: string; content: string; score: number; docName: string; kbName: string }> = [];

    for (const helper of helpers) {
      const results = await helper.search(query, topK);
      const kbName = helper.kbInfo.name;
      for (const r of results) {
        allResults.push({ ...r, kbName });
      }
    }

    // Deduplicate by chunkId
    const seen = new Set<string>();
    const deduped = allResults.filter((r) => {
      if (seen.has(r.chunkId)) return false;
      seen.add(r.chunkId);
      return true;
    });

    // Sort by score descending
    deduped.sort((a, b) => b.score - a.score);

    const m = topMFinal ?? 5;
    const finalResults = deduped.slice(0, m);

    if (finalResults.length === 0) return null;

    return finalResults
      .map((r, i) => `[${i + 1}] [${r.kbName} / ${r.docName}] (score: ${r.score.toFixed(4)})\n${r.content}`)
      .join("\n\n---\n\n");
  }

  getKb(kbId: string): KnowledgeBase | undefined {
    return this.kbs.get(kbId);
  }

  getKbByName(kbName: string): KnowledgeBase | undefined {
    for (const kb of this.kbs.values()) {
      if (kb.name === kbName) return kb;
    }
    return undefined;
  }

  async deleteKb(kbId: string): Promise<void> {
    await this.vectorStore.deleteByKbId(kbId);
    this.kbs.delete(kbId);
    this.kbHelpers.delete(kbId);
    this.metadataStore?.deleteKb(kbId);
  }

  listKbs(): KnowledgeBase[] {
    return Array.from(this.kbs.values());
  }

  getDocuments(kbId: string): KBDocument[] {
    return this.metadataStore ? this.metadataStore.getDocumentsByKb(kbId) : [];
  }

  async deleteDocument(docId: string): Promise<void> {
    await this.vectorStore.deleteByDocId(docId);
    this.metadataStore?.deleteDocument(docId);
  }

  private getKbHelper(kbId: string): KBHelper {
    const helper = this.kbHelpers.get(kbId);
    if (!helper) {
      throw new KnowledgeBaseUploadError({
        stage: "access",
        userMessage: `Knowledge base not found: ${kbId}`,
      });
    }
    return helper;
  }
}
