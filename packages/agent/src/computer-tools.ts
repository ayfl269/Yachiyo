/**
 * Runtime computer tools for sandbox/local environment.
 * Provides file operations, code execution, and shell tools that sub-agents can use.
 * Ported from Python: core/tools/computer_tools/
 */

import { createFunctionTool, type FunctionTool } from "./tool.js";
import type { ContextWrapper, CallToolResult } from "./types.js";
import { readFile, writeFile, mkdir, readdir, stat, unlink, rename } from "fs/promises";
import { createWriteStream, existsSync } from "fs";
import { join, resolve, normalize, dirname, sep } from "path";
import { execFile, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";

// ── Permission helpers ──

export interface ComputerToolContext {
  event?: {
    unifiedMsgOrigin?: string;
  };
  providerSettings?: {
    computer_use_runtime?: "local" | "sandbox";
  };
}

function isLocalRuntime(context: ComputerToolContext): boolean {
  const runtime = context.providerSettings?.computer_use_runtime ?? "local";
  return runtime === "local";
}

function getToolContext(_ctx: unknown): ComputerToolContext {
  const wrapper = _ctx as ContextWrapper<ComputerToolContext> | undefined;
  return wrapper?.context ?? ({} as ComputerToolContext);
}

/**
 * Extract the tool-level AbortSignal from the run context, if available.
 *
 * The tool-loop runner sets `_toolAbortController` before each tool call
 * and aborts it on timeout. Tools that check this signal can cancel
 * long-running operations (subprocesses, file scans) cleanly instead of
 * relying solely on their own timeout.
 */
export function getAbortSignal(_ctx: unknown): AbortSignal | undefined {
  const wrapper = _ctx as ContextWrapper | undefined;
  return wrapper?._toolAbortController?.signal;
}

/**
 * Normalize a workspace path for local runtime.
 *
 * Rejects paths that resolve outside `workspaceRoot` to prevent path
 * traversal attacks (e.g. `/etc/passwd`, `../../etc/shadow`). Absolute
 * paths and relative paths are both resolved and then checked against the
 * workspace boundary using directory containment (not substring matching).
 */
export function normalizeRwPath(
  rawPath: string,
  options: { localEnv: boolean; workspaceRoot?: string }
): string {
  let p = normalize(rawPath);
  const root = resolve(options.workspaceRoot ?? process.cwd());

  if (!p.startsWith("/") && !/^[A-Za-z]:/.test(p)) {
    p = resolve(root, p);
  } else {
    p = resolve(p);
  }

  // Enforce workspace boundary: resolved path must be the root itself or
  // live inside it. This blocks absolute paths and `../` escape attempts.
  if (p !== root && !p.startsWith(root + sep)) {
    throw new Error(`Path '${p}' is outside the workspace root '${root}'`);
  }

  return p;
}

/**
 * Write a file atomically by writing to a temp file then renaming.
 *
 * Direct `writeFile` can leave a corrupted/partial file if the process is
 * killed mid-write. `rename` is atomic on POSIX and on Windows (when the
 * target doesn't exist or both files are on the same volume), so the
 * destination either has the old content or the new content — never a mix.
 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = join(dirname(filePath), `.tmp-${randomUUID()}`);
  await writeFile(tmpPath, content, "utf-8");
  try {
    await rename(tmpPath, filePath);
  } catch (e) {
    // Clean up the temp file if rename failed.
    try { await unlink(tmpPath); } catch { /* ignore */ }
    throw e;
  }
}

// ── File Read Tool ──

