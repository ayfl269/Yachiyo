/**
 * ProcessStage.saveRunHistory 回归测试
 *
 * 背景：此前实现会把 agent 运行过程中的全部消息（含 tool_calls 中间态、
 * tool 结果消息）原样写入会话历史，导致：
 *   1. 保存的记录条数与用户实际发送/接收的数量不一致；
 *   2. 工具调用记录与工具返回数据被持久化到对话数据中。
 *
 * 修复后 saveRunHistory 只保存干净的 user/assistant 转写：
 *   - system / _checkpoint / tool 角色全部跳过；
 *   - 仅携带 tool_calls（无可见文本）的 assistant 消息跳过；
 *   - 带可见文本的 assistant 消息保留文本、剥离 tool_calls 元数据；
 *   - _noSave 标记的消息跳过；
 *   - systemTriggered 运行注入的最后一条 user 指令不落库；
 *   - 历史超过 maxHistoryMessages 时截断保留最近的消息。
 */
import { ProcessStage } from "@yachiyo/pipeline/stages/process.js";
import type { PipelineContext } from "@yachiyo/pipeline/context.js";
import type { Message } from "@yachiyo/common/llm-message.js";

// ── Test framework ──

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

// ── Helpers ──

interface RecordedUpdate {
  umo: string;
  convId: string;
  history: Array<Record<string, unknown>>;
}

async function createStage(configOverrides: Record<string, unknown> = {}): Promise<{
  stage: ProcessStage;
  updates: RecordedUpdate[];
}> {
  const updates: RecordedUpdate[] = [];
  const ctx = {
    config: { maxStep: 30, ...configOverrides },
    conversationManager: {
      updateConversation: async (umo: string, convId: string, data: { history: string }) => {
        updates.push({ umo, convId, history: JSON.parse(data.history) as Array<Record<string, unknown>> });
      },
    },
  };
  const stage = new ProcessStage();
  await stage.initialize(ctx as unknown as PipelineContext);
  return { stage, updates };
}

/** ToolLoopAgentRunner 的最小 mock：只暴露 currentRunContext.messages */
function createRunner(messages: Message[]): unknown {
  return { currentRunContext: { messages } };
}

async function saveHistory(
  stage: ProcessStage,
  runner: unknown,
  options?: { systemTriggered?: boolean },
): Promise<void> {
  const fn = (stage as unknown as {
    saveRunHistory: (
      runner: unknown,
      umo: string,
      convId: string,
      options?: { systemTriggered?: boolean },
    ) => Promise<void>;
  }).saveRunHistory;
  await fn.call(stage, runner, "onebot11:private:888", "conv-1", options);
}

function msg(role: Message["role"], content?: Message["content"], extra: Partial<Message> = {}): Message {
  return { role, ...(content !== undefined ? { content } : {}), ...extra } as Message;
}

function toolCall(id: string, name: string): Message["tool_calls"] {
  return [{ type: "function", id, function: { name, arguments: "{}" } }];
}

// ── Tests ──

