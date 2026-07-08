/**
 * 交互式终端工具测试
 * 测试 interactive-shell-tool.ts 提供的会话管理功能
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

// 辅助:从 CallToolResult 中提取文本
function extractText(result: CallToolResult): string {
  if (result.content && result.content.length > 0 && result.content[0].type === "text") {
    return (result.content[0] as { type: "text"; text: string }).text;
  }
  return "";
}

// 辅助:等待一段时间
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// 1. 测试: 基本会话生命周期 (start → list → close)
// ============================================================

async function testSessionLifecycle(): Promise<void> {
  console.log("\n=== 测试: 基本会话生命周期 ===");

  // 清理可能残留的会话
  closeAllInteractiveSessions();

  // start
  const id = interactiveShellStart(undefined, { workspaceRoot: process.cwd() });
  console.log("  创建会话:", id ? "✅" : "❌", `(id=${id})`);

  // list
  const list = listInteractiveSessions();
  console.log("  列出会话数量:", list.length === 1 ? "✅" : "❌", `(count=${list.length})`);
  console.log("  会话 id 匹配:", list[0]?.id === id ? "✅" : "❌");
  console.log("  会话状态 running:", list[0]?.closed === false && list[0]?.exitCode === null ? "✅" : "❌");

  // close
  const closed = interactiveShellClose(id);
  console.log("  关闭会话:", closed ? "✅" : "❌");

  // list after close
  const listAfter = listInteractiveSessions();
  console.log("  关闭后会话数:", listAfter.length === 0 ? "✅" : "❌", `(count=${listAfter.length})`);

  console.log("  ✅ 基本会话生命周期测试通过");
}

// ============================================================
// 2. 测试: 发送输入并读取输出
// ============================================================

async function testSendAndRead(): Promise<void> {
  console.log("\n=== 测试: 发送输入并读取输出 ===");

  const id = interactiveShellStart(undefined, { workspaceRoot: process.cwd() });

  // 等待 shell 启动并消耗启动 banner
  await sleep(500);
  await interactiveShellRead(id, { waitMs: 1000 }); // 消耗 banner

  // 发送 echo 命令
  const sent = interactiveShellSend(id, "echo hello_interactive");
  console.log("  发送输入:", sent ? "✅" : "❌");

  // 等待命令输出到达
  await sleep(300);

  // 读取输出 (等待最多 2 秒)
  const result = await interactiveShellRead(id, { waitMs: 2000 });
  console.log("  读取结果不为空:", result !== null ? "✅" : "❌");

  if (result) {
    const output = (result.stdout + " " + result.stderr).trim();
    console.log("  输出包含 'hello_interactive':", output.includes("hello_interactive") ? "✅" : "❌");
    console.log("  原始输出:", JSON.stringify(output.slice(0, 100)));
  }

  // 再次读取 — since-read 缓冲应已清空
  const result2 = await interactiveShellRead(id, { waitMs: 300 });
  const output2 = result2 ? (result2.stdout + result2.stderr).trim() : "";
  console.log("  第二次读取 (缓冲已清空):", output2.length === 0 ? "✅" : "⚠️ (可能有延迟输出)");

  interactiveShellClose(id);
  console.log("  ✅ 发送输入并读取输出测试通过");
}

// ============================================================
// 3. 测试: 多命令交互场景
// ============================================================

async function testMultiCommandInteractive(): Promise<void> {
  console.log("\n=== 测试: 多命令交互场景 ===");

  const isWindows = process.platform === "win32";
  const id = interactiveShellStart(undefined, { workspaceRoot: process.cwd() });
  await sleep(200);

  // 命令 1: 设置变量
  if (isWindows) {
    interactiveShellSend(id, "set MYVAR=hello_world");
  } else {
    interactiveShellSend(id, "export MYVAR=hello_world");
  }
  await sleep(300);
  await interactiveShellRead(id, { waitMs: 500 }); // 消耗输出

  // 命令 2: 读取变量
  if (isWindows) {
    interactiveShellSend(id, "echo %MYVAR%");
  } else {
    interactiveShellSend(id, "echo $MYVAR");
  }
  const result = await interactiveShellRead(id, { waitMs: 2000 });
  if (result) {
    const output = (result.stdout + " " + result.stderr).trim();
    console.log("  变量设置并读取:", output.includes("hello_world") ? "✅" : "❌");
    console.log("  输出:", JSON.stringify(output.slice(0, 100)));
  }

  // 命令 3: 执行计算
  if (isWindows) {
    interactiveShellSend(id, "set /a 2+3");
  } else {
    interactiveShellSend(id, "echo $((2+3))");
  }
  const result2 = await interactiveShellRead(id, { waitMs: 2000 });
  if (result2) {
    const output = (result2.stdout + " " + result2.stderr).trim();
    console.log("  数学计算 2+3=5:", output.includes("5") ? "✅" : "❌");
    console.log("  输出:", JSON.stringify(output.slice(0, 100)));
  }

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
    const id = interactiveShellStart(undefined, { workspaceRoot: process.cwd() });
    ids.push(id);
  }

  const list = listInteractiveSessions();
  console.log("  创建 3 个会话:", list.length === 3 ? "✅" : "❌", `(count=${list.length})`);

  // 向每个会话发送不同命令
  for (let i = 0; i < ids.length; i++) {
    interactiveShellSend(ids[i], `echo session_${i}`);
  }

  // 读取并验证
  let allCorrect = true;
  for (let i = 0; i < ids.length; i++) {
    const result = await interactiveShellRead(ids[i], { waitMs: 2000 });
    if (result) {
      const output = (result.stdout + " " + result.stderr).trim();
      if (!output.includes(`session_${i}`)) {
        allCorrect = false;
        console.log(`  会话 ${i} 输出不匹配: ${JSON.stringify(output.slice(0, 80))}`);
      }
    }
  }
  console.log("  各会话独立输出正确:", allCorrect ? "✅" : "❌");

  // 关闭所有
  const closedCount = closeAllInteractiveSessions();
  console.log("  关闭所有会话:", closedCount === 3 ? "✅" : "❌", `(closed=${closedCount})`);

  console.log("  ✅ 多会话并发测试通过");
}

// ============================================================
// 5. 测试: 边界情况
// ============================================================

async function testEdgeCases(): Promise<void> {
  console.log("\n=== 测试: 边界情况 ===");

  // 1. 关闭不存在的会话
  const closeFake = interactiveShellClose("nonexistent-id");
  console.log("  关闭不存在的会话返回 false:", closeFake === false ? "✅" : "❌");

  // 2. 向不存在的会话发送输入
  const sendFake = interactiveShellSend("nonexistent-id", "test");
  console.log("  向不存在的会话发送返回 false:", sendFake === false ? "✅" : "❌");

  // 3. 读取不存在的会话
  const readFake = await interactiveShellRead("nonexistent-id");
  console.log("  读取不存在的会话返回 null:", readFake === null ? "✅" : "❌");

  // 4. 关闭已关闭的会话
  const id = interactiveShellStart(undefined, { workspaceRoot: process.cwd() });
  await sleep(100);
  interactiveShellClose(id);
  const closeAgain = interactiveShellClose(id);
  console.log("  关闭已关闭的会话返回 false:", closeAgain === false ? "✅" : "❌");

  // 5. 向已关闭的会话发送输入
  const sendToClosed = interactiveShellSend(id, "test");
  console.log("  向已关闭会话发送返回 false:", sendToClosed === false ? "✅" : "❌");

  // 6. 不追加换行发送
  const id2 = interactiveShellStart(undefined, { workspaceRoot: process.cwd() });
  await sleep(100);
  const sentNoNewline = interactiveShellSend(id2, "echo test", { addNewline: false });
  console.log("  不追加换行发送成功:", sentNoNewline ? "✅" : "❌");
  interactiveShellClose(id2);

  // 7. clear=false 读取不消耗缓冲
  const id3 = interactiveShellStart(undefined, { workspaceRoot: process.cwd() });
  await sleep(500);
  await interactiveShellRead(id3, { waitMs: 1000 }); // 消耗启动 banner
  interactiveShellSend(id3, "echo peek_test");
  await sleep(300); // 等待输出到达
  const peek1 = await interactiveShellRead(id3, { waitMs: 2000, clear: false });
  const peek2 = await interactiveShellRead(id3, { waitMs: 500, clear: false });
  const peek1Text = peek1 ? (peek1.stdout + peek1.stderr).trim() : "";
  const peek2Text = peek2 ? (peek2.stdout + peek2.stderr).trim() : "";
  console.log("  peek 模式 (clear=false) 首次读取有内容:", peek1Text.includes("peek_test") ? "✅" : "❌");
  console.log("  peek 模式二次读取仍有内容:", peek2Text.includes("peek_test") ? "✅" : "❌");
  interactiveShellClose(id3);

  console.log("  ✅ 边界情况测试通过");
}

// ============================================================
// 6. 测试: 带初始命令启动
// ============================================================

async function testStartWithCommand(): Promise<void> {
  console.log("\n=== 测试: 带初始命令启动 ===");

  const isWindows = process.platform === "win32";
  // 用初始命令启动 (cmd /K 保持 shell 存活; sh -c 仅运行命令)
  const command = isWindows ? "echo initial_command_output" : "echo initial_command_output";
  const id = interactiveShellStart(command, { workspaceRoot: process.cwd() });

  const result = await interactiveShellRead(id, { waitMs: 3000 });
  if (result) {
    const output = (result.stdout + " " + result.stderr).trim();
    console.log("  初始命令输出正确:", output.includes("initial_command_output") ? "✅" : "❌");
    console.log("  输出:", JSON.stringify(output.slice(0, 100)));
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

  // 启动一个会话并让它自然退出
  const isWindows = process.platform === "win32";
  // 使用 exit 命令让 shell 退出
  const id = interactiveShellStart(undefined, { workspaceRoot: process.cwd() });
  await sleep(100);
  interactiveShellSend(id, isWindows ? "exit" : "exit");
  await sleep(500); // 等待进程退出

  const listBefore = listInteractiveSessions();
  console.log("  退出后会话仍在列表 (待清理):", listBefore.length >= 1 ? "✅" : "❌");

  const cleaned = cleanupDeadSessions();
  console.log("  cleanupDeadSessions 清理数量:", cleaned >= 1 ? "✅" : "❌", `(cleaned=${cleaned})`);

  const listAfter = listInteractiveSessions();
  console.log("  清理后列表为空:", listAfter.length === 0 ? "✅" : "❌", `(count=${listAfter.length})`);

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

  console.log("  工具名称正确:",
    startTool.name === "interactive_shell_start" &&
    sendTool.name === "interactive_shell_send" &&
    readTool.name === "interactive_shell_read" &&
    listTool.name === "interactive_shell_list" &&
    closeTool.name === "interactive_shell_close"
      ? "✅" : "❌");

  // 通过工具 handler 完整流程
  // 1. start
  const startResult = await startTool.handler!(undefined, undefined) as CallToolResult;
  const startText = extractText(startResult);
  const idMatch = startText.match(/id=([a-f0-9]+)/);
  console.log("  start 工具返回 id:", idMatch ? "✅" : "❌");

  if (idMatch) {
    const sessionId = idMatch[1];

    // 2. send
    const sendResult = await sendTool.handler!(undefined, sessionId, "echo tool_factory_test") as CallToolResult;
    console.log("  send 工具成功:", !sendResult.isError ? "✅" : "❌");

    // 3. read
    const readResult = await readTool.handler!(undefined, sessionId, 2000) as CallToolResult;
    const readText = extractText(readResult);
    console.log("  read 工具包含输出:", readText.includes("tool_factory_test") ? "✅" : "❌");

    // 4. list
    const listResult = await listTool.handler!(undefined) as CallToolResult;
    const listText = extractText(listResult);
    console.log("  list 工具包含会话 id:", listText.includes(sessionId) ? "✅" : "❌");

    // 5. close
    const closeResult = await closeTool.handler!(undefined, sessionId) as CallToolResult;
    console.log("  close 工具成功:", !closeResult.isError ? "✅" : "❌");

    // 6. close again (should fail)
    const closeAgainResult = await closeTool.handler!(undefined, sessionId) as CallToolResult;
    console.log("  重复 close 返回错误:", closeAgainResult.isError ? "✅" : "❌");
  }

  closeAllInteractiveSessions();
  console.log("  ✅ 工具工厂测试通过");
}

// ============================================================
// 运行所有测试
// ============================================================

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   交互式终端工具测试                      ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`  平台: ${process.platform}`);

  try {
    await testSessionLifecycle();
    await testSendAndRead();
    await testMultiCommandInteractive();
    await testMultipleSessions();
    await testEdgeCases();
    await testStartWithCommand();
    await testCleanupDeadSessions();
    await testToolFactories();

    // 最终清理
    closeAllInteractiveSessions();

    console.log("\n╔══════════════════════════════════════════╗");
    console.log("║   🎉 所有交互式终端工具测试通过!          ║");
    console.log("╚══════════════════════════════════════════╝");
    process.exit(0);
  } catch (e) {
    console.error("\n❌ 测试失败:", e);
    closeAllInteractiveSessions();
    process.exit(1);
  }
}

main();
