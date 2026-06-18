import { promises as fs } from "fs";
import path from "path";
import os from "os";

export interface CachedImage {
  toolCallId: string;
  toolName: string;
  filePath: string;
  mimeType: string;
  createdAt: number;
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
};

const CACHE_EXPIRY_MS = 3600 * 1000; // 1 hour

export class ToolImageCache {
  private static instance: ToolImageCache | null = null;
  private cacheDir: string;
  private initialized = false;

  private constructor() {
    this.cacheDir = path.join(os.tmpdir(), "agent_tool_images");
  }

  static getInstance(): ToolImageCache {
    if (!ToolImageCache.instance) {
      ToolImageCache.instance = new ToolImageCache();
    }
    return ToolImageCache.instance;
  }

  async ensureDir(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.cacheDir, { recursive: true });
    this.initialized = true;
  }

  private getFileExtension(mimeType: string): string {
    return MIME_TO_EXT[mimeType.toLowerCase()] ?? ".png";
  }

  async saveImage(
    base64Data: string,
    toolCallId: string,
    toolName: string,
    index = 0,
    mimeType = "image/png"
  ): Promise<CachedImage> {
    await this.ensureDir();

    const ext = this.getFileExtension(mimeType);
    const fileName = `${toolCallId}_${index}${ext}`;
    const filePath = path.join(this.cacheDir, fileName);

    const imageBuffer = Buffer.from(base64Data, "base64");
    await fs.writeFile(filePath, imageBuffer);

    return {
      toolCallId,
      toolName,
      filePath,
      mimeType,
      createdAt: Date.now(),
    };
  }

  async getImageBase64ByPath(
    filePath: string,
    mimeType = "image/png"
  ): Promise<{ base64Data: string; mimeType: string } | null> {
    try {
      const imageBuffer = await fs.readFile(filePath);
      const base64Data = imageBuffer.toString("base64");
      return { base64Data, mimeType };
    } catch {
      return null;
    }
  }

  async cleanupExpired(): Promise<number> {
    await this.ensureDir();
    const now = Date.now();
    let cleaned = 0;

    try {
      const files = await fs.readdir(this.cacheDir);
      for (const fileName of files) {
        const filePath = path.join(this.cacheDir, fileName);
        const stat = await fs.stat(filePath);
        if (stat.isFile() && now - stat.mtimeMs > CACHE_EXPIRY_MS) {
          await fs.unlink(filePath);
          cleaned++;
        }
      }
    } catch {
      // ignore errors during cleanup
    }

    return cleaned;
  }
}

/** Global singleton instance */
export const toolImageCache = ToolImageCache.getInstance();