async function main() {
  // ── 工具调用中间态过滤 ──
  console.log("\n=== 工具调用中间态过滤 ===");
  {
    const { stage, updates } = await createStage();
    const messages: Message[] = [
      msg("system", "你是助手"),
      msg("user", "今天天气如何？"),
      msg("assistant", undefined, { tool_calls: toolCall("call_1", "get_weather") }),
      msg("tool", '{"temp": 25}', { tool_call_id: "call_1" }),
      msg("assistant", "今天 25 度，晴。"),
    ];
    await saveHistory(stage, createRunner(messages));

    assert(updates.length === 1, "完成一次 updateConversation");
    const history = updates[0].history;
    assert(history.length === 2, "只保存 user 与最终 assistant 两条（记录数与实际收发一致）");
    assert(history[0].role === "user" && history[0].content === "今天天气如何？", "user 消息保留原文");
    assert(history[1].role === "assistant" && history[1].content === "今天 25 度，晴。", "最终 assistant 回复保留");
    assert(
      history.every((e) => typeof e.role === "string" && (typeof e.content === "string" || Array.isArray(e.content))),
      "每条记录满足 role(string) + content(string|content-part array) 的持久化格式",
    );
  }

  // ── 带可见文本的 assistant 消息：保留文本、剥离 tool_calls ──
  console.log("\n=== assistant 可见文本与元数据剥离 ===");
  {
    const { stage, updates } = await createStage();
    const messages: Message[] = [
      msg("user", "查一下"),
      msg("assistant", "我先查一下工具", { tool_calls: toolCall("call_2", "search") }),
      msg("tool", "结果", { tool_call_id: "call_2" }),
      msg("assistant", "查询完成"),
    ];
    await saveHistory(stage, createRunner(messages));

    const history = updates[0].history;
    assert(history.length === 3, "user 与两条带文本的 assistant 均保留（tool 中间态跳过）");
    assert(
      history[1].role === "assistant" && history[1].content === "我先查一下工具",
      "带文本的 assistant 消息保留（含 tool_calls 但有可见文本）",
    );
    assert(!("tool_calls" in history[1]), "tool_calls 元数据不落库");
    assert(!("tool_call_id" in history[1]), "tool_call_id 不落库");
  }

  // ── _checkpoint / _noSave 过滤 ──
  console.log("\n=== _checkpoint 与 _noSave 过滤 ===");
  {
    const { stage, updates } = await createStage();
    const messages: Message[] = [
      msg("user", "正常消息"),
      msg("_checkpoint", { id: "cp1" }),
      msg("user", "临时消息", { _noSave: true }),
      msg("assistant", "回复"),
    ];
    await saveHistory(stage, createRunner(messages));

    const history = updates[0].history;
    assert(history.length === 2, "_checkpoint 与 _noSave 消息均被跳过");
    assert(history[0].content === "正常消息" && history[1].content === "回复", "保留的消息内容正确");
  }

  // ── systemTriggered：内部指令不落库 ──
  console.log("\n=== systemTriggered 内部指令过滤 ===");
  {
    const { stage, updates } = await createStage();
    const messages: Message[] = [
      msg("user", "之前的问题"),
      msg("assistant", "之前的回答"),
      msg("user", "[内部指令] 请提醒用户喝水"),
    ];

    await saveHistory(stage, createRunner(messages), { systemTriggered: true });
    let history = updates[0].history;
    assert(history.length === 2, "systemTriggered 跳过最后一条 user（内部指令）");
    assert(!JSON.stringify(history).includes("内部指令"), "内部指令内容不出现在历史中");

    updates.length = 0;
    await saveHistory(stage, createRunner(messages));
    history = updates[0].history;
    assert(history.length === 3, "非 systemTriggered 时 user 消息正常保留");
  }

  // ── 空文本与 ContentPart 数组 ──
  console.log("\n=== 空文本与 ContentPart 数组 ===");
  {
    const { stage, updates } = await createStage();
    const messages: Message[] = [
      msg("assistant", ""),
      msg("assistant", "   "),
      msg("assistant", [{ type: "text", text: "多模态回复" }]),
      msg("user", "问题"),
    ];
    await saveHistory(stage, createRunner(messages));

    const history = updates[0].history;
    assert(history.length === 2, "空字符串/纯空白 assistant 消息被跳过");
    const parts = history[0].content as Array<{ type: string; text?: string }>;
    assert(Array.isArray(parts) && parts[0]?.type === "text" && parts[0]?.text === "多模态回复", "ContentPart 数组内容原样保留");
  }

  // ── 空消息 / 纯中间态 → 不触发保存 ──
  console.log("\n=== 空消息与纯中间态 ===");
  {
    const { stage, updates } = await createStage();

    await saveHistory(stage, createRunner([]));
    assert(updates.length === 0, "空 messages 不触发 updateConversation");

    await saveHistory(stage, { currentRunContext: undefined });
    assert(updates.length === 0, "currentRunContext 缺失时不报错、不保存");

    await saveHistory(stage, createRunner([
      msg("system", "sys"),
      msg("assistant", undefined, { tool_calls: toolCall("call_3", "t") }),
      msg("tool", "r", { tool_call_id: "call_3" }),
    ]));
    assert(updates.length === 0, "全部被过滤时（纯中间态）不保存空历史");
  }

  // ── maxHistoryMessages 截断 ──
  console.log("\n=== maxHistoryMessages 截断 ===");
  {
    const { stage, updates } = await createStage({ maxHistoryMessages: 3 });
    const messages: Message[] = Array.from({ length: 10 }, (_, i) => msg("user", `m${i}`));
    await saveHistory(stage, createRunner(messages));

    const history = updates[0].history;
    assert(history.length === 3, "超出上限时截断为 maxHistoryMessages 条");
    assert(
      history.map((e) => e.content).join(",") === "m7,m8,m9",
      "截断保留最近的消息",
    );
  }

  // ── 默认上限 200 ──
  console.log("\n=== 默认上限 200 ===");
  {
    const { stage, updates } = await createStage();
    const messages: Message[] = Array.from({ length: 250 }, (_, i) => msg("user", `m${i}`));
    await saveHistory(stage, createRunner(messages));
    assert(updates[0].history.length === 200, "未配置时默认截断为 200 条");
    assert(updates[0].history[0].content === "m50", "默认截断从第 51 条开始保留");
  }

  // ── 透传参数 ──
  console.log("\n=== umo / convId 透传 ===");
  {
    const { stage, updates } = await createStage();
    await saveHistory(stage, createRunner([msg("user", "hi")]));
    assert(updates[0].umo === "onebot11:private:888" && updates[0].convId === "conv-1", "umo 与 convId 正确透传给 updateConversation");
  }

  // ── 汇总 ──
  console.log(`\n总计: ${passed + failed} | 通过: ${passed} | 失败: ${failed}`);
  if (failures.length) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("测试执行异常:", e);
  process.exit(1);
});
