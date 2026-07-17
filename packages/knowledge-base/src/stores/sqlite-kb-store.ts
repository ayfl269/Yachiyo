/**
 * SQLite stores for Knowledge Base metadata and vectors.
 *
 * Persists knowledge bases, documents, chunks, and vector embeddings
 * to knowledge.db.
 */

import type Database from "better-sqlite3";
import type { KnowledgeBase, KBDocument, KBChunk } from "../types.js";
import { VectorStore, type VectorSearchResult } from "../vector-store.js";
import type { Migration } from "@yachiyo/common/database.js";

// ── Migrations ──

export const KNOWLEDGE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "knowledge_base_initial",
    up: `
      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        emoji TEXT DEFAULT '',
        embedding_provider_id TEXT NOT NULL,
        rerank_provider_id TEXT,
        chunk_size INTEGER NOT NULL DEFAULT 500,
        chunk_overlap INTEGER NOT NULL DEFAULT 50,
        top_k_dense INTEGER NOT NULL DEFAULT 10,
        top_k_sparse INTEGER NOT NULL DEFAULT 10,
        top_m_final INTEGER NOT NULL DEFAULT 5,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS kb_documents (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT,
        type TEXT NOT NULL DEFAULT '',
        chunk_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS kb_chunks (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        kb_id TEXT NOT NULL,
        content TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (doc_id) REFERENCES kb_documents(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS kb_vectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id TEXT NOT NULL UNIQUE,
        doc_id TEXT NOT NULL,
        kb_id TEXT NOT NULL,
        embedding BLOB NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        doc_name TEXT NOT NULL DEFAULT '',
        chunk_index INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (chunk_id) REFERENCES kb_chunks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id);
      CREATE INDEX IF NOT EXISTS idx_kb_documents_kb ON kb_documents(kb_id);
      CREATE INDEX IF NOT EXISTS idx_kb_vectors_kb ON kb_vectors(kb_id);
      CREATE INDEX IF NOT EXISTS idx_kb_vectors_doc ON kb_vectors(doc_id);
    `,
  },
];

// ── Row Types ──

/** Row type for the knowledge_bases table. */
interface KbMetadataRow {
  id: string;
  name: string;
  description: string;
  emoji: string;
  embedding_provider_id: string;
  rerank_provider_id: string | null;
  chunk_size: number;
  chunk_overlap: number;
  top_k_dense: number;
  top_k_sparse: number;
  top_m_final: number;
  created_at: string;
}

/** Row type for the kb_documents table. */
interface KbDocumentRow {
  id: string;
  kb_id: string;
  name: string;
  url: string | null;
  type: string;
  chunk_count: number;
  created_at: number;
}

/** Row type for SELECT chunk_id, embedding, content, doc_name FROM kb_vectors. */
interface KbVectorRow {
  chunk_id: string;
  embedding: Buffer;
  content: string;
  doc_name: string;
}

/** Row type for COUNT(*) as cnt queries. */
interface CountRow {
  cnt: number;
}

// ── KB Metadata Store ──

