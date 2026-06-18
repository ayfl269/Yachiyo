/**
 * Image reference validation and normalization utilities.
 * Ported from Python: core/utils/image_ref_utils.py, core/utils/string_utils.py
 */

import { existsSync } from "fs";
import { resolve, extname, relative } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

// ── String normalization & deduplication ──

/**
 * Strip whitespace, skip empty strings, and remove duplicates while preserving order.
 */
export function normalizeAndDedupeStrings(items: Iterable<unknown> | null | undefined): string[] {
  if (items == null) return [];

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== "string") continue;
    const cleaned = item.trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    normalized.push(cleaned);
  }
  return normalized;
}

// ── Image reference validation ──

const ALLOWED_IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".bmp", ".tif", ".tiff", ".svg", ".heic",
]);

/**
 * Resolve a `file:///` URI to a local filesystem path.
 */
export function resolveFileUrlPath(imageRef: string): string {
  if (!imageRef.startsWith("file://")) return imageRef;
  try {
    return fileURLToPath(imageRef);
  } catch {
    // Fallback: manual parsing
    let path = imageRef.replace(/^file:\/\/+/,"");
    // Windows: /C:/... → C:/...
    if (process.platform === "win32" && /^\/[A-Za-z]:/.test(path)) {
      path = path.slice(1);
    }
    return decodeURIComponent(path) || imageRef;
  }
}

function isPathWithinRoots(filePath: string, roots: readonly string[]): boolean {
  try {
    const candidate = resolve(filePath);
    for (const root of roots) {
      const rootPath = resolve(root);
      const rel = relative(rootPath, candidate);
      if (!rel.startsWith("..") && !rel.startsWith("/")) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Check whether an image reference string is supported.
 *
 * - `http://`, `https://`, `base64://` URLs are always accepted.
 * - `file://` URIs are resolved to a local path first.
 * - Local paths with a recognized image extension are accepted.
 * - Extensionless local files are accepted only if `allowExtensionlessExistingLocalFile`
 *   is true, the file exists, and it resides within one of `extensionlessLocalRoots`.
 */
export function isSupportedImageRef(
  imageRef: string,
  options?: {
    allowExtensionlessExistingLocalFile?: boolean;
    extensionlessLocalRoots?: readonly string[];
  }
): boolean {
  if (!imageRef) return false;

  const lowered = imageRef.toLowerCase();
  if (lowered.startsWith("http://") || lowered.startsWith("https://") || lowered.startsWith("base64://")) {
    return true;
  }

  const filePath = lowered.startsWith("file://") ? resolveFileUrlPath(imageRef) : imageRef;
  const ext = extname(filePath).toLowerCase();

  if (ALLOWED_IMAGE_EXTENSIONS.has(ext)) return true;

  if (!options?.allowExtensionlessExistingLocalFile) return false;
  if (!options.extensionlessLocalRoots?.length) return false;

  return ext === "" && existsSync(filePath) && isPathWithinRoots(filePath, options.extensionlessLocalRoots);
}

/**
 * Collect, deduplicate, and validate image URLs from multiple sources.
 * Designed for Handoff tool image collection.
 *
 * @param fromArgs - Image URLs extracted from tool call arguments
 * @param fromMessage - Image URLs extracted from the current message event
 * @param tempDir - Temp directory to allow extensionless local files from
 */
export function collectAndValidateImageUrls(
  fromArgs: unknown,
  fromMessage: string[],
  tempDir?: string,
): string[] {
  // Parse image_urls from tool args
  const argUrls = collectImageUrlsFromArgs(fromArgs);

  // Merge both sources
  const candidates = [...argUrls, ...fromMessage];

  // Normalize & deduplicate
  const normalized = normalizeAndDedupeStrings(candidates);

  // Validate each candidate
  const extensionlessRoots = tempDir ? [tempDir, tmpdir()] : [tmpdir()];
  const sanitized = normalized.filter((item) =>
    isSupportedImageRef(item, {
      allowExtensionlessExistingLocalFile: true,
      extensionlessLocalRoots: extensionlessRoots,
    })
  );

  const droppedCount = normalized.length - sanitized.length;
  if (droppedCount > 0) {
    console.debug(`Dropped ${droppedCount} invalid image_urls entries in handoff image inputs.`);
  }

  return sanitized;
}

/**
 * Extract image URLs from raw tool call arguments.
 * Handles: null, single string, array of strings, set of strings.
 */
export function collectImageUrlsFromArgs(imageUrlsRaw: unknown): string[] {
  if (imageUrlsRaw == null) return [];

  if (typeof imageUrlsRaw === "string") return [imageUrlsRaw];

  if (
    (Array.isArray(imageUrlsRaw) || imageUrlsRaw instanceof Set) &&
    typeof imageUrlsRaw !== "string"
  ) {
    const items = Array.isArray(imageUrlsRaw) ? imageUrlsRaw : Array.from(imageUrlsRaw as Set<unknown>);
    return items.filter((item): item is string => typeof item === "string");
  }

  console.debug(`Unsupported image_urls type in handoff tool args: ${typeof imageUrlsRaw}`);
  return [];
}
