/**
 * 上下文窗口解析单测
 *
 * 覆盖两条解析路径：
 * 1. dashboard 侧 `pickContextLimit` —— 只读 provider API 官方元数据，绝不猜测。
 *    （`max_tokens` 仅在 ≥32k 时作为最后兜底，因为它在 OpenAI 兼容协议里通常是
 *    "最大输出量"；把它当窗口会让压缩触发线低到几千 tokens，几乎每轮都压缩。）
 * 2. agent 侧运行态解析 —— provider 探测值（未知时为 0）> 模型名容量后缀 > 默认 200k，
 *    以及 context-overflow 降级用的窗口阶梯与触发阈值派生。
 */
import { pickContextLimit, MIN_PLAUSIBLE_CONTEXT_WINDOW } from "../packages/dashboard/src/model-context-limit.js";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  CONTEXT_WINDOW_LADDER,
  extractContextLimitFromModelName,
  resolveModelContextWindow,
  nextSmallerContextWindow,
  deriveCompressTriggerTokens,
} from "../packages/agent/src/context/config.js";

// ── Test framework ──

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    const detail = `${message} (expected ${String(expected)}, got ${String(actual)})`;
    failures.push(detail);
    console.error(`  FAIL: ${detail}`);
  }
}

// ── pickContextLimit：官方字段优先 ──

function testPickContextLimit(): void {
  console.log("\n=== pickContextLimit：官方字段优先 ===");
  assertEqual(pickContextLimit({ context_length: 200000 }), 200000, "context_length 直接采信");
  assertEqual(pickContextLimit({ context_window: 131072 }), 131072, "context_window 直接采信");
  assertEqual(pickContextLimit({ max_context_length: 65536 }), 65536, "max_context_length 直接采信");
  assertEqual(pickContextLimit({ inputTokenLimit: 1048576 }), 1048576, "inputTokenLimit（Gemini 口径）直接采信");
  assertEqual(pickContextLimit({ max_input_tokens: 262144 }), 262144, "max_input_tokens（OpenRouter 口径）直接采信");
  assertEqual(pickContextLimit({ context_length: 4096 }), 4096, "官方字段偏小也采信（只有 <1000 才忽略）");
  assertEqual(pickContextLimit({ context_length: 500 }), undefined, "官方字段 <1000 视为无效");

  console.log("\n=== pickContextLimit：max_tokens 的 32k 下界 ===");
  assertEqual(pickContextLimit({ max_tokens: 4096 }), undefined, "max_tokens=4096（输出上限）不被当窗口");
  assertEqual(pickContextLimit({ max_tokens: 8192 }), undefined, "max_tokens=8192 不被当窗口");
  assertEqual(
    pickContextLimit({ max_tokens: MIN_PLAUSIBLE_CONTEXT_WINDOW - 1 }),
    undefined,
    "刚好低于下界时不采信",
  );
  assertEqual(
    pickContextLimit({ max_tokens: MIN_PLAUSIBLE_CONTEXT_WINDOW }),
    MIN_PLAUSIBLE_CONTEXT_WINDOW,
    "达到下界即采信",
  );
  assertEqual(pickContextLimit({ context_length: 4096, max_tokens: 65536 }), 4096, "官方字段存在时不看 max_tokens");
  assertEqual(pickContextLimit({}), undefined, "无任何字段返回 undefined");
  assertEqual(pickContextLimit({ max_tokens: "8192" }), undefined, "字符串型 max_tokens 不采信");
  assertEqual(pickContextLimit({ max_tokens: null }), undefined, "null 型 max_tokens 不采信");
}

// ── 默认窗口与模型名后缀 ──