export function createFileReadTool(workspaceRoot?: string): FunctionTool<ComputerToolContext> {
  return createFunctionTool<ComputerToolContext>({
    name: "file_read_tool",
    description: "Read file content. Supports text files. Use offset/limit for large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to read. If relative, will be in workspace root." },
        offset: { type: "integer", description: "Optional line offset to start reading from. 0-based index.", minimum: 0 },
        limit: { type: "integer", description: "Optional maximum number of lines to read.", minimum: 1 },
      },
      required: ["path"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const path = String(args[0] ?? "");
      const offset = args[1] != null ? Number(args[1]) : undefined;
      const limit = args[2] != null ? Number(args[2]) : undefined;
      const context = getToolContext(_ctx);
      const localEnv = isLocalRuntime(context);
      const normalizedPath = normalizeRwPath(path, { localEnv, workspaceRoot });

      try {
        if (!existsSync(normalizedPath)) {
          return { content: [{ type: "text", text: `error: File not found: ${normalizedPath}` }] };
        }

        const content = await readFile(normalizedPath, "utf-8");
        const lines = content.split("\n");

        const startLine = offset ?? 0;
        const endLine = limit != null ? startLine + limit : lines.length;
        const selectedLines = lines.slice(startLine, endLine);

        // Add line numbers
        const numbered = selectedLines.map((line, i) => `${startLine + i + 1}→${line}`).join("\n");

        return { content: [{ type: "text", text: numbered || "(empty file)" }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: Failed to read file: ${e}` }] };
      }
    },
  });
}

// ── File Write Tool ──

export function createFileWriteTool(workspaceRoot?: string): FunctionTool<ComputerToolContext> {
  return createFunctionTool<ComputerToolContext>({
    name: "file_write_tool",
    description: "Write UTF-8 text content to a file. Creates parent directories if needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to write. If relative, will be in workspace root." },
        content: { type: "string", description: "The text content to write to the file." },
      },
      required: ["path", "content"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const path = String(args[0] ?? "");
      const content = String(args[1] ?? "");
      const context = getToolContext(_ctx);

      const localEnv = isLocalRuntime(context);
      const normalizedPath = normalizeRwPath(path, { localEnv, workspaceRoot });

      try {
        await mkdir(dirname(normalizedPath), { recursive: true });
        await atomicWriteFile(normalizedPath, content);
        return { content: [{ type: "text", text: `Successfully wrote to ${normalizedPath}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: Failed to write file: ${e}` }], isError: true };
      }
    },
  });
}

// ── File Edit Tool ──

export function createFileEditTool(workspaceRoot?: string): FunctionTool<ComputerToolContext> {
  return createFunctionTool<ComputerToolContext>({
    name: "file_edit_tool",
    description: "Edit a file by replacing old_string with new_string. Use replace_all to replace all occurrences.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to edit." },
        old_string: { type: "string", description: "The text to replace." },
        new_string: { type: "string", description: "The text to replace it with." },
        replace_all: { type: "boolean", description: "Replace all occurrences. Default: false.", default: false },
      },
      required: ["path", "old_string", "new_string"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const path = String(args[0] ?? "");
      const oldString = String(args[1] ?? "");
      const newString = String(args[2] ?? "");
      const replaceAll = args[3] === true;
      const context = getToolContext(_ctx);

      const localEnv = isLocalRuntime(context);
      const normalizedPath = normalizeRwPath(path, { localEnv, workspaceRoot });

      try {
        if (!existsSync(normalizedPath)) {
          return { content: [{ type: "text", text: `error: File not found: ${normalizedPath}` }], isError: true };
        }

        const content = await readFile(normalizedPath, "utf-8");

        if (!content.includes(oldString)) {
          return { content: [{ type: "text", text: `error: old_string not found in file. Make sure the string matches exactly.` }], isError: true };
        }

        let newContent: string;
        if (replaceAll) {
          newContent = content.split(oldString).join(newString);
        } else {
          const idx = content.indexOf(oldString);
          if (content.indexOf(oldString, idx + 1) !== -1) {
            return {
              content: [{ type: "text", text: `error: old_string appears multiple times in the file. Use replace_all=true to replace all occurrences, or provide more context to make the match unique.` }],
              isError: true,
            };
          }
          newContent = content.replace(oldString, newString);
        }

        await atomicWriteFile(normalizedPath, newContent);
        return { content: [{ type: "text", text: `Successfully edited ${normalizedPath}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: Failed to edit file: ${e}` }], isError: true };
      }
    },
  });
}

// ── Grep Tool ──

export function createGrepTool(workspaceRoot?: string): FunctionTool<ComputerToolContext> {
  return createFunctionTool<ComputerToolContext>({
    name: "grep_tool",
    description: "Search file contents using a regex pattern. Returns matching lines with file paths.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regex pattern to search for." },
        path: { type: "string", description: "Directory or file to search in. Defaults to workspace root." },
        glob: { type: "string", description: "Optional glob pattern to filter files (e.g. '*.ts')." },
        context_lines: { type: "integer", description: "Number of context lines before and after match. Default: 2.", minimum: 0 },
        result_limit: { type: "integer", description: "Maximum number of results. Default: 50.", minimum: 1 },
      },
      required: ["pattern"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const pattern = String(args[0] ?? "");
      const searchPath = args[1] != null ? String(args[1]) : undefined;
      const glob = args[2] != null ? String(args[2]) : undefined;
      const contextLines = args[3] != null ? Number(args[3]) : undefined;
      const resultLimit = args[4] != null ? Number(args[4]) : undefined;
      const context = getToolContext(_ctx);
      const abortSignal = getAbortSignal(_ctx);
      const localEnv = isLocalRuntime(context);
      const root = workspaceRoot ?? process.cwd();
      const normalizedPath = searchPath ? normalizeRwPath(searchPath, { localEnv, workspaceRoot: root }) : root;

      try {
        const results = await grepSearch(pattern, normalizedPath, {
          glob,
          contextLines: contextLines ?? 2,
          resultLimit: resultLimit ?? 50,
          abortSignal,
        });

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No matches found." }] };
        }

        return { content: [{ type: "text", text: results.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: Search failed: ${e}` }], isError: true };
      }
    },
  });
}

