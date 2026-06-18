import { TTSProvider } from "../manager.js";
import { withRetry } from "../retry.js";
import { ProviderAPIError } from "../errors.js";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

export interface OpenAITTSProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  responseFormat?: string;
  speed?: number;
}

export class OpenAITTSProvider extends TTSProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private voice: string;
  private responseFormat: string;
  private speed: number;

  constructor(config: OpenAITTSProviderConfig) {
    super();
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    this.model = config.model ?? "tts-1";
    this.voice = config.voice ?? "alloy";
    this.responseFormat = config.responseFormat ?? "mp3";
    this.speed = config.speed ?? 1.0;
  }

  supportStream(): boolean {
    return false;
  }

  async getAudio(text: string): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: text,
      voice: this.voice,
      response_format: this.responseFormat,
      speed: this.speed,
    };

    const arrayBuffer = await withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        let errorMessage: string;
        try {
          const errorBody = (await res.json()) as Record<string, unknown>;
          const error = errorBody?.error as Record<string, unknown> | undefined;
          errorMessage = (error?.message as string) ?? res.statusText;
        } catch {
          errorMessage = res.statusText;
        }
        throw new ProviderAPIError("openai-tts", res.status, undefined, errorMessage);
      }

      return res.arrayBuffer();
    });

    const ext = this.responseFormat === "mp3" ? "mp3" : this.responseFormat;
    const fileName = `tts_${randomUUID()}.${ext}`;
    const filePath = join(tmpdir(), fileName);
    writeFileSync(filePath, Buffer.from(arrayBuffer));

    return filePath;
  }
}
