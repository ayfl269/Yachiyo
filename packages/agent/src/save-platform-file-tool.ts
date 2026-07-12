/**
 * Save platform file tool.
 *
 * Lets the agent download files received from message platforms (or any
 * HTTP/HTTPS URL) and save them to local persistent storage. This enables
 * workflows like:
 *   1. User sends a file/image/voice/video on QQ/WeChat
 *   2. PreProcessStage annotates the message with file URLs (received_files)
 *   3. Agent calls this tool to list received files and save them locally
 *   4. Agent can then read/process the saved file with other tools
 *
 * Actions:
 *   list  List files received in the current message context
 *   save  Download a URL and save to local storage
 */

import { createFunctionTool, type FunctionTool } from "./tool.js";
import type { ContextWrapper, CallToolResult } from "./types.js";
import { downloadFile } from "./download-utils.js";
import { stat } from "fs/promises";
import { join, resolve, normalize, sep, extname } from "path";
import { randomUUID } from "crypto";

// ── Types ──

/**
 * Structured info about a file received from a message platform.
 * Mirrors `ReceivedFile` from @yachiyo/pipeline (defined locally here to
 * avoid adding @yachiyo/pipeline as a dependency of @yachiyo/agent).
 */
export interface ReceivedFile {
  type: "file" | "image" | "record" | "video";
  url?: string;
  name?: string;
  file?: string;
}

export interface SavePlatformFileToolContext {
  /** The current message event, providing access to received_files extra. */
  event?: {
    unifiedMsgOrigin?: string;
    getExtra?<T = unknown>(key: string): T | undefined;
  };
}

function getToolContext(_ctx: unknown): SavePlatformFileToolContext {
  const wrapper = _ctx as ContextWrapper<SavePlatformFileToolContext> | undefined;
  const ctx = wrapper?.context;
  if (!ctx) return {} as SavePlatformFileToolContext;

  // When called from the pipeline, `ctx` is a MessageEvent instance that has
  // `unifiedMsgOrigin` (getter) and `getExtra()` directly on it.
  const maybeEvent = ctx as {
    unifiedMsgOrigin?: string;
    getExtra?<T = unknown>(key: string): T | undefined;
  };
  if (typeof maybeEvent.getExtra === "function") {
    return {
      event: {
        unifiedMsgOrigin: maybeEvent.unifiedMsgOrigin,
        getExtra: maybeEvent.getExtra.bind(maybeEvent),
      },
    };
  }
  return ctx as SavePlatformFileToolContext;
}

export interface CreateSavePlatformFileToolOptions {
  /**
   * Root directory where downloaded files are stored. Defaults to
   * `<process.cwd()>/data/received_files`.
   */
  filesRoot?: string;
}

// ── Path safety ──

/**
 * Resolve and validate a target file path under `filesRoot`.
 *
 * Rejects paths that resolve outside `filesRoot` to prevent path traversal
 * attacks (e.g. `../../etc/passwd`). The filename is sanitized to remove
 * path separators and dangerous characters.
 */
function resolveSafeFilePath(
  filesRoot: string,
  subdir: string | undefined,
  filename: string,
): string {
  const root = resolve(filesRoot);

  // Sanitize filename: remove path separators, keep extension
  const safeName = sanitizeFilename(filename);
  if (!safeName) {
    throw new Error("Invalid filename after sanitization");
  }

  // Sanitize subdir: remove leading/trailing slashes, reject traversal
  let safeSubdir = "";
  if (subdir) {
    safeSubdir = normalize(subdir)
      .replace(/^[/\\]+/, "")
      .replace(/[/\\]+$/, "");
    // Reject any remaining `..` segments
    if (safeSubdir.includes("..")) {
      throw new Error(`Invalid subdirectory: '${subdir}' contains '..'`);
    }
  }

  const targetDir = safeSubdir ? join(root, safeSubdir) : root;
  const targetPath = join(targetDir, safeName);

  // Final containment check
  const targetCmp = process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
  const rootCmp = process.platform === "win32" ? root.toLowerCase() : root;
  if (targetCmp !== rootCmp && !targetCmp.startsWith(rootCmp + sep)) {
    throw new Error(`Resolved path '${targetPath}' is outside the files root '${root}'`);
  }

  return targetPath;
}