export class SqliteKBMetadataStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // === Knowledge Bases ===

  saveKb(kb: KnowledgeBase): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO knowledge_bases
        (id, name, description, emoji, embedding_provider_id, rerank_provider_id,
         chunk_size, chunk_overlap, top_k_dense, top_k_sparse, top_m_final)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      kb.id, kb.name, kb.description, kb.emoji,
      kb.embeddingProviderId, kb.rerankProviderId,
      kb.chunkSize, kb.chunkOverlap, kb.topKDense, kb.topKSparse, kb.topMFinal,
    );
  }

  getKb(id: string): KnowledgeBase | null {
    const row = this.db.prepare("SELECT id, name, description, emoji, embedding_provider_id, rerank_provider_id, chunk_size, chunk_overlap, top_k_dense, top_k_sparse, top_m_final, created_at FROM knowledge_bases WHERE id = ?").get(id) as KbMetadataRow;
    return row ? this.rowToKb(row) : null;
  }

  getKbByName(name: string): KnowledgeBase | null {
    const row = this.db.prepare("SELECT id, name, description, emoji, embedding_provider_id, rerank_provider_id, chunk_size, chunk_overlap, top_k_dense, top_k_sparse, top_m_final, created_at FROM knowledge_bases WHERE name = ?").get(name) as KbMetadataRow;
    return row ? this.rowToKb(row) : null;
  }

  getAllKbs(): KnowledgeBase[] {
    const rows = this.db.prepare("SELECT id, name, description, emoji, embedding_provider_id, rerank_provider_id, chunk_size, chunk_overlap, top_k_dense, top_k_sparse, top_m_final, created_at FROM knowledge_bases ORDER BY name").all() as KbMetadataRow[];
    return rows.map((r) => this.rowToKb(r));
  }

  deleteKb(id: string): void {
    this.db.prepare("DELETE FROM knowledge_bases WHERE id = ?").run(id);
  }

  // === Documents ===

  saveDocument(doc: KBDocument): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO kb_documents (id, kb_id, name, url, type, chunk_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(doc.id, doc.kbId, doc.name, doc.url, doc.type, doc.chunkCount, doc.createdAt);
  }

  getDocumentsByKb(kbId: string): KBDocument[] {
    const rows = this.db.prepare("SELECT id, kb_id, name, url, type, chunk_count, created_at FROM kb_documents WHERE kb_id = ?").all(kbId) as KbDocumentRow[];
    return rows.map((r) => this.rowToDoc(r));
  }

  deleteDocument(docId: string): void {
    this.db.prepare("DELETE FROM kb_documents WHERE id = ?").run(docId);
  }

  // === Chunks ===

  saveChunk(chunk: KBChunk): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO kb_chunks (id, doc_id, kb_id, content, chunk_index)
      VALUES (?, ?, ?, ?, ?)
    `).run(chunk.id, chunk.docId, chunk.kbId, chunk.content, chunk.index);
  }

  saveChunks(chunks: KBChunk[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO kb_chunks (id, doc_id, kb_id, content, chunk_index)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const chunk of chunks) {
        stmt.run(chunk.id, chunk.docId, chunk.kbId, chunk.content, chunk.index);
      }
    })();
  }

  // ── Helpers ──

  private rowToKb(row: KbMetadataRow): KnowledgeBase {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      emoji: row.emoji,
      embeddingProviderId: row.embedding_provider_id,
      rerankProviderId: row.rerank_provider_id,
      chunkSize: row.chunk_size,
      chunkOverlap: row.chunk_overlap,
      topKDense: row.top_k_dense,
      topKSparse: row.top_k_sparse,
      topMFinal: row.top_m_final,
    };
  }

  private rowToDoc(row: KbDocumentRow): KBDocument {
    return {
      id: row.id,
      kbId: row.kb_id,
      name: row.name,
      url: row.url,
      type: row.type,
      createdAt: row.created_at,
      chunkCount: row.chunk_count,
    };
  }
}

// ── SQLite Vector Store ──

function embeddingToBuffer(embedding: number[]): Buffer {
  const arr = new Float32Array(embedding);
  return Buffer.from(arr.buffer);
}

function bufferToEmbedding(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export class SqliteVectorStore extends VectorStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    super();
    this.db = db;
  }

  async initialize(): Promise<void> {
    // Migrations applied externally
  }

  async close(): Promise<void> {
    // DB lifecycle managed by DatabaseManager
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
    this.db.transaction(() => {
      // 1. Upsert Document metadata
      // 使用 ON CONFLICT(id) DO UPDATE 而非 INSERT OR REPLACE，避免触发
      // kb_chunks.doc_id 的 ON DELETE CASCADE 级联删除已有 chunks/vectors。
      this.db.prepare(`
        INSERT INTO kb_documents (id, kb_id, name, type, chunk_count, created_at)
        VALUES (?, ?, ?, '', 1, ?)
        ON CONFLICT(id) DO UPDATE SET
          kb_id = excluded.kb_id,
          name = excluded.name,
          type = excluded.type,
          chunk_count = excluded.chunk_count,
          created_at = excluded.created_at
      `).run(docId, kbId, docName, Date.now());

      // 2. Upsert Chunk metadata
      this.db.prepare(`
        INSERT INTO kb_chunks (id, doc_id, kb_id, content, chunk_index)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          doc_id = excluded.doc_id,
          kb_id = excluded.kb_id,
          content = excluded.content,
          chunk_index = excluded.chunk_index
      `).run(chunkId, docId, kbId, content, index);

      // 3. Upsert Vector data（chunk_id 上有 UNIQUE 约束）
      this.db.prepare(`
        INSERT INTO kb_vectors
          (chunk_id, embedding, content, doc_id, doc_name, chunk_index, kb_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chunk_id) DO UPDATE SET
          embedding = excluded.embedding,
          content = excluded.content,
          doc_id = excluded.doc_id,
          doc_name = excluded.doc_name,
          chunk_index = excluded.chunk_index,
          kb_id = excluded.kb_id
      `).run(chunkId, embeddingToBuffer(embedding), content, docId, docName, index, kbId);
    })();
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
    if (items.length === 0) return;

    // Group items by docId to calculate chunk counts and insert documents
    const docMap = new Map<string, { kbId: string; name: string; count: number }>();
    for (const item of items) {
      const existing = docMap.get(item.docId);
      if (existing) {
        existing.count = Math.max(existing.count, item.index + 1);
      } else {
        docMap.set(item.docId, { kbId: item.kbId, name: item.docName, count: item.index + 1 });
      }
    }

    const docStmt = this.db.prepare(`
      INSERT INTO kb_documents (id, kb_id, name, type, chunk_count, created_at)
      VALUES (?, ?, ?, '', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kb_id = excluded.kb_id,
        name = excluded.name,
        type = excluded.type,
        chunk_count = excluded.chunk_count,
        created_at = excluded.created_at
    `);

    const chunkStmt = this.db.prepare(`
      INSERT INTO kb_chunks (id, doc_id, kb_id, content, chunk_index)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        doc_id = excluded.doc_id,
        kb_id = excluded.kb_id,
        content = excluded.content,
        chunk_index = excluded.chunk_index
    `);

    const vectorStmt = this.db.prepare(`
      INSERT INTO kb_vectors
        (chunk_id, embedding, content, doc_id, doc_name, chunk_index, kb_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        embedding = excluded.embedding,
        content = excluded.content,
        doc_id = excluded.doc_id,
        doc_name = excluded.doc_name,
        chunk_index = excluded.chunk_index,
        kb_id = excluded.kb_id
    `);

    this.db.transaction(() => {
      // 1. Insert documents
      const now = Date.now();
      for (const [docId, doc] of docMap.entries()) {
        docStmt.run(docId, doc.kbId, doc.name, doc.count, now);
      }

      // 2. Insert chunks and vectors
      for (const item of items) {
        chunkStmt.run(item.chunkId, item.docId, item.kbId, item.content, item.index);
        vectorStmt.run(
          item.chunkId,
          embeddingToBuffer(item.embedding),
          item.content,
          item.docId,
          item.docName,
          item.index,
          item.kbId,
        );
      }
    })();
  }

  async search(queryEmbedding: number[], topK: number, kbId?: string): Promise<VectorSearchResult[]> {
    // Cap the number of rows scanned to prevent O(N) memory blowup on large
    // knowledge bases. We fetch up to MAX_SCAN_ROWS, compute cosine similarity
    // incrementally, and keep only the top-K by score using a partial sort.
    // This is a pragmatic mitigation until an ANN index (sqlite-vec/FAISS) is
    // available.
    const MAX_SCAN_ROWS = Math.max(topK * 50, 5000);

    // 1. 根据是否传入 kbId，决定是否仅筛选当前知识库的向量，减少数据库 I/O 和内存开销
    const sql = kbId
      ? "SELECT chunk_id, embedding, content, doc_name FROM kb_vectors WHERE kb_id = ? LIMIT ?"
      : "SELECT chunk_id, embedding, content, doc_name FROM kb_vectors LIMIT ?";

    const rows = (kbId
      ? this.db.prepare(sql).all(kbId, MAX_SCAN_ROWS)
      : this.db.prepare(sql).all(MAX_SCAN_ROWS)) as KbVectorRow[];

    const queryArr = new Float32Array(queryEmbedding);
    const len = queryArr.length;

    // 2. 预先计算查询向量的范数，避免在循环体内重复计算，显著降低 CPU 消耗
    let queryNormSq = 0;
    for (let i = 0; i < len; i++) {
      queryNormSq += queryArr[i] * queryArr[i];
    }
    const queryNorm = Math.sqrt(queryNormSq);

    if (queryNorm === 0) {
      return [];
    }

    const results: Array<{ chunkId: string; score: number; content: string; docName: string }> = [];
    let dimensionMismatchCount = 0;

    for (const row of rows) {
      const vecArr = bufferToEmbedding(row.embedding);
      if (vecArr.length !== len) {
        // Skip rows whose embedding dimension doesn't match the query (e.g.
        // after a provider model change) instead of failing the entire
        // search. Log a warning so operators can detect stale vectors.
        dimensionMismatchCount++;
        continue;
      }

      // 3. 内联计算点积与文档向量的范数（避开多余的函数调用开销，方便 V8 引擎做更好的优化）
      let dot = 0;
      let normBSq = 0;
      for (let i = 0; i < len; i++) {
        const valB = vecArr[i];
        dot += queryArr[i] * valB;
        normBSq += valB * valB;
      }

      const normB = Math.sqrt(normBSq);
      const score = normB === 0 ? 0 : dot / (queryNorm * normB);

      results.push({
        chunkId: row.chunk_id,
        score,
        content: row.content,
        docName: row.doc_name,
      });
    }

    if (dimensionMismatchCount > 0) {
      console.warn(
        `[SqliteVectorStore] Skipped ${dimensionMismatchCount} vector(s) with mismatched dimensions during search.`,
      );
    }

    results.sort((a, b) => b.score - a.score);

    return results.slice(0, topK).map((r) => ({
      chunkId: r.chunkId,
      content: r.content,
      score: r.score,
      docName: r.docName,
    }));
  }

  async deleteByDocId(docId: string): Promise<void> {
    this.db.prepare("DELETE FROM kb_vectors WHERE doc_id = ?").run(docId);
  }

  async deleteByKbId(kbId: string): Promise<void> {
    this.db.prepare("DELETE FROM kb_vectors WHERE kb_id = ?").run(kbId);
  }

  async count(kbId?: string): Promise<number> {
    if (!kbId) {
      const row = this.db.prepare("SELECT COUNT(*) as cnt FROM kb_vectors").get() as CountRow;
      return row?.cnt ?? 0;
    }
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM kb_vectors WHERE kb_id = ?").get(kbId) as CountRow;
    return row?.cnt ?? 0;
  }
}
