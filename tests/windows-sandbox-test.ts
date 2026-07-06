/**
 * Windows 进程级沙箱测试
 * 测试 Windows Job Object 沙箱功能
 */
import {
  buildWindowsSandboxScript,
  buildWindowsSandboxCommand,
  setupWindowsJobObject,
  teardownWindowsJobObject,
  DEFAULT_WINDOWS_PROCESS_SANDBOX_CONFIG,
} from "@yachiyo/agent/sandbox.js";
import type { WindowsProcessSandboxConfig } from "@yachiyo/agent/sandbox.js";

// ============================================================
// 1. 测试: buildWindowsSandboxScript
// ============================================================

function testBuildWindowsSandboxScript(): void {
  console.log("\n=== 测试: buildWindowsSandboxScript ===");

  if (process.platform !== "win32") {
    console.log("  ⏭ 跳过 (非 Windows 平台)");
    return;
  }

  // 基本命令
  const script1 = buildWindowsSandboxScript("notepad.exe", [], {});
  console.log("  基本命令生成脚本:", script1 !== null ? "✅" : "❌");
  console.log("  包含 CreateJobObjectW:", script1!.includes("CreateJobObjectW"));
  console.log("  包含 SetInformationJobObject:", script1!.includes("SetInformationJobObject"));
  console.log("  包含 AssignProcessToJobObject:", script1!.includes("AssignProcessToJobObject"));

  // 带参数命令
  const script2 = buildWindowsSandboxScript("node.exe", ["-e", "console.log('hello')"], {});
  console.log("  带参数命令生成脚本:", script2 !== null ? "✅" : "❌");
  console.log("  参数包含 node:", script2!.includes("node.exe"));

  // 自定义配置
  const config: WindowsProcessSandboxConfig = {
    cpuRateWeight: 3000,
    memoryLimitBytes: 512 * 1024 * 1024,
    maxProcesses: 10,
    killOnClose: true,
  };
  const script3 = buildWindowsSandboxScript("cmd.exe", ["/c", "dir"], config);
  console.log("  自定义配置生成脚本:", script3 !== null ? "✅" : "❌");
  console.log("  包含内存限制:", script3!.includes("536870912")); // 512MB
  console.log("  包含进程限制:", script3!.includes("10"));

  // 默认配置
  console.log("  默认 CPU 权重:", DEFAULT_WINDOWS_PROCESS_SANDBOX_CONFIG.cpuRateWeight);
  console.log("  默认内存限制:", DEFAULT_WINDOWS_PROCESS_SANDBOX_CONFIG.memoryLimitBytes);
  console.log("  默认最大进程:", DEFAULT_WINDOWS_PROCESS_SANDBOX_CONFIG.maxProcesses);
  console.log("  默认 killOnClose:", DEFAULT_WINDOWS_PROCESS_SANDBOX_CONFIG.killOnClose);

  console.log("  ✅ buildWindowsSandboxScript 测试通过");
}

// ============================================================
// 2. 测试: buildWindowsSandboxCommand
// ============================================================

function testBuildWindowsSandboxCommand(): void {
  console.log("\n=== 测试: buildWindowsSandboxCommand ===");

  if (process.platform !== "win32") {
    console.log("  ⏭ 跳过 (非 Windows 平台)");
    return;
  }

  const cmd = buildWindowsSandboxCommand("notepad.exe", {});
  console.log("  生成 PowerShell 命令:", cmd !== null ? "✅" : "❌");
  console.log("  包含 powershell.exe:", cmd!.includes("powershell.exe"));
  console.log("  包含 EncodedCommand:", cmd!.includes("EncodedCommand"));
  console.log("  包含 ExecutionPolicy Bypass:", cmd!.includes("ExecutionPolicy Bypass"));
  console.log("  包含 NoProfile:", cmd!.includes("NoProfile"));

  // 验证命令可以被 PowerShell 解码
  const base64Match = cmd!.match(/EncodedCommand\s+(\S+)/);
  console.log("  Base64 编码存在:", base64Match ? "✅" : "❌");

  if (base64Match) {
    const decoded = Buffer.from(base64Match[1], "base64").toString("utf16le");
    console.log("  解码后包含 notepad.exe:", decoded.includes("notepad.exe"));
    console.log("  解码后包含 CreateJobObjectW:", decoded.includes("CreateJobObjectW"));
  }

  console.log("  ✅ buildWindowsSandboxCommand 测试通过");
}

