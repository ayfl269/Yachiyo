import { EmbeddingProvider } from "../manager.js";
import { withRetry } from "../retry.js";
import { ProviderAPIError } from "../errors.js";

export interface GeminiEmbeddingProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  taskType?: string;
}

const MODEL_DEFAULT_DIMS: Record<string, number> = {
  "text-embedding-004": 768,
  "embedding-001": 768,
};

export class GeminiEmbeddingProvider extends EmbeddingProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private taskType: string;
  private cachedDim: number | null = null;

  constructor(config: GeminiEmbeddingProviderConfig) {
    super();
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.model = config.model ?? "text-embedding-004";
    this.taskType = config.taskType ?? "RETRIEVAL_DOCUMENT";
  }

  async getEmbedding(text: string): Promise<number[]> {
    const data = await withRetry(async () => {
      const res = await fetch(
        `${this.baseUrl}/models/${this.model}:embedContent?key=${this.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: `models/${this.model}`,
            content: { parts: [{ text }] },
            taskType: this.taskType,
          }),
        },
      );

      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        throw new ProviderAPIError(
          "gemini-embedding",
          res.status,
          undefined,
          errorBody || `HTTP ${res.status}`,
        );
      }

      return res.json() as Promise<{ embedding: { values: number[] } }>;
    });

    const values = data.embedding.values;

    if (this.cachedDim === null) {
      this.cachedDim = values.length;
    }

    return values;
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    const requests = texts.map((text) => ({
      model: `models/${this.model}`,
      content: { parts: [{ text }] },
      taskType: this.taskType,
    }));

    const data = await withRetry(async () => {
      const res = await fetch(
        `${this.baseUrl}/models/${this.model}:batchEmbedContents?key=${this.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requests }),
        },
      );

      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        throw new ProviderAPIError(
          "gemini-embedding",
          res.status,
          undefined,
          errorBody || `HTTP ${res.status}`,
        );
      }

      return res.json() as Promise<{ embeddings: { values: number[] }[] }>;
    });

    const results = data.embeddings.map((e) => e.values);

    if (results.length > 0 && this.cachedDim === null) {
      this.cachedDim = results[0].length;
    }

    return results;
  }

  getDim(): number {
    if (this.cachedDim !== null) return this.cachedDim;
    return MODEL_DEFAULT_DIMS[this.model] ?? 768;
  }
}
