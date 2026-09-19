import { TTSProvider } from "../manager.js";
import { withRetry } from "../retry.js";
import { ProviderAPIError } from "../errors.js";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

// ── Generated-file registry (temp file cleanup) ──
//
// getAudio() RETURNS the temp file path: the caller (pipeline/platform
// adapter) sends the audio to the user after this method resolves, so the
// file CANNOT be deleted in a `finally` here without breaking delivery.
// (The pipeline additionally tracks these files via
// `event.trackTemporaryLocalFile` for immediate post-send cleanup; the
// registry below covers all other call paths.)
//
// Instead every generated path is registered with a creation timestamp.
// A sweep runs on each getAudio() call and at process exit, deleting
// entries older than TTL — long enough for any send flow, short enough
// to bound temp-directory growth.
const GENERATED_FILE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const generatedFiles = new Map<string, number>();

function sweepGeneratedFiles(now = Date.now()): void {
  for (const [path, createdAt] of generatedFiles) {
    if (now - createdAt >= GENERATED_FILE_TTL_MS) {
      generatedFiles.delete(path);
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch { /* ignore — best-effort cleanup */ }
    }
  }
}

let exitHookInstalled = false;
function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Best-effort: on graceful exit, drop files this provider generated that
  // were never consumed and cleaned up by a caller.
  process.once("exit", () => {
    for (const path of generatedFiles.keys()) {
      try { unlinkSync(path); } catch { /* ignore */ }
    }
    generatedFiles.clear();
  });
}

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

    // Sanitize the extension: responseFormat is user/config controlled and was
    // previously interpolated verbatim into the temp filename, so a value like
    // "../../evil" escaped tmpdir() and wrote an arbitrary path.
    const rawExt = this.responseFormat.trim().toLowerCase();
    const ext = /^[a-z0-9]+$/.test(rawExt) ? rawExt : "mp3";
    const fileName = `tts_${randomUUID()}.${ext}`;
    const filePath = join(tmpdir(), fileName);
    writeFileSync(filePath, Buffer.from(arrayBuffer));

    // Register for TTL/exit cleanup (see registry comment above).
    ensureExitHook();
    sweepGeneratedFiles();
    generatedFiles.set(filePath, Date.now());

    return filePath;
  }
}
