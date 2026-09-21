/**
 * Runtime computer tools for sandbox/local environment.
 * Provides file operations, code execution, and shell tools that sub-agents can use.
 * Ported from Python: core/tools/computer_tools/
 */

import { createFunctionTool, type FunctionTool } from "./tool.js";
import type { ContextWrapper, CallToolResult } from "./types.js";
import { readFile, writeFile, mkdir, readdir, stat, unlink, rename } from "fs/promises";
import { createWriteStream, existsSync, realpathSync } from "fs";
import { join, resolve, normalize, dirname, basename, sep } from "path";
import { execFile, type ChildProcess, type ExecFileOptionsWithStringEncoding } from "child_process";
import { randomUUID } from "crypto";
import { isPathAllowed, type SandboxPolicy } from "./sandbox.js";
import { fileLockManager, type FileLockMode } from "./coordination.js";

// ── Permission helpers ──

export interface ComputerToolContext {
  event?: {
    unifiedMsgOrigin?: string;
  };
  providerSettings?: {
    computer_use_runtime?: "local" | "sandbox";
  };
  /** Optional sandbox policy. When present, path/domain restrictions are enforced. */
  sandboxPolicy?: SandboxPolicy;
}

function getToolContext(_ctx: unknown): ComputerToolContext {
  const wrapper = _ctx as ContextWrapper<ComputerToolContext> | undefined;
  const context = wrapper?.context ?? ({} as ComputerToolContext);
  // The effective sandbox policy for a run lives on the ContextWrapper
  // (`_sandboxPolicy`), set by the tool executor for sub-agent handoffs. Tools
  // read it from the event context (`context.sandboxPolicy`), which is never
  // populated — so the policy was silently inert. Fall back to the wrapper
  // field so path/domain restrictions are actually enforced. An explicit
  // `context.sandboxPolicy` still wins.
  if (context.sandboxPolicy === undefined && wrapper?._sandboxPolicy !== undefined) {
    return { ...context, sandboxPolicy: wrapper._sandboxPolicy };
  }
  return context;
}

/**
 * 将模型传入的秒数收敛到 [1, max]：负数/0 在 Node 的 execFile 语义下等于
 * 禁用超时（模型可借此绕过超时），NaN 同理无意义。超上限时取 max——
 * 工具调用层另有 runner 的 toolCallTimeout abort 兜底。
 */