// ── Shell Execute Tool ──

/**
 * Best-effort guard against obviously destructive shell commands.
 *
 * NOTE: This is defense-in-depth, NOT a security boundary. Shell command
 * parsing can always be subverted (base64, variable expansion, quoting,
 * aliases, pipes, here-documents, …). Real isolation must come from
 * process-level sandboxing (see sandbox.ts). This guard only exists to catch
 * accidental foot-guns like `rm -rf /` from a model typo — the previous
 * regex blacklist was trivially bypassed by extra whitespace or alternative
 * targets such as `rm -rf ~` / `rm -rf /home`.
 */
function isDestructiveCommand(command: string): boolean {
  // Collapse all whitespace (spaces, tabs, newlines) so tricks like
  // `rm  -rf /` or `rm\t-rf /` cannot slip past a pattern expecting one space.
  const c = command.replace(/\s+/g, " ").trim();

  const patterns: RegExp[] = [
    // rm with a recursive flag targeting root/home/wildcard/parent
    /\brm\s+(?:-[a-z]*r[a-z]*|--recursive)[\s='"`]*(?:\/+|~|\$HOME|\*|\.\.(?:\s|$|;|&|\|))/,
    // mkfs / mke2fs — reformat a filesystem
    /\bmk(?:fs|e2fs)\b/,
    // dd writing to a block device
    /\bdd\b[^|]*\bof=\/dev\//,
    // direct redirect to a block device
    />\s*\/dev\/(?:sd|nvme|hd|vd|xvd|disk)/,
    // find from root with -delete or -exec rm
    /\bfind\s+\/\b[^|]*(?:-delete|-exec\s+rm\b)/,
    // classic fork bomb: :(){ :|:& };:
    /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    // system shutdown / reboot
    /\b(?:shutdown|reboot|halt|poweroff|init\s+0)\b/,
  ];

  return patterns.some((p) => p.test(c));
}

/**
 * Registry of background shell processes started by `execute_shell`.
 *
 * Keeping the ChildProcess references here means they can be tracked and
 * terminated instead of leaking forever (the previous implementation discarded
 * the reference immediately). Entries are removed automatically when the child
 * exits.
 */
const backgroundProcesses = new Map<string, ChildProcess>();

/**
 * Kill a background shell process by id. Returns true if a process was found
 * and signalled, false otherwise. The caller may follow up with a SIGKILL if
 * the process does not exit within a grace period.
 */
export function killBackgroundShell(id: string): boolean {
  const child = backgroundProcesses.get(id);
  if (!child) return false;
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore — process may have already exited */
  }
  return true;
}

