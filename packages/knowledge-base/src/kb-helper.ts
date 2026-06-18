import type { KnowledgeBase } from "./types.js";
import type { EmbeddingProvider, RerankProvider } from "@yachiyo/provider/manager.js";
import type { VectorSearchResult } from "./vector-store.js";
import type { VectorStore } from "./vector-store.js";
import type { TextChunker } from "./chunker.js";
import { generateId } from "@yachiyo/common/id-generator.js";
import { KnowledgeBaseUploadError } from "@yachiyo/common/errors.js";

export class KBHelper {
  private kb: KnowledgeBase;
  private embeddingProvider: EmbeddingProvider;
  private rerankProvider: RerankProvider | null;
  private vectorStore: VectorStore;
  private chunker: TextChunker;

  get kbInfo(): KnowledgeBase {
    return this.kb;
  }

  constructor(
    kb: KnowledgeBase,
    embeddingProvider: EmbeddingProvider,
    rerankProvider: RerankProvider | null,
    vectorStore: VectorStore,
    chunker: TextChunker,
  ) {
    this.kb = kb;
    this.embeddingProvider = embeddingProvider;
    this.rerankProvider = rerankProvider;
    this.vectorStore = vectorStore;
    this.chunker = chunker;
  }

  async uploadFromUrl(url: string, options?: { docName?: string }): Promise<void> {
    let text: string;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new KnowledgeBaseUploadError({
          stage: "download",
          userMessage: `Failed to download from URL: ${url}`,
          details: { status: response.status, statusText: response.statusText },
        });
      }
      text = await response.text();
    } catch (error) {
      if (error instanceof KnowledgeBaseUploadError) throw error;
      throw new KnowledgeBaseUploadError({
        stage: "download",
        userMessage: `Failed to download from URL: ${url}`,
        details: { error: String(error) },
      });
    }

    const docName = options?.docName ?? this.extractDocName(url);
    await this.uploadText(text, docName, url);
  }

  async uploadText(text: string, docName: string, url?: string | null): Promise<void> {
    const chunks = this.chunker.chunk(text);
    if (chunks.length === 0) {
      throw new KnowledgeBaseUploadError({
        stage: "chunk",
        userMessage: "No chunks produced from the provided text",
      });
    }

    let embeddings: number[][];
    try {
      embeddings = await this.embeddingProvider.getEmbeddings(chunks);
    } catch (error) {
      throw new KnowledgeBaseUploadError({
        stage: "embedding",
        userMessage: "Failed to generate embeddings",
        details: { error: String(error) },
      });
    }

    const docId = generateId();
    const items = chunks.map((content, index) => ({
      chunkId: generateId(),
      embedding: embeddings[index],
      content,
      docId,
      docName,
      index,
      kbId: this.kb.id,
    }));

    try {
      await this.vectorStore.batchUpsert(items);
    } catch (error) {
      throw new KnowledgeBaseUploadError({
        stage: "upsert",
        userMessage: "Failed to store chunks in vector store",
        details: { error: String(error) },
      });
    }
  }

  async search(query: string, topK?: number): Promise<VectorSearchResult[]> {
    const k = topK ?? this.kb.topKDense;
    const queryEmbedding = await this.embeddingProvider.getEmbedding(query);
    const results = await this.vectorStore.search(queryEmbedding, k, this.kb.id);

    if (this.rerankProvider && results.length > 0) {
      const documents = results.map((r) => r.content);
      const rerankResults = await this.rerankProvider.rerank(query, documents, k);
      return rerankResults.map((rr) => ({
        chunkId: results[rr.index].chunkId,
        content: results[rr.index].content,
        score: rr.relevanceScore,
        docName: results[rr.index].docName,
      }));
    }

    return results;
  }

  private extractDocName(url: string): string {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split("/").filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : parsed.hostname;
    } catch {
      return url;
    }
  }
}
