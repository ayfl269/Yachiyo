/**
 * Interactive shell session tools.
 *
 * Provides a set of tools that allow an agent to maintain a long-lived,
 * bidirectional shell session: start a process, send input to its stdin,
 * read accumulated stdout/stderr, list active sessions, and close them.
 *
 * Unlike `execute_shell` (one-shot, fire-and-forget), these tools keep the
 * ChildProcess alive between tool calls so that interactive programs (REPLs,
 * ssh clients, mysql cli, etc.) can be driven step by step.
 *
 * NOTE: This uses `child_process.spawn` with piped stdio — NOT a true PTY.
 * Programs that strictly require a TTY (e.g. those calling `isatty()`) may
 * disable their prompt or colors. For full terminal emulation, a `node-pty`
 * integration would be needed; this implementation deliberately avoids native
 * dependencies while covering the vast majority of interactive use-cases.
 */

import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { createFunctionTool, type FunctionTool } from "./tool.js";
import type { CallToolResult, ContextWrapper } from "./types.js";
import type { ComputerToolContext } from "./computer-tools.js";

// ── Session registry ──

interface InteractiveSession {
  id: string;
  child: ChildProcess;
  /** All stdout accumulated since the session started (never cleared). */
  stdoutAll: string;
  /** All stderr accumulated since the session started (never cleared). */
  stderrAll: string;
  /** stdout accumulated since the last `read` call (cleared on read). */
  stdoutSinceRead: string;
  /** stderr accumulated since the last `read` call (cleared on read). */
  stderrSinceRead: string;
  createdAt: number;
  lastActivityAt: number;
  closed: boolean;
  exitCode: number | null;
  signalCode: string | null;
  command: string;
}

const sessions = new Map<string, InteractiveSession>();

/** Maximum number of concurrent interactive sessions. */
const MAX_SESSIONS = 20;

/** Per-buffer size cap to prevent unbounded memory growth (5 MB). */
const MAX_BUFFER_SIZE = 5 * 1024 * 1024;

/**
 * Truncate a buffer string to the last `maxSize` characters, keeping recent
 * output (which is almost always what the caller wants) and prepending a
 * notice when truncation occurred.
 */
function clampBuffer(buf: string, maxSize: number): string {
  if (buf.length <= maxSize) return buf;
  const dropped = buf.length - maxSize;
  return `[… ${dropped} earlier chars truncated …]\n` + buf.slice(-maxSize);
}

/**
 * Remove entries for sessions whose child process has exited. Returns the
 * number of entries removed. Called before starting a new session to reclaim
 * slots held by dead sessions.
 */
export function cleanupDeadSessions(): number {
  let cleaned = 0;
  for (const [id, s] of sessions) {
    if (s.closed || s.child.killed || s.exitCode !== null || s.signalCode !== null) {
      sessions.delete(id);
      cleaned++;
    }
  }
  return cleaned;
}

/**
 * List all currently registered interactive sessions.
 */
export function listInteractiveSessions(): {
  id: string;
  pid: number | undefined;
  command: string;
  closed: boolean;
  exitCode: number | null;
  createdAt: number;
  lastActivityAt: number;
}[] {
  const result: {
    id: string;
    pid: number | undefined;
    command: string;
    closed: boolean;
    exitCode: number | null;
    createdAt: number;
    lastActivityAt: number;
  }[] = [];
  for (const [id, s] of sessions) {
    result.push({
      id,
      pid: s.child.pid,
      command: s.command,
      closed: s.closed,
      exitCode: s.exitCode,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
    });
  }
  return result;
}

/**
 * Start a new interactive shell session.
 *
 * Returns the session id, or throws if the maximum number of concurrent
 * sessions has been reached.
 */