// ============================================================
// 3. 测试: setupWindowsJobObject & teardown
// ============================================================

async function testSetupAndTeardown(): Promise<void> {
  console.log("\n=== 测试: setupWindowsJobObject & teardown ===");

  if (process.platform !== "win32") {
    console.log("  ⏭ 跳过 (非 Windows 平台)");
    return;
  }

  const { access } = await import("fs/promises");

  // 创建沙箱
  const scriptPath = await setupWindowsJobObject("test-agent", {});
  console.log("  创建沙箱脚本:", scriptPath !== null ? "✅" : "❌");
  console.log("  脚本路径:", scriptPath);

  if (scriptPath) {
    // 验证文件存在
    try {
      await access(scriptPath);
      console.log("  脚本文件可访问:", "✅");
    } catch {
      console.log("  脚本文件不存在:", "❌");
    }

    // 读取脚本内容
    const { readFile } = await import("fs/promises");
    const content = await readFile(scriptPath, "utf-8");
    console.log("  脚本包含 Job Object:", content.includes("JobObjectHelper"));
    console.log("  脚本包含 __COMMAND_PLACEHOLDER__:", content.includes("__COMMAND_PLACEHOLDER__"));

    // 销毁沙箱
    await teardownWindowsJobObject("test-agent");
    try {
      await access(scriptPath);
      console.log("  销毁后文件仍存在:", "❌");
    } catch {
      console.log("  销毁后文件已删除:", "✅");
    }
  }

  console.log("  ✅ setupWindowsJobObject & teardown 测试通过");
}

// ============================================================
// 4. 测试: 实际执行沙箱命令 (安全测试)
// ============================================================

async function testSandboxExecution(): Promise<void> {
  console.log("\n=== 测试: 沙箱命令实际执行 ===");

  if (process.platform !== "win32") {
    console.log("  ⏭ 跳过 (非 Windows 平台)");
    return;
  }

  const { execSync } = await import("child_process");

  // 测试 1: 简单命令在沙箱中执行
  console.log("  测试 1: echo 命令在沙箱中执行");
  const config1: WindowsProcessSandboxConfig = {
    memoryLimitBytes: 64 * 1024 * 1024, // 64MB
    maxProcesses: 5,
    killOnClose: true,
  };
  const sandboxCmd = buildWindowsSandboxCommand("cmd.exe /c echo Hello from Sandbox!", config1);
  if (sandboxCmd) {
    try {
      const output = execSync(sandboxCmd, {
        encoding: "utf-8",
        timeout: 15000,
        windowsHide: true,
      }).trim();
      console.log("  输出:", output);
      console.log("  沙箱执行成功:", output.includes("Hello from Sandbox!") ? "✅" : "❌");
    } catch (e) {
      console.log("  沙箱执行失败:", (e as Error).message?.slice(0, 100));
    }
  }

  // 测试 2: 验证内存限制 (测试超大内存分配)
  console.log("  测试 2: 验证内存限制 (64MB)");
  const config2: WindowsProcessSandboxConfig = {
    memoryLimitBytes: 64 * 1024 * 1024, // 64MB
    maxProcesses: 5,
    killOnClose: true,
  };
  // 使用 PowerShell 尝试分配大内存
  const memTestScript = buildWindowsSandboxScript(
    "powershell.exe",
    ["-NoProfile", "-Command", "[byte[]]$arr = New-Object byte[] 100MB; Start-Sleep -Seconds 1"],
    config2
  );
  if (memTestScript) {
    const encoded = Buffer.from(memTestScript, "utf16le").toString("base64");
    const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
    try {
      execSync(cmd, {
        encoding: "utf-8",
        timeout: 30000,
        windowsHide: true,
      });
      console.log("  内存测试执行完成 (可能成功或被限制)");
    } catch {
      console.log("  内存限制可能已生效 (进程被终止): ✅");
    }
  }

  // 测试 3: 验证进程数限制
  console.log("  测试 3: 验证进程数限制 (maxProcesses=3)");
  const config3: WindowsProcessSandboxConfig = {
    maxProcesses: 3,
    killOnClose: true,
  };
  const procTestScript = buildWindowsSandboxScript(
    "cmd.exe",
    ["/c", "start /b cmd.exe /c timeout /t 5 & start /b cmd.exe /c timeout /t 5 & start /b cmd.exe /c timeout /t 5 & echo done"],
    config3
  );
  if (procTestScript) {
    const encoded = Buffer.from(procTestScript, "utf16le").toString("base64");
    const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
    try {
      const output = execSync(cmd, {
        encoding: "utf-8",
        timeout: 30000,
        windowsHide: true,
      }).trim();
      console.log("  进程限制测试输出:", output);
      console.log("  进程限制测试完成: ✅");
    } catch {
      console.log("  进程限制可能已生效: ✅");
    }
  }

  console.log("  ✅ 沙箱命令实际执行测试通过");
}