export function createShellTool(workspaceRoot?: string): FunctionTool<ComputerToolContext> {
  return createFunctionTool<ComputerToolContext>({
    name: "execute_shell",
    description: "Execute a shell command. Use background=true for long-running commands.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute." },
        background: { type: "boolean", description: "Run the command in the background. Default: false.", default: false },
        timeout: { type: "integer", description: "Optional timeout in seconds. Default: 300.", default: 300 },
        env: { type: "object", description: "Optional environment variables.", additionalProperties: { type: "string" }, default: {} },
      },
      required: ["command"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const command = String(args[0] ?? "");
      const background = args[1] === true;
      const timeout = args[2] != null ? Number(args[2]) : undefined;
      const env = (args[3] as Record<string, string>) ?? undefined;
      const abortSignal = getAbortSignal(_ctx);

      // Defense-in-depth guard: block obviously destructive commands.
      // NOTE: this is NOT a security boundary — see isDestructiveCommand docs.
      if (isDestructiveCommand(command)) {
        return { content: [{ type: "text", text: `error: Command blocked for safety: contains a potentially destructive pattern. If this is a legitimate command, run it outside the agent tool layer.` }], isError: true };
      }

      const cwd = workspaceRoot ?? process.cwd();
      const timeoutMs = (timeout ?? 300) * 1000;

      try {
        if (background) {
          const id = crypto.randomUUID().slice(0, 8);
          // Write logs inside the workspace so file_read_tool can access them
          // (normalizeRwPath rejects paths outside workspaceRoot).
          const logDir = join(workspaceRoot ?? process.cwd(), ".logs");
          await mkdir(logDir, { recursive: true });
          const logPath = join(logDir, `shell_bg_${id}.log`);
          // Actually redirect stdout/stderr to the log file — the previous
          // implementation computed logPath but never wired up the streams,
          // so the returned message was a lie and the output was lost.
          const logStream = createWriteStream(logPath, { flags: "w" });
          // Keep the ChildProcess reference so it can be tracked and killed
          // via killBackgroundShell(id); the previous implementation discarded
          // it immediately, causing unbounded process leaks.
          const child = execFile(
            process.platform === "win32" ? "cmd" : "/bin/sh",
            process.platform === "win32" ? ["/c", command] : ["-c", command],
            { cwd, env: { ...process.env, ...env }, timeout: timeoutMs }
          );
          child.stdout?.pipe(logStream);
          child.stderr?.pipe(logStream);
          backgroundProcesses.set(id, child);
          child.on("close", () => {
            backgroundProcesses.delete(id);
            logStream.end();
          });
          child.on("error", () => {
            backgroundProcesses.delete(id);
            logStream.end();
          });
          return { content: [{ type: "text", text: `Background command started (id=${id}). Output is being written to ${logPath}. Use killBackgroundShell("${id}") to terminate it.` }] };
        }

        const result = await new Promise<{ stdout: string; stderr: string; code: number; aborted: boolean }>((resolvePromise) => {
          const child = execFile(
            process.platform === "win32" ? "cmd" : "/bin/sh",
            process.platform === "win32" ? ["/c", command] : ["-c", command],
            { cwd, env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }
          );

          // Kill child process when abort signal fires (e.g. tool timeout).
          if (abortSignal) {
            if (abortSignal.aborted) {
              child.kill("SIGTERM");
            } else {
              abortSignal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
            }
          }

          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
          child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
          child.on("close", (code) => {
            resolvePromise({ stdout, stderr, code: code ?? 0, aborted: abortSignal?.aborted ?? false });
          });
          child.on("error", (_err) => {
            resolvePromise({ stdout, stderr, code: -1, aborted: abortSignal?.aborted ?? false });
          });
        });

        if (result.aborted) {
          return { content: [{ type: "text", text: `error: Command was aborted (timeout or cancellation).\n${result.stdout || ""}` }], isError: true };
        }

        let output = "";
        if (result.stdout) output += result.stdout;
        if (result.stderr) output += (output ? "\n" : "") + `[stderr]\n${result.stderr}`;
        if (result.code !== 0) output += `\n[exit code: ${result.code}]`;

        return { content: [{ type: "text", text: output || "(no output)" }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("timed out")) {
          return { content: [{ type: "text", text: `error: Command timed out after ${timeout ?? 300} seconds.` }], isError: true };
        }
        return { content: [{ type: "text", text: `error: Shell execution failed: ${msg}` }], isError: true };
      }
    },
  });
}

// ── Python Execute Tool (local) ──

