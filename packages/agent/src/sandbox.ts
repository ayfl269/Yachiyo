/**
 * Sandbox configuration and policy for sub-agents.
 *
 * Tool-level sandbox: tool whitelist/denylist, path restrictions, and
 * network domain restrictions enforced by the tool executor and the
 * computer/web tools. Process-level isolation (containers, cgroups, job
 * objects) is intentionally NOT part of this module — if hard isolation is
 * ever required, run the agent runtime itself inside a container rather
 * than reimplementing OS-level sandboxing here.
 */

import { resolve, sep } from "path";

// ── Tool-level Sandbox Policy ──

/**
 * Defines what a sub-agent is allowed to do at the tool level.
 */
export interface SandboxPolicy {
  /** Tool names the sub-agent is allowed to use. If undefined, all tools are allowed. */
  allowedTools?: string[];

  /** Tool names explicitly denied. Takes precedence over allowedTools. */
  deniedTools?: string[];

  /** Path prefixes the sub-agent is allowed to read/write. If undefined, all paths allowed. */
  allowedPaths?: string[];

  /** Path prefixes the sub-agent is NOT allowed to access. Takes precedence over allowedPaths. */
  deniedPaths?: string[];

  /** Network domains the sub-agent is allowed to access. If undefined, all domains allowed. */
  allowedDomains?: string[];

  /** Whether the sub-agent can execute shell commands. Default: false for dynamic sub-agents. */
  allowShell?: boolean;

  /** Whether the sub-agent can execute code (python/node). Default: false for dynamic sub-agents. */
  allowCodeExecution?: boolean;

  /** Whether the sub-agent can delete files. Default: false for dynamic sub-agents. */
  allowFileDeletion?: boolean;

  /** Maximum number of tool calls the sub-agent can make. Default: 30. */
  maxToolCalls?: number;

  /** Maximum total execution time in seconds. Default: 120. */
  maxExecutionTimeSeconds?: number;
}

/**
 * Default sandbox policy for dynamically created sub-agents.
 * Restrictive by default.
 */
export const DEFAULT_DYNAMIC_SUBAGENT_POLICY: SandboxPolicy = {
  deniedTools: [
    "execute_shell",
    "execute_python",
    "execute_node",
    "file_delete_tool",
    "interactive_shell_start",
    "interactive_shell_send",
    "interactive_shell_read",
    "interactive_shell_list",
    "interactive_shell_close",
    // wait 系列：与 start/send/read/list/close 同属 shell 会话工具族，
    // wait_for_pattern 还能对共享注册表（模块级 Map）中已有会话的输出做
    // 正则扫描——缺了它们 allowShell=false 就形同虚设。
    "interactive_shell_wait",
    "interactive_shell_wait_for_pattern",
    // execute_shell 后台进程管理工具（可终止/枚举任意后台 shell）
    "background_shell_kill",
    "background_shell_list",
    // proxy_manage 会重定向整个进程的出站流量（fetch + Playwright），
    // 子代理改代理 = 劫持后续所有网络请求。
    "proxy_manage",
    // browser_execute_script 在页面上下文执行任意 JS（含 fetch），可绕过
    // allowedDomains 域名策略；browser_upload 可把任意本地路径的文件上传到
    // 远端站点。两者对受限子代理都是沙箱逃逸面。
    "browser_execute_script",
    "browser_upload",
  ],
  allowShell: false,
  allowCodeExecution: false,
  allowFileDeletion: false,
  maxToolCalls: 30,
  maxExecutionTimeSeconds: 120,
};

/**
 * Default sandbox policy for pre-configured sub-agents.
 * Less restrictive — trusts the developer's configuration.
 */
export const DEFAULT_PRECONFIGURED_SUBAGENT_POLICY: SandboxPolicy = {
  maxToolCalls: 50,
  maxExecutionTimeSeconds: 300,
};

/**
 * Intersect two sandbox policies, producing a policy at least as strict as
 * each input. Used when a sub-agent performs a further handoff: without this
 * a restricted dynamic sub-agent could escalate privileges by transferring
 * to an unrestricted pre-configured agent.
 *
 * Rules (undefined = "no restriction" for every field):
 * - allowedTools: intersection (if both defined); deniedTools: union
 * - allowedPaths/allowedDomains: intersection; deniedPaths: union
 * - allow* flags: AND
 * - maxToolCalls / maxExecutionTimeSeconds: min of defined values
 */
export function intersectSandboxPolicies(a: SandboxPolicy, b: SandboxPolicy): SandboxPolicy {
  const intersectStrings = (x?: string[], y?: string[]): string[] | undefined => {
    if (x === undefined) return y;
    if (y === undefined) return x;
    const ySet = new Set(y);
    return x.filter((item) => ySet.has(item));
  };
  const unionStrings = (x?: string[], y?: string[]): string[] | undefined => {
    if (x === undefined) return y;
    if (y === undefined) return x;
    return [...new Set([...x, ...y])];
  };
  const minOpt = (x?: number, y?: number): number | undefined => {
    if (x === undefined) return y;
    if (y === undefined) return x;
    return Math.min(x, y);
  };

  return {
    allowedTools: intersectStrings(a.allowedTools, b.allowedTools),
    deniedTools: unionStrings(a.deniedTools, b.deniedTools),
    allowedPaths: intersectStrings(a.allowedPaths, b.allowedPaths),
    deniedPaths: unionStrings(a.deniedPaths, b.deniedPaths),
    allowedDomains: intersectStrings(a.allowedDomains, b.allowedDomains),
    allowShell: (a.allowShell ?? true) && (b.allowShell ?? true),
    allowCodeExecution: (a.allowCodeExecution ?? true) && (b.allowCodeExecution ?? true),
    allowFileDeletion: (a.allowFileDeletion ?? true) && (b.allowFileDeletion ?? true),
    maxToolCalls: minOpt(a.maxToolCalls, b.maxToolCalls),
    maxExecutionTimeSeconds: minOpt(a.maxExecutionTimeSeconds, b.maxExecutionTimeSeconds),
  };
}