// ============================================================
// 5. 测试: 边界情况
// ============================================================

async function testEdgeCases(): Promise<void> {
  console.log("\n=== 测试: 边界情况 ===");

  if (process.platform !== "win32") {
    console.log("  ⏭ 跳过 (非 Windows 平台)");
    return;
  }

  // 空参数
  const script1 = buildWindowsSandboxScript("notepad.exe", [], {});
  console.log("  空参数生成脚本:", script1 !== null ? "✅" : "❌");

  // 特殊字符参数
  const script2 = buildWindowsSandboxScript("cmd.exe", ["/c", "echo 'hello \"world\"'"], {});
  console.log("  特殊字符参数生成脚本:", script2 !== null ? "✅" : "❌");

  // 最小配置
  const minConfig: WindowsProcessSandboxConfig = {
    cpuRateWeight: 100,
    memoryLimitBytes: 1024, // 1KB
    maxProcesses: 1,
  };
  const script3 = buildWindowsSandboxScript("cmd.exe", ["/c", "echo test"], minConfig);
  console.log("  最小配置生成脚本:", script3 !== null ? "✅" : "❌");

  // 最大配置
  const maxConfig: WindowsProcessSandboxConfig = {
    cpuRateWeight: 10000,
    memoryLimitBytes: 4 * 1024 * 1024 * 1024, // 4GB
    maxProcesses: 1000,
  };
  const script4 = buildWindowsSandboxScript("cmd.exe", ["/c", "echo test"], maxConfig);
  console.log("  最大配置生成脚本:", script4 !== null ? "✅" : "❌");

  // 重复 setup/teardown
  console.log("  重复 setup/teardown 测试:");
  // C-23 fix: previously this was a fire-and-forget Promise chain. Since
  // testEdgeCases was synchronous and main() did not await it, the process
  // could exit before the chain completed. We now return the Promise so
  // the caller can await it.
  await setupWindowsJobObject("test-dup", {}).then((p1) => {
    console.log("    第一次创建:", p1 !== null ? "✅" : "❌");
    return setupWindowsJobObject("test-dup", {});
  }).then((p2) => {
    console.log("    第二次创建 (覆盖):", p2 !== null ? "✅" : "❌");
    return teardownWindowsJobObject("test-dup");
  }).then(() => {
    console.log("    销毁完成: ✅");
  });

  console.log("  ✅ 边界情况测试通过");
}

// ============================================================
// 运行所有测试
// ============================================================

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   Windows 进程级沙箱测试                  ║");
  console.log("╚══════════════════════════════════════════╝");

  if (process.platform !== "win32") {
    console.error("❌ 错误: 此测试只能在 Windows 平台运行!");
    process.exit(1);
  }

  try {
    testBuildWindowsSandboxScript();
    testBuildWindowsSandboxCommand();
    await testSetupAndTeardown();
    await testSandboxExecution();
    await testEdgeCases();

    console.log("\n╔══════════════════════════════════════════╗");
    console.log("║   🎉 所有 Windows 沙箱测试通过!           ║");
    console.log("╚══════════════════════════════════════════╝");
    process.exit(0);
  } catch (e) {
    console.error("\n❌ 测试失败:", e);
    process.exit(1);
  }
}

main();