/**
 * Sanitize a filename: strip path separators, null bytes, and reserved
 * Windows names. Preserves the file extension.
 */
function sanitizeFilename(name: string): string {
  // Take the basename only
  const base = name.split(/[/\\]/).pop() ?? name;
  // Remove null bytes and control chars
  let cleaned = base.replace(/[\x00-\x1f]/g, "");
  // Remove leading dots (hidden files / relative path tricks)
  cleaned = cleaned.replace(/^\.+/, "");
  // Limit length
  if (cleaned.length > 200) {
    const ext = extname(cleaned);
    cleaned = cleaned.slice(0, 200 - ext.length) + ext;
  }
  return cleaned;
}

/**
 * Generate a safe filename from a URL if no explicit name is provided.
 */
function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const pathname = u.pathname;
    const base = pathname.split("/").pop() ?? "";
    if (base && base.length > 0 && base.length <= 200) {
      return sanitizeFilename(base);
    }
  } catch {
    // not a valid URL, fall through
  }
  return `file_${randomUUID().slice(0, 8)}`;
}

/**
 * Guess MIME type from file extension.
 */
function guessMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".pdf": return "application/pdf";
    case ".doc": return "application/msword";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls": return "application/vnd.ms-excel";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".ppt": return "application/vnd.ms-powerpoint";
    case ".pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".zip": return "application/zip";
    case ".rar": return "application/x-rar-compressed";
    case ".7z": return "application/x-7z-compressed";
    case ".tar": return "application/x-tar";
    case ".gz": return "application/gzip";
    case ".txt": return "text/plain";
    case ".json": return "application/json";
    case ".xml": return "application/xml";
    case ".csv": return "text/csv";
    case ".html": return "text/html";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".bmp": return "image/bmp";
    case ".svg": return "image/svg+xml";
    case ".mp3": return "audio/mp3";
    case ".wav": return "audio/wav";
    case ".ogg": return "audio/ogg";
    case ".flac": return "audio/flac";
    case ".aac": return "audio/aac";
    case ".m4a": return "audio/mp4";
    case ".mp4": return "video/mp4";
    case ".avi": return "video/x-msvideo";
    case ".mov": return "video/quicktime";
    case ".mkv": return "video/x-matroska";
    case ".webm": return "video/webm";
    default: return "application/octet-stream";
  }
}

// ── Tool factory ──

export function createSavePlatformFileTool(
  options?: CreateSavePlatformFileToolOptions,
): FunctionTool<SavePlatformFileToolContext> {
  const filesRoot = resolve(options?.filesRoot ?? join(process.cwd(), "data", "received_files"));

  return createFunctionTool<SavePlatformFileToolContext>({
    name: "save_platform_file",
    description:
      "Download a file from a URL (typically received from a message platform) and save it to local persistent storage. " +
      "Use 'list' to see files received in the current message. " +
      "Use 'save' to download a URL and store it locally — the file can then be read with file_read_tool or processed by other tools. " +
      "Supported file types include: documents (pdf, docx, xlsx), images (jpg, png, gif), audio (mp3, wav), video (mp4), archives (zip, tar), and more.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action to perform.",
          enum: ["list", "save"],
        },
        url: {
          type: "string",
          description:
            "The URL of the file to download (for 'save' action). " +
            "Use 'list' first to discover URLs of files received in the current message.",
        },
        filename: {
          type: "string",
          description:
            "Optional filename for the saved file (for 'save' action). " +
            "If omitted, derived from the URL. Path separators are stripped.",
        },
        subdir: {
          type: "string",
          description:
            "Optional subdirectory under the file storage root (for 'save' action). " +
            "Path traversal (..) is rejected. Example: 'downloads', 'images/2024'.",
        },
      },
      required: ["action"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const ctx = getToolContext(_ctx);

      const action = args[0] != null ? String(args[0]) : undefined;
      const url = args[1] != null ? String(args[1]) : undefined;
      const filename = args[2] != null ? String(args[2]) : undefined;
      const subdir = args[3] != null ? String(args[3]) : undefined;

      if (!action) {
        return formatError("Missing required parameter: action");
      }

      switch (action) {
        case "list":
          return handleList(ctx);
        case "save":
          return handleSave(filesRoot, { url, filename, subdir });
        default:
          return formatError(`Unknown action: ${action}. Valid actions: list, save`);
      }
    },
  });
}

