import { STTProvider } from "../manager.js";
import { withRetry } from "../retry.js";
import { ProviderAPIError } from "../errors.js";
import { safeFetch } from "@yachiyo/common/ssrf-guard.js";
import { readFileSync } from "fs";
import { basename, isAbsolute, relative, resolve } from "path";
import { tmpdir } from "os";

export interface OpenAISttProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  language?: string;
}

export class OpenAISttProvider extends STTProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private language?: string;

  constructor(config: OpenAISttProviderConfig) {
    super();
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    this.model = config.model ?? "whisper-1";
    this.language = config.language;
  }

  async getText(audioUrl: string): Promise<string> {
    let filePath: string;

    if (this.isUrl(audioUrl)) {
      const downloaded = await this.downloadAudio(audioUrl);
      filePath = downloaded;
    } else {
      // Local paths are attacker-influencable (the value comes from message
      // content). Only files inside the OS temp directory may be read —
      // that is where our own TTS/STT flow writes its intermediates.
      // Anything else (e.g. /etc/passwd, ~/.ssh/id_rsa) must never be
      // uploaded to the external transcription API.
      filePath = resolve(audioUrl);
      const base = resolve(tmpdir());
      const rel = relative(base, filePath);
      if (!isAbsolute(audioUrl) || rel.startsWith("..") || resolve(base, rel) !== filePath) {
        throw new ProviderAPIError(
          "openai_stt",
          0,
          "INVALID_AUDIO_PATH",
          `STT: local audio path is outside the allowed temp directory: ${audioUrl}`,
        );
      }
    }

    const fileBuffer = readFileSync(filePath);
    const fileName = basename(filePath);

    const formData = new FormData();
    formData.append("model", this.model);
    formData.append("file", new Blob([fileBuffer]), fileName);
    if (this.language) {
      formData.append("language", this.language);
    }

    const data = await withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: formData,
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
        throw new ProviderAPIError("openai-stt", res.status, undefined, errorMessage);
      }

      return res.json() as Promise<{ text: string }>;
    });

    return data.text;
  }

  private isUrl(str: string): boolean {
    return str.startsWith("http://") || str.startsWith("https://");
  }

  private async downloadAudio(url: string): Promise<string> {
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { randomUUID } = await import("crypto");
    const { writeFileSync } = await import("fs");

    // safeFetch validates URL scheme to prevent non-HTTP protocols, and limits response
    // size and redirect loops (LAN access is allowed per business requirements).
    const res = await safeFetch(url);
    if (!res.ok) {
      throw new ProviderAPIError("openai-stt", res.status, undefined, `Failed to download audio from ${url}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const fileName = `stt_${randomUUID()}.audio`;
    const filePath = join(tmpdir(), fileName);
    writeFileSync(filePath, Buffer.from(arrayBuffer));

    return filePath;
  }
}
