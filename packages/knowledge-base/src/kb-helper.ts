import type { KnowledgeBase } from "./types.js";
import type { EmbeddingProvider, RerankProvider } from "@yachiyo/provider/manager.js";
import type { VectorSearchResult } from "./vector-store.js";
import type { VectorStore } from "./vector-store.js";
import type { TextChunker } from "./chunker.js";
import { generateId } from "@yachiyo/common/id-generator.js";
import { KnowledgeBaseUploadError } from "@yachiyo/common/errors.js";
import { safeFetch } from "@yachiyo/common/ssrf-guard.js";

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
    let finalUrl = url;
    try {
      // safeFetch validates URL scheme to prevent non-HTTP protocols, and limits response
      // size and redirect loops (LAN access is allowed per business requirements).
      const response = await safeFetch(url);
      finalUrl = response.url || url;

      if (!response.ok) {
        throw new KnowledgeBaseUploadError({
          stage: "download",
          userMessage: `Failed to download from URL: ${finalUrl}`,
          details: { status: response.status, statusText: response.statusText },
        });
      }

      // Content-Type allowlist: only accept text-based content that the
      // chunker can meaningfully process. Binary files (executables, images,
      // archives) would produce garbage chunks and waste embedding tokens.
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const isAllowedType =
        contentType.startsWith("text/") ||
        contentType.includes("json") ||
        contentType.includes("xml") ||
        contentType.includes("markdown") ||
        contentType.includes("plain") ||
        contentType.includes("html") ||
        contentType.includes("application/pdf") ||
        contentType === ""; // some servers omit Content-Type; allow and let text() decide
      if (!isAllowedType) {
        throw new KnowledgeBaseUploadError({
          stage: "download",
          userMessage: `Unsupported Content-Type "${contentType}". Only text-based content (text/*, JSON, XML, HTML, PDF) is accepted.`,
          details: { contentType, url: finalUrl },
        });
      }

      // Cap the downloaded text size to prevent memory exhaustion from
      // oversized documents. safeFetch already caps the stream at 10 MB,
      // but we enforce a tighter limit here since the text is held in memory
      // for chunking + embedding.
      const MAX_TEXT_BYTES = 5 * 1024 * 1024; // 5 MB
      const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
      if (contentLength > MAX_TEXT_BYTES) {
        throw new KnowledgeBaseUploadError({
          stage: "download",
          userMessage: `Document too large (${contentLength} bytes, max ${MAX_TEXT_BYTES} bytes).`,
          details: { contentLength, maxBytes: MAX_TEXT_BYTES, url: finalUrl },
        });
      }

      text = await response.text();
      if (text.length > MAX_TEXT_BYTES) {
        throw new KnowledgeBaseUploadError({
          stage: "download",
          userMessage: `Document too large after decode (${text.length} chars, max ${MAX_TEXT_BYTES} chars).`,
          details: { textLength: text.length, maxBytes: MAX_TEXT_BYTES, url: finalUrl },
        });
      }
    } catch (error) {
      if (error instanceof KnowledgeBaseUploadError) throw error;
      throw new KnowledgeBaseUploadError({
        stage: "download",
        userMessage: `Failed to download from URL: ${finalUrl}`,
        details: { error: String(error) },
      });
    }

    const docName = options?.docName ?? this.extractDocName(finalUrl);
    await this.uploadText(text, docName, finalUrl);
  }

  async uploadText(text: string, docName: string, _url?: string | null): Promise<void> {
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
