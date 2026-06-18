import { EmbeddingProvider } from "../manager.js";
import { withRetry } from "../retry.js";
import { ProviderAPIError } from "../errors.js";

export interface OpenAIEmbeddingProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
}

const MODEL_DEFAULT_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

export class OpenAIEmbeddingProvider extends EmbeddingProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private dimensions?: number;
  private cachedDim: number | null = null;

  constructor(config: OpenAIEmbeddingProviderConfig) {
    super();
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    this.model = config.model ?? "text-embedding-3-small";
    this.dimensions = config.dimensions;
  }

  async getEmbedding(text: string): Promise<number[]> {
    const results = await this.getEmbeddings([text]);
    return results[0];
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: texts,
      encoding_format: "float",
    };
    if (this.dimensions !== undefined) {
      body.dimensions = this.dimensions;
    }

    const data = await withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
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
          "openai-embedding",
          res.status,
          undefined,
          errorBody || `HTTP ${res.status}`,
        );
      }

      return res.json() as Promise<{
        data: { embedding: number[]; index: number }[];
        usage?: { prompt_tokens: number; total_tokens: number };
      }>;
    });

    const sorted = data.data.sort((a, b) => a.index - b.index);
    const embeddings = sorted.map((d) => d.embedding);

    if (embeddings.length > 0 && this.cachedDim === null) {
      this.cachedDim = embeddings[0].length;
    }

    return embeddings;
  }

  getDim(): number {
    if (this.cachedDim !== null) return this.cachedDim;
    if (this.dimensions !== undefined) return this.dimensions;
    return MODEL_DEFAULT_DIMS[this.model] ?? 1536;
  }
}