function clampTimeoutSeconds(value: number | undefined, fallback: number, max = 3600): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), max);
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
  options: { workspaceRoot?: string; sandboxPolicy?: SandboxPolicy }
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
  // On Windows (case-insensitive FS), compare lowercased paths so that
  // varying case cannot bypass the workspace boundary.
  const pCmp = process.platform === "win32" ? p.toLowerCase() : p;
  const rootCmp = process.platform === "win32" ? root.toLowerCase() : root;
  if (pCmp !== rootCmp && !pCmp.startsWith(rootCmp + sep)) {
    throw new Error(`Path '${p}' is outside the workspace root '${root}'`);
  }

  // Resolve symlinks so a link inside the workspace cannot point outside of
  // it (e.g. a symlink created by execute_shell or file_move_tool). For a
  // not-yet-existing path (new file), resolve the nearest existing ancestor
  // and keep the remaining non-existent suffix appended verbatim.
  //
  // `realPath` is computed first so BOTH the workspace-root containment and
  // the sandbox allowedPaths/deniedPaths checks run against the symlink-
  // resolved target. Checking the sandbox policy only against the lexical
  // path let a symlink inside an allowed dir point elsewhere in the workspace
  // and escape `allowedPaths`.
  let realPath = p;
  try {
    const realRoot = realpathSync(root);
    let probe = p;
    let suffix = "";
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      suffix = join(basename(probe), suffix);
      probe = parent;
    }
    realPath = suffix ? join(realpathSync(probe), suffix) : realpathSync(probe);
    const realCmp = process.platform === "win32" ? realPath.toLowerCase() : realPath;
    const realRootCmp = process.platform === "win32" ? realRoot.toLowerCase() : realRoot;
    if (realCmp !== realRootCmp && !realCmp.startsWith(realRootCmp + sep)) {
      throw new Error(`Path '${p}' resolves outside the workspace root '${root}' via symlinks`);
    }
  } catch (e) {
    // Propagate our own containment violation; skip the realpath check when
    // the path disappeared or never existed (lexical check already passed);
    // anything else is an unexpected FS error worth surfacing.
    if (e instanceof Error && e.message.includes("outside the workspace root")) throw e;
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
  }

  // Apply sandbox policy path restrictions (allowedPaths / deniedPaths).
  // This enforces the SandboxPolicy that was previously defined but never
  // checked at the tool execution layer. Evaluate against the resolved target
  // so symlinks cannot sidestep `allowedPaths`.
  if (options.sandboxPolicy) {
    if (!isPathAllowed(p, options.sandboxPolicy) || !isPathAllowed(realPath, options.sandboxPolicy)) {
      throw new Error(`Path '${p}' is denied by sandbox policy`);
    }
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

// ── File locking ──

/**
 * Resolve the file-lock holder identity for the current run.
 *
 * Sub-agent handoffs set `_lockHolderId` to a per-invocation unique id; the
 * main agent (and standalone tool usage) falls back to the singleton
 * `"__main__"` holder. Using a stable per-run identity lets concurrent
 * sub-agents contend on the same paths (write locks are exclusive) while a
 * single run's own re-entrant accesses are granted immediately.
 */
function getLockHolderId(_ctx: unknown): string {
  const wrapper = _ctx as ContextWrapper | undefined;
  return wrapper?._lockHolderId ?? "__main__";
}

/**
 * Acquire a {@link fileLockManager} lock for `filePath` around a file
 * operation, then release it in a `finally`. Without this, the lock manager
 * was dead code (`acquire()` had no callers) and concurrent sub-agents could
 * interleave read-modify-write cycles on the same file (e.g. two
 * `file_edit_tool` calls clobbering each other).
 *
 * Returns `{ granted: false }` when the lock could not be acquired within
 * `timeoutMs` so the caller can surface a clear "file busy" error instead of
 * proceeding unprotected.
 */
async function withFileLock<T>(
  ctx: unknown,
  filePath: string,
  mode: FileLockMode,
  fn: () => Promise<T>,
  timeoutMs = 30_000
): Promise<{ granted: true; value: T } | { granted: false }> {
  const holderId = getLockHolderId(ctx);
  const granted = await fileLockManager.acquire(filePath, mode, holderId, timeoutMs);
  if (!granted) return { granted: false };
  try {
    return { granted: true, value: await fn() };
  } finally {
    fileLockManager.release(filePath, holderId, mode);
  }
}

/**
 * Acquire write locks for multiple paths atomically (all-or-nothing) and run
 * `fn` while holding them. Paths are locked in sorted order so two concurrent
 * multi-path operations (e.g. moves in opposite directions) cannot deadlock.
 * On partial acquisition failure, already-acquired locks are released.
 */
async function withFileLocks<T>(
  ctx: unknown,
  paths: string[],
  fn: () => Promise<T>,
  timeoutMs = 30_000
): Promise<{ granted: true; value: T } | { granted: false }> {
  const holderId = getLockHolderId(ctx);
  const uniqueSorted = [...new Set(paths)].sort();
  const acquired: string[] = [];
  try {
    for (const p of uniqueSorted) {
      const granted = await fileLockManager.acquire(p, "write", holderId, timeoutMs);
      if (!granted) {
        return { granted: false };
      }
      acquired.push(p);
    }
    return { granted: true, value: await fn() };
  } finally {
    for (const p of acquired) {
      fileLockManager.release(p, holderId, "write");
    }
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
      const normalizedPath = normalizeRwPath(path, { workspaceRoot, sandboxPolicy: context.sandboxPolicy });

      try {
        if (!existsSync(normalizedPath)) {
          return { content: [{ type: "text", text: `error: File not found: ${normalizedPath}` }] };
        }

        const lock = await withFileLock(_ctx, normalizedPath, "read", async () => {
          const content = await readFile(normalizedPath, "utf-8");
          const lines = content.split("\n");

          const startLine = offset ?? 0;
          const endLine = limit != null ? startLine + limit : lines.length;
          const selectedLines = lines.slice(startLine, endLine);

          // Add line numbers
          return selectedLines.map((line, i) => `${startLine + i + 1}→${line}`).join("\n");
        });
        if (!lock.granted) {
          return { content: [{ type: "text", text: `error: Timed out waiting for a lock on ${normalizedPath}. Another sub-agent may be writing it.` }], isError: true };
        }

        return { content: [{ type: "text", text: lock.value || "(empty file)" }] };
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

      const normalizedPath = normalizeRwPath(path, { workspaceRoot, sandboxPolicy: context.sandboxPolicy });

      try {
        const lock = await withFileLock(_ctx, normalizedPath, "write", async () => {
          await mkdir(dirname(normalizedPath), { recursive: true });
          await atomicWriteFile(normalizedPath, content);
        });
        if (!lock.granted) {
          return { content: [{ type: "text", text: `error: Timed out waiting for a write lock on ${normalizedPath}. Another sub-agent may be writing it.` }], isError: true };
        }
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

      const normalizedPath = normalizeRwPath(path, { workspaceRoot, sandboxPolicy: context.sandboxPolicy });

      try {
        if (!existsSync(normalizedPath)) {
          return { content: [{ type: "text", text: `error: File not found: ${normalizedPath}` }], isError: true };
        }

        // Hold the write lock across the entire read-modify-write cycle.
        // Locking only the final write would let two concurrent edits both
        // read the same base content and have the second silently clobber the
        // first's change (lost update).
        type EditOutcome = { ok: true } | { ok: false; message: string };
        const lock = await withFileLock(_ctx, normalizedPath, "write", async (): Promise<EditOutcome> => {
          const content = await readFile(normalizedPath, "utf-8");

          if (!content.includes(oldString)) {
            return { ok: false, message: `error: old_string not found in file. Make sure the string matches exactly.` };
          }

          let newContent: string;
          if (replaceAll) {
            newContent = content.split(oldString).join(newString);
          } else {
            const idx = content.indexOf(oldString);
            if (content.indexOf(oldString, idx + 1) !== -1) {
              return {
                ok: false,
                message: `error: old_string appears multiple times in the file. Use replace_all=true to replace all occurrences, or provide more context to make the match unique.`,
              };
            }
            newContent = content.replace(oldString, newString);
          }

          await atomicWriteFile(normalizedPath, newContent);
          return { ok: true };
        });
        if (!lock.granted) {
          return { content: [{ type: "text", text: `error: Timed out waiting for a write lock on ${normalizedPath}. Another sub-agent may be editing it.` }], isError: true };
        }
        if (!lock.value.ok) {
          return { content: [{ type: "text", text: lock.value.message }], isError: true };
        }
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
      const root = workspaceRoot ?? process.cwd();
      const normalizedPath = searchPath ? normalizeRwPath(searchPath, { workspaceRoot: root, sandboxPolicy: context.sandboxPolicy }) : root;

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
 *
 * Exported so that `interactive_shell_start` (whose /K command is equivalent
 * to an execute_shell one-shot) applies the same guard.
 */
export function isDestructiveCommand(command: string): boolean {
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
    // system shutdown / reboot: only when the command actually INVOKES one of
    // these as the program (start of the command or after a shell separator),
    // not merely mentions the word (e.g. `grep reboot .`,
    // `git log --grep=shutdown`). The previous unbounded \b match rejected
    // legitimate read-only commands that happened to contain the word.
    /(?:^|[;&|]\s*|\bsudo\s+|\bdoas\s+)(?:shutdown|reboot|halt|poweroff|init\s+0)(?:\s|$)/,
    // Windows: recursive directory removal targeting a drive root / wildcard
    /\brd\s+(?:\/s|\/q|\/s\s+\/q)\s+(?:"?[a-z]:[\\/]?|\*|%systemroot%)/i,
    /\brmdir\s+(?:\/s|\/q|\/s\s+\/q)\s+(?:"?[a-z]:[\\/]?|\*)/i,
    // Windows: recursive delete with wildcards (e.g. `del /f /s /q C:\*`)
    /\bdel\s+(?:[a-z]\s+)*\/s\s+(?:[a-z]\s+)*"?(?:[a-z]+:[\\/]*|\*)/i,
    // PowerShell: recursive force removal of a drive root or wildcard
    /\bremove-item\b[^|;&]*(?:-recurse|-force)[^|;&]*(?:"?[a-z]:[\\/]?\*?|\*)/i,
    // Windows: filesystem format / partition tools
    /\b(?:format|diskpart|bcdedit)\b\s/i,
    // Windows: registry hive deletion (whole keys, not single values)
    /\breg\s+delete\b[^|;&]*\/f\b/i,
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

/** Maximum number of concurrent background processes to prevent unbounded growth. */
const MAX_BACKGROUND_PROCESSES = 50;

/** 单个后台命令日志文件的大小上限（bytes）：超出后停止写入并记录截断标记，
 * 防止高输出进程（npm install 等）无限写满磁盘。 */
const BACKGROUND_LOG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Remove entries for child processes that have already exited. Returns the
 * number of entries removed. Useful before starting a new background process
 * to reclaim slots held by dead entries whose `close`/`error` events have
 * already fired but were not yet cleaned up.
 */
export function cleanupDeadBackgroundProcesses(): number {
  let cleaned = 0;
  for (const [id, child] of backgroundProcesses) {
    if (child.killed || child.exitCode !== null || child.signalCode !== null) {
      backgroundProcesses.delete(id);
      cleaned++;
    }
  }
  return cleaned;
}

/**
 * List all currently registered background processes. Useful for diagnostics
 * and cleanup. Does NOT include processes whose entries have already been
 * removed by the `close`/`error` listeners.
 */
export function listBackgroundProcesses(): { id: string; pid: number | undefined; killed: boolean }[] {
  const result: { id: string; pid: number | undefined; killed: boolean }[] = [];
  for (const [id, child] of backgroundProcesses) {
    result.push({ id, pid: child.pid, killed: child.killed });
  }
  return result;
}

/**
 * Kill a background shell process by id. Returns true if a process was found
 * and signalled, false otherwise. The caller may follow up with a SIGKILL if
 * the process does not exit within a grace period.
 */
/**
 * Kill a child process together with its whole process tree.
 *
 * On Windows, `child.kill()` only terminates the spawned shell (cmd.exe);
 * its children (e.g. `cmd /c node server.js` → node) survive as orphans, so
 * we use `taskkill /T /F` which walks the tree. On POSIX we spawn the shell
 * with `detached: true` so it leads its own process group, then signal the
 * whole group with `-pid` (falling back to the direct child kill).
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.pid == null || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      // Fire-and-forget: taskkill is async, but the close handler cleans up
      // the registry entry whenever the processes actually die.
      // (Options cast: `detached`/`stdio` pass through to the underlying
      // spawn at runtime but are not part of execFile's public option type.)
      const opts = { stdio: "ignore", windowsHide: true } as unknown as ExecFileOptionsWithStringEncoding;
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], opts)
        .on("error", () => { try { child.kill(signal); } catch { /* ignore */ } });
    } else {
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    }
  } catch {
    try { child.kill(signal); } catch { /* ignore */ }
  }
}

/** Grace period before a SIGTERM'd process is force-killed. */
export const KILL_ESCALATION_MS = 3000;

/**
 * Kill a background shell process by id. Returns true if a process was found
 * and signalled, false otherwise. Escalates to SIGKILL / `taskkill /F` if the
 * process is still alive after {@link KILL_ESCALATION_MS}, so "signal sent"
 * actually means the process is (being) terminated.
 */
export function killBackgroundShell(id: string): boolean {
  const child = backgroundProcesses.get(id);
  if (!child) return false;
  killProcessTree(child, "SIGTERM");
  // Escalate to force-kill if the tree survived the graceful signal.
  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      killProcessTree(child, "SIGKILL");
    }
  }, KILL_ESCALATION_MS);
  if (typeof escalation === "object" && escalation && "unref" in escalation) {
    escalation.unref();
  }
  return true;
}

/**
 * 终止全部后台 shell 进程并清空注册表。进程关闭时调用，防止子进程成为
 * 孤儿（Windows 上 cmd.exe 会残留）。
 */
export function killAllBackgroundShells(): number {
  let count = 0;
  for (const [id] of backgroundProcesses) {
    if (killBackgroundShell(id)) count++;
  }
  backgroundProcesses.clear();
  return count;
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
      const timeoutMs = clampTimeoutSeconds(timeout, 300) * 1000;

      try {
        if (background) {
          // Enforce a maximum number of concurrent background processes to
          // prevent unbounded Map growth and resource exhaustion.
          if (backgroundProcesses.size >= MAX_BACKGROUND_PROCESSES) {
            cleanupDeadBackgroundProcesses();
            if (backgroundProcesses.size >= MAX_BACKGROUND_PROCESSES) {
              return {
                content: [{ type: "text", text: `error: Maximum number of background processes (${MAX_BACKGROUND_PROCESSES}) reached. Use background_shell_list to inspect, or background_shell_kill to terminate unused processes.` }],
                isError: true,
              };
            }
          }
          // Collision-proof id: re-draw if the 8-char prefix is already live.
          let id = randomUUID().slice(0, 8);
          while (backgroundProcesses.has(id)) {
            id = randomUUID().slice(0, 8);
          }
          // Write logs inside the workspace so file_read_tool can access them
          // (normalizeRwPath rejects paths outside workspaceRoot).
          const logDir = join(workspaceRoot ?? process.cwd(), ".logs");
          await mkdir(logDir, { recursive: true });
          const logPath = join(logDir, `shell_bg_${id}.log`);
          // Actually redirect stdout/stderr to the log file — the previous
          // implementation computed logPath but never wired up the streams,
          // so the returned message was a lie and the output was lost.
          const logStream = createWriteStream(logPath, { flags: "w" });
          // A write failure (disk full, file deleted/locked externally) emits
          // an unhandled 'error' event which would crash the whole process.
          logStream.on("error", (err) => {
            console.error(`[execute_shell] background log stream error for ${logPath}:`, err);
          });
          // Keep the ChildProcess reference so it can be tracked and killed
          // via killBackgroundShell(id); the previous implementation discarded
          // it immediately, causing unbounded process leaks.
          //
          // NO execFile timeout here: background tasks are meant to be
          // long-running ("use background=true for long-running commands"),
          // and Node's timeout option would silently SIGTERM them after
          // timeoutMs. Lifecycle is managed explicitly via background_shell_kill
          // and the process-exit hook in killAllBackgroundShells().
          const child = execFile(
            process.platform === "win32" ? "cmd" : "/bin/sh",
            process.platform === "win32" ? ["/c", command] : ["-c", command],
            // Options cast: `detached` passes through to the underlying spawn
            // at runtime (needed for POSIX process-group kills) but is not
            // part of execFile's public option type.
            {
              cwd,
              env: { ...process.env, ...env },
              // POSIX: new process group so killProcessTree can signal the
              // whole tree; Windows uses taskkill /T instead.
              detached: process.platform !== "win32",
            } as unknown as ExecFileOptionsWithStringEncoding
          );
          // Cap total bytes written to the log file: a high-output process
          // would otherwise grow the file without bound. Once the cap is hit
          // we stop writing and record a truncation notice.
          let logWritten = 0;
          let logCapped = false;
          const writeLogChunk = (data: Buffer): void => {
            if (logCapped) return;
            if (logWritten + data.length > BACKGROUND_LOG_MAX_BYTES) {
              logCapped = true;
              logStream.end(`\n[log truncated at ${BACKGROUND_LOG_MAX_BYTES} bytes]\n`);
              return;
            }
            logWritten += data.length;
            logStream.write(data);
          };
          const endLogStream = (): void => {
            if (!logStream.writableEnded) logStream.end();
          };
          child.stdout?.on("data", writeLogChunk);
          child.stderr?.on("data", writeLogChunk);
          backgroundProcesses.set(id, child);
          child.on("close", () => {
            backgroundProcesses.delete(id);
            endLogStream();
          });
          child.on("error", () => {
            backgroundProcesses.delete(id);
            endLogStream();
          });
          return { content: [{ type: "text", text: `Background command started (id=${id}). Output is being written to ${logPath}. Use background_shell_kill with id="${id}" to terminate it.` }] };
        }

        // Manage the timeout ourselves instead of execFile's `timeout`
        // option: Node's built-in timeout only SIGTERMs the shell, leaving
        // the actual workload (cmd's children) running, and the resulting
        // close event looks like a normal exit. Our own timer kills the
        // whole tree and lets us report the timeout explicitly.
        const result = await new Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; aborted: boolean }>((resolvePromise) => {
          const child = execFile(
            process.platform === "win32" ? "cmd" : "/bin/sh",
            process.platform === "win32" ? ["/c", command] : ["-c", command],
            // Options cast: see the background-branch note on `detached`.
            {
              cwd, env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024,
              // POSIX: own process group so killProcessTree reaches children.
              detached: process.platform !== "win32",
            } as unknown as ExecFileOptionsWithStringEncoding
          );

          let timedOut = false;
          const killAndFlag = (why: "timeout" | "abort"): void => {
            timedOut = why === "timeout";
            killProcessTree(child, "SIGTERM");
            // Force-kill escalation if the tree ignores SIGTERM.
            const escalation = setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) {
                killProcessTree(child, "SIGKILL");
              }
            }, KILL_ESCALATION_MS);
            if (typeof escalation === "object" && escalation && "unref" in escalation) {
              escalation.unref();
            }
          };

          if (timeoutMs > 0) {
            const timer = setTimeout(() => killAndFlag("timeout"), timeoutMs);
            if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
            child.once("close", () => clearTimeout(timer));
          }

          // Kill child process when abort signal fires (e.g. tool timeout).
          if (abortSignal) {
            if (abortSignal.aborted) {
              killAndFlag("abort");
            } else {
              abortSignal.addEventListener("abort", () => killAndFlag("abort"), { once: true });
            }
          }

          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
          child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
          child.on("close", (code, signal) => {
            resolvePromise({ stdout, stderr, code, signal, timedOut, aborted: abortSignal?.aborted ?? false });
          });
          child.on("error", (_err) => {
            resolvePromise({ stdout, stderr, code: -1, signal: null, timedOut, aborted: abortSignal?.aborted ?? false });
          });
        });

        if (result.aborted) {
          return { content: [{ type: "text", text: `error: Command was aborted (timeout or cancellation).\n${result.stdout || ""}` }], isError: true };
        }

        let output = "";
        if (result.stdout) output += result.stdout;
        if (result.stderr) output += (output ? "\n" : "") + `[stderr]\n${result.stderr}`;
        if (result.timedOut) {
          output += `\n[command timed out after ${Math.round(timeoutMs / 1000)} seconds and was terminated]`;
          return { content: [{ type: "text", text: output || "(no output)" }], isError: true };
        }
        // Signal-terminated (not by us): e.g. OOM killer or external kill —
        // report faithfully instead of pretending exit code 0.
        if (result.signal) {
          output += `\n[command terminated by signal ${result.signal}]`;
          return { content: [{ type: "text", text: output || "(no output)" }], isError: true };
        }
        if (result.code !== 0) output += `\n[exit code: ${result.code}]`;

        return { content: [{ type: "text", text: output || "(no output)" }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `error: Shell execution failed: ${msg}` }], isError: true };
      }
    },
  });
}