export function createLocalPythonTool(workspaceRoot?: string): FunctionTool<ComputerToolContext> {
  return createFunctionTool<ComputerToolContext>({
    name: "execute_python",
    description: "Execute Python code in a local subprocess.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "The Python code to execute." },
        silent: { type: "boolean", description: "Whether to suppress the output. Default: false.", default: false },
        timeout: { type: "integer", description: "Optional timeout in seconds. Default: 30.", default: 30 },
      },
      required: ["code"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const code = String(args[0] ?? "");
      const silent = args[1] === true;
      const timeout = args[2] != null ? Number(args[2]) : undefined;
      const timeoutMs = (timeout ?? 30) * 1000;
      const cwd = workspaceRoot ?? process.cwd();

      try {
        const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolvePromise) => {
          const child = execFile(
            "python3",
            ["-c", code],
            { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }
          );

          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
          child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
          child.on("close", (code) => { resolvePromise({ stdout, stderr, code: code ?? 0 }); });
          child.on("error", (err) => {
            // python3 might not exist on Windows, try python
            if (process.platform === "win32" && err.message.includes("python3")) {
              const child2 = execFile("python", ["-c", code], { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
              let stdout2 = "";
              let stderr2 = "";
              child2.stdout?.on("data", (data: Buffer) => { stdout2 += data.toString(); });
              child2.stderr?.on("data", (data: Buffer) => { stderr2 += data.toString(); });
              child2.on("close", (code2) => { resolvePromise({ stdout: stdout2, stderr: stderr2, code: code2 ?? 0 }); });
              child2.on("error", () => { resolvePromise({ stdout: "", stderr: "Python not found", code: -1 }); });
            } else {
              resolvePromise({ stdout: "", stderr: err.message, code: -1 });
            }
          });
        });

        if (silent) {
          return { content: [{ type: "text", text: "Code executed successfully (silent mode)." }] };
        }

        let output = "";
        if (result.stdout) output += result.stdout;
        if (result.stderr) output += (output ? "\n" : "") + `[stderr]\n${result.stderr}`;
        if (result.code !== 0) output += `\n[exit code: ${result.code}]`;

        return { content: [{ type: "text", text: output || "(no output)" }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: Python execution failed: ${e}` }], isError: true };
      }
    },
  });
}

// ── List Directory Tool ──

export function createListDirTool(workspaceRoot?: string): FunctionTool<ComputerToolContext> {
  return createFunctionTool<ComputerToolContext>({
    name: "list_dir_tool",
    description: "List files and directories in a given path. Returns names, types (file/dir), and sizes.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list. Defaults to workspace root." },
        recursive: { type: "boolean", description: "List recursively. Default: false.", default: false },
        max_depth: { type: "integer", description: "Maximum recursion depth when recursive=true. Default: 3.", minimum: 1, default: 3 },
      },
      required: [],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const dirPath = args[0] != null ? String(args[0]) : undefined;
      const recursive = args[1] === true;
      const maxDepth = args[2] != null ? Number(args[2]) : undefined;
      const context = getToolContext(_ctx);
      const localEnv = isLocalRuntime(context);
      const root = workspaceRoot ?? process.cwd();
      const normalizedPath = dirPath ? normalizeRwPath(dirPath, { localEnv, workspaceRoot: root }) : root;

      try {
        if (!existsSync(normalizedPath)) {
          return { content: [{ type: "text", text: `error: Directory not found: ${normalizedPath}` }] };
        }

        const s = await stat(normalizedPath);
        if (!s.isDirectory()) {
          return { content: [{ type: "text", text: `error: Path is not a directory: ${normalizedPath}` }] };
        }

        const lines: string[] = [];

        async function walkDir(dir: string, depth: number, prefix: string): Promise<void> {
          if (recursive && depth > (maxDepth ?? 3)) return;

          let entries;
          try {
            entries = await readdir(dir, { withFileTypes: true });
          } catch {
            lines.push(`${prefix}(unreadable)`);
            return;
          }

          // Sort: directories first, then files, alphabetically
          const sorted = entries.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          });

          for (const entry of sorted) {
            // Skip common non-interesting directories
            if (entry.isDirectory() && ["node_modules", ".git", "__pycache__", ".svn", ".hg"].includes(entry.name)) {
              lines.push(`${prefix}${entry.name}/ (skipped)`);
              continue;
            }

            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              lines.push(`${prefix}${entry.name}/`);
              if (recursive) {
                await walkDir(fullPath, depth + 1, prefix + "  ");
              }
            } else if (entry.isFile()) {
              try {
                const fileStat = await stat(fullPath);
                const sizeStr = fileStat.size < 1024 ? `${fileStat.size}B`
                  : fileStat.size < 1024 * 1024 ? `${(fileStat.size / 1024).toFixed(1)}KB`
                  : `${(fileStat.size / (1024 * 1024)).toFixed(1)}MB`;
                lines.push(`${prefix}${entry.name} (${sizeStr})`);
              } catch {
                lines.push(`${prefix}${entry.name}`);
              }
            }
          }
        }

        await walkDir(normalizedPath, 0, "");

        return { content: [{ type: "text", text: lines.join("\n") || "(empty directory)" }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: Failed to list directory: ${e}` }], isError: true };
      }
    },
  });
}

