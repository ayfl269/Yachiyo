/**
 * Download utilities for remote images and audio files.
 * Downloads HTTP/HTTPS resources and converts them to base64 data URLs.
 * Ported from Python: core/utils/io.py
 */

import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { join, extname } from "path";
import { tmpdir } from "os";
import { safeFetch } from "./ssrf-guard.js";

// 图片压缩阈值（字节）：超过此大小的图片会被压缩
const IMAGE_COMPRESS_THRESHOLD = 60 * 1024; // 60KB
const IMAGE_MAX_BASE64_LENGTH = 80_000; // 压缩后目标 base64 长度，适配本地网关 100KB Body 限制

// sharp 类型声明与 pnpm 不兼容，使用 require 动态加载
// 此处定义最小可用接口以避免 `any` 类型
interface SharpChain {
  jpeg(options?: { quality?: number; mozjpeg?: boolean }): SharpChain;
  resize(
    width?: number,
    height?: number,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ): SharpChain;
  toBuffer(): Promise<Buffer>;
  toBuffer(options: { resolveWithObject: true }): Promise<{
    data: Buffer;
    info: { size: number };
  }>;
}

interface SharpModule {
  (input: Buffer): SharpChain;
}

/**
 * 压缩图片文件，返回压缩后的 buffer 和 mime 类型。
 * 使用 sharp 库进行高效的图片压缩。
 */
async function compressImage(filePath: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const sharp = require("sharp") as SharpModule;
    const bytes = await readFile(filePath);
    if (bytes.length < IMAGE_COMPRESS_THRESHOLD) return null;

    // 计算目标大小（base64 长度 ≈ 原始大小 * 4/3，反推原始大小）
    const targetBytes = Math.floor(IMAGE_MAX_BASE64_LENGTH * 3 / 4);

    // 尝试不同 quality 进行压缩
    let quality = 80;
    let result = await sharp(bytes)
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    // 如果压缩后仍然太大，降低质量并限制尺寸
    if (result.info.size > targetBytes) {
      quality = 60;
      result = await sharp(bytes)
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
    }

    if (result.info.size > targetBytes) {
      quality = 40;
      result = await sharp(bytes)
        .resize(800, 800, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
    }

    if (result.info.size > targetBytes) {
      quality = 30;
      result = await sharp(bytes)
        .resize(600, 600, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
    }

    return { buffer: result.data, mimeType: "image/jpeg" };
  } catch (e) {
    console.warn(`[DownloadUtils] Image compression failed: ${e}`);
    return null;
  }
}

/** Default download timeout (60s). Callers may pass a larger value for big files. */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Download a file from a URL and return its bytes.
 * Uses fetch() with SSL verification (Node.js 18+).
 *
 * @param timeoutMs Optional timeout in milliseconds (default: 60s). Pass a
 *   larger value for big files (long audio/video); pass a smaller value for
 *   quick avatar/thumbnail fetches.
 */
export async function downloadBytes(url: string, timeoutMs: number = DEFAULT_DOWNLOAD_TIMEOUT_MS): Promise<Uint8Array> {
  const headers: Record<string, string> = {};
  // QQ 多媒体下载需要 Referer 头
  if (url.includes("multimedia.nt.qq.com.cn")) {
    headers["Referer"] = "https://web.qq.com/";
  }
  // safeFetch validates URL scheme to prevent non-HTTP protocols, and limits response
  // size and redirect loops (LAN access is allowed per business requirements).
  // The signal-based timeout is preserved.
  const response = await safeFetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  const arrayBuf = await response.arrayBuffer();
  return new Uint8Array(arrayBuf);
}

/**
 * Download an image from a URL and save it to a temp file.
 * Returns the local file path.
 *
 * @param timeoutMs Optional download timeout in milliseconds (default: 60s).
 */
export async function downloadImageByUrl(
  url: string,
  targetPath?: string,
  timeoutMs?: number,
): Promise<string> {
  const bytes = await downloadBytes(url, timeoutMs);
  const filePath = targetPath ?? join(tmpdir(), `img_${crypto.randomUUID().slice(0, 8)}.jpg`);
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, bytes);
  return filePath;
}

/**
 * Download a file from a URL to a specified local path.
 *
 * @param timeoutMs Optional download timeout in milliseconds (default: 60s).
 */
export async function downloadFile(
  url: string,
  targetPath: string,
  timeoutMs?: number,
): Promise<void> {
  const bytes = await downloadBytes(url, timeoutMs);
  await mkdir(join(targetPath, ".."), { recursive: true });
  await writeFile(targetPath, bytes);
}

/**
 * Encode a local image file to a base64 data URL.
 * Supports: local file path, base64:// URI, file:/// URI.
 * 大图片会自动压缩以避免请求体过大。
 */
