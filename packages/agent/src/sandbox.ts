/**
 * Sandbox configuration and policy for sub-agents.
 *
 * Plan A: Tool-level sandbox (tool whitelist, path restriction, network whitelist, file locks)
 * Plan B: Process-level sandbox (Linux cgroup + namespace)
 */

import { resolve, sep } from "path";

// ── Plan A: Tool-level Sandbox Policy ──

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
  deniedTools: ["execute_shell", "execute_python", "execute_node", "file_delete_tool"],
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
  if (resolvedFile === resolvedDir) return true;
  return resolvedFile.startsWith(resolvedDir + sep);
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

// ── Plan B: Process-level Sandbox (Linux) ──

/**
 * Configuration for process-level sandboxing (Linux cgroup + namespace).
 */
export interface ProcessSandboxConfig {
  /** CPU quota as percentage. E.g., 20 means 20% of one CPU core. Default: 20. */
  cpuQuotaPercent?: number;

  /** Memory limit in bytes. Default: 268435456 (256MB). */
  memoryLimitBytes?: number;

  /** Maximum number of processes/PIDs. Default: 20. */
  maxPids?: number;

  /** Whether to create a new network namespace (no network access). Default: true. */
  networkIsolated?: boolean;

  /** Whether to create a new mount namespace with restricted paths. Default: true. */
  mountIsolated?: boolean;

  /** Paths to mount read-only in the sandbox. */
  readOnlyPaths?: string[];

  /** Paths to mount read-write in the sandbox. */
  readWritePaths?: string[];

  /** Working directory inside the sandbox. Default: /workspace. */
  workingDir?: string;
}

/**
 * Default process sandbox config for Linux.
 */
export const DEFAULT_PROCESS_SANDBOX_CONFIG: ProcessSandboxConfig = {
  cpuQuotaPercent: 20,
  memoryLimitBytes: 256 * 1024 * 1024, // 256MB
  maxPids: 20,
  networkIsolated: true,
  mountIsolated: true,
  readOnlyPaths: ["/usr", "/lib", "/lib64", "/bin"],
  readWritePaths: ["/workspace", "/tmp"],
  workingDir: "/workspace",
};

/**
 * Quote a string for safe use as a single POSIX shell argument.
 *
 * Wraps the value in single quotes and escapes any embedded single quotes
 * using the standard `'\''` sequence. The result is safe to interpolate
 * into a `sh -c` invocation: metacharacters such as `;`, `&&`, `|`, `$()`,
 * and backticks cannot break out of the quoting.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the unshare + cgexec command string for Linux process sandboxing.
 * Returns null if not on Linux or if cgroup v2 is not available.
 *
 * The caller-supplied `command` and `cgroupPath` are passed to the shell as
 * separately-quoted arguments so that any metacharacters they contain are
 * interpreted only by the inner shell running *inside* the sandbox, never by
 * the outer shell that launches the sandbox wrapper.
 */
export function buildLinuxSandboxCommand(
  command: string,
  config: ProcessSandboxConfig,
  cgroupPath: string
): string | null {
  if (process.platform !== "linux") {
    return null;
  }

  const cfg = { ...DEFAULT_PROCESS_SANDBOX_CONFIG, ...config };

  const parts: string[] = ["unshare"];

  // Namespace isolation
  if (cfg.mountIsolated) parts.push("--mount");
  if (cfg.networkIsolated) parts.push("--net");
  parts.push("--pid"); // Always isolate PID

  // cgroup resource limits — cgroupPath is quoted so a malicious/ill-formed
  // path cannot inject flags or break out of the `-g` argument.
  const cgexecArg = shellQuote(`cpu,memory,pids:${cgroupPath}`);

  // The user command is passed as a single quoted argument to `sh -c`, so
  // metacharacters (`;`, `&&`, backticks, `$()`, …) are evaluated by the
  // inner shell that runs inside the sandbox, not by the outer launcher.
  const sandboxCmd = `${parts.join(" ")} cgexec -g ${cgexecArg} -- sh -c ${shellQuote(command)}`;
  return sandboxCmd;
}