/** Structural view of a sub-agent target used to resolve its sandbox policy. */
export interface SubAgentPolicyTarget {
  sandboxPolicy?: SandboxPolicy;
  dynamic?: boolean;
}

/**
 * Resolve the effective sandbox policy for a handoff target by intersecting
 * the target's own policy (or its dynamic/pre-configured default) with the
 * parent run's policy. Single source of truth shared by the tool executor
 * (which enforces it) and the agent runner (which uses it to size the
 * per-tool-call timeout so the sub-agent's budget is actually reachable).
 */
export function resolveEffectiveSubAgentPolicy(
  target: SubAgentPolicyTarget,
  parentPolicy?: SandboxPolicy
): SandboxPolicy {
  const targetPolicy: SandboxPolicy = target.sandboxPolicy
    ?? (target.dynamic ? DEFAULT_DYNAMIC_SUBAGENT_POLICY : DEFAULT_PRECONFIGURED_SUBAGENT_POLICY);
  return parentPolicy ? intersectSandboxPolicies(parentPolicy, targetPolicy) : targetPolicy;
}

/**
 * Effective execution-time budget (seconds) for a handoff target. Used to
 * size the parent's per-tool-call timeout so a pre-configured sub-agent's
 * 300s budget is not silently clipped by the parent's shorter default
 * (e.g. 120s) tool-call timeout.
 */
export function resolveSubAgentExecutionBudgetSeconds(
  target: SubAgentPolicyTarget,
  parentPolicy?: SandboxPolicy
): number {
  return resolveEffectiveSubAgentPolicy(target, parentPolicy).maxExecutionTimeSeconds ?? 120;
}

/**
 * Apply a sandbox policy to a tool set, returning only the allowed tools.
 */
export function applySandboxPolicyToToolSet(
  tools: import("./tool.js").FunctionTool[],
  policy: SandboxPolicy
): import("./tool.js").FunctionTool[] {
  const denied = new Set(policy.deniedTools ?? []);

  // Add implicit denials based on policy flags
  if (!policy.allowShell) {
    denied.add("execute_shell");
    denied.add("interactive_shell_start");
    denied.add("interactive_shell_send");
    denied.add("interactive_shell_read");
    denied.add("interactive_shell_list");
    denied.add("interactive_shell_close");
    // wait/wait_for_pattern 与后台进程管理工具同属 shell 会话工具族
    denied.add("interactive_shell_wait");
    denied.add("interactive_shell_wait_for_pattern");
    denied.add("background_shell_kill");
    denied.add("background_shell_list");
  }
  if (!policy.allowCodeExecution) {
    denied.add("execute_python");
    denied.add("execute_node");
  }
  if (!policy.allowFileDeletion) {
    denied.add("file_delete_tool");
  }

  let filtered = tools.filter((t) => !denied.has(t.name));

  // If allowedTools is specified, only keep those
  if (policy.allowedTools) {
    const allowed = new Set(policy.allowedTools);
    filtered = filtered.filter((t) => allowed.has(t.name));
  }

  return filtered;
}

/**
 * Check whether `filePath` is the same as, or located inside, `dir`.
 * Both inputs are normalized via `path.resolve()` before comparison to
 * defeat path-traversal tricks (e.g. `/home/user/../user2/secret`, trailing
 * slashes, mixed separators). A plain `startsWith` is NOT safe because
 * `/home/user/sec` would match `/home/user/secret`.
 */
function isPathInside(filePath: string, dir: string): boolean {
  const resolvedFile = resolve(filePath);
  const resolvedDir = resolve(dir);
  // On Windows (case-insensitive FS), compare lowercased paths so that
  // C:\Users and c:\users are treated as the same directory. Without this,
  // an attacker could bypass workspace boundaries by varying case.
  const fileCmp = process.platform === "win32" ? resolvedFile.toLowerCase() : resolvedFile;
  const dirCmp = process.platform === "win32" ? resolvedDir.toLowerCase() : resolvedDir;
  if (fileCmp === dirCmp) return true;
  return fileCmp.startsWith(dirCmp + sep);
}

/**
 * Check if a file path is allowed by the sandbox policy.
 *
 * Both `allowedPaths` and `deniedPaths` are interpreted as directory roots:
 * a path is considered to match a policy entry only when it resolves to a
 * location inside (or equal to) that entry. Substring matching (`includes`)
 * is intentionally NOT used because it would let `/etc/passed` be denied by
 * a `/etc/pass` rule and could produce false positives/negatives.
 */
export function isPathAllowed(path: string, policy: SandboxPolicy): boolean {
  const resolved = resolve(path);

  // Denied paths take precedence
  if (policy.deniedPaths) {
    for (const dir of policy.deniedPaths) {
      if (isPathInside(resolved, resolve(dir))) {
        return false;
      }
    }
  }

  // If allowedPaths is specified, path must match one
  if (policy.allowedPaths) {
    let matched = false;
    for (const dir of policy.allowedPaths) {
      if (isPathInside(resolved, resolve(dir))) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }

  return true;
}

/**
 * Check if a URL domain is allowed by the sandbox policy.
 */
export function isDomainAllowed(url: string, policy: SandboxPolicy): boolean {
  if (!policy.allowedDomains || policy.allowedDomains.length === 0) {
    return true; // No restriction
  }

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    return policy.allowedDomains.some((domain) => {
      return hostname === domain || hostname.endsWith(`.${domain}`);
    });
  } catch {
    return false; // Invalid URL
  }
}

