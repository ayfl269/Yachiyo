import type { KnowledgeBase } from "./types.js";
import type { EmbeddingProvider, RerankProvider } from "@yachiyo/provider/manager.js";
import type { VectorSearchResult } from "./vector-store.js";
import type { VectorStore } from "./vector-store.js";
import type { TextChunker } from "./chunker.js";
import { generateId } from "@yachiyo/common/id-generator.js";
import { KnowledgeBaseUploadError } from "@yachiyo/common/errors.js";
import { BlockList } from "net";
import { promises as dnsPromises } from "dns";

// ── SSRF protection ──────────────────────────────────────────────────────
// Block private, loopback, link-local, and reserved IP ranges so that
// uploadFromUrl cannot be used to probe internal services (e.g. cloud
// metadata endpoints like 169.254.169.254, localhost services, RFC-1918
// hosts). This is defense-in-depth; DNS-rebinding residual risk remains
// because Node's fetch does its own resolution after we validate.
const SSRF_BLOCKLIST = new BlockList();
// IPv4 private / reserved / special-use ranges
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  SSRF_BLOCKLIST.addSubnet(addr, prefix, "ipv4");
}
// IPv6 loopback / link-local / unique-local / multicast
SSRF_BLOCKLIST.addSubnet("::1", 128, "ipv6");
SSRF_BLOCKLIST.addSubnet("fc00::", 7, "ipv6");
SSRF_BLOCKLIST.addSubnet("fe80::", 10, "ipv6");
SSRF_BLOCKLIST.addSubnet("ff00::", 8, "ipv6");

const MAX_REDIRECTS = 5;
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Validate that a URL is safe to fetch: scheme must be http/https and all
 * resolved IP addresses must fall outside private/reserved ranges.
 * Throws KnowledgeBaseUploadError on violation.
 */
async function assertSafeUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new KnowledgeBaseUploadError({
      stage: "download",
      userMessage: `Invalid URL: ${rawUrl}`,
    });
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new KnowledgeBaseUploadError({
      stage: "download",
      userMessage: `URL scheme '${parsed.protocol}' is not allowed (only http/https)`,
    });
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (!hostname) {
    throw new KnowledgeBaseUploadError({
      stage: "download",
      userMessage: "URL has no hostname",
    });
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsPromises.lookup(hostname, { all: true });
  } catch (err) {
    throw new KnowledgeBaseUploadError({
      stage: "download",
      userMessage: `DNS resolution failed for '${hostname}': ${err}`,
    });
  }

  if (addresses.length === 0) {
    throw new KnowledgeBaseUploadError({
      stage: "download",
      userMessage: `No DNS records found for '${hostname}'`,
    });
  }

  for (const { address, family } of addresses) {
    const fam = family === 6 ? "ipv6" : "ipv4";
    if (SSRF_BLOCKLIST.check(address, fam)) {
      throw new KnowledgeBaseUploadError({
        stage: "download",
        userMessage: `URL resolves to a blocked private/reserved IP address (${address}). SSRF attempt prevented.`,
      });
    }
  }
}

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
      // Validate the initial URL before fetching (SSRF guard).
      await assertSafeUrl(url);

      let response = await fetch(url, { redirect: "manual" });

      // Follow redirects manually, re-validating each Location header.
      let redirectCount = 0;
      while (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
        if (++redirectCount > MAX_REDIRECTS) {
          throw new KnowledgeBaseUploadError({
            stage: "download",
            userMessage: `Too many redirects (>${MAX_REDIRECTS}) when fetching ${url}`,
          });
        }
        const location = response.headers.get("location")!;
        finalUrl = new URL(location, finalUrl).toString(); // resolve relative redirects
        await assertSafeUrl(finalUrl);
        response = await fetch(finalUrl, { redirect: "manual" });
      }

      if (!response.ok) {
        throw new KnowledgeBaseUploadError({
          stage: "download",
          userMessage: `Failed to download from URL: ${finalUrl}`,
          details: { status: response.status, statusText: response.statusText },
        });
      }
      text = await response.text();
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
