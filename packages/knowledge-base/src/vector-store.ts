export interface VectorSearchResult {
  chunkId: string;
  content: string;
  score: number;
  docName: string;
  metadata?: Record<string, unknown>;
}

export abstract class VectorStore {
  abstract initialize(): Promise<void>;
  abstract close(): Promise<void>;
  abstract upsert(
    chunkId: string,
    embedding: number[],
    content: string,
    docId: string,
    docName: string,
    index: number,
    kbId: string,
  ): Promise<void>;
  abstract batchUpsert(
    items: Array<{
      chunkId: string;
      embedding: number[];
      content: string;
      docId: string;
      docName: string;
      index: number;
      kbId: string;
    }>,
  ): Promise<void>;
  abstract search(queryEmbedding: number[], topK: number, kbId?: string): Promise<VectorSearchResult[]>;
  abstract deleteByDocId(docId: string): Promise<void>;
  abstract deleteByKbId(kbId: string): Promise<void>;
  abstract count(kbId?: string): Promise<number>;
}
