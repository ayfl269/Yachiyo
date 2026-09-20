/**
 * 思考强度（reasoning effort）测试
 *
 * 覆盖：
 * 1. reasoning.ts 的映射与模型门控（Anthropic/OpenAI/Responses/Gemini）
 * 2. 四个 provider 请求体中的原生字段是否正确写入/省略
 * 3. ProviderChatParams.reasoningEffort 与 ProviderConfig.reasoningEffort 的回退
 * 4. 非推理模型不发送字段（避免上游 400）
 */
import { AnthropicProvider } from "@yachiyo/provider/implementations/anthropic-provider.js";
import { OpenAIProvider } from "@yachiyo/provider/implementations/openai-provider.js";
import { OpenAIResponsesProvider } from "@yachiyo/provider/implementations/openai-responses-provider.js";
import { GeminiProvider } from "@yachiyo/provider/implementations/gemini-provider.js";
import {
  resolveReasoningEffort,
  normalizeReasoningEffort,
  reasoningEffortRank,
  modelSupportsReasoning,
  anthropicThinkingConfig,
  openaiReasoningEffort,
  responsesReasoningEffort,
  geminiThinkingConfig,
} from "@yachiyo/provider/reasoning.js";
import type { Message } from "@yachiyo/common/llm-message.js";

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passCount++;
    console.log(`  ✅ ${message}`);
  } else {
    failCount++;
    console.error(`  ❌ ${message}`);
  }
}

// ── Mock fetch ──
const originalFetch = globalThis.fetch;
let lastBody: any = null;
let lastUrl: string | null = null;

