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

export interface ToolImageCacheStats {
  /** Total bytes of all cached files on disk. */
  totalSizeBytes: number;
  /** Number of files in the cache directory. */
  fileCount: number;
  /** Number of files evicted by LRU/size limits since startup. */
  evictedCount: number;
  /** Number of files removed by TTL expiry since startup. */
  expiredCount: number;
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

/**
 * Default upper bound on total cache size. 1 GB is generous enough for
 * typical agent workloads (each image is usually <1 MB) but bounded
 * enough that a long-lived process won't slowly fill the disk. Caller
 * can override via constructor option.
 */
const DEFAULT_MAX_TOTAL_SIZE_BYTES = 1024 * 1024 * 1024; // 1 GB

/**
 * Default upper bound on file count. Protects against pathological
 * cases where many tiny images would otherwise slip past the size
 * limit. 5000 files × ~200 KB average ≈ 1 GB.
 */
const DEFAULT_MAX_FILE_COUNT = 5000;

/**
 * Minimum interval between automatic sweep checks. Sweeps are
 * triggered by {@link saveImage} calls; rate-limited to avoid
 * stat-ing the cache directory on every write.
 */
const SWEEP_MIN_INTERVAL_MS = 30 * 1000; // 30 seconds

export class ToolImageCache {
  private static instance: ToolImageCache | null = null;
  private cacheDir: string;
  private initialized = false;
  private maxTotalSizeBytes: number;
  private maxFileCount: number;
  private evictedCount = 0;
  private expiredCount = 0;
  private lastSweepAt = 0;

  private constructor(options?: {
    maxTotalSizeBytes?: number;
    maxFileCount?: number;
    cacheDir?: string;
  }) {
    this.cacheDir = options?.cacheDir ?? path.join(os.tmpdir(), "agent_tool_images");
    this.maxTotalSizeBytes = options?.maxTotalSizeBytes ?? DEFAULT_MAX_TOTAL_SIZE_BYTES;
    this.maxFileCount = options?.maxFileCount ?? DEFAULT_MAX_FILE_COUNT;
  }

  static getInstance(): ToolImageCache {
    if (!ToolImageCache.instance) {
      ToolImageCache.instance = new ToolImageCache();
    }
    return ToolImageCache.instance;
  }

  /**
   * Test-only: create a fresh instance with custom limits. The caller
   * is responsible for cleaning up the cache directory after the test.
   * Production code should use {@link getInstance}.
   */
  static createInstance(options?: {
    maxTotalSizeBytes?: number;
    maxFileCount?: number;
    cacheDir?: string;
  }): ToolImageCache {
    ToolImageCache.instance = new ToolImageCache(options);
    return ToolImageCache.instance;
  }

  /** Test-only: reset the singleton so the next {@link getInstance}
   * creates a fresh instance. Does NOT delete files on disk. */
  static resetInstance(): void {
    ToolImageCache.instance = null;
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

    // Opportunistic LRU + size sweep. Rate-limited internally so we
    // don't stat the cache directory on every write — only at most
    // once per SWEEP_MIN_INTERVAL_MS.
    await this.maybeSweep();

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
      // Touch atime so LRU sweep keeps this file longer. Best-effort:
      // some filesystems mount with noatime; the call still succeeds
      // and updates ctime/mtime on most platforms.
      try {
        const now = new Date();
        await fs.utimes(filePath, now, now);
      } catch {
        // ignore — atime update is best-effort
      }
      return { base64Data, mimeType };
    } catch {
      return null;
    }
  }

  /**
   * Remove files older than {@link CACHE_EXPIRY_MS}. Returns the
   * number of files removed. Safe to call concurrently — errors are
   * swallowed and the count reflects only successful removals.
   */
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

    this.expiredCount += cleaned;
    return cleaned;
  }

  /**
   * Opportunistic LRU + size-limit sweep. Triggered by {@link saveImage}
   * but rate-limited to at most one sweep per {@link SWEEP_MIN_INTERVAL_MS}.
   *
   * When total size exceeds {@link maxTotalSizeBytes} or file count
   * exceeds {@link maxFileCount}, the oldest files (by atime, falling
   * back to mtime) are removed until under the limit. Files younger
   * than 60 seconds are never evicted to avoid racing with in-flight
   * reads.
   */
  private async maybeSweep(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
    this.lastSweepAt = now;

    try {
      const files = await fs.readdir(this.cacheDir);
      const entries: Array<{ name: string; size: number; atime: number; mtime: number }> = [];
      let totalSize = 0;

      for (const fileName of files) {
        const filePath = path.join(this.cacheDir, fileName);
        try {
          const stat = await fs.stat(filePath);
          if (!stat.isFile()) continue;
          totalSize += stat.size;
          entries.push({
            name: fileName,
            size: stat.size,
            atime: stat.atimeMs,
            mtime: stat.mtimeMs,
          });
        } catch {
          // file may have been deleted between readdir and stat — skip
        }
      }

      // First: TTL-based expiry (same as cleanupExpired but inline).
      const expiryCutoff = now - CACHE_EXPIRY_MS;
      const graceCutoff = now - 60_000; // 60s grace period
      const survivors: typeof entries = [];
      for (const entry of entries) {
        const accessTime = Math.max(entry.atime, entry.mtime);
        if (accessTime < expiryCutoff) {
          try {
            await fs.unlink(path.join(this.cacheDir, entry.name));
            totalSize -= entry.size;
            this.expiredCount++;
          } catch {
            survivors.push(entry); // keep entry so size cap pass can retry
          }
        } else {
          survivors.push(entry);
        }
      }

      // Then: LRU eviction by access time (older first). Skip files
      // within the 60s grace period to avoid evicting files that are
      // being actively read.
      if (totalSize > this.maxTotalSizeBytes || survivors.length > this.maxFileCount) {
        survivors.sort((a, b) => Math.max(a.atime, a.mtime) - Math.max(b.atime, b.mtime));
        for (const entry of survivors) {
          if (totalSize <= this.maxTotalSizeBytes && survivors.length <= this.maxFileCount) break;
          const accessTime = Math.max(entry.atime, entry.mtime);
          if (accessTime > graceCutoff) continue; // grace period
          try {
            await fs.unlink(path.join(this.cacheDir, entry.name));
            totalSize -= entry.size;
            this.evictedCount++;
          } catch {
            // ignore — best-effort
          }
        }
      }
    } catch {
      // Sweep is best-effort; never fail a saveImage because of it.
    }
  }

  /**
   * Current cache stats. Reads the directory once and returns total
   * size, file count, and cumulative eviction/expiry counters. Intended
   * for metrics endpoints — not cached, so call sparingly.
   */
  async getStats(): Promise<ToolImageCacheStats> {
    await this.ensureDir();
    let totalSizeBytes = 0;
    let fileCount = 0;
    try {
      const files = await fs.readdir(this.cacheDir);
      for (const fileName of files) {
        const filePath = path.join(this.cacheDir, fileName);
        try {
          const stat = await fs.stat(filePath);
          if (stat.isFile()) {
            totalSizeBytes += stat.size;
            fileCount++;
          }
        } catch {
          // skip
        }
      }
    } catch {
      // ignore — return zeros
    }
    return {
      totalSizeBytes,
      fileCount,
      evictedCount: this.evictedCount,
      expiredCount: this.expiredCount,
    };
  }
}

/** Global singleton instance */
export const toolImageCache = ToolImageCache.getInstance();
