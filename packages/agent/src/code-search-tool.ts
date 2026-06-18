/**
 * Code search tool: AST-aware and symbol-based code search.
 * Provides smarter code search than plain grep by understanding code structure.
 */

import { createFunctionTool, type FunctionTool } from "./tool.js";
import type { ContextWrapper, CallToolResult } from "./types.js";
import { readFile, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

// ── Context type ──

export interface CodeSearchToolContext {
  event?: {
    unifiedMsgOrigin?: string;
  };
}

function getToolContext(_ctx: unknown): CodeSearchToolContext {
  const wrapper = _ctx as ContextWrapper<CodeSearchToolContext> | undefined;
  return wrapper?.context ?? ({} as CodeSearchToolContext);
}

// ── Symbol patterns for different languages ──

interface SymbolPattern {
  type: string; // "function", "class", "method", "variable", "interface", "type", "constant", "import"
  regex: RegExp;
  extractName: (match: RegExpMatchArray) => string;
}

const SYMBOL_PATTERNS: Record<string, SymbolPattern[]> = {
  typescript: [
    { type: "interface", regex: /interface\s+(\w+)/g, extractName: (m) => m[1] },
    { type: "type", regex: /type\s+(\w+)\s*=/g, extractName: (m) => m[1] },
    { type: "class", regex: /class\s+(\w+)/g, extractName: (m) => m[1] },
    { type: "function", regex: /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>)/g, extractName: (m) => m[1] || m[2] },
    { type: "method", regex: /(?:(?:public|private|protected|static|async)\s+)*(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/g, extractName: (m) => m[1] },
    { type: "constant", regex: /(?:const|export\s+const)\s+(\w+)\s*=/g, extractName: (m) => m[1] },
    { type: "import", regex: /import\s+.*?(?:{([^}]+)}|(\w+))\s+from/g, extractName: (m) => (m[1] || m[2]).trim().split(",")[0].trim() },
  ],
  python: [
    { type: "class", regex: /class\s+(\w+)/g, extractName: (m) => m[1] },
    { type: "function", regex: /def\s+(\w+)/g, extractName: (m) => m[1] },
    { type: "variable", regex: /(\w+)\s*=\s*/g, extractName: (m) => m[1] },
    { type: "import", regex: /(?:from\s+[\w.]+\s+)?import\s+([\w.*,\s]+)/g, extractName: (m) => m[1].split(",")[0].trim() },
  ],
  generic: [
    { type: "function", regex: /function\s+(\w+)/g, extractName: (m) => m[1] },
    { type: "class", regex: /class\s+(\w+)/g, extractName: (m) => m[1] },
    { type: "method", regex: /def\s+(\w+)|func\s+(\w+)|fn\s+(\w+)/g, extractName: (m) => m[1] || m[2] || m[3] },
    { type: "interface", regex: /interface\s+(\w+)/g, extractName: (m) => m[1] },
    { type: "constant", regex: /(?:const|FINAL|static\s+final)\s+(\w+)/g, extractName: (m) => m[1] },
  ],
};

function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const langMap: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "typescript", jsx: "typescript", mjs: "typescript",
    py: "python", pyw: "python",
    java: "generic", go: "generic", rs: "generic", c: "generic", cpp: "generic", h: "generic",
    rb: "generic", php: "generic", swift: "generic", kt: "generic",
  };
  return langMap[ext] ?? "generic";
}

// ── Code search implementation ──

interface SearchResult {
  file: string;
  line: number;
  symbolType: string;
  symbolName: string;
  context: string;
}