function testDefaultsAndNameSuffix(): void {
  console.log("\n=== 默认窗口与模型名容量后缀 ===");
  assertEqual(DEFAULT_MODEL_CONTEXT_WINDOW, 200_000, "默认窗口为 200k（按现代模型最低能力估计，高估由运行态降级兜底）");
  assertEqual(CONTEXT_WINDOW_LADDER[0], 200_000, "降级阶梯最高档 200k");
  assertEqual(CONTEXT_WINDOW_LADDER[CONTEXT_WINDOW_LADDER.length - 1], 4_000, "降级阶梯最低档 4k");

  assertEqual(extractContextLimitFromModelName("qwen2.5-72b-128k"), 131072, "数字后缀按 1024 进制换算");
  assertEqual(extractContextLimitFromModelName("some-model-1m"), 1048576, "1m 后缀换算");
  assertEqual(extractContextLimitFromModelName(""), undefined, "空名称返回 undefined");
  // 家族分支已删除：模型族名不再映射窗口，未识别即 undefined。
  assertEqual(extractContextLimitFromModelName("claude-3-5-sonnet-20241022"), undefined, "claude-3 族不再硬编码（家族清单已删）");
  assertEqual(extractContextLimitFromModelName("gpt-4o-mini"), undefined, "gpt-4o 族不再硬编码");
  assertEqual(extractContextLimitFromModelName("deepseek-chat"), undefined, "无后缀模型返回 undefined");

  console.log("\n=== resolveModelContextWindow：运行态解析优先级 ===");
  assertEqual(resolveModelContextWindow(131072), 131072, "provider 探测值优先");
  assertEqual(resolveModelContextWindow(0, "qwen2.5-72b-128k"), 131072, "探测值缺失时用名称后缀");
  assertEqual(resolveModelContextWindow(undefined, "qwen2.5-72b-128k"), 131072, "undefined 探测值同样走名称后缀");
  assertEqual(resolveModelContextWindow(0, "claude-sonnet-4"), 200_000, "无探测值且无后缀 → 默认 200k");
  assertEqual(resolveModelContextWindow(-5), 200_000, "非法探测值 → 默认 200k");
}

// ── 降级阶梯与触发阈值派生 ──

function testDowngradeLadder(): void {
  console.log("\n=== nextSmallerContextWindow：降级阶梯 ===");
  assertEqual(nextSmallerContextWindow(200_000), 128_000, "200k → 128k");
  assertEqual(nextSmallerContextWindow(128_000), 64_000, "128k → 64k");
  assertEqual(nextSmallerContextWindow(4_000), undefined, "已到阶梯底部 → 放弃降级");
  assertEqual(nextSmallerContextWindow(100_000), 64_000, "非阶梯值也取严格小于它的最大档");
  // 报错里带真实窗口：比当前假设小 → 直接采用（一次失败拿到精确值）
  assertEqual(nextSmallerContextWindow(200_000, 8192), 8192, "报错里的真实窗口优先于阶梯");
  // 报错里的数字不比当前假设小（如 Anthropic 报 200000 > 200000）→ 仍按阶梯下调
  assertEqual(nextSmallerContextWindow(200_000, 200_000), 128_000, "解析值不小于当前假设时按阶梯下调");

  console.log("\n=== deriveCompressTriggerTokens：触发阈值派生 ===");
  assertEqual(deriveCompressTriggerTokens(128_000, 4096), 105_318, "128k 窗口 + 4096 预留 → 105318");
  assertEqual(deriveCompressTriggerTokens(4_096, 4_096), 1_740, "小窗口走半窗口钳制（预留被扣成 0 也不会失控）");
  assertEqual(deriveCompressTriggerTokens(0, 4_096), 0, "窗口未知 → 不启用 token 维度控制");
  assertEqual(deriveCompressTriggerTokens(2_000, 4_096), 850, "预留大于窗口时取窗口一半");
}

// ── 汇总 ──

function main(): void {
  testPickContextLimit();
  testDefaultsAndNameSuffix();
  testDowngradeLadder();

  console.log(`\n总计: ${passed + failed} | 通过: ${passed} | 失败: ${failed}`);
  if (failures.length) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main();