// ── File Delete Tool ──

export function createFileDeleteTool(workspaceRoot?: string): FunctionTool<ComputerToolContext> {
  return createFunctionTool<ComputerToolContext>({
    name: "file_delete_tool",
    description: "Delete a file. Cannot delete directories. Use with caution as deletion is permanent.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to delete. If relative, will be in workspace root." },
      },
      required: ["path"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const path = String(args[0] ?? "");
      const context = getToolContext(_ctx);

      const localEnv = isLocalRuntime(context);
      const normalizedPath = normalizeRwPath(path, { localEnv, workspaceRoot });

      try {
        if (!existsSync(normalizedPath)) {
          return { content: [{ type: "text", text: `error: File not found: ${normalizedPath}` }], isError: true };
        }

        const s = await stat(normalizedPath);
        if (s.isDirectory()) {
          return { content: [{ type: "text", text: `error: Path is a directory, not a file. Use shell commands for directory removal.` }], isError: true };
        }

        await unlink(normalizedPath);
        return { content: [{ type: "text", text: `Successfully deleted ${normalizedPath}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: Failed to delete file: ${e}` }], isError: true };
      }
    },
  });
}

// ── File Move Tool ──

export function createFileMoveTool(workspaceRoot?: string): FunctionTool<ComputerToolContext> {
  return createFunctionTool<ComputerToolContext>({
    name: "file_move_tool",
    description: "Move or rename a file or directory. Creates the destination parent directory if needed.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source path of the file or directory to move." },
        destination: { type: "string", description: "Destination path. If relative, will be in workspace root." },
      },
      required: ["source", "destination"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const source = String(args[0] ?? "");
      const destination = String(args[1] ?? "");
      const context = getToolContext(_ctx);

      const localEnv = isLocalRuntime(context);
      const normalizedSource = normalizeRwPath(source, { localEnv, workspaceRoot });
      const normalizedDest = normalizeRwPath(destination, { localEnv, workspaceRoot });

      try {
        if (!existsSync(normalizedSource)) {
          return { content: [{ type: "text", text: `error: Source not found: ${normalizedSource}` }], isError: true };
        }

        if (existsSync(normalizedDest)) {
          return { content: [{ type: "text", text: `error: Destination already exists: ${normalizedDest}` }], isError: true };
        }

        // Ensure destination parent directory exists
        await mkdir(dirname(normalizedDest), { recursive: true });
        await rename(normalizedSource, normalizedDest);

        return { content: [{ type: "text", text: `Successfully moved ${normalizedSource} → ${normalizedDest}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: Failed to move: ${e}` }], isError: true };
      }
    },
  });
}

// ── Node.js Execute Tool (local) ──