async function searchSymbols(
  rootPath: string,
  options: {
    symbolName?: string;
    symbolType?: string;
    language?: string;
    glob?: string;
    resultLimit: number;
  },
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const globRegex = options.glob ? new RegExp(`^${options.glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i") : null;

  async function walkDir(dir: string): Promise<void> {
    if (results.length >= options.resultLimit) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (results.length >= options.resultLimit) return;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (["node_modules", ".git", "__pycache__", ".svn", ".hg", "dist", "build", ".next", ".nuxt", "coverage"].includes(entry.name)) continue;
        await walkDir(fullPath);
      } else if (entry.isFile()) {
        if (globRegex && !globRegex.test(entry.name)) continue;

        const lang = options.language ?? detectLanguage(entry.name);
        const patterns = SYMBOL_PATTERNS[lang] ?? SYMBOL_PATTERNS.generic;

        try {
          const content = await readFile(fullPath, "utf-8");
          const lines = content.split("\n");

          for (const pattern of patterns) {
            if (options.symbolType && pattern.type !== options.symbolType) continue;

            // Reset regex lastIndex
            pattern.regex.lastIndex = 0;

            for (let i = 0; i < lines.length; i++) {
              if (results.length >= options.resultLimit) return;

              const line = lines[i];
              pattern.regex.lastIndex = 0;
              const match = pattern.regex.exec(line);
              if (!match) continue;

              const name = pattern.extractName(match);
              if (!name) continue;

              // Filter by symbol name if specified
              if (options.symbolName && !name.toLowerCase().includes(options.symbolName.toLowerCase())) continue;

              // Get context (2 lines before and after)
              const start = Math.max(0, i - 2);
              const end = Math.min(lines.length, i + 3);
              const ctx = lines.slice(start, end)
                .map((l, idx) => `${start + idx + 1}→${l}`)
                .join("\n");

              results.push({
                file: fullPath,
                line: i + 1,
                symbolType: pattern.type,
                symbolName: name,
                context: ctx,
              });
            }
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }

  if (existsSync(rootPath)) {
    const s = await stat(rootPath);
    if (s.isDirectory()) {
      await walkDir(rootPath);
    }
  }

  return results;
}

// ── Code Search Tool ──

export function createCodeSearchTool(workspaceRoot?: string): FunctionTool<CodeSearchToolContext> {
  return createFunctionTool<CodeSearchToolContext>({
    name: "code_search_tool",
    description: "Search code by symbol name or type (function, class, interface, etc.). Smarter than grep for finding code definitions.",
    parameters: {
      type: "object",
      properties: {
        symbol_name: { type: "string", description: "Name of the symbol to search for (partial match supported)." },
        symbol_type: {
          type: "string",
          description: "Type of symbol to search for.",
          enum: ["function", "class", "method", "variable", "interface", "type", "constant", "import"],
        },
        language: { type: "string", description: "Programming language hint. Auto-detected from file extension if omitted.", enum: ["typescript", "python", "generic"] },
        path: { type: "string", description: "Directory to search in. Defaults to workspace root." },
        glob: { type: "string", description: "Optional glob pattern to filter files (e.g. '*.ts')." },
        result_limit: { type: "integer", description: "Maximum number of results. Default: 20.", minimum: 1, maximum: 100, default: 20 },
      },
      required: [],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const symbolName = args[0] != null ? String(args[0]) : undefined;
      const symbolType = args[1] != null ? String(args[1]) : undefined;
      const language = args[2] != null ? String(args[2]) : undefined;
      const searchPath = args[3] != null ? String(args[3]) : undefined;
      const glob = args[4] != null ? String(args[4]) : undefined;
      const resultLimit = args[5] != null ? Number(args[5]) : 20;

      if (!symbolName && !symbolType) {
        return { content: [{ type: "text", text: "error: At least one of 'symbol_name' or 'symbol_type' must be provided." }], isError: true };
      }

      const root = workspaceRoot ?? process.cwd();
      const normalizedPath = searchPath ?? root;

      try {
        const results = await searchSymbols(normalizedPath, {
          symbolName,
          symbolType,
          language,
          glob,
          resultLimit,
        });

        if (results.length === 0) {
          const filterDesc = [
            symbolName ? `name="${symbolName}"` : "",
            symbolType ? `type="${symbolType}"` : "",
          ].filter(Boolean).join(", ");
          return { content: [{ type: "text", text: `No symbols found matching ${filterDesc}.` }] };
        }

        const formatted = results
          .map((r, i) => `${i + 1}. [${r.symbolType}] ${r.symbolName}\n   ${r.file}:${r.line}\n${r.context.split("\n").map((l) => "   " + l).join("\n")}`)
          .join("\n\n");

        return { content: [{ type: "text", text: `Found ${results.length} symbol(s):\n\n${formatted}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: Code search failed: ${e}` }], isError: true };
      }
    },
  });
}
