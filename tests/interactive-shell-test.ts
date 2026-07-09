/**
 * 交互式终端工具测试
 * 测试 interactive-shell-tool.ts 提供的会话管理功能
 *
 * 测试设计原则:
 * 1. 断言失败时抛出异常,而非仅打印 ❌ — 确保进程退出码非零
 * 2. 所有测试在发送命令前消耗 shell 启动 banner — 避免时序竞态
 * 3. 使用 readUntilFound 轮询读取直到模式匹配 — 处理分块输出
 * 4. 每个测试自行清理会话 — 避免跨测试污染
 */
import {
  interactiveShellStart,
  interactiveShellSend,
  interactiveShellRead,
  interactiveShellClose,
  listInteractiveSessions,
  cleanupDeadSessions,
  closeAllInteractiveSessions,
  createInteractiveShellStartTool,
  createInteractiveShellSendTool,
  createInteractiveShellReadTool,
  createInteractiveShellListTool,
  createInteractiveShellCloseTool,
} from "@yachiyo/agent/interactive-shell-tool.js";
import type { CallToolResult } from "@yachiyo/agent/types.js";
import { homedir } from "os";

// ── 辅助函数 ──

const isWindows = process.platform === "win32";

/** 断言条件为真,否则抛出异常 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`断言失败: ${message}`);
  }
  console.log(`  ✅ ${message}`);
}

/** 断言条件为假,否则抛出异常 */
function assertNot(condition: boolean, message: string): void {
  if (condition) {
    throw new Error(`断言失败: ${message} (期望 false 但得到 true)`);
  }
  console.log(`  ✅ ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 从 CallToolResult 中提取文本 */
function extractText(result: CallToolResult): string {
  if (result.content && result.content.length > 0 && result.content[0].type === "text") {
    return (result.content[0] as { type: "text"; text: string }).text;
  }
  return "";
}

/**
 * 启动会话并等待 shell 就绪,消耗启动 banner。
 * 返回 session id。
 */
async function startSessionAndConsumeBanner(opts?: {
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
}): Promise<string> {
  const id = interactiveShellStart(opts?.command, {
    workspaceRoot: opts?.cwd ?? process.cwd(),
    cwd: opts?.cwd,
    env: opts?.env,
  });
  // 等待 shell 启动并输出 banner
  await sleep(500);
  // 消耗 banner (读取并丢弃)
  await interactiveShellRead(id, { waitMs: 1000 });
  return id;
}

/**
 * 轮询读取会话输出,直到匹配指定模式或超时。
 * 解决分块输出导致的时序问题。
 */
async function readUntilFound(
  id: string,
  pattern: string | RegExp,
  timeoutMs = 5000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let accumulated = "";
  while (Date.now() < deadline) {
    const result = await interactiveShellRead(id, { waitMs: 500, clear: false });
    if (!result) throw new Error(`readUntilFound: 会话 ${id} 不存在`);
    accumulated += result.stdout + result.stderr;
    if (typeof pattern === "string") {
      if (accumulated.includes(pattern)) return accumulated;
    } else {
      if (pattern.test(accumulated)) return accumulated;
    }
  }
  throw new Error(`readUntilFound: 在 ${timeoutMs}ms 内未找到模式 ${pattern}, 已读取: ${JSON.stringify(accumulated.slice(-200))}`);
}

// ============================================================
// 1. 测试: 基本会话生命周期 (start → list → close)
// ============================================================

async function testSessionLifecycle(): Promise<void> {
  console.log("\n=== 测试: 基本会话生命周期 ===");
  closeAllInteractiveSessions();

  const id = interactiveShellStart(undefined, { workspaceRoot: process.cwd() });
  assert(!!id, `创建会话返回 id (id=${id})`);

  const list = listInteractiveSessions();
  assert(list.length === 1, `列出会话数量为 1 (count=${list.length})`);
  assert(list[0]?.id === id, "会话 id 匹配");
  assert(list[0]?.closed === false && list[0]?.exitCode === null, "会话状态为 running");
  assert(typeof list[0]?.pid === "number", `pid 为数字 (pid=${list[0]?.pid})`);

  const closed = interactiveShellClose(id);
  assert(closed, "关闭会话返回 true");

  const listAfter = listInteractiveSessions();
  assert(listAfter.length === 0, `关闭后会话数为 0 (count=${listAfter.length})`);

  console.log("  ✅ 基本会话生命周期测试通过");
}

// ============================================================
// 2. 测试: 发送输入并读取输出
// ============================================================

async function testSendAndRead(): Promise<void> {
  console.log("\n=== 测试: 发送输入并读取输出 ===");

  const id = await startSessionAndConsumeBanner();

  const sent = interactiveShellSend(id, "echo hello_interactive");
  assert(sent, "发送输入返回 true");

  const output = await readUntilFound(id, "hello_interactive", 5000);
  assert(output.includes("hello_interactive"), "输出包含 'hello_interactive'");

  // 再次读取 — since-read 缓冲应已清空 (readUntilFound 用 clear=false)
  // 手动清除并验证
  await interactiveShellRead(id, { waitMs: 100, clear: true });
  const result2 = await interactiveShellRead(id, { waitMs: 300 });
  const output2 = result2 ? (result2.stdout + result2.stderr).trim() : "";
  assert(output2.length === 0, `第二次读取缓冲为空 (len=${output2.length})`);

  interactiveShellClose(id);
  console.log("  ✅ 发送输入并读取输出测试通过");
}

// ============================================================
// 3. 测试: 多命令交互场景 (变量持久性)
// ============================================================

async function testMultiCommandInteractive(): Promise<void> {
  console.log("\n=== 测试: 多命令交互场景 ===");

  const id = await startSessionAndConsumeBanner();

  // 命令 1: 设置变量
  if (isWindows) {
    interactiveShellSend(id, "set MYVAR=hello_world");
  } else {
    interactiveShellSend(id, "export MYVAR=hello_world");
  }
  await sleep(300);
  await interactiveShellRead(id, { waitMs: 500, clear: true }); // 消耗输出

  // 命令 2: 读取变量 — 验证会话状态保持
  if (isWindows) {
    interactiveShellSend(id, "echo %MYVAR%");
  } else {
    interactiveShellSend(id, "echo $MYVAR");
  }
  const output1 = await readUntilFound(id, "hello_world", 5000);
  assert(output1.includes("hello_world"), "变量在后续命令中保持 (会话状态持久)");

  // 清除 readUntilFound 的 peek 缓冲
  await interactiveShellRead(id, { waitMs: 100, clear: true });

  // 命令 3: 执行计算
  if (isWindows) {
    interactiveShellSend(id, "set /a 2+3");
  } else {
    interactiveShellSend(id, "echo $((2+3))");
  }
  const output2 = await readUntilFound(id, /\b5\b/, 5000);
  assert(output2.includes("5"), "数学计算 2+3=5 正确");

  await interactiveShellRead(id, { waitMs: 100, clear: true }); // 清除
  interactiveShellClose(id);
  console.log("  ✅ 多命令交互场景测试通过");
}

// ============================================================
// 4. 测试: 多会话并发
// ============================================================

async function testMultipleSessions(): Promise<void> {
  console.log("\n=== 测试: 多会话并发 ===");
  closeAllInteractiveSessions();

  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = await startSessionAndConsumeBanner();
    ids.push(id);
  }

  const list = listInteractiveSessions();
  assert(list.length === 3, `创建 3 个会话 (count=${list.length})`);

  // 向每个会话发送不同命令
  for (let i = 0; i < ids.length; i++) {
    interactiveShellSend(ids[i], `echo session_${i}`);
  }

  // 读取并验证各会话独立输出
  for (let i = 0; i < ids.length; i++) {
    const output = await readUntilFound(ids[i], `session_${i}`, 5000);
    assert(output.includes(`session_${i}`), `会话 ${i} 独立输出正确`);
    await interactiveShellRead(ids[i], { waitMs: 100, clear: true }); // 清除
  }

  const closedCount = closeAllInteractiveSessions();
  assert(closedCount === 3, `关闭所有会话 (closed=${closedCount})`);

  console.log("  ✅ 多会话并发测试通过");
}

// ============================================================
// 5. 测试: 边界情况
// ============================================================

async function testEdgeCases(): Promise<void> {
  console.log("\n=== 测试: 边界情况 ===");

  // 5.1 关闭不存在的会话
  assertNot(interactiveShellClose("nonexistent-id"), "关闭不存在的会话返回 false");

  // 5.2 向不存在的会话发送输入
  assertNot(interactiveShellSend("nonexistent-id", "test"), "向不存在的会话发送返回 false");

  // 5.3 读取不存在的会话
  const readFake = await interactiveShellRead("nonexistent-id");
  assert(readFake === null, "读取不存在的会话返回 null");

  // 5.4 关闭已关闭的会话
  const id = await startSessionAndConsumeBanner();
  assert(interactiveShellClose(id), "首次关闭返回 true");
  assertNot(interactiveShellClose(id), "重复关闭返回 false");

  // 5.5 向已关闭的会话发送输入
  assertNot(interactiveShellSend(id, "test"), "向已关闭会话发送返回 false");

  // 5.6 读取已关闭的会话 (已从注册表移除,应返回 null)
  const readClosed = await interactiveShellRead(id);
  assert(readClosed === null, "读取已关闭会话返回 null");

  // 5.7 不追加换行发送
  const id2 = await startSessionAndConsumeBanner();
  const sentNoNewline = interactiveShellSend(id2, "echo no_newline_test", { addNewline: false });
  assert(sentNoNewline, "不追加换行发送返回 true");
  // 发送换行以执行命令
  interactiveShellSend(id2, "", { addNewline: true });
  const nlOutput = await readUntilFound(id2, "no_newline_test", 5000);
  assert(nlOutput.includes("no_newline_test"), "不追加换行后补发换行可执行命令");
  await interactiveShellRead(id2, { waitMs: 100, clear: true });
  interactiveShellClose(id2);

  // 5.8 clear=false 读取不消耗缓冲 (peek 模式)
  const id3 = await startSessionAndConsumeBanner();
  interactiveShellSend(id3, "echo peek_test");
  const peek1 = await readUntilFound(id3, "peek_test", 5000);
  assert(peek1.includes("peek_test"), "peek 首次读取包含内容");
  // 再次读取 (clear=false),应仍能看到相同内容
  const peek2 = await interactiveShellRead(id3, { waitMs: 500, clear: false });
  const peek2Text = peek2 ? (peek2.stdout + peek2.stderr) : "";
  assert(peek2Text.includes("peek_test"), "peek 二次读取仍有内容 (缓冲未消耗)");
  interactiveShellClose(id3);

  console.log("  ✅ 边界情况测试通过");
}

// ============================================================
// 6. 测试: 带初始命令启动
// ============================================================

async function testStartWithCommand(): Promise<void> {
  console.log("\n=== 测试: 带初始命令启动 ===");

  const id = interactiveShellStart("echo initial_command_output", {
    workspaceRoot: process.cwd(),
  });

  const result = await interactiveShellRead(id, { waitMs: 3000 });
  assert(result !== null, "读取结果不为 null");

  if (result) {
    const output = (result.stdout + " " + result.stderr).trim();
    assert(output.includes("initial_command_output"), "初始命令输出正确");
  }

  interactiveShellClose(id);
  console.log("  ✅ 带初始命令启动测试通过");
}

// ============================================================
// 7. 测试: cleanupDeadSessions
// ============================================================

async function testCleanupDeadSessions(): Promise<void> {
  console.log("\n=== 测试: cleanupDeadSessions ===");
  closeAllInteractiveSessions();

  const id = await startSessionAndConsumeBanner();

  // 让 shell 自然退出
  interactiveShellSend(id, "exit");
  // 轮询等待进程退出 (最多 5 秒)
  let exited = false;
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const list = listInteractiveSessions();
    const session = list.find((s) => s.id === id);
    if (session && (session.exitCode !== null || session.closed)) {
      exited = true;
      break;
    }
  }
  assert(exited, "shell 进程在 5 秒内退出");

  const listBefore = listInteractiveSessions();
  assert(listBefore.length >= 1, `退出后会话仍在列表 (count=${listBefore.length})`);

  const cleaned = cleanupDeadSessions();
  assert(cleaned >= 1, `cleanupDeadSessions 清理了 ${cleaned} 个会话`);

  const listAfter = listInteractiveSessions();
  assert(listAfter.length === 0, `清理后列表为空 (count=${listAfter.length})`);

  console.log("  ✅ cleanupDeadSessions 测试通过");
}

// ============================================================
// 8. 测试: 工具工厂 (Tool factory)
// ============================================================

async function testToolFactories(): Promise<void> {
  console.log("\n=== 测试: 工具工厂 ===");

  const startTool = createInteractiveShellStartTool(process.cwd());
  const sendTool = createInteractiveShellSendTool();
  const readTool = createInteractiveShellReadTool();
  const listTool = createInteractiveShellListTool();
  const closeTool = createInteractiveShellCloseTool();

  assert(
    startTool.name === "interactive_shell_start" &&
      sendTool.name === "interactive_shell_send" &&
      readTool.name === "interactive_shell_read" &&
      listTool.name === "interactive_shell_list" &&
      closeTool.name === "interactive_shell_close",
    "所有工具名称正确"
  );

  // 通过工具 handler 完整流程
  // 1. start
  const startResult = await startTool.handler!(undefined, undefined) as CallToolResult;
  assert(!startResult.isError, "start 工具不返回错误");

  const startText = extractText(startResult);
  const idMatch = startText.match(/id=([a-f0-9]+)/);
  assert(!!idMatch, `start 工具返回 id (text=${startText.slice(0, 80)})`);

  if (!idMatch) throw new Error("无法继续: 未获取到 session id");
  const sessionId = idMatch[1];

  // 消耗 banner
  await sleep(500);
  await interactiveShellRead(sessionId, { waitMs: 1000 });

  // 2. send
  const sendResult = await sendTool.handler!(undefined, sessionId, "echo tool_factory_test") as CallToolResult;
  assert(!sendResult.isError, "send 工具不返回错误");

  // 3. read — 使用底层函数轮询以确保读到输出
  const tfOutput = await readUntilFound(sessionId, "tool_factory_test", 5000);
  assert(tfOutput.includes("tool_factory_test"), "read 输出包含 'tool_factory_test'");

  // 清除 peek 缓冲
  await interactiveShellRead(sessionId, { waitMs: 100, clear: true });

  // 4. list
  const listResult = await listTool.handler!(undefined) as CallToolResult;
  const listText = extractText(listResult);
  assert(listText.includes(sessionId), "list 工具包含会话 id");

  // 5. close
  const closeResult = await closeTool.handler!(undefined, sessionId) as CallToolResult;
  assert(!closeResult.isError, "close 工具不返回错误");

  // 6. close again (should fail)
  const closeAgainResult = await closeTool.handler!(undefined, sessionId) as CallToolResult;
  assert(!!closeAgainResult.isError, "重复 close 返回错误");

  closeAllInteractiveSessions();
  console.log("  ✅ 工具工厂测试通过");
}

// ============================================================
// 9. 测试: MAX_SESSIONS 限制
// ============================================================

async function testMaxSessions(): Promise<void> {
  console.log("\n=== 测试: MAX_SESSIONS 限制 ===");
  closeAllInteractiveSessions();

  // 创建大量会话 (超过 20 的上限)
  const ids: string[] = [];
  let threwAtLimit = false;
  for (let i = 0; i < 25; i++) {
    try {
      const id = interactiveShellStart(undefined, { workspaceRoot: process.cwd() });
      ids.push(id);
    } catch (e) {
      threwAtLimit = true;
      assert(
        (e as Error).message.includes("Maximum number of interactive sessions"),
        `达到上限时抛出正确错误: ${(e as Error).message.slice(0, 80)}`
      );
      break;
    }
  }

  assert(threwAtLimit, `在 MAX_SESSIONS 上限时抛出异常 (创建了 ${ids.length} 个)`);
  assert(ids.length <= 20, `创建的会话数不超过 20 (count=${ids.length})`);

  closeAllInteractiveSessions();

  // 验证清理后可以再次创建
  const newId = interactiveShellStart(undefined, { workspaceRoot: process.cwd() });
  assert(!!newId, "清理后可以再次创建会话");
  interactiveShellClose(newId);

  console.log("  ✅ MAX_SESSIONS 限制测试通过");
}

// ============================================================
// 10. 测试: env 和 cwd 参数
// ============================================================

async function testEnvAndCwd(): Promise<void> {
  console.log("\n=== 测试: env 和 cwd 参数 ===");

  // 测试 env: 自定义环境变量
  const id1 = await startSessionAndConsumeBanner({
    env: { MY_TEST_ENV_VAR: "env_value_123" },
  });

  if (isWindows) {
    interactiveShellSend(id1, "echo %MY_TEST_ENV_VAR%");
  } else {
    interactiveShellSend(id1, "echo $MY_TEST_ENV_VAR");
  }
  const envOutput = await readUntilFound(id1, "env_value_123", 5000);
  assert(envOutput.includes("env_value_123"), "自定义环境变量在 shell 中可用");
  await interactiveShellRead(id1, { waitMs: 100, clear: true });
  interactiveShellClose(id1);

  // 测试 cwd: 指定工作目录
  const homeDir = homedir();
  const id2 = await startSessionAndConsumeBanner({ cwd: homeDir });

  if (isWindows) {
    interactiveShellSend(id2, "cd");
  } else {
    interactiveShellSend(id2, "pwd");
  }
  const cwdOutput = await readUntilFound(id2, homeDir.split(/[\\/]/).pop()!, 5000);
  assert(cwdOutput.includes(homeDir) || cwdOutput.toLowerCase().includes(homeDir.toLowerCase()),
    `cwd 参数生效 (输出包含 ${homeDir})`);
  await interactiveShellRead(id2, { waitMs: 100, clear: true });
  interactiveShellClose(id2);

  console.log("  ✅ env 和 cwd 参数测试通过");
}

// ============================================================
// 11. 测试: 缓冲截断 (clampBuffer)
// ============================================================

async function testBufferTruncation(): Promise<void> {
  console.log("\n=== 测试: 缓冲截断 ===");

  const id = await startSessionAndConsumeBanner();

  // 生成大量输出 (约 100KB,不会触发 5MB 截断但验证缓冲可累积)
  // 使用 repeat 输出大量数据
  interactiveShellSend(id, isWindows
    ? "for /L %i in (1,1,100) do echo LINE_%i"
    : "for i in $(seq 1 100); do echo LINE_$i; done");

  // 轮询读取直到看到 LINE_100
  const output = await readUntilFound(id, "LINE_100", 10000);
  assert(output.includes("LINE_1"), "缓冲包含早期输出 LINE_1");
  assert(output.includes("LINE_100"), "缓冲包含末尾输出 LINE_100");

  await interactiveShellRead(id, { waitMs: 100, clear: true });
  interactiveShellClose(id);
  console.log("  ✅ 缓冲截断测试通过");
}

// ============================================================
// 12. 测试: stderr 捕获
// ============================================================

async function testStderrCapture(): Promise<void> {
  console.log("\n=== 测试: stderr 捕获 ===");

  const id = await startSessionAndConsumeBanner();

  // 向 stderr 写入 (Windows 和 Unix 方式不同)
  if (isWindows) {
    // cmd.exe 没有直接写 stderr 的命令,用 dir 不存在的目录产生错误输出
    interactiveShellSend(id, "dir C:\\nonexistent_dir_12345 2>&1");
  } else {
    interactiveShellSend(id, "echo stderr_msg >&2");
  }

  // 读取输出 (stdout + stderr 合并)
  const result = await interactiveShellRead(id, { waitMs: 3000 });
  assert(result !== null, "读取结果不为 null");

  if (result) {
    const combined = result.stdout + result.stderr;
    // Windows: dir 错误会输出 "File Not Found" 或类似消息
    // Unix: echo >&2 输出 "stderr_msg"
    const hasOutput = combined.trim().length > 0;
    assert(hasOutput, `stderr 被捕获 (combined len=${combined.length})`);
  }

  await interactiveShellRead(id, { waitMs: 100, clear: true });
  interactiveShellClose(id);
  console.log("  ✅ stderr 捕获测试通过");
}

// ============================================================
// 运行所有测试
// ============================================================

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   交互式终端工具测试                      ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`  平台: ${process.platform}`);

  // 确保开始前没有残留会话
  closeAllInteractiveSessions();

  const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: "基本会话生命周期", fn: testSessionLifecycle },
    { name: "发送输入并读取输出", fn: testSendAndRead },
    { name: "多命令交互场景", fn: testMultiCommandInteractive },
    { name: "多会话并发", fn: testMultipleSessions },
    { name: "边界情况", fn: testEdgeCases },
    { name: "带初始命令启动", fn: testStartWithCommand },
    { name: "cleanupDeadSessions", fn: testCleanupDeadSessions },
    { name: "工具工厂", fn: testToolFactories },
    { name: "MAX_SESSIONS 限制", fn: testMaxSessions },
    { name: "env 和 cwd 参数", fn: testEnvAndCwd },
    { name: "缓冲截断", fn: testBufferTruncation },
    { name: "stderr 捕获", fn: testStderrCapture },
  ];

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const test of tests) {
    try {
      await test.fn();
      passed++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${test.name}: ${msg}`);
      console.error(`\n❌ 测试失败 [${test.name}]: ${msg}`);
    } finally {
      // 每个测试后清理残留会话
      closeAllInteractiveSessions();
    }
  }

  console.log("\n╔══════════════════════════════════════════╗");
  console.log(`║   通过: ${passed}  失败: ${failed}  总计: ${tests.length}`);
  console.log("╚══════════════════════════════════════════╝");

  if (failed > 0) {
    console.error("\n失败详情:");
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }

  console.log("║   🎉 所有交互式终端工具测试通过!          ║");
  process.exit(0);
}

main();
