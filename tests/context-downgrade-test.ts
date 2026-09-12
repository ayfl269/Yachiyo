/**
 * context-overflow 降级机制单测
 *
 * 背景：模型上下文窗口的"假设值"可能高估（默认 200k 起步，或中转丢失元数据）。
 * provider 报上下文超限时，运行态据此把假设窗口下调并**从压缩前的原始列表**
 * 重新压缩，而不是在已被压缩过的视图上继续压缩（否则每降一级就再丢一层历史）。
 *
 * 本文件覆盖三块：
 * 1. provider 层的 overflow 识别与"真实窗口"解析（报错文本自带数字时一次拿到精确值）；
 * 2. 降级阶梯 `nextSmallerContextWindow` 的边界；
 * 3. `ContextManager.process` 的 maxContextTokens override 确实会下调压缩触发阈值。
 */
import {
  ContextLengthExceededError,
  ProviderAPIError,
  isContextOverflowError,
  isContextOverflowText,
  parseContextOverflowLimit,
} from "../packages/provider/src/errors.js";
import { ContextManager } from "../packages/agent/src/context/manager.js";
import { createContextConfig, nextSmallerContextWindow } from "../packages/agent/src/context/config.js";
import type { Message } from "@yachiyo/common/llm-message.js";

// ── Test framework ──

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.error(`  FAIL: ${message}`);
  }
}

// ── 1. overflow 识别与真实窗口解析 ──

function testParseContextOverflowLimit(): void {
  console.log("\n=== parseContextOverflowLimit：从报错解析真实窗口 ===");
  // OpenAI 经典报错
  assert(
    parseContextOverflowLimit(
      "This model's maximum context length is 16385 tokens. However, you requested 20000 tokens (15000 in the messages, 5000 in the completion)."
    ) === 16385,
    "OpenAI 报错解析出 16385",
  );
  // Anthropic 经典报错
  assert(
    parseContextOverflowLimit("prompt is too long: 12345 tokens > 200000 maximum") === 200000,
    "Anthropic 报错解析出 200000",
  );
  // 常见网关
  assert(
    parseContextOverflowLimit("request failed: input context length limit 8192 tokens exceeded") === 8192,
    "网关报错解析出 8192",
  );
  // 不带数字 / 无关文本
  assert(parseContextOverflowLimit("context_length_exceeded") === undefined, "只有错误码时解析不出数字");
  assert(parseContextOverflowLimit("Unauthorized") === undefined, "无关报错返回 undefined");
  assert(parseContextOverflowLimit("") === undefined, "空文本返回 undefined");
  // 过小的数字不当窗口（如 "requested 12 tokens"）
  assert(
    parseContextOverflowLimit("you requested 12 tokens but the limit is 500") === undefined,
    "过小的数字（<1024）不当作窗口",
  );
}

function testIsContextOverflow(): void {
  console.log("\n=== isContextOverflow：类型优先、文本兜底 ===");
  // 类型判断
  assert(isContextOverflowError(new ContextLengthExceededError("openai")), "ContextLengthExceededError 命中");
  const coded = new ProviderAPIError("oneapi", 400, "context_length_exceeded", "bad request");
  assert(isContextOverflowError(coded), "errorCode=context_length_exceeded 的 ProviderAPIError 命中");
  // 文本兜底（兼容不抛类型的网关）
  assert(
    isContextOverflowError(new Error("This model's maximum context length is 8192 tokens.")),
    "文本含 maximum context length 命中",
  );
  assert(isContextOverflowText("prompt is too long: 1 tokens > 200000 maximum"), "Anthropic 文本命中");
  // 非超限错误不得命中（否则 401/429/500 会被误降级）
  assert(!isContextOverflowError(new Error("401 Unauthorized")), "401 不命中");
  assert(!isContextOverflowError(new ProviderAPIError("openai", 429, "rate_limit_exceeded", "Rate limit exceeded")), "429 不命中");
  assert(!isContextOverflowError(new Error("internal server error 500")), "500 不命中");
  assert(!isContextOverflowText(""), "空文本不命中");
}

// ── 2. 降级阶梯边界 ──

function testLadderBoundaries(): void {
  console.log("\n=== 降级阶梯边界 ===");
  assert(nextSmallerContextWindow(8_000) === 4_000, "8k → 4k");
  assert(nextSmallerContextWindow(4_000) === undefined, "4k 已是最低档 → undefined");
  assert(nextSmallerContextWindow(2_000) === undefined, "低于最低档 → undefined");
  assert(nextSmallerContextWindow(128_000, 4_000) === 4_000, "解析值可以直接降到阶梯外");
}

// ── 3. ContextManager 的 maxContextTokens override ──

function pair(index: number): Message[] {
  // 每条约 2000 个英文单词字符 ≈ 600 tokens（估算口径：英文 0.3 token/字）
  const text = `turn ${index} `.padEnd(12, "x") + "y".repeat(2000);
  return [
    { role: "user", content: `question ${index}: ${text}` },
    { role: "assistant", content: `answer ${index}: ${text}` },
  ];
}

async function testContextManagerOverride(): Promise<void> {
  console.log("\n=== ContextManager.process 的 maxContextTokens override ===");

  // 窗口 100k：触发线 ≈ 81640，正常消息量不会触发压缩。
  const manager = new ContextManager(createContextConfig({ maxContextTokens: 100_000 }));
  const messages: Message[] = [1, 2, 3, 4].flatMap(pair);

  const untouched = await manager.process(messages.map((m) => ({ ...m })));
  assert(untouched.length === messages.length, "默认窗口下不触发压缩（8 条消息全保留）");

  // override 到 2k：触发线 = floor(max(2000-4096, 1000) × 0.85) = 850，
  // 4800 tokens 远超 → 必须压缩（丢弃最早的轮次）。
  const downgraded = await manager.process(messages.map((m) => ({ ...m })), 0, { maxContextTokens: 2_000 });
  assert(downgraded.length < messages.length, `override 生效：消息被压缩（${messages.length} → ${downgraded.length}）`);
  assert(downgraded[downgraded.length - 1].role === "assistant", "压缩保留最新消息");

  // 原始列表不被就地改写（降级重试依赖这一点：可反复从快照重压）。
  assert(messages.length === 8, "传入的原始列表长度不变（process 不就地改写入参）");
  assert(
    (messages[0].content as string).startsWith("question 1:"),
    "原始列表第一条内容未被改动",
  );
}

// ── 汇总 ──

async function main(): Promise<void> {
  testParseContextOverflowLimit();
  testIsContextOverflow();
  testLadderBoundaries();
  await testContextManagerOverride();

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
