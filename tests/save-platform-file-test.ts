/**
 * Unit tests for the save_platform_file tool.
 *
 * Tests cover:
 *   - list action (with and without received_files in context)
 *   - save action URL validation
 *   - save action path traversal protection
 *   - filename sanitization
 *   - MIME type guessing
 *   - unknown action handling
 *   - actual file download via local HTTP server
 */

import { createSavePlatformFileTool } from "@yachiyo/agent/save-platform-file-tool.js";
import type { FunctionTool, CallToolResult, ContextWrapper } from "@yachiyo/agent/types.js";
import { join } from "path";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { createServer, type Server } from "http";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  \u2714 ${message}`);
  } else {
    failed++;
    console.error(`  \u2717 ${message}`);
  }
}

function getText(result: CallToolResult): string {
  if (result.content && result.content.length > 0 && result.content[0].type === "text") {
    return (result.content[0] as { text: string }).text;
  }
  return "";
}

// Build a mock context wrapper that simulates a MessageEvent with getExtra()
function makeMockContext(receivedFiles?: unknown[]): ContextWrapper {
  const extras: Record<string, unknown> = {};
  if (receivedFiles !== undefined) {
    extras["received_files"] = receivedFiles;
  }
  return {
    context: {
      unifiedMsgOrigin: "onebot11:group:123456",
      getExtra: <T = unknown>(key: string): T | undefined => extras[key] as T | undefined,
    },
  } as unknown as ContextWrapper;
}

async function callTool(
  tool: FunctionTool,
  ctx: ContextWrapper,
  ...args: unknown[]
): Promise<CallToolResult> {
  if (!tool.handler) {
    throw new Error("Tool has no handler");
  }
  const result = await tool.handler(ctx, ...args);
  if (result === null) {
    return { content: [{ type: "text", text: "(no output)" }] };
  }
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }
  return result as CallToolResult;
}

/** Start a local HTTP server that serves test content. Returns the base URL. */
function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/test.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Hello, this is test file content for save_platform_file!");
      } else if (url === "/data.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"key": "value"}');
      } else if (url === "/report.pdf") {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        res.end("%PDF-1.4 fake pdf content");
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function main(): Promise<void> {
  // Use a temp directory as filesRoot for testing
  const tempRoot = await mkdtemp(join(tmpdir(), "spf-test-"));
  const { server, baseUrl } = await startTestServer();

  try {
    const tool = createSavePlatformFileTool({ filesRoot: tempRoot });

    // ── Test: list action with no received files ──
    console.log("\n=== list action: no received files ===");
    {
      const ctx = makeMockContext(undefined);
      const result = await callTool(tool, ctx, "list");
      assert(!result.isError, "list with no files should not error");
      assert(
        getText(result).includes("No files received"),
        "Should show 'No files received' message",
      );
    }

    // ── Test: list action with received files ──
    console.log("\n=== list action: with received files ===");
    {
      const receivedFiles = [
        { type: "file", url: "https://example.com/doc.pdf", name: "report.pdf", file: "f1" },
        { type: "image", url: "https://example.com/img.jpg", file: "i1" },
        { type: "record", url: "https://example.com/audio.mp3", file: "a1" },
        { type: "video", url: "https://example.com/video.mp4", file: "v1" },
      ];
      const ctx = makeMockContext(receivedFiles);
      const result = await callTool(tool, ctx, "list");
      assert(!result.isError, "list with files should not error");
      const text = getText(result);
      assert(text.includes("4"), "Should show count of 4 files");
      assert(text.includes("FILE"), "Should list FILE type");
      assert(text.includes("IMAGE"), "Should list IMAGE type");
      assert(text.includes("VOICE"), "Should list VOICE type");
      assert(text.includes("VIDEO"), "Should list VIDEO type");
      assert(text.includes("report.pdf"), "Should show file name");
      assert(text.includes("https://example.com/doc.pdf"), "Should show URL");
    }

    // ── Test: save action with missing URL ──
    console.log("\n=== save action: missing URL ===");
    {
      const ctx = makeMockContext(undefined);
      const result = await callTool(tool, ctx, "save");
      assert(result.isError === true, "Should error on missing URL");
      assert(
        getText(result).includes("Missing required parameter: url"),
        "Should show missing URL error",
      );
    }

    // ── Test: save action with invalid URL scheme ──
    console.log("\n=== save action: invalid URL scheme ===");
    {
      const ctx = makeMockContext(undefined);
      const result = await callTool(tool, ctx, "save", "ftp://example.com/file.pdf");
      assert(result.isError === true, "Should error on non-HTTP scheme");
      assert(
        getText(result).includes("Invalid URL scheme"),
        "Should show invalid scheme error",
      );
    }

    // ── Test: save action with path traversal in subdir ──
    console.log("\n=== save action: path traversal in subdir ===");
    {
      const ctx = makeMockContext(undefined);
      const result = await callTool(
        tool,
        ctx,
        "save",
        `${baseUrl}/test.txt`,
        "test.txt",
        "../../../etc",
      );
      assert(result.isError === true, "Should error on path traversal in subdir");
      assert(
        getText(result).includes("Invalid path") || getText(result).includes(".."),
        "Should show path traversal error",
      );
    }

    // ── Test: save action with path traversal in filename ──
    console.log("\n=== save action: path traversal in filename ===");
    {
      const ctx = makeMockContext(undefined);
      const result = await callTool(
        tool,
        ctx,
        "save",
        `${baseUrl}/test.txt`,
        "../../etc/passwd",
      );
      // The filename is sanitized (basename taken), so this should not error
      // but should save as "passwd" inside filesRoot
      assert(!result.isError, "Filename traversal should be sanitized, not error");
      const text = getText(result);
      assert(text.includes("File saved successfully"), "Should save successfully");
      assert(text.includes("passwd"), "Should save with sanitized name 'passwd'");
      assert(!text.includes(".."), "Saved path should not contain '..'");

      // Verify the file was actually saved
      const savedPath = join(tempRoot, "passwd");
      const savedContent = await readFile(savedPath, "utf-8");
      assert(
        savedContent.includes("test file content"),
        "Saved file should contain the downloaded content",
      );
    }

    // ── Test: save action with actual download ──
    console.log("\n=== save action: download from local server ===");
    {
      const ctx = makeMockContext(undefined);
      const result = await callTool(
        tool,
        ctx,
        "save",
        `${baseUrl}/test.txt`,
        "downloaded.txt",
        "downloads",
      );
      assert(!result.isError, "Download should succeed");
      const text = getText(result);
      assert(text.includes("File saved successfully"), "Should show success message");
      assert(text.includes("downloaded.txt"), "Should show filename");
      assert(text.includes("text/plain"), "Should detect MIME type text/plain");
      assert(text.includes("downloads"), "Should be in downloads subdir");

      // Verify the file was actually saved
      const savedPath = join(tempRoot, "downloads", "downloaded.txt");
      const savedContent = await readFile(savedPath, "utf-8");
      assert(
        savedContent.includes("test file content"),
        "Saved file content should match downloaded content",
      );
    }

    // ── Test: save action with auto-derived filename ──
    console.log("\n=== save action: auto-derived filename ===");
    {
      const ctx = makeMockContext(undefined);
      const result = await callTool(
        tool,
        ctx,
        "save",
        `${baseUrl}/data.json`,
      );
      assert(!result.isError, "Download with auto-filename should succeed");
      const text = getText(result);
      assert(text.includes("data.json"), "Should derive filename from URL");
      assert(text.includes("application/json"), "Should detect JSON MIME type");
    }

    // ── Test: save action with nested subdir ──
    console.log("\n=== save action: nested subdir ===");
    {
      const ctx = makeMockContext(undefined);
      const result = await callTool(
        tool,
        ctx,
        "save",
        `${baseUrl}/test.txt`,
        "nested.txt",
        "a/b/c",
      );
      assert(!result.isError, "Download with nested subdir should succeed");
      const text = getText(result);
      assert(text.includes(join("a", "b", "c")), "Should show nested subdir in path");

      // Verify file exists at nested path
      const savedPath = join(tempRoot, "a", "b", "c", "nested.txt");
      const savedContent = await readFile(savedPath, "utf-8");
      assert(savedContent.includes("test file content"), "File at nested path should have correct content");
    }

    // ── Test: save action with PDF MIME detection ──
    console.log("\n=== save action: PDF MIME detection ===");
    {
      const ctx = makeMockContext(undefined);
      const result = await callTool(
        tool,
        ctx,
        "save",
        `${baseUrl}/report.pdf`,
        "quarterly.pdf",
      );
      assert(!result.isError, "PDF download should succeed");
      const text = getText(result);
      assert(text.includes("application/pdf"), "Should detect PDF MIME type");
    }

    // ── Test: unknown action ──
    console.log("\n=== unknown action ===");
    {
      const ctx = makeMockContext(undefined);
      const result = await callTool(tool, ctx, "delete_all");
      assert(result.isError === true, "Unknown action should error");
      assert(
        getText(result).includes("Unknown action"),
        "Should show unknown action error",
      );
    }

    // ── Test: missing action parameter ──
    console.log("\n=== missing action parameter ===");
    {
      const ctx = makeMockContext(undefined);
      const result = await callTool(tool, ctx);
      assert(result.isError === true, "Missing action should error");
      assert(
        getText(result).includes("Missing required parameter: action"),
        "Should show missing action error",
      );
    }

    // ── Test: tool metadata ──
    console.log("\n=== tool metadata ===");
    {
      assert(tool.name === "save_platform_file", "Tool name should be 'save_platform_file'");
      assert(
        tool.description.includes("download") || tool.description.includes("Download"),
        "Description should mention download",
      );
      assert(
        tool.description.includes("list") || tool.description.includes("List"),
        "Description should mention list action",
      );
      const params = tool.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, { enum?: string[] }>;
      assert(
        props.action.enum?.includes("list") && props.action.enum?.includes("save"),
        "Action enum should include 'list' and 'save'",
      );
      assert(
        Array.isArray(params.required) && params.required.includes("action"),
        "'action' should be required",
      );
    }

    // ── Test: list action with empty received_files array ──
    console.log("\n=== list action: empty received_files array ===");
    {
      const ctx = makeMockContext([]);
      const result = await callTool(tool, ctx, "list");
      assert(!result.isError, "Empty array should not error");
      assert(
        getText(result).includes("No files received"),
        "Should show 'No files received' for empty array",
      );
    }

    // ── Test: save action with empty URL string ──
    console.log("\n=== save action: empty URL ===");
    {
      const ctx = makeMockContext(undefined);
      const result = await callTool(tool, ctx, "save", "");
      assert(result.isError === true, "Empty URL should error");
      assert(
        getText(result).includes("Missing required parameter: url"),
        "Should show missing URL error",
      );
    }

    // ── Test: save action with whitespace-only URL ──
    console.log("\n=== save action: whitespace URL ===");
    {
      const ctx = makeMockContext(undefined);
      const result = await callTool(tool, ctx, "save", "   ");
      assert(result.isError === true, "Whitespace URL should error");
      assert(
        getText(result).includes("Missing required parameter: url"),
        "Should show missing URL error for whitespace",
      );
    }

    // ── Test: save action with 404 URL ──
    console.log("\n=== save action: 404 URL ===");
    {
      const ctx = makeMockContext(undefined);
      const result = await callTool(
        tool,
        ctx,
        "save",
        `${baseUrl}/nonexistent.txt`,
        "missing.txt",
      );
      assert(result.isError === true, "404 download should error");
      assert(
        getText(result).includes("Failed to download"),
        "Should show download failure error",
      );
    }

  } finally {
    // Clean up: close server first, then remove temp directory
    await closeServer(server);
    try { await rm(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ── Summary ──
  console.log("\n==================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("==================================================");
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
