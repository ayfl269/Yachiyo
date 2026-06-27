import type { VectorSearchResult } from "../vector-store.js";
import { VectorStore } from "../vector-store.js";

interface StoredVector {
  embedding: number[];
  content: string;
  docId: string;
  docName: string;
  index: number;
  kbId: string;
}

export class InMemoryVectorStore extends VectorStore {
  private store = new Map<string, StoredVector>();

  async initialize(): Promise<void> {
    // no-op for in-memory
  }

  async close(): Promise<void> {
    this.store.clear();
  }

  async upsert(
    chunkId: string,
    embedding: number[],
    content: string,
    docId: string,
    docName: string,
    index: number,
    kbId: string,
  ): Promise<void> {
    this.store.set(chunkId, { embedding, content, docId, docName, index, kbId });
  }

  async batchUpsert(
    items: Array<{
      chunkId: string;
      embedding: number[];
      content: string;
      docId: string;
      docName: string;
      index: number;
      kbId: string;
    }>,
  ): Promise<void> {
    for (const item of items) {
      this.store.set(item.chunkId, {
        embedding: item.embedding,
        content: item.content,
        docId: item.docId,
        docName: item.docName,
        index: item.index,
        kbId: item.kbId,
      });
    }
  }

  async search(queryEmbedding: number[], topK: number, kbId?: string): Promise<VectorSearchResult[]> {
    const results: Array<{ chunkId: string; score: number; vector: StoredVector }> = [];

    // Precompute query vector norm
    const queryNormSq = queryEmbedding.reduce((sum, val) => sum + val * val, 0);
    const queryNorm = Math.sqrt(queryNormSq);

    if (queryNorm === 0) {
      return [];
    }

    const len = queryEmbedding.length;

    for (const [chunkId, vector] of this.store) {
      // Filter by kbId if provided
      if (kbId && vector.kbId !== kbId) {
        continue;
      }

      const emb = vector.embedding;
      if (emb.length !== len) {
        throw new Error(
          `Dimension mismatch: query vector has length ${len}, but stored vector ${chunkId} has length ${emb.length}`
        );
      }

      let dot = 0;
      let normBSq = 0;
      for (let i = 0; i < len; i++) {
        const valB = emb[i];
        dot += queryEmbedding[i] * valB;
        normBSq += valB * valB;
      }
      const normB = Math.sqrt(normBSq);
      const score = normB === 0 ? 0 : dot / (queryNorm * normB);

      results.push({ chunkId, score, vector });
    }

    results.sort((a, b) => b.score - a.score);

    return results.slice(0, topK).map((r) => ({
      chunkId: r.chunkId,
      content: r.vector.content,
      score: r.score,
      docName: r.vector.docName,
    }));
  }

  async deleteByDocId(docId: string): Promise<void> {
    for (const [id, vector] of this.store) {
      if (vector.docId === docId) {
        this.store.delete(id);
      }
    }
  }

  async deleteByKbId(kbId: string): Promise<void> {
    for (const [id, vector] of this.store) {
      if (vector.kbId === kbId) {
        this.store.delete(id);
      }
    }
  }

  async count(kbId?: string): Promise<number> {
    if (!kbId) return this.store.size;
    let c = 0;
    for (const vector of this.store.values()) {
      if (vector.kbId === kbId) c++;
    }
    return c;
  }
}
