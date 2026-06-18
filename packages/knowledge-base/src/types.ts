export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  emoji: string;
  embeddingProviderId: string;
  rerankProviderId: string | null;
  chunkSize: number;
  chunkOverlap: number;
  topKDense: number;
  topKSparse: number;
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
