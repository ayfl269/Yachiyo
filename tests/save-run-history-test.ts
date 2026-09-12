/**
 * ProcessStage.saveRunHistory 回归测试
 *
 * 背景（两个历史缺陷）：
 *   1. 此前实现会把 agent 运行过程中的全部消息（含 tool_calls 中间态、tool
 *      结果消息）原样写入会话历史，导致保存的记录条数与用户实际收发不一致；
 *   2. 此前实现是"整体覆盖"：把 currentRunContext.messages（会被
 *      ContextManager.process() 按轮截断 / 用 LLM 摘要替换旧内容）整体写回
 *      conversation.history，导致一旦触发压缩，最早的轮次就从存储里消失了——
 *      而后台记忆索引读取的正是这份存储。
 *
 * 现在的语义：
 *   - 只追加本次运行产出的消息（runner 通过 runMessagesStartIndex 标记边界）；
 *   - 追加前先读存储，永远在存储末尾拼接，绝不整体覆盖；
 *   - 运行视图里被压缩掉的内容不影响存储；
 *   - 加载的历史与当前用户消息不在这里写（saveUserMessage 是用户消息的唯一
 *     写入者），因此每条消息恰好一个写入者，追加天然幂等；
 *   - system 触发运行的内部指令是"本次运行的 prompt"，同样被边界排除。
 */
// 注意：这里必须用相对路径引 src。裸包名（@yachiyo/pipeline/...）在 tsx 运行时
// 会经 package exports 解析到 dist，导致测试跑的是过期构建而不是当前源码。
import { ProcessStage } from "../packages/pipeline/src/stages/process.js";
import type { PipelineContext } from "../packages/pipeline/src/context.js";
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

interface StageFixture {
  stage: ProcessStage;
  updates: RecordedUpdate[];
  /** 当前存储内容（updateConversation 会同步更新它，模拟真实存储）。 */
  stored: Array<Record<string, unknown>>;
}

async function createStage(
  configOverrides: Record<string, unknown> = {},
  seedStored: Array<Record<string, unknown>> = [],
): Promise<StageFixture> {
  const updates: RecordedUpdate[] = [];
  const stored: Array<Record<string, unknown>> = seedStored.map((e) => ({ ...e }));
  const ctx = {
    config: { maxStep: 30, ...configOverrides },
    conversationManager: {
      getConversation: async () => ({ history: JSON.stringify(stored) }),
      updateConversation: async (
        umo: string,
        convId: string,
        data: { history: string },
      ) => {
        const parsed = JSON.parse(data.history) as Array<Record<string, unknown>>;
        stored.length = 0;
        stored.push(...parsed);
        updates.push({ umo, convId, history: parsed });
      },
    },
  };
  const stage = new ProcessStage();
  await stage.initialize(ctx as unknown as PipelineContext);
  return { stage, updates, stored };
}

/** ToolLoopAgentRunner 的最小 mock：暴露运行态消息与"本次运行起点"。 */
function createRunner(messages: Message[], runMessagesStartIndex = 0): unknown {
  return { currentRunContext: { messages }, runMessagesStartIndex };
}