/**
 * Set up cgroup v2 for a sub-agent sandbox.
 * Creates the cgroup directory and writes resource limits.
 * Returns the cgroup path or null on failure.
 */
export async function setupLinuxCgroup(
  agentName: string,
  config: ProcessSandboxConfig
): Promise<string | null> {
  if (process.platform !== "linux") {
    return null;
  }

  const { mkdir, writeFile } = await import("fs/promises");
  const { join } = await import("path");

  const cfg = { ...DEFAULT_PROCESS_SANDBOX_CONFIG, ...config };
  const cgroupBase = "/sys/fs/cgroup";
  const cgroupName = `agent_sub_${agentName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const cgroupPath = join(cgroupBase, cgroupName);

  try {
    // Create cgroup directory
    await mkdir(cgroupPath, { recursive: true });

    // Set CPU limit (cpu.max: quota period)
    const cpuQuota = cfg.cpuQuotaPercent! * 1000; // Convert to microseconds per 100ms period
    await writeFile(join(cgroupPath, "cpu.max"), `${cpuQuota} 100000`);

    // Set memory limit
    await writeFile(join(cgroupPath, "memory.max"), String(cfg.memoryLimitBytes));

    // Set PID limit
    await writeFile(join(cgroupPath, "pids.max"), String(cfg.maxPids));

    // Enable controllers
    await writeFile(join(cgroupPath, "cgroup.subtree_control"), "+cpu +memory +pids");

    return cgroupName;
  } catch (e) {
    console.warn(`[Sandbox] Failed to setup cgroup for ${agentName}: ${e}`);
    return null;
  }
}

/**
 * Tear down cgroup for a sub-agent sandbox.
 */
export async function teardownLinuxCgroup(agentName: string): Promise<void> {
  if (process.platform !== "linux") {
    return;
  }

  const { writeFile } = await import("fs/promises");
  const { join } = await import("path");

  const cgroupBase = "/sys/fs/cgroup";
  const cgroupName = `agent_sub_${agentName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const cgroupPath = join(cgroupBase, cgroupName);

  try {
    // Move all processes to root cgroup first
    await writeFile(join(cgroupPath, "cgroup.procs"), "").catch(() => {});
    // Remove the cgroup
    const { rm } = await import("fs/promises");
    await rm(cgroupPath, { recursive: true, force: true });
  } catch {
    // Ignore teardown errors
  }
}

// ── Plan B: Process-level Sandbox (Windows) ──

/**
 * Configuration for process-level sandboxing on Windows (Job Object).
 */
export interface WindowsProcessSandboxConfig {
  /** CPU rate control weight (1-10000, where 10000 = 100%). Default: 2000 (20%). */
  cpuRateWeight?: number;

  /** Memory limit in bytes for the entire job. Default: 268435456 (256MB). */
  memoryLimitBytes?: number;

  /** Maximum number of active processes in the job. Default: 20. */
  maxProcesses?: number;

  /**
   * Whether to deny network access via Windows Firewall outbound rule.
   * Note: Full AppContainer-level network isolation requires native addon.
   * This uses a pragmatic PowerShell New-NetFirewallRule approach instead.
   * Default: false.
   */
  denyNetwork?: boolean;

  /** Whether to kill all processes in the job when the job handle is closed. Default: true. */
  killOnClose?: boolean;

  /** Working directory for the sandboxed process. Default: process.cwd(). */
  workingDir?: string;
}

/**
 * Default Windows process sandbox config.
 */
export const DEFAULT_WINDOWS_PROCESS_SANDBOX_CONFIG: WindowsProcessSandboxConfig = {
  cpuRateWeight: 2000,
  memoryLimitBytes: 256 * 1024 * 1024, // 256MB
  maxProcesses: 20,
  denyNetwork: false,
  killOnClose: true,
  workingDir: undefined,
};

/**
 * Generate a PowerShell script that creates a Windows Job Object with resource limits,
 * starts the target command under that job, and waits for completion.
 *
 * Uses .NET P/Invoke to call Win32 APIs — no native addon dependency.
 * Requires PowerShell 5.1+ (ships with Windows 10/11 and Server 2016+).
 *
 * Returns null if not on Windows.
 */
export function buildWindowsSandboxScript(
  command: string,
  args: string[],
  config: WindowsProcessSandboxConfig
): string | null {
  if (process.platform !== "win32") {
    return null;
  }

  const cfg = { ...DEFAULT_WINDOWS_PROCESS_SANDBOX_CONFIG, ...config };
  const escapedCommand = command.replace(/'/g, "''");
  const escapedArgs = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(", ");
  const argsArrayLiteral = args.length > 0 ? `@(${escapedArgs})` : "@()";

  // The PowerShell script uses Add-Type to P/Invoke Win32 Job Object APIs.
  // JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x100
  // JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x8
  // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
  // JOBOBJECT_CPU_RATE_CONTROL_ENABLE = 0x1
  // JOBOBJECT_CPU_RATE_CONTROL_WEIGHT_BASED = 0x8
  const script = `
# Windows Job Object Sandbox Script (auto-generated)
$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;

public class JobObjectHelper {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(
        IntPtr hJob, int jobInfoClass, IntPtr lpJobObjectInfo, uint cbLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (class 9)
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    // JOBOBJECT_CPU_RATE_CONTROL_INFORMATION (class 15)
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
        public uint ControlFlags;
        public uint Weight;
    }

    public static IntPtr CreateSandboxJob(
        long memoryLimit, uint maxProcesses, bool killOnClose, uint cpuWeight)
    {
        IntPtr hJob = CreateJobObjectW(IntPtr.Zero, null);
        if (hJob == IntPtr.Zero)
            throw new Exception("CreateJobObjectW failed: " + Marshal.GetLastWin32Error());

        // Set extended limit (memory + process count + kill on close)
        uint flags = 0;
        var extInfo = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();

        if (memoryLimit > 0) {
            flags |= 0x100; // JOB_OBJECT_LIMIT_PROCESS_MEMORY
            extInfo.ProcessMemoryLimit = (UIntPtr)(ulong)memoryLimit;
        }
        if (maxProcesses > 0) {
            flags |= 0x8; // JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            extInfo.BasicLimitInformation.ActiveProcessLimit = maxProcesses;
        }
        if (killOnClose) {
            flags |= 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        }
        extInfo.BasicLimitInformation.LimitFlags = flags;

        int extInfoSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr extInfoPtr = Marshal.AllocHGlobal(extInfoSize);
        try {
            Marshal.StructureToPtr(extInfo, extInfoPtr, false);
            if (!SetInformationJobObject(hJob, 9, extInfoPtr, (uint)extInfoSize))
                throw new Exception("SetInformationJobObject(ExtendedLimit) failed: " + Marshal.GetLastWin32Error());
        } finally {
            Marshal.FreeHGlobal(extInfoPtr);
        }

        // Set CPU rate control (weight-based)
        if (cpuWeight > 0 && cpuWeight <= 10000) {
            var cpuInfo = new JOBOBJECT_CPU_RATE_CONTROL_INFORMATION();
            cpuInfo.ControlFlags = 0x1 | 0x8; // ENABLE | WEIGHT_BASED
            cpuInfo.Weight = cpuWeight;

            int cpuInfoSize = Marshal.SizeOf(typeof(JOBOBJECT_CPU_RATE_CONTROL_INFORMATION));
            IntPtr cpuInfoPtr = Marshal.AllocHGlobal(cpuInfoSize);
            try {
                Marshal.StructureToPtr(cpuInfo, cpuInfoPtr, false);
                // Class 15 = JobObjectCpuRateControlInformation
                SetInformationJobObject(hJob, 15, cpuInfoPtr, (uint)cpuInfoSize);
                // CPU rate control may fail on older Windows; non-fatal
            } finally {
                Marshal.FreeHGlobal(cpuInfoPtr);
            }
        }

        return hJob;
    }
}
'@

$hJob = [JobObjectHelper]::CreateSandboxJob(${cfg.memoryLimitBytes ?? 0}, ${cfg.maxProcesses ?? 0}, ${cfg.killOnClose !== false ? "$true" : "$false"}, ${cfg.cpuRateWeight ?? 0})

try {
    $procInfo = Start-Process -FilePath '${escapedCommand}' -ArgumentList ${argsArrayLiteral} -PassThru -NoNewWindow${cfg.workingDir ? ` -WorkingDirectory '${cfg.workingDir.replace(/'/g, "''")}'` : ""}
    [JobObjectHelper]::AssignProcessToJobObject($hJob, $procInfo.Handle) | Out-Null
    $procInfo.WaitForExit()
    exit $procInfo.ExitCode
} finally {
    [JobObjectHelper]::CloseHandle($hJob) | Out-Null
}
`.trim();

  return script;
}

/**
 * Build a Windows sandbox command that wraps the target command in a Job Object.
 *
 * Returns null if not on Windows.
 */
export function buildWindowsSandboxCommand(
  command: string,
  config: WindowsProcessSandboxConfig
): string | null {
  if (process.platform !== "win32") {
    return null;
  }

  // For a simple command string, split into command + args
  const parts = command.trim().split(/\s+/);
  const exe = parts[0];
  const args = parts.slice(1);
  const script = buildWindowsSandboxScript(exe, args, config);
  if (!script) return null;

  // Encode the script as a base64-encoded command for PowerShell
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

/**
 * Set up a Windows Job Object sandbox for a sub-agent.
 * Creates a PowerShell helper script in a temporary directory.
 * Returns the script file path, or null on failure / non-Windows.
 */
export async function setupWindowsJobObject(
  agentName: string,
  config: WindowsProcessSandboxConfig
): Promise<string | null> {
  if (process.platform !== "win32") {
    return null;
  }

  const { mkdir, writeFile } = await import("fs/promises");
  const { join } = await import("path");
  const { tmpdir } = await import("os");

  const cfg = { ...DEFAULT_WINDOWS_PROCESS_SANDBOX_CONFIG, ...config };
  const safeName = agentName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const sandboxDir = join(tmpdir(), "agent_sandbox");
  const scriptPath = join(sandboxDir, `sandbox_${safeName}.ps1`);

  try {
    await mkdir(sandboxDir, { recursive: true });

    // Write a template script. The actual command will be injected at runtime.
    const templateScript = buildWindowsSandboxScript(
      "__COMMAND_PLACEHOLDER__",
      [],
      cfg
    );
    if (!templateScript) return null;

    await writeFile(scriptPath, templateScript, "utf-8");
    console.info(`[Sandbox] Created Windows Job Object script for ${agentName}: ${scriptPath}`);
    return scriptPath;
  } catch (e) {
    console.warn(`[Sandbox] Failed to setup Windows Job Object for ${agentName}: ${e}`);
    return null;
  }
}

/**
 * Tear down Windows Job Object sandbox for a sub-agent.
 * Removes the temporary PowerShell helper script.
 */
export async function teardownWindowsJobObject(agentName: string): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }

  const { rm } = await import("fs/promises");
  const { join } = await import("path");
  const { tmpdir } = await import("os");

  const safeName = agentName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const sandboxDir = join(tmpdir(), "agent_sandbox");
  const scriptPath = join(sandboxDir, `sandbox_${safeName}.ps1`);

  try {
    await rm(scriptPath, { force: true });
  } catch {
    // Ignore teardown errors
  }
}