export async function encodeImageToBase64(imageRef: string): Promise<string> {
  // base64:// URI → data:image/jpeg;base64,...
  if (imageRef.startsWith("base64://")) {
    return imageRef.replace("base64://", "data:image/jpeg;base64,");
  }

  // file:/// URI → resolve to local path
  let filePath = imageRef;
  if (imageRef.startsWith("file:///")) {
    filePath = resolveFileUriPath(imageRef);
  }

  // 尝试压缩大图片
  const compressed = await compressImage(filePath);
  if (compressed) {
    const base64 = compressed.buffer.toString("base64");
    return `data:${compressed.mimeType};base64,${base64}`;
  }

  const bytes = await readFile(filePath);
  const mimeType = detectImageMimeType(bytes);

  // Transcode unsupported formats (like gif, bmp) to jpeg using sharp
  if (mimeType !== "image/jpeg" && mimeType !== "image/png" && mimeType !== "image/webp") {
    try {
      const sharp = require("sharp") as SharpModule;
      const transcodedBuffer = await sharp(bytes).jpeg().toBuffer();
      const base64 = transcodedBuffer.toString("base64");
      return `data:image/jpeg;base64,${base64}`;
    } catch (e) {
      console.warn(`[DownloadUtils] Transcoding failed for ${mimeType}: ${e}`);
    }
  }

  const base64 = Buffer.from(bytes).toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Encode a local audio file to a base64 data URL.
 * Supports: local file path, base64:// URI, file:/// URI.
 */
export async function encodeAudioToBase64(
  audioRef: string,
  mimeType?: string,
): Promise<string> {
  if (audioRef.startsWith("base64://")) {
    const mime = mimeType ?? "audio/wav";
    return audioRef.replace("base64://", `data:${mime};base64,`);
  }

  let filePath = audioRef;
  if (audioRef.startsWith("file:///")) {
    filePath = resolveFileUriPath(audioRef);
  }

  const bytes = await readFile(filePath);
  const detectedMime = mimeType ?? detectAudioMimeType(filePath);
  const base64 = Buffer.from(bytes).toString("base64");
  return `data:${detectedMime};base64,${base64}`;
}

/**
 * Resolve a remote or local image reference to a base64 data URL.
 * - http/https URLs are downloaded first, then encoded.
 * - file:/// URIs are resolved to local paths, then encoded.
 * - base64:// URIs are converted directly.
 * - Local paths are read and encoded directly.
 */
export async function resolveImageToDataUrl(imageRef: string): Promise<string | null> {
  try {
    if (imageRef.startsWith("http://") || imageRef.startsWith("https://")) {
      const localPath = await downloadImageByUrl(imageRef);
      try {
        const dataUrl = await encodeImageToBase64(localPath);
        return dataUrl;
      } finally {
        // Clean up temp file
        try { await unlink(localPath); } catch { /* ignore */ }
      }
    }
    const result = await encodeImageToBase64(imageRef);
    return result;
  } catch (e) {
    console.warn(`[DownloadUtils] FAILED to resolve image ref ${imageRef.slice(0, 120)}: ${e}`);
    return null;
  }
}

/**
 * Resolve a remote or local audio reference to a base64 data URL.
 * - http/https URLs are downloaded first, then encoded.
 * - file:/// URIs are resolved to local paths, then encoded.
 * - base64:// URIs are converted directly.
 * - Local paths are read and encoded directly.
 */
export async function resolveAudioToDataUrl(audioRef: string): Promise<string | null> {
  try {
    if (audioRef.startsWith("http://") || audioRef.startsWith("https://")) {
      const suffix = extname(new URL(audioRef).pathname) || ".wav";
      const tempPath = join(tmpdir(), `audio_${crypto.randomUUID().slice(0, 8)}${suffix}`);
      try {
        await downloadFile(audioRef, tempPath);
        return await encodeAudioToBase64(tempPath);
      } finally {
        try { await unlink(tempPath); } catch { /* ignore */ }
      }
    }
    return await encodeAudioToBase64(audioRef);
  } catch (e) {
    console.warn(`Failed to resolve audio ref ${audioRef}: ${e}`);
    return null;
  }
}

// ── Internal helpers ──

function resolveFileUriPath(uri: string): string {
  try {
    const { fileURLToPath } = require("url") as typeof import("url");
    return fileURLToPath(uri);
  } catch {
    let path = uri.replace(/^file:\/\/+/, "");
    if (process.platform === "win32" && /^\/[A-Za-z]:/.test(path)) {
      path = path.slice(1);
    }
    return decodeURIComponent(path);
  }
}

const IMAGE_MAGIC_BYTES: Array<[number[], string]> = [
  [[0x89, 0x50, 0x4e, 0x47], "image/png"],
  [[0xff, 0xd8, 0xff], "image/jpeg"],
  [[0x47, 0x49, 0x46], "image/gif"],
  [[0x52, 0x49, 0x46, 0x46], "image/webp"], // RIFF header (also check for WEBP)
  [[0x42, 0x4d], "image/bmp"],
];

function detectImageMimeType(bytes: Uint8Array): string {
  for (const [magic, mime] of IMAGE_MAGIC_BYTES) {
    if (bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b)) {
      // Special case: RIFF container → verify WEBP
      if (magic[0] === 0x52 && bytes.length >= 12) {
        const webpMarker = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
        if (webpMarker === "WEBP") return "image/webp";
        continue;
      }
      return mime;
    }
  }
  return "image/jpeg"; // default fallback
}

function detectAudioMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".mp3": return "audio/mp3";
    case ".wav": return "audio/wav";
    case ".ogg": return "audio/ogg";
    case ".flac": return "audio/flac";
    case ".aac": return "audio/aac";
    case ".m4a": return "audio/mp4";
    default: return "audio/wav";
  }
}