export function interactiveShellStart(
  command: string | undefined,
  options: {
    cwd?: string;
    env?: Record<string, string>;
    workspaceRoot?: string;
  } = {}
): string {
  if (sessions.size >= MAX_SESSIONS) {
    cleanupDeadSessions();
    if (sessions.size >= MAX_SESSIONS) {
      throw new Error(
        `Maximum number of interactive sessions (${MAX_SESSIONS}) reached. ` +
          `Use interactiveShellClose to terminate unused sessions, or interactiveShellList to inspect.`
      );
    }
  }

  const cwd = options.cwd ?? options.workspaceRoot ?? process.cwd();
  const isWindows = process.platform === "win32";
  const exe = isWindows ? "cmd.exe" : "/bin/sh";
  const args = isWindows ? ["/Q"] : ["-i"]; // /Q disables echo on cmd; -i is ignored harmlessly by sh

  // If a specific command is provided, we still launch the shell and let the
  // caller send it via stdin. This keeps the session interactive. However, if
  // a command is given we pass it with -c so non-interactive one-shots work too.
  let finalExe = exe;
  let finalArgs = args;
  if (command && command.trim()) {
    if (isWindows) {
      finalArgs = ["/Q", "/K", command];
    } else {
      finalArgs = ["-c", command];
    }
  }

  const child = spawn(finalExe, finalArgs, {
    cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: false,
  });

  const id = randomUUID().slice(0, 8);
  const session: InteractiveSession = {
    id,
    child,
    stdoutAll: "",
    stderrAll: "",
    stdoutSinceRead: "",
    stderrSinceRead: "",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    closed: false,
    exitCode: null,
    signalCode: null,
    command: command || exe,
  };

  child.stdout?.on("data", (data: Buffer) => {
    const text = data.toString();
    session.stdoutAll = clampBuffer(session.stdoutAll + text, MAX_BUFFER_SIZE);
    session.stdoutSinceRead += text;
    session.lastActivityAt = Date.now();
  });

  child.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    session.stderrAll = clampBuffer(session.stderrAll + text, MAX_BUFFER_SIZE);
    session.stderrSinceRead += text;
    session.lastActivityAt = Date.now();
  });

  child.on("exit", (code, signal) => {
    session.exitCode = code;
    session.signalCode = signal;
  });

  child.on("error", (err) => {
    session.stderrAll = clampBuffer(session.stderrAll + `\n[spawn error: ${err.message}]\n`, MAX_BUFFER_SIZE);
    session.stderrSinceRead += `\n[spawn error: ${err.message}]\n`;
    session.closed = true;
  });

  sessions.set(id, session);
  return id;
}

/**
 * Send input to an interactive session's stdin.
 *
 * Returns true if the input was written, false if the session was not found
 * or its stdin is no longer writable (process exited).
 */
export function interactiveShellSend(
  id: string,
  input: string,
  options: { addNewline?: boolean } = {}
): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.closed || session.exitCode !== null) return false;

  const stdin = session.child.stdin;
  if (!stdin || stdin.destroyed) return false;

  const text = options.addNewline === false ? input : input + "\n";
  session.lastActivityAt = Date.now();
  return stdin.write(text);
}

/**
 * Read output from an interactive session.
 *
 * Waits up to `waitMs` for new output, then returns whatever has accumulated
 * since the previous read (or since session start on the first read). If
 * `clear` is false, the "since-read" buffer is not cleared so the same output
 * can be read again.
 *
 * Returns null if the session was not found.
 */
