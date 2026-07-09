/**
 * ask_user_question 工具测试
 *
 * 测试 createAskUserTool 创建的工具：
 * 1. 工具属性（name, parameters, active, isBackgroundTask）
 * 2. 基本问题发送（仅 question 参数）
 * 3. 带选项的问题（question + options）
 * 4. 带标题和选项（question + options + header）
 * 5. 空问题返回错误
 * 6. 无 send 函数的上下文（不抛错）
 * 7. send 抛出异常时返回 isError
 * 8. 通过 FunctionToolExecutor 集成调用
 */
import {
  createAskUserTool,
  type AskUserToolContext,
  type PlainMessageComponent,
} from "@yachiyo/agent/ask-user-tool.js";
import { FunctionToolExecutor } from "@yachiyo/agent/tool-executor.js";
import type { ContextWrapper, CallToolResult } from "@yachiyo/agent/types.js";

// ── Test helpers ──

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    failed++;
    failures.push(message);
    console.error(`  FAIL: ${message}`);
  } else {
    passed++;
    console.log(`  PASS: ${message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    const detail = `${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
    failures.push(detail);
    console.error(`  FAIL: ${detail}`);
  }
}

/**
 * 创建一个 mock 的 AskUserToolContext，记录 send 调用。
 * sendCalls 数组会收集每次调用时传入的 components。
 */
function createMockContext(options?: {
  sendShouldThrow?: Error;
  unifiedMsgOrigin?: string;
}): {
  ctx: AskUserToolContext;
  sendCalls: PlainMessageComponent[][];
} {
  const sendCalls: PlainMessageComponent[][] = [];
  const ctx: AskUserToolContext = {
    unifiedMsgOrigin: options?.unifiedMsgOrigin ?? "test:umo",
    send: options?.sendShouldThrow
      ? async () => {
          throw options.sendShouldThrow!;
        }
      : async (components: PlainMessageComponent[]) => {
          sendCalls.push(components);
        },
  };
  return { ctx, sendCalls };
}

/** 创建一个包装 AskUserToolContext 的 ContextWrapper */
function createWrapper(ctx: AskUserToolContext): ContextWrapper<AskUserToolContext> {
  return {
    context: ctx,
    messages: [],
    toolCallTimeout: 60,
  };
}

/** 从 CallToolResult 提取文本内容 */
function resultText(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// ── Tests ──

async function testToolProperties(): Promise<void> {
  console.log("\n── Test: 工具属性 ──");
  const tool = createAskUserTool();

  assertEqual(tool.name, "ask_user_question", "工具名称为 ask_user_question");
  assert(tool.description.length > 0, "工具描述非空");
  assert(tool.active === true, "工具默认启用");
  assert(tool.isBackgroundTask === false, "非后台任务");
  assert(typeof tool.handler === "function", "handler 已定义");

  const params = tool.parameters as Record<string, unknown>;
  const props = params.properties as Record<string, unknown>;
  assertEqual(params.type, "object", "parameters.type = object");
  assert("question" in props, "包含 question 参数");
  assert("options" in props, "包含 options 参数");
  assert("header" in props, "包含 header 参数");
  assertEqual(params.required, ["question"], "required = [question]");
}

async function testBasicQuestion(): Promise<void> {
  console.log("\n── Test: 基本问题（仅 question）──");
  const tool = createAskUserTool();
  const { ctx, sendCalls } = createMockContext();
  const wrapper = createWrapper(ctx);

  const result = (await tool.handler!(wrapper, "你想要什么语言？")) as CallToolResult;

  assert(sendCalls.length === 1, "send 被调用一次");
  assertEqual(sendCalls[0].length, 1, "发送单个组件");
  assertEqual(sendCalls[0][0].type, "Plain", "组件类型为 Plain");

  const sentText = sendCalls[0][0].text;
  assert(sentText.includes("你想要什么语言？"), "发送的文本包含问题");
  assert(!sentText.includes("【"), "无标题时不包含【】标记");
  assert(!sentText.includes("1."), "无选项时不包含编号列表");

  const text = resultText(result);
  assert(text.includes("Question sent to user successfully"), "返回结果包含成功提示");
  assert(text.includes("END your response"), "返回结果指示 LLM 停止生成");
  assert(!result.isError, "不是错误结果");
}

async function testQuestionWithOptions(): Promise<void> {
  console.log("\n── Test: 带选项的问题 ──");
  const tool = createAskUserTool();
  const { ctx, sendCalls } = createMockContext();
  const wrapper = createWrapper(ctx);

  const options = ["Python", "JavaScript", "Rust"];
  const result = (await tool.handler!(wrapper, "选择你喜欢的语言？", options)) as CallToolResult;

  assert(sendCalls.length === 1, "send 被调用一次");
  const sentText = sendCalls[0][0].text;

  assert(sentText.includes("选择你喜欢的语言？"), "包含问题文本");
  assert(sentText.includes("1. Python"), "包含选项 1");
  assert(sentText.includes("2. JavaScript"), "包含选项 2");
  assert(sentText.includes("3. Rust"), "包含选项 3");
  assert(sentText.includes("请回复选项编号 1-3"), "包含编号提示");

  const text = resultText(result);
  assert(text.includes("Options:"), "返回结果包含选项摘要");
  assert(text.includes("1. Python, 2. JavaScript, 3. Rust"), "返回结果包含所有选项");
  assert(!result.isError, "不是错误结果");
}

async function testQuestionWithHeaderAndOptions(): Promise<void> {
  console.log("\n── Test: 带标题和选项 ──");
  const tool = createAskUserTool();
  const { ctx, sendCalls } = createMockContext();
  const wrapper = createWrapper(ctx);

  const result = (await tool.handler!(
    wrapper,
    "使用哪种认证方式？",
    ["API Key", "OAuth 2.0", "JWT"],
    "Auth method"
  )) as CallToolResult;

  assert(sendCalls.length === 1, "send 被调用一次");
  const sentText = sendCalls[0][0].text;

  assert(sentText.startsWith("【Auth method】"), "以标题开头");
  assert(sentText.includes("使用哪种认证方式？"), "包含问题");
  assert(sentText.includes("1. API Key"), "包含选项 1");
  assert(sentText.includes("2. OAuth 2.0"), "包含选项 2");
  assert(sentText.includes("3. JWT"), "包含选项 3");
  assert(!result.isError, "不是错误结果");
}

async function testEmptyQuestion(): Promise<void> {
  console.log("\n── Test: 空问题返回错误 ──");
  const tool = createAskUserTool();
  const { ctx, sendCalls } = createMockContext();
  const wrapper = createWrapper(ctx);

  const result = (await tool.handler!(wrapper, "")) as CallToolResult;

  assertEqual(result.isError, true, "返回 isError = true");
  assert(sendCalls.length === 0, "未调用 send");
  const text = resultText(result);
  assert(text.includes("required"), "错误信息包含 required 提示");

  // 仅空白字符也应视为空
  const result2 = (await tool.handler!(wrapper, "   ")) as CallToolResult;
  assertEqual(result2.isError, true, "仅空白字符也返回 isError");
}

async function testNoSendFunction(): Promise<void> {
  console.log("\n── Test: 无 send 函数的上下文 ──");
  const tool = createAskUserTool();
  const ctx: AskUserToolContext = {
    unifiedMsgOrigin: "test:umo",
    // 不提供 send 函数
  };
  const wrapper = createWrapper(ctx);

  // 不应抛出异常
  const result = (await tool.handler!(wrapper, "这是一个问题？")) as CallToolResult;

  assert(!result.isError, "不返回错误（只是没发送）");
  const text = resultText(result);
  assert(text.includes("Question sent to user successfully"), "仍返回成功结果");
}

async function testSendThrowsError(): Promise<void> {
  console.log("\n── Test: send 抛出异常 ──");
  const tool = createAskUserTool();
  const { ctx } = createMockContext({
    sendShouldThrow: new Error("网络连接失败"),
  });
  const wrapper = createWrapper(ctx);

  const result = (await tool.handler!(wrapper, "问题？", ["A", "B"])) as CallToolResult;

  assertEqual(result.isError, true, "send 失败时返回 isError");
  const text = resultText(result);
  assert(text.includes("Failed to send question to user"), "错误信息包含失败提示");
  assert(text.includes("网络连接失败"), "错误信息包含原始错误消息");
}

async function testExecutorIntegration(): Promise<void> {
  console.log("\n── Test: FunctionToolExecutor 集成 ──");
  const tool = createAskUserTool();
  const { ctx, sendCalls } = createMockContext();
  const wrapper = createWrapper(ctx);

  const executor = new FunctionToolExecutor<AskUserToolContext>();
  const toolArgs = {
    question: "通过 executor 调用？",
    options: ["是", "否"],
    header: "集成测试",
  };

  const results: CallToolResult[] = [];
  for await (const r of executor.execute(tool, wrapper, toolArgs)) {
    if (r) results.push(r);
  }

  assertEqual(results.length, 1, "executor 产生 1 个结果");
  assert(sendCalls.length === 1, "send 被调用一次");

  const sentText = sendCalls[0][0].text;
  assert(sentText.includes("【集成测试】"), "通过 executor 调用也包含标题");
  assert(sentText.includes("1. 是"), "包含选项 1");
  assert(sentText.includes("2. 否"), "包含选项 2");

  const text = resultText(results[0]);
  assert(text.includes("Question sent to user successfully"), "返回成功结果");
  assert(!results[0].isError, "不是错误结果");
}

async function testSingleOptionIgnored(): Promise<void> {
  console.log("\n── Test: 单个选项不显示为列表 ──");
  const tool = createAskUserTool();
  const { ctx, sendCalls } = createMockContext();
  const wrapper = createWrapper(ctx);

  // options.length < 2 时不显示选项列表
  const result = (await tool.handler!(wrapper, "问题？", ["唯一选项"])) as CallToolResult;

  assert(sendCalls.length === 1, "send 被调用");
  const sentText = sendCalls[0][0].text;
  assert(!sentText.includes("1. 唯一选项"), "单个选项不格式化为列表");
  assert(!sentText.includes("请回复选项编号"), "不包含编号提示");
  assert(!result.isError, "不是错误");
}

// ── Main ──

async function main(): Promise<void> {
  console.log("═══ ask_user_question 工具测试 ═══");

  try {
    await testToolProperties();
    await testBasicQuestion();
    await testQuestionWithOptions();
    await testQuestionWithHeaderAndOptions();
    await testEmptyQuestion();
    await testNoSendFunction();
    await testSendThrowsError();
    await testExecutorIntegration();
    await testSingleOptionIgnored();
  } catch (e) {
    console.error("\n═══ UNEXPECTED ERROR ═══");
    console.error(e);
    failed++;
    failures.push(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log("\n═══════════════════════════════════");
  console.log(`通过: ${passed}  失败: ${failed}  总计: ${passed + failed}`);
  if (failures.length > 0) {
    console.log("\n失败详情:");
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
  }
  console.log(failed === 0 ? "\n✅ 所有 ask_user_question 测试通过!" : "\n❌ 存在失败的测试");
  process.exit(failed === 0 ? 0 : 1);
}

main();
