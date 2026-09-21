export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  emoji: string;
  embeddingProviderId: string;
  rerankProviderId: string | null;
  chunkSize: number;
  chunkOverlap: number;
  /** Number of dense (vector) candidates retrieved before rerank. */
  topKDense: number;
  /**
   * @reserved Number of sparse (keyword/BM25) candidates. Sparse retrieval is
   * NOT implemented yet — the store has no FTS index and `KBHelper.search`
   * only performs dense vector search. This value is persisted and surfaced in
   * the dashboard but has no effect until hybrid retrieval is added.
   */
  topKSparse: number;
  /** Number of final results returned after fusion/rerank. */
  topMFinal: number;
}

export interface KBDocument {
  id: string;
  kbId: string;
  name: string;
  url: string | null;
  type: string;
  createdAt: number;
  chunkCount: number;
}

export interface KBChunk {
  id: string;
  docId: string;
  kbId: string;
  content: string;
  index: number;
  embedding?: number[];
}