async function saveHistory(
  stage: ProcessStage,
  runner: unknown,
  options?: { fallbackAssistantText?: string },
): Promise<void> {
  const fn = (stage as unknown as {
    saveRunHistory: (
      runner: unknown,
      umo: string,
      convId: string,
      options?: { fallbackAssistantText?: string },
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

  // ── system 触发运行的内部指令不落库（结构性排除：它是本次运行的 prompt） ──
  console.log("\n=== 内部指令（运行 prompt）不落库 ===");
  {
    const seed = [
      { role: "user", content: "之前的问题" },
      { role: "assistant", content: "之前的回答" },
    ];
    const { stage, updates, stored } = await createStage({}, seed);
    // 运行态消息 = 加载的历史 + 注入的内部指令；本次运行没有产出任何
    // assistant 消息（模拟一个"只执行了提醒动作"的运行）。
    const messages: Message[] = [
      msg("user", "之前的问题"),
      msg("assistant", "之前的回答"),
      msg("user", "[内部指令] 请提醒用户喝水"),
    ];
    await saveHistory(stage, createRunner(messages, 3));

    assert(updates.length === 0, "没有可追加的内容时不触发写入");
    assert(stored.length === 2, "存储内容保持不变");
    assert(!JSON.stringify(stored).includes("内部指令"), "内部指令内容不出现在历史中");
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

    await saveHistory(stage, { currentRunContext: undefined, runMessagesStartIndex: 0 });
    assert(updates.length === 0, "currentRunContext 缺失时不报错、不保存");

    await saveHistory(stage, createRunner([
      msg("system", "sys"),
      msg("assistant", undefined, { tool_calls: toolCall("call_3", "t") }),
      msg("tool", "r", { tool_call_id: "call_3" }),
    ]));
    assert(updates.length === 0, "全部被过滤时（纯中间态）不保存空历史");
  }

  // ── append-only：存储不做截断 ──
  console.log("\n=== append-only：存储不做截断 ===");
  {
    const { stage, updates } = await createStage({}, []);
    const messages: Message[] = Array.from({ length: 10 }, (_, i) => msg("user", `m${i}`));
    await saveHistory(stage, createRunner(messages));

    const history = updates[0].history;
    assert(history.length === 10, "maxHistoryMessages 不再截断落库内容（全量保留 10 条）");
    assert(
      history.map((e) => e.content).join(",") === "m0,m1,m2,m3,m4,m5,m6,m7,m8,m9",
      "完整按原顺序保留全部消息",
    );
  }

  // ── 追加而非覆盖：压缩截断运行视图后，存储内容不丢失 ──
  console.log("\n=== 压缩后追加，历史不丢 ===");
  {
    // 存储里已有 3 条历史（两轮完整对话）。
    const seed = [
      { role: "user", content: "旧问题1" },
      { role: "assistant", content: "旧回答1" },
      { role: "user", content: "旧问题2" },
    ];
    const { stage, updates, stored } = await createStage({}, seed);

    // 模拟 ContextManager 压缩后的运行视图：最早的一条（旧问题1）已被丢弃，
    // 本次运行只新产出一条 assistant 回复。运行起点为 1（加载的历史 + prompt
    // 之后的第一个下标）。
    const messages: Message[] = [
      msg("assistant", "旧回答1"),
      msg("user", "旧问题2"),
      msg("assistant", "新回复"),
    ];
    await saveHistory(stage, createRunner(messages, 2));

    assert(updates.length === 1, "触发一次追加写入");
    assert(stored.length === 4, `存储为 旧3 条 + 新1 条 = 4 条（实际=${stored.length}）`);
    assert(stored[0].content === "旧问题1", "被压缩丢弃的最早一条仍保留在存储中（append-only 生效）");
    assert(stored[3].content === "新回复", "本次运行的新回复追加在末尾");
    assert(
      stored.map((e) => e.role).join(",") === "user,assistant,user,assistant",
      "追加后的角色顺序仍然合法（user/assistant 交替）",
    );
  }

  // ── 加载的历史不会被重复追加 ──
  console.log("\n=== 加载的历史不重复追加 ===");
  {
    const seed = [
      { role: "user", content: "问题" },
      { role: "assistant", content: "回答" },
    ];
    const { stage, updates, stored } = await createStage({}, seed);
    // 运行视图包含加载的历史（起点 2），本次运行只产出一条回复。
    const messages: Message[] = [
      msg("user", "问题"),
      msg("assistant", "回答"),
      msg("assistant", "新回答"),
    ];
    await saveHistory(stage, createRunner(messages, 2));

    assert(updates.length === 1, "触发一次追加写入");
    assert(stored.length === 3, "存储只增加了本次运行的 1 条（实际=" + stored.length + "）");
    assert(stored.filter((e) => e.content === "回答").length === 1, "已存储的内容不会被重复追加");
  }

  // ── 运行没有产出可保存内容时，回退到管线提取的回复文本 ──
  console.log("\n=== 无产出时回退到提取的回复文本 ===");
  {
    const seed = [{ role: "user", content: "问题" }];
    const { stage, updates, stored } = await createStage({}, seed);
    // 运行视图为空（例如回复被压缩丢弃、或运行上下文已被消费）。
    await saveHistory(stage, createRunner([], 0), { fallbackAssistantText: "兜底回复" });

    assert(updates.length === 1, "回退路径仍触发一次写入");
    assert(stored.length === 2, "存储 = 旧 1 条 + 兜底回复 1 条");
    assert(stored[1].role === "assistant" && stored[1].content === "兜底回复", "兜底回复以 assistant 身份落库");
  }

  // ── 读存储失败时拒绝写入（避免盲目追加/覆盖） ──
  console.log("\n=== 读存储失败时拒绝写入 ===");
  {
    const updates: RecordedUpdate[] = [];
    const ctx = {
      config: { maxStep: 30 },
      conversationManager: {
        getConversation: async () => { throw new Error("db locked"); },
        updateConversation: async (
          umo: string,
          convId: string,
          data: { history: string },
        ) => {
          updates.push({ umo, convId, history: JSON.parse(data.history) as Array<Record<string, unknown>> });
        },
      },
    };
    const stage = new ProcessStage();
    await stage.initialize(ctx as unknown as PipelineContext);
    await saveHistory(stage, createRunner([msg("assistant", "新回复")], 0));
    assert(updates.length === 0, "读取存储失败时不执行写入");
  }

  // ── 错误响应不进历史（err 运行不提供兜底文本） ──
  console.log("\n=== 错误响应不进历史 ===");
  {
    const { stage } = await createStage();
    const apply = (stage as unknown as {
      applyNonStreamingResult: (event: unknown, runResult: unknown) => Promise<void>;
    }).applyNonStreamingResult;

    const makeEvent = () => {
      const extras = new Map<string, unknown>();
      return {
        event: {
          setResult: () => { /* 由 respond 阶段消费，这里无需记录 */ },
          setExtra: (k: string, v: unknown) => { extras.set(k, v); },
        },
        extras,
      };
    };

    // 失败运行：管线刻意不为 err 响应缓存回复文本 → saveRunHistory 拿不到兜底，
    // 且 runContext.messages 里也没有 err 消息（runner 不入列）→ 错误文本不进历史。
    const errCase = makeEvent();
    await apply.call(stage, errCase.event, {
      finalResponse: { role: "err", completionText: "LLM 响应错误: boom" },
      chains: [],
    });
    assert(!errCase.extras.has("_cachedAssistantText"), "err 响应不设置 _cachedAssistantText（错误文本不进历史）");

    // 成功运行：缓存回复文本，供 saveRunHistory 在"无产出"时兜底。
    const okCase = makeEvent();
    await apply.call(stage, okCase.event, {
      finalResponse: { role: "assistant", completionText: "正常回复" },
      chains: [],
    });
    assert(
      okCase.extras.get("_cachedAssistantText") === "正常回复",
      "成功响应缓存回复文本，供 saveRunHistory 兜底",
    );
  }

  // ── 透传参数 ──
  console.log("\n=== umo / convId 透传 ===");
  {
    const { stage, updates } = await createStage();
    await saveHistory(stage, createRunner([msg("assistant", "hi")], 0));
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
