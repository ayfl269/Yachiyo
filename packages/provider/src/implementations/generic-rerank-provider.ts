import { RerankProvider } from "../manager.js";
import type { RerankResult } from "../manager.js";
import { withRetry } from "../retry.js";
import { ProviderAPIError } from "../errors.js";

export interface GenericRerankProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxDocuments?: number;
}

export class GenericRerankProvider extends RerankProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private maxDocuments: number;

  constructor(config: GenericRerankProviderConfig) {
    super();
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    this.maxDocuments = config.maxDocuments ?? 1000;
  }

  async rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]> {
    const docs = documents.slice(0, this.maxDocuments);

    const body: Record<string, unknown> = {
      model: this.model,
      query,
      documents: docs,
      return_documents: true,
    };
    if (topN !== undefined) {
      body.top_n = topN;
    }

    const data = await withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/rerank`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        throw new ProviderAPIError(
          "generic-rerank",
          res.status,
          undefined,
          errorBody || `HTTP ${res.status}`,
        );
      }

      return res.json() as Promise<{
        results: {
          index: number;
          relevance_score: number;
          document?: { text: string };
        }[];
      }>;
    });

    return data.results.map((r) => ({
      index: r.index,
      relevanceScore: r.relevance_score,
      document: { text: r.document?.text ?? "" },
    }));
  }
}