export function createLocalNodeTool(workspaceRoot?: string): FunctionTool<ComputerToolContext> {
  return createFunctionTool<ComputerToolContext>({
    name: "execute_node",
    description: "Execute JavaScript code in a Node.js subprocess. (TypeScript is not supported — use execute_shell with tsx for TS.)",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "The JavaScript code to execute." },
        silent: { type: "boolean", description: "Whether to suppress the output. Default: false.", default: false },
        timeout: { type: "integer", description: "Optional timeout in seconds. Default: 30.", default: 30 },
      },
      required: ["code"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const code = String(args[0] ?? "");
      const silent = args[1] === true;
      const timeout = args[2] != null ? Number(args[2]) : undefined;
      const timeoutMs = (timeout ?? 30) * 1000;
      const cwd = workspaceRoot ?? process.cwd();

      try {
        const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolvePromise) => {
          const child = execFile(
            "node",
            ["-e", code],
            { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }
          );

          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
          child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
          child.on("close", (code) => { resolvePromise({ stdout, stderr, code: code ?? 0 }); });
          child.on("error", (err) => { resolvePromise({ stdout: "", stderr: err.message, code: -1 }); });
        });

        if (silent) {
          return { content: [{ type: "text", text: "Code executed successfully (silent mode)." }] };
        }

        let output = "";
        if (result.stdout) output += result.stdout;
        if (result.stderr) output += (output ? "\n" : "") + `[stderr]\n${result.stderr}`;
        if (result.code !== 0) output += `\n[exit code: ${result.code}]`;

        return { content: [{ type: "text", text: output || "(no output)" }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("timed out")) {
          return { content: [{ type: "text", text: `error: Node.js execution timed out after ${timeout ?? 30} seconds.` }], isError: true };
        }
        return { content: [{ type: "text", text: `error: Node.js execution failed: ${msg}` }], isError: true };
      }
    },
  });
}

// ── Tool assembly helpers ──

export type ComputerRuntime = "local" | "sandbox";

/**
 * Get the set of computer tools for the given runtime.
 * This mirrors Python's `_get_runtime_computer_tools()`.
 */
export function getRuntimeComputerTools(
  runtime: ComputerRuntime,
  workspaceRoot?: string,
): FunctionTool<ComputerToolContext>[] {
  const tools: FunctionTool<ComputerToolContext>[] = [
    createFileReadTool(workspaceRoot),
    createFileWriteTool(workspaceRoot),
    createFileEditTool(workspaceRoot),
    createListDirTool(workspaceRoot),
    createFileDeleteTool(workspaceRoot),
    createFileMoveTool(workspaceRoot),
    createGrepTool(workspaceRoot),
    createShellTool(workspaceRoot),
  ];

  if (runtime === "local") {
    tools.push(createLocalPythonTool(workspaceRoot));
    tools.push(createLocalNodeTool(workspaceRoot));
  }
  // sandbox-only tools (upload/download, ipython) would be added here
  // when sandbox booter is implemented

  return tools;
}

// ── grep implementation with ripgrep integration ──

/**
 * Lazy-loaded ripgrep availability check. Probed once on first use;
 * cached thereafter to avoid repeated `which rg` overhead.
 */
let ripgrepAvailable: boolean | null = null;

async function isRipgrepAvailable(): Promise<boolean> {
  if (ripgrepAvailable !== null) return ripgrepAvailable;
  return new Promise<boolean>((resolve) => {
    const child = execFile(
      process.platform === "win32" ? "where" : "which",
      ["rg"],
      { timeout: 3000 },
    );
    child.on("error", () => { ripgrepAvailable = false; resolve(false); });
    child.on("close", (code) => { ripgrepAvailable = code === 0; resolve(ripgrepAvailable); });
  });
}

/**
 * Run grep using ripgrep. Returns null if ripgrep is unavailable or
 * fails unexpectedly, so the caller can fall back to the JS implementation.
 */
async function grepWithRipgrep(
  pattern: string,
  searchPath: string,
  options: { glob?: string; contextLines: number; resultLimit: number; abortSignal?: AbortSignal },
): Promise<string[] | null> {
  if (!(await isRipgrepAvailable())) return null;

  const args = ["-i", "-n", "--no-heading", "--color=never", `--max-count=${options.resultLimit}`];
  if (options.contextLines > 0) args.push("-C", String(options.contextLines));
  if (options.glob) args.push("--glob", options.glob);
  args.push("--", pattern, searchPath);

  return new Promise<string[] | null>((resolve) => {
    const child = execFile("rg", args, { maxBuffer: 10 * 1024 * 1024, timeout: 30000 });
    let stdout = "";
    child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });

    // Kill child process when abort signal fires.
    if (options.abortSignal) {
      if (options.abortSignal.aborted) child.kill("SIGTERM");
      else options.abortSignal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    }

    child.on("error", () => { resolve(null); });
    child.on("close", (code) => {
      // Exit code 1 = no matches (not an error).
      if (code !== 0 && code !== 1) { resolve(null); return; }
      const results: string[] = [];
      for (const line of stdout.split("\n")) {
        if (!line || line === "--") continue;
        // Format: path:line:content (match) or path-line-content (context)
        const m = line.match(/^(.+)([:-])(\d+)\2(.*)$/);
        if (m) results.push(`${m[1]}:${m[3]}: ${m[4]}`);
      }
      resolve(results);
    });
  });
}