async function mockFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const requestUrl = typeof url === "string" ? url : (url as any).url || url.toString();
  lastUrl = requestUrl;
  lastBody = init?.body ? JSON.parse(init.body as string) : null;
  return new Response(JSON.stringify({
    choices: [{ message: { content: "ok" } }],
    content: [{ type: "text", text: "ok" }],
    candidates: [{ content: { parts: [{ text: "ok" }] } }],
    usage: { input_tokens: 1, output_tokens: 1 },
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── 1. Pure mapping helpers ──
function testMappingHelpers(): void {
  console.log("\n=== 1. 映射与门控辅助函数 ===");

  assert(normalizeReasoningEffort("HIGH") === "high", "normalizeReasoningEffort 大小写不敏感");
  assert(normalizeReasoningEffort("bogus") === undefined, "normalizeReasoningEffort 拒绝非法值");
  assert(normalizeReasoningEffort(5) === undefined, "normalizeReasoningEffort 拒绝非字符串");

  assert(resolveReasoningEffort("high", "low") === "high", "请求值优先于配置值");
  assert(resolveReasoningEffort(undefined, "medium") === "medium", "请求缺失时回退配置值");
  assert(resolveReasoningEffort(undefined, undefined) === undefined, "两者皆缺省返回 undefined");

  assert(reasoningEffortRank("high") > reasoningEffortRank("low"), "rank 反映强度顺序");
  assert(reasoningEffortRank(undefined) === -1, "undefined 的 rank 为 -1");

  assert(modelSupportsReasoning("o3-mini"), "识别 OpenAI o 系列");
  assert(modelSupportsReasoning("gpt-5"), "识别 gpt-5");
  assert(modelSupportsReasoning("claude-3-7-sonnet-20250219"), "识别 Claude 3.7");
  assert(modelSupportsReasoning("claude-sonnet-4-5"), "识别 Claude 4.x");
  assert(modelSupportsReasoning("gemini-2.5-flash"), "识别 Gemini 2.5");
  assert(!modelSupportsReasoning("gpt-4o"), "gpt-4o 不支持推理");
  assert(!modelSupportsReasoning("claude-3-5-sonnet"), "Claude 3.5 不支持推理");
  assert(!modelSupportsReasoning(undefined), "undefined 模型不支持");

  // Anthropic
  const a = anthropicThinkingConfig("high", "claude-sonnet-4-5", 64000);
  assert(a?.type === "enabled" && a.budget_tokens === 24576, "Anthropic high → 24576 预算");
  const aOff = anthropicThinkingConfig("off", "claude-sonnet-4-5", 64000);
  assert(aOff?.type === "disabled", "Anthropic off → disabled");
  assert(anthropicThinkingConfig("high", "claude-3-5-sonnet", 64000) === undefined, "Anthropic 非推理模型 → undefined");
  assert(anthropicThinkingConfig(undefined, "claude-sonnet-4-5", 64000) === undefined, "Anthropic undefined → undefined");
  // max_tokens 太小无法满足 1024 最小预算 → undefined
  assert(anthropicThinkingConfig("high", "claude-sonnet-4-5", 1500) === undefined, "Anthropic max_tokens 过小 → undefined");
  // 预算被 max_tokens 夹紧
  const aClamped = anthropicThinkingConfig("high", "claude-sonnet-4-5", 5000);
  assert(aClamped?.type === "enabled" && aClamped.budget_tokens === 3976, "Anthropic 预算按 max_tokens-1024 夹紧");

  // OpenAI
  assert(openaiReasoningEffort("medium", "o3-mini") === "medium", "OpenAI medium 透传");
  assert(openaiReasoningEffort("off", "o3-mini") === "none", "OpenAI off → none");
  assert(openaiReasoningEffort("high", "gpt-4o") === undefined, "OpenAI 非推理模型 → undefined");

  // Responses
  assert(responsesReasoningEffort("minimal", "gpt-5") === "low", "Responses minimal → low");
  assert(responsesReasoningEffort("high", "gpt-5") === "high", "Responses high 透传");
  assert(responsesReasoningEffort("high", "gpt-4o") === undefined, "Responses 非推理模型 → undefined");

  // Gemini
  const g = geminiThinkingConfig("medium", "gemini-2.5-flash");
  assert(g?.thinkingBudget === 12288 && g.includeThoughts === true, "Gemini medium → 12288 + includeThoughts");
  assert(geminiThinkingConfig("off", "gemini-2.5-flash")?.thinkingBudget === 0, "Gemini off → budget 0");
  assert(geminiThinkingConfig("high", "gemini-1.5-flash") === undefined, "Gemini 非推理模型 → undefined");
}

// ── 2. Provider request bodies ──
async function testProviderBodies(): Promise<void> {
  console.log("\n=== 2. Provider 请求体原生字段 ===");

  // Anthropic
  const anthropic = new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-4-5", maxTokens: 64000 } as any);
  await anthropic.textChat({ contexts: [{ role: "user", content: "hi" }] as Message[], reasoningEffort: "high" });
  assert(lastBody?.thinking?.type === "enabled" && lastBody.thinking.budget_tokens === 24576, "Anthropic 请求含 thinking 预算");
  assert(lastBody?.temperature === undefined, "Anthropic 开启 thinking 时移除 temperature");

  // Anthropic 非推理模型 → 无 thinking
  await anthropic.textChat({ contexts: [{ role: "user", content: "hi" }] as Message[], reasoningEffort: "high" });
  const anthropicNonReasoning = new AnthropicProvider({ apiKey: "k", model: "claude-3-5-sonnet", maxTokens: 64000 } as any);
  await anthropicNonReasoning.textChat({ contexts: [{ role: "user", content: "hi" }] as Message[], reasoningEffort: "high" });
  assert(lastBody?.thinking === undefined, "Anthropic 非推理模型不发送 thinking");

  // OpenAI Chat
  const openai = new OpenAIProvider({ apiKey: "k", model: "o3-mini" } as any);
  await openai.textChat({ contexts: [{ role: "user", content: "hi" }] as Message[], reasoningEffort: "medium" });
  assert(lastBody?.reasoning_effort === "medium", "OpenAI 请求含 reasoning_effort");
  const openaiPlain = new OpenAIProvider({ apiKey: "k", model: "gpt-4o" } as any);
  await openaiPlain.textChat({ contexts: [{ role: "user", content: "hi" }] as Message[], reasoningEffort: "medium" });
  assert(lastBody?.reasoning_effort === undefined, "OpenAI 非推理模型不发送 reasoning_effort");

  // OpenAI Responses
  const responses = new OpenAIResponsesProvider({ apiKey: "k", model: "gpt-5" } as any);
  await responses.textChat({ contexts: [{ role: "user", content: "hi" }] as Message[], reasoningEffort: "high" });
  assert(lastBody?.reasoning?.effort === "high", "Responses 请求含 reasoning.effort");
  assert(Array.isArray(lastBody?.include) && lastBody.include.includes("reasoning.encrypted_content"), "Responses 请求含 encrypted_content include");

  // Gemini
  const gemini = new GeminiProvider({ apiKey: "k", model: "gemini-2.5-flash" } as any);
  await gemini.textChat({ contexts: [{ role: "user", content: "hi" }] as Message[], reasoningEffort: "low" });
  assert(lastBody?.generationConfig?.thinkingConfig?.thinkingBudget === 4096, "Gemini 请求含 thinkingConfig 预算");
  assert(lastBody?.generationConfig?.thinkingConfig?.includeThoughts === true, "Gemini includeThoughts=true");
}

// ── 3. Config fallback ──
async function testConfigFallback(): Promise<void> {
  console.log("\n=== 3. ProviderConfig 默认回退 ===");

  const openaiCfg = new OpenAIProvider({ apiKey: "k", model: "o3-mini", reasoningEffort: "low" } as any);
  await openaiCfg.textChat({ contexts: [{ role: "user", content: "hi" }] as Message[] });
  assert(lastBody?.reasoning_effort === "low", "请求未指定时使用 ProviderConfig.reasoningEffort");

  // 请求值覆盖配置值
  await openaiCfg.textChat({ contexts: [{ role: "user", content: "hi" }] as Message[], reasoningEffort: "high" });
  assert(lastBody?.reasoning_effort === "high", "请求值覆盖 ProviderConfig 默认");

  // 未配置 → 不发送
  const openaiNone = new OpenAIProvider({ apiKey: "k", model: "o3-mini" } as any);
  await openaiNone.textChat({ contexts: [{ role: "user", content: "hi" }] as Message[] });
  assert(lastBody?.reasoning_effort === undefined, "未配置时不发送字段（保留模型默认）");
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   思考强度（Reasoning Effort）测试        ║");
  console.log("╚══════════════════════════════════════════╝");
  (globalThis as any).fetch = mockFetch;
  try {
    testMappingHelpers();
    await testProviderBodies();
    await testConfigFallback();

    console.log(`\n结果: ${passCount} 通过, ${failCount} 失败`);
    if (failCount > 0) process.exit(1);
    console.log("🎉 思考强度测试全部通过!");
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