export async function interactiveShellRead(
  id: string,
  options: { waitMs?: number; clear?: boolean } = {}
): Promise<{ stdout: string; stderr: string; closed: boolean; exitCode: number | null } | null> {
  const session = sessions.get(id);
  if (!session) return null;

  const waitMs = options.waitMs ?? 500;
  const clear = options.clear !== false; // default true

  // If there's nothing to read yet, wait a bit for output to arrive.
  if (session.stdoutSinceRead.length === 0 && session.stderrSinceRead.length === 0 && session.exitCode === null) {
    const deadline = Date.now() + waitMs;
    // Poll every 20ms — simple and dependency-free.
    while (
      Date.now() < deadline &&
      session.stdoutSinceRead.length === 0 &&
      session.stderrSinceRead.length === 0 &&
      session.exitCode === null
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  const result = {
    stdout: session.stdoutSinceRead,
    stderr: session.stderrSinceRead,
    closed: session.closed || session.exitCode !== null,
    exitCode: session.exitCode,
  };

  if (clear) {
    session.stdoutSinceRead = "";
    session.stderrSinceRead = "";
  }

  return result;
}

/**
 * Close an interactive session. Sends SIGTERM (or equivalent) to the child
 * process and removes it from the registry.
 *
 * Returns true if a session was found and signalled, false otherwise.
 */
export function interactiveShellClose(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  try {
    if (!session.closed && session.exitCode === null) {
      // Close stdin first so interactive programs that read until EOF can exit
      // gracefully before we escalate to SIGTERM.
      session.child.stdin?.end();
      session.child.stdin?.destroy();
      session.child.kill("SIGTERM");
    }
  } catch {
    /* ignore — process may have already exited */
  }
  session.closed = true;
  // Remove from registry after a short delay so a final read can still see
  // any remaining buffered output. For simplicity in the synchronous case we
  // remove immediately; callers who need the final output should read before
  // closing.
  sessions.delete(id);
  return true;
}

/**
 * Close all interactive sessions. Useful for cleanup on shutdown.
 */
export function closeAllInteractiveSessions(): number {
  let count = 0;
  for (const id of sessions.keys()) {
    if (interactiveShellClose(id)) count++;
  }
  return count;
}

// ── Tool factories ──

function getToolContext(_ctx: unknown): ComputerToolContext {
  const wrapper = _ctx as ContextWrapper<ComputerToolContext> | undefined;
  return wrapper?.context ?? ({} as ComputerToolContext);
}

/**
 * Extract the tool-level AbortSignal from the run context, if available.
 * Mirrors the same helper in computer-tools.ts.
 */
function getAbortSignal(_ctx: unknown): AbortSignal | undefined {
  const wrapper = _ctx as ContextWrapper | undefined;
  return wrapper?._toolAbortController?.signal;
}

export function createInteractiveShellStartTool(
  workspaceRoot?: string
): FunctionTool<ComputerToolContext> {
  return createFunctionTool<ComputerToolContext>({
    name: "interactive_shell_start",
    description:
      "Start a long-lived interactive shell session. Returns a session id. " +
      "Use interactive_shell_send to write to stdin and interactive_shell_read to collect stdout/stderr. " +
      "Unlike execute_shell, the process stays alive between calls so interactive programs (REPLs, ssh, mysql cli) can be driven step by step.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Optional initial command to run. If omitted, a bare shell (cmd.exe on Windows, /bin/sh on Unix) is started. If provided, the shell runs this command and stays alive for further input.",
        },
        cwd: {
          type: "string",
          description: "Working directory. Defaults to workspace root.",
        },
        env: {
          type: "object",
          description: "Optional environment variables to merge into the process environment.",
          additionalProperties: { type: "string" },
          default: {},
        },
      },
      required: [],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const command = args[0] != null ? String(args[0]) : undefined;
      const cwd = args[1] != null ? String(args[1]) : undefined;
      const env = (args[2] as Record<string, string>) ?? undefined;
      const context = getToolContext(_ctx);
      const abortSignal = getAbortSignal(_ctx);
      const root = workspaceRoot ?? context.providerSettings?.computer_use_runtime === "sandbox" ? workspaceRoot : (cwd ?? workspaceRoot);

      try {
        const id = interactiveShellStart(command, {
          cwd: cwd ?? root,
          env,
          workspaceRoot,
        });

        // If the tool call is aborted, clean up the session.
        if (abortSignal) {
          if (abortSignal.aborted) {
            interactiveShellClose(id);
            return {
              content: [{ type: "text", text: "error: Session was aborted before it could start." }],
              isError: true,
            };
          }
          abortSignal.addEventListener(
            "abort",
            () => { interactiveShellClose(id); },
            { once: true }
          );
        }

        return {
          content: [
            {
              type: "text",
              text: `Interactive session started (id=${id}). Use interactive_shell_send with this id to write input, interactive_shell_read to collect output, and interactive_shell_close to terminate.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `error: Failed to start interactive session: ${e}` }],
          isError: true,
        };
      }
    },
  });
}

export function createInteractiveShellSendTool(): FunctionTool<ComputerToolContext> {
  return createFunctionTool<ComputerToolContext>({
    name: "interactive_shell_send",
    description:
      "Send input to an interactive shell session's stdin. By default a trailing newline is appended. " +
      "Returns success/failure (the session may have exited).",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The session id returned by interactive_shell_start." },
        input: { type: "string", description: "The text to write to the session's stdin." },
        add_newline: {
          type: "boolean",
          description: "Whether to append a newline after the input. Default: true.",
          default: true,
        },
      },
      required: ["session_id", "input"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const sessionId = String(args[0] ?? "");
      const input = String(args[1] ?? "");
      const addNewline = args[2] !== false;

      const ok = interactiveShellSend(sessionId, input, { addNewline });
      if (!ok) {
        return {
          content: [
            {
              type: "text",
              text: `error: Could not send input to session '${sessionId}'. The session may not exist, may have exited, or its stdin is no longer writable. Use interactive_shell_list to inspect.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Input sent to session ${sessionId} (${input.length} chars).` }],
      };
    },
  });
}

export function createInteractiveShellReadTool(): FunctionTool<ComputerToolContext> {
  return createFunctionTool<ComputerToolContext>({
    name: "interactive_shell_read",
    description:
      "Read output (stdout + stderr) from an interactive shell session that has accumulated since the previous read. " +
      "If no output is available, waits up to wait_ms for output to arrive. The since-read buffer is cleared after reading by default.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The session id returned by interactive_shell_start." },
        wait_ms: {
          type: "integer",
          description: "How long to wait for output if none is immediately available, in milliseconds. Default: 500.",
          default: 500,
          minimum: 0,
          maximum: 30000,
        },
        clear: {
          type: "boolean",
          description: "Whether to clear the since-read buffer after reading. Default: true. Set to false to peek without consuming.",
          default: true,
        },
      },
      required: ["session_id"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const sessionId = String(args[0] ?? "");
      const waitMs = args[1] != null ? Number(args[1]) : undefined;
      const clear = args[2] !== false;

      const result = await interactiveShellRead(sessionId, { waitMs, clear });
      if (!result) {
        return {
          content: [
            { type: "text", text: `error: Session '${sessionId}' not found. Use interactive_shell_list to see active sessions.` },
          ],
          isError: true,
        };
      }

      let output = "";
      if (result.stdout) output += result.stdout;
      if (result.stderr) output += (output ? "\n" : "") + `[stderr]\n${result.stderr}`;
      if (result.closed) {
        output += `\n[session closed`;
        if (result.exitCode !== null) output += `, exit code: ${result.exitCode}`;
        output += `]`;
      }

      return {
        content: [{ type: "text", text: output || "(no new output)" }],
      };
    },
  });
}

export function createInteractiveShellListTool(): FunctionTool<ComputerToolContext> {
  return createFunctionTool<ComputerToolContext>({
    name: "interactive_shell_list",
    description: "List all active interactive shell sessions with their status, pid, and command.",
    parameters: { type: "object", properties: {}, required: [] },
    active: true,
    handler: async (_ctx: unknown, ..._args: unknown[]): Promise<CallToolResult> => {
      const list = listInteractiveSessions();
      if (list.length === 0) {
        return { content: [{ type: "text", text: "No active interactive sessions." }] };
      }
      const lines = list.map((s) => {
        const status = s.closed ? "closed" : s.exitCode !== null ? `exited(${s.exitCode})` : "running";
        const age = Math.round((Date.now() - s.createdAt) / 1000);
        return `  ${s.id}  pid=${s.pid ?? "-"}  status=${status}  age=${age}s  cmd=${s.command}`;
      });
      return { content: [{ type: "text", text: `Interactive sessions (${list.length}):\n${lines.join("\n")}` }] };
    },
  });
}

export function createInteractiveShellCloseTool(): FunctionTool<ComputerToolContext> {
  return createFunctionTool<ComputerToolContext>({
    name: "interactive_shell_close",
    description: "Close an interactive shell session. Sends SIGTERM to the child process and removes it from the registry.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The session id returned by interactive_shell_start." },
      },
      required: ["session_id"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const sessionId = String(args[0] ?? "");
      const ok = interactiveShellClose(sessionId);
      if (!ok) {
        return {
          content: [{ type: "text", text: `error: Session '${sessionId}' not found.` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: `Session ${sessionId} closed.` }] };
    },
  });
}

/**
 * Get the full set of interactive shell tools.
 */
export function getInteractiveShellTools(
  workspaceRoot?: string
): FunctionTool<ComputerToolContext>[] {
  return [
    createInteractiveShellStartTool(workspaceRoot),
    createInteractiveShellSendTool(),
    createInteractiveShellReadTool(),
    createInteractiveShellListTool(),
    createInteractiveShellCloseTool(),
  ];
}