/**
 * Detect patterns that are likely to cause ReDoS (Regular Expression
 * Denial of Service). Catches the most common catastrophic backtracking
 * patterns: nested quantifiers like `(a+)+`, `(a*)*`, overlapping quantifiers
 * like `a+a*`. This is a best-effort heuristic — not a complete solution.
 */
function isPotentialReDoS(pattern: string): boolean {
  // Nested quantifiers: (…[+*?]…)[+*?{]
  if (/\([^)]*[+*?][^)]*\)[+*?{]/.test(pattern)) return true;
  // Overlapping quantifiers: a++ a** a+* etc.
  if (/[+*?][+*?]/.test(pattern)) return true;
  return false;
}

/** Maximum pattern length to prevent overly complex regexes. */
const GREP_MAX_PATTERN_LENGTH = 500;
/** Skip lines longer than this to avoid slow regex matching on huge lines. */
const GREP_MAX_LINE_LENGTH = 10_000;

async function grepSearch(
  pattern: string,
  searchPath: string,
  options: { glob?: string; contextLines: number; resultLimit: number; abortSignal?: AbortSignal },
): Promise<string[]> {
  // Validate pattern to prevent ReDoS
  if (pattern.length > GREP_MAX_PATTERN_LENGTH) {
    return [`error: Pattern too long (max ${GREP_MAX_PATTERN_LENGTH} characters).`];
  }
  if (isPotentialReDoS(pattern)) {
    return ["error: Pattern contains potentially dangerous nested quantifiers (e.g. `(a+)+`) which can cause ReDoS. Please simplify the pattern."];
  }

  // Try ripgrep first — it's orders of magnitude faster than the JS fallback.
  const rgResults = await grepWithRipgrep(pattern, searchPath, options);
  if (rgResults !== null) return rgResults;

  // Fallback: pure JS implementation
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch (e) {
    return [`error: Invalid regex pattern: ${e}`];
  }

  const results: string[] = [];
  const globRegex = options.glob ? globToRegex(options.glob) : null;

  async function walkDir(dir: string): Promise<void> {
    if (results.length >= options.resultLimit) return;
    if (options.abortSignal?.aborted) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (results.length >= options.resultLimit) return;
      if (options.abortSignal?.aborted) return;
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip common non-interesting directories
        if (["node_modules", ".git", "__pycache__", ".svn", ".hg"].includes(entry.name)) continue;
        await walkDir(fullPath);
      } else if (entry.isFile()) {
        if (globRegex && !globRegex.test(entry.name)) continue;

        try {
          const content = await readFile(fullPath, "utf-8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            if (results.length >= options.resultLimit) return;
            if (lines[i].length > GREP_MAX_LINE_LENGTH) continue;
            if (!regex.test(lines[i])) continue;

            const start = Math.max(0, i - options.contextLines);
            const end = Math.min(lines.length, i + options.contextLines + 1);
            const ctx = lines.slice(start, end)
              .map((line, idx) => `${start + idx + 1}→${line}`)
              .join("\n");

            results.push(`${fullPath}:\n${ctx}`);
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }

  if (existsSync(searchPath)) {
    const s = await stat(searchPath);
    if (s.isDirectory()) {
      await walkDir(searchPath);
    } else {
      // Single file search
      try {
        const content = await readFile(searchPath, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= options.resultLimit) return results;
          if (lines[i].length > GREP_MAX_LINE_LENGTH) continue;
          if (!regex.test(lines[i])) continue;
          const start = Math.max(0, i - options.contextLines);
          const end = Math.min(lines.length, i + options.contextLines + 1);
          const ctx = lines.slice(start, end)
            .map((line, idx) => `${start + idx + 1}→${line}`)
            .join("\n");
          results.push(`${searchPath}:\n${ctx}`);
        }
      } catch { /* skip */ }
    }
  }

  return results;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}