// ── Action handlers ──

function handleList(ctx: SavePlatformFileToolContext): CallToolResult {
  const receivedFiles = ctx.event?.getExtra?.<ReceivedFile[]>("received_files");

  if (!receivedFiles || receivedFiles.length === 0) {
    return formatText("No files received in the current message context.");
  }

  const lines: string[] = [
    `Files received in the current message (${receivedFiles.length}):`,
    "",
  ];

  for (let i = 0; i < receivedFiles.length; i++) {
    const f = receivedFiles[i];
    const typeLabel =
      f.type === "file" ? "FILE" :
      f.type === "image" ? "IMAGE" :
      f.type === "record" ? "VOICE" :
      f.type === "video" ? "VIDEO" :
      "UNKNOWN";
    const namePart = f.name ? ` name="${f.name}"` : "";
    const filePart = f.file ? ` file_id="${f.file}"` : "";
    const urlPart = f.url ? ` url="${f.url}"` : " (no URL available)";
    lines.push(`[${i}] ${typeLabel}${namePart}${filePart}${urlPart}`);
  }

  lines.push("");
  lines.push("To save a file, use action='save' with the URL above.");

  return formatText(lines.join("\n"));
}

async function handleSave(
  filesRoot: string,
  params: { url?: string; filename?: string; subdir?: string },
): Promise<CallToolResult> {
  const url = params.url;
  if (!url || !url.trim()) {
    return formatError("Missing required parameter: url (for 'save' action)");
  }

  // Validate URL scheme
  if (!/^https?:\/\//i.test(url)) {
    return formatError(
      `Invalid URL scheme: '${url}'. Only http:// and https:// URLs are supported.`,
    );
  }

  // Determine target filename
  const desiredName = params.filename?.trim() || filenameFromUrl(url);
  if (!desiredName) {
    return formatError("Could not determine a valid filename. Please provide 'filename' parameter.");
  }

  // Resolve safe target path
  let targetPath: string;
  try {
    targetPath = resolveSafeFilePath(filesRoot, params.subdir, desiredName);
  } catch (e) {
    return formatError(
      `Invalid path: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Download the file (5-minute timeout for large files)
  try {
    await downloadFile(url, targetPath, 5 * 60 * 1000);
  } catch (e) {
    return formatError(
      `Failed to download file from ${url}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Get file info
  let size: number;
  try {
    const s = await stat(targetPath);
    size = s.size;
  } catch {
    size = 0;
  }

  const mimeType = guessMimeType(targetPath);
  const sizeStr = formatFileSize(size);

  return formatText(
    `File saved successfully.\n` +
    `  URL:      ${url}\n` +
    `  Path:     ${targetPath}\n` +
    `  Size:     ${sizeStr} (${size} bytes)\n` +
    `  MIME:     ${mimeType}\n` +
    `\n` +
    `You can now read this file using file_read_tool (for text files) or process it with other tools.`,
  );
}

// ── Formatting helpers ──

function formatText(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError: false,
  };
}

function formatError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