// ── Background Shell Process Tools ──

export function createBackgroundShellListTool(): FunctionTool<ComputerToolContext> {
  return createFunctionTool<ComputerToolContext>({
    name: "background_shell_list",
    description:
      "List background shell processes started by execute_shell with background=true. " +
      "Returns each process's id, pid, and status. Run this before starting new background " +
      "processes or when the maximum process limit is reached.",
    parameters: { type: "object", properties: {}, required: [] },
    active: true,
    handler: async (_ctx: unknown, ..._args: unknown[]): Promise<CallToolResult> => {
      cleanupDeadBackgroundProcesses();
      const list = listBackgroundProcesses();
      if (list.length === 0) {
        return { content: [{ type: "text", text: "No background shell processes." }] };
      }
      const lines = list.map((p) => `  ${p.id}  pid=${p.pid ?? "-"}  ${p.killed ? "killed(signalled)" : "running"}`);
      return { content: [{ type: "text", text: `Background shell processes (${list.length}):\n${lines.join("\n")}` }] };
    },
  });
}

export function createBackgroundShellKillTool(): FunctionTool<ComputerToolContext> {
  return createFunctionTool<ComputerToolContext>({
    name: "background_shell_kill",
    description:
      "Kill a background shell process by the id returned by execute_shell (background=true). " +
      "Sends SIGTERM. If the process does not exit, it can be killed via execute_shell (taskkill/kill -9).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The background process id returned by execute_shell." },
      },
      required: ["id"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const id = String(args[0] ?? "");
      const ok = killBackgroundShell(id);
      if (!ok) {
        return {
          content: [{ type: "text", text: `error: Background process '${id}' not found. Use background_shell_list to inspect active processes.` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: `Termination signal sent to background process ${id}.` }] };
    },
  });
}

// ── Code execution helpers (shared by execute_python / execute_node) ──

interface CodeProcessResult {
  stdout: string;
  stderr: string;
  /** Exit code, or null when the process was signal-terminated. */
  code: number | null;
  /** Signal that terminated the process, if any. */
  signal: NodeJS.Signals | null;
  /** True when our own timeout fired and we killed the process tree. */
  timedOut: boolean;
  /** True when the caller's abort signal fired. */
  aborted: boolean;
}

/**
 * Run a code-execution command, trying each candidate launcher in order (e.g.
 * `python3` then `python` on Windows) when the previous one fails to spawn.
 *
 * We deliberately do NOT use `execFile`'s `timeout` option:
 *   1. it only SIGTERMs the direct child, leaving grandchildren as orphans; and
 *   2. without a callback it does not throw on timeout — the `close` event
 *      simply reports `code === null`, which the previous code misread as
 *      exit 0, so a timed-out run was reported to the model as *success* with
 *      partial output and no timeout notice.
 * Here we manage the timer ourselves, kill the whole process tree, and record
 * `timedOut`/`signal` so the caller can report the outcome honestly.
 */
function runCodeProcess(
  candidates: Array<{ command: string; args: string[] }>,
  options: { cwd: string; abortSignal?: AbortSignal; timeoutMs: number },
): Promise<CodeProcessResult> {
  const { cwd, abortSignal, timeoutMs } = options;

  return new Promise<CodeProcessResult>((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let current: ChildProcess | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const resolveOnce = (value: CodeProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(value);
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string): void => {
      resolveOnce({ stdout, stderr, code, signal, timedOut, aborted });
    };

    const killAndFlag = (why: "timeout" | "abort"): void => {
      if (why === "timeout") timedOut = true;
      else aborted = true;
      if (!current) return;
      killProcessTree(current, "SIGTERM");
      const escalation = setTimeout(() => {
        if (current && current.exitCode === null && current.signalCode === null) {
          killProcessTree(current, "SIGKILL");
        }
      }, KILL_ESCALATION_MS);
      if (typeof escalation === "object" && escalation && "unref" in escalation) {
        escalation.unref();
      }
    };

    const trySpawn = (index: number): void => {
      if (settled) return;
      const { command, args } = candidates[index];
      let stdout = "";
      let stderr = "";

      const child = execFile(command, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
      current = child;

      if (abortSignal) {
        if (abortSignal.aborted) {
          killProcessTree(child);
        } else {
          // Named handler so it can be removed when this candidate fails and we
          // fall back to the next launcher. The previous anonymous listener was
          // never removed, so an abort could fire against a stale `current` and
          // each fallback leaked a listener on the long-lived signal.
          const onAbort = (): void => {
            abortSignal.removeEventListener("abort", onAbort);
            killAndFlag("abort");
          };
          abortSignal.addEventListener("abort", onAbort, { once: true });
          child.once("error", () => abortSignal.removeEventListener("abort", onAbort));
          child.once("close", () => abortSignal.removeEventListener("abort", onAbort));
        }
      }

      child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
      child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

      child.on("close", (code, signal) => finish(code, signal, stdout, stderr));
      child.on("error", (err) => {
        // Launcher not found: fall back to the next candidate (e.g. `python`
        // after `python3` on Windows). Otherwise surface the spawn error.
        if (index + 1 < candidates.length) {
          trySpawn(index + 1);
        } else {
          finish(-1, null, "", err.message);
        }
      });
    };

    timer = setTimeout(() => killAndFlag("timeout"), timeoutMs);
    if (typeof timer === "object" && timer && "unref" in timer) timer.unref();

    trySpawn(0);
  });
}

/** Format a code-process result for the model, with honest timeout/exit info. */
function formatCodeOutput(result: CodeProcessResult): string {
  let output = "";
  if (result.stdout) output += result.stdout;
  if (result.stderr) output += (output ? "\n" : "") + `[stderr]\n${result.stderr}`;
  if (result.timedOut) {
    output += `\n[execution timed out and was terminated]`;
  } else if (result.aborted) {
    output += `\n[execution aborted]`;
  } else if (result.signal) {
    output += `\n[execution terminated by signal ${result.signal}]`;
  } else if (result.code !== 0) {
    output += `\n[exit code: ${result.code}]`;
  }
  return output || "(no output)";
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
      const timeoutMs = clampTimeoutSeconds(timeout, 30) * 1000;
      const cwd = workspaceRoot ?? process.cwd();
      const abortSignal = getAbortSignal(_ctx);

      try {
        // Try python3, then python (Windows installs commonly expose only the
        // latter). runCodeProcess handles the fallback on spawn failure.
        const result = await runCodeProcess(
          [
            { command: "python3", args: ["-c", code] },
            { command: "python", args: ["-c", code] },
          ],
          { cwd, abortSignal, timeoutMs },
        );

        if (silent) {
          return { content: [{ type: "text", text: "Code executed successfully (silent mode)." }] };
        }

        return {
          content: [{ type: "text", text: formatCodeOutput(result) }],
          ...(result.timedOut || result.code !== 0 ? { isError: true } : {}),
        };
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
      const root = workspaceRoot ?? process.cwd();
      const normalizedPath = dirPath ? normalizeRwPath(dirPath, { workspaceRoot: root, sandboxPolicy: context.sandboxPolicy }) : root;

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

      const normalizedPath = normalizeRwPath(path, { workspaceRoot, sandboxPolicy: context.sandboxPolicy });

      try {
        if (!existsSync(normalizedPath)) {
          return { content: [{ type: "text", text: `error: File not found: ${normalizedPath}` }], isError: true };
        }

        const s = await stat(normalizedPath);
        if (s.isDirectory()) {
          return { content: [{ type: "text", text: `error: Path is a directory, not a file. Use shell commands for directory removal.` }], isError: true };
        }

        const lock = await withFileLock(_ctx, normalizedPath, "write", async () => {
          await unlink(normalizedPath);
        });
        if (!lock.granted) {
          return { content: [{ type: "text", text: `error: Timed out waiting for a write lock on ${normalizedPath}. Another sub-agent may be using it.` }], isError: true };
        }
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

      const normalizedSource = normalizeRwPath(source, { workspaceRoot, sandboxPolicy: context.sandboxPolicy });
      const normalizedDest = normalizeRwPath(destination, { workspaceRoot, sandboxPolicy: context.sandboxPolicy });

      try {
        if (!existsSync(normalizedSource)) {
          return { content: [{ type: "text", text: `error: Source not found: ${normalizedSource}` }], isError: true };
        }

        if (existsSync(normalizedDest)) {
          return { content: [{ type: "text", text: `error: Destination already exists: ${normalizedDest}` }], isError: true };
        }

        // Lock both source and destination (sorted internally) so a move
        // cannot interleave with an edit/write of either path.
        const lock = await withFileLocks(_ctx, [normalizedSource, normalizedDest], async () => {
          // Ensure destination parent directory exists
          await mkdir(dirname(normalizedDest), { recursive: true });
          await rename(normalizedSource, normalizedDest);
        });
        if (!lock.granted) {
          return { content: [{ type: "text", text: `error: Timed out waiting for a lock on ${normalizedSource} or ${normalizedDest}. Another sub-agent may be using it.` }], isError: true };
        }

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
      const timeoutMs = clampTimeoutSeconds(timeout, 30) * 1000;
      const cwd = workspaceRoot ?? process.cwd();
      const abortSignal = getAbortSignal(_ctx);

      try {
        const result = await runCodeProcess(
          [{ command: "node", args: ["-e", code] }],
          { cwd, abortSignal, timeoutMs },
        );

        if (silent) {
          return { content: [{ type: "text", text: "Code executed successfully (silent mode)." }] };
        }

        return {
          content: [{ type: "text", text: formatCodeOutput(result) }],
          ...(result.timedOut || result.code !== 0 ? { isError: true } : {}),
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
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
    createBackgroundShellListTool(),
    createBackgroundShellKillTool(),
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
        // Format: path:line:content (match) or path-line-content (context).
        // Lazy `.+?` so a content line like `foo:bar:12:baz` keeps the
        // line number correctly anchored to the last `:` separator.
        const m = line.match(/^(.+?)([:-])(\d+)\2(.*)$/);
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
 *
 * Exported so that `interactive_shell_wait_for_pattern` (which runs model
 * supplied regexes against output buffers) applies the same guard as grep.
 */
export function isPotentialReDoS(pattern: string): boolean {
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
/**
 * Maximum file size (bytes) the pure-JS grep fallback will read into memory.
 * Files larger than this are skipped: reading a multi-GB file (binary, video,
 * dataset) in full just to run a line regex causes huge memory spikes.
 * ripgrep, when available, streams and has no such limit.
 */
const GREP_MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB

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
          // Skip oversized files before reading them into memory.
          const fileStat = await stat(fullPath);
          if (fileStat.size > GREP_MAX_FILE_BYTES) continue;

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
        const fileStat = await stat(searchPath);
        if (fileStat.size > GREP_MAX_FILE_BYTES) {
          return [`error: File too large to search (max ${GREP_MAX_FILE_BYTES} bytes).`];
        }
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
