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
  // Anthropic 思考为 opt-in：off 应省略字段（不存在合法的 disabled 值）
  assert(anthropicThinkingConfig("off", "claude-sonnet-4-5", 64000) === undefined, "Anthropic off → 省略字段（而非 disabled）");
  assert(anthropicThinkingConfig("high", "claude-3-5-sonnet", 64000) === undefined, "Anthropic 非推理模型 → undefined");
  assert(anthropicThinkingConfig(undefined, "claude-sonnet-4-5", 64000) === undefined, "Anthropic undefined → undefined");
  // max_tokens 太小无法满足 1024 最小预算 → undefined
  assert(anthropicThinkingConfig("high", "claude-sonnet-4-5", 1500) === undefined, "Anthropic max_tokens 过小 → undefined");
  // 预算被 max_tokens 夹紧
  const aClamped = anthropicThinkingConfig("high", "claude-sonnet-4-5", 5000);
  assert(aClamped?.type === "enabled" && aClamped.budget_tokens === 3976, "Anthropic 预算按 max_tokens-1024 夹紧");

  // OpenAI
  assert(openaiReasoningEffort("medium", "o3-mini") === "medium", "OpenAI medium 透传");
  // o 系列不接受 "none"，off 应省略字段而非发送 none
  assert(openaiReasoningEffort("off", "o3-mini") === undefined, "OpenAI o3 off → 省略（不接受 none）");
  assert(openaiReasoningEffort("off", "gpt-5.1") === "none", "OpenAI gpt-5.1 off → none");
  assert(openaiReasoningEffort("high", "gpt-4o") === undefined, "OpenAI 非推理模型 → undefined");

  // Responses
  assert(responsesReasoningEffort("minimal", "gpt-5") === "low", "Responses minimal → low");
  assert(responsesReasoningEffort("high", "gpt-5") === "high", "Responses high 透传");
  assert(responsesReasoningEffort("off", "o3-mini") === undefined, "Responses o3 off → 省略（不接受 none）");
  assert(responsesReasoningEffort("high", "gpt-4o") === undefined, "Responses 非推理模型 → undefined");

  // Gemini 2.5 Flash：budget，0 可关闭
  const g = geminiThinkingConfig("medium", "gemini-2.5-flash");
  assert(!!g && "thinkingBudget" in g && g.thinkingBudget === 12288 && g.includeThoughts === true, "Gemini Flash medium → 12288");
  const gOff = geminiThinkingConfig("off", "gemini-2.5-flash");
  assert(!!gOff && "thinkingBudget" in gOff && gOff.thinkingBudget === 0, "Gemini Flash off → budget 0");
  // Gemini 2.5 Pro：不能关闭，最小 128
  const gPro = geminiThinkingConfig("off", "gemini-2.5-pro");
  assert(!!gPro && "thinkingBudget" in gPro && gPro.thinkingBudget === 128, "Gemini Pro off → 最小 128（不可关闭）");
  // Gemini 3.x：用 thinkingLevel 而非 budget
  const g3 = geminiThinkingConfig("high", "gemini-3-pro-preview");
  assert(!!g3 && "thinkingLevel" in g3 && g3.thinkingLevel === "high", "Gemini 3 high → thinkingLevel=high");
  const g3low = geminiThinkingConfig("off", "gemini-3-flash");
  assert(!!g3low && "thinkingLevel" in g3low && g3low.thinkingLevel === "low", "Gemini 3 off → thinkingLevel=low（不可完全关闭）");
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

  // Gemini Flash：budget
  const gemini = new GeminiProvider({ apiKey: "k", model: "gemini-2.5-flash" } as any);
  await gemini.textChat({ contexts: [{ role: "user", content: "hi" }] as Message[], reasoningEffort: "low" });
  assert(lastBody?.generationConfig?.thinkingConfig?.thinkingBudget === 4096, "Gemini Flash 请求含 thinkingConfig 预算");
  assert(lastBody?.generationConfig?.thinkingConfig?.includeThoughts === true, "Gemini includeThoughts=true");
  // Gemini Pro：off 不能发 0（会 400），最小 128
  const geminiPro = new GeminiProvider({ apiKey: "k", model: "gemini-2.5-pro" } as any);
  await geminiPro.textChat({ contexts: [{ role: "user", content: "hi" }] as Message[], reasoningEffort: "off" });
  assert(lastBody?.generationConfig?.thinkingConfig?.thinkingBudget === 128, "Gemini Pro off 请求发 128 而非 0");
  // Gemini 3：thinkingLevel
  const gemini3 = new GeminiProvider({ apiKey: "k", model: "gemini-3-pro-preview" } as any);
  await gemini3.textChat({ contexts: [{ role: "user", content: "hi" }] as Message[], reasoningEffort: "high" });
  assert(lastBody?.generationConfig?.thinkingConfig?.thinkingLevel === "high", "Gemini 3 请求用 thinkingLevel");
  assert(lastBody?.generationConfig?.thinkingConfig?.thinkingBudget === undefined, "Gemini 3 不发 thinkingBudget");
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

// ── 4. Auto reasoning-effort controller ──
async function testAutoController(): Promise<void> {
  console.log("\n=== 4. 自动思考强度控制器 ===");
  const { computeAutoReasoningEffort } = await import("@yachiyo/agent/runners/tool-loop-agent-runner.js");

  const base = { stepIndex: 0, sameToolStreak: 1, emptyOutputRetries: 0, compressionFired: false };
  assert(computeAutoReasoningEffort(base) === "low", "初始步无信号 → 最低档 low");

  // 工具循环变深 → 升级
  assert(
    computeAutoReasoningEffort({ ...base, stepIndex: 4 }) === "medium",
    "step>=4 → 升到 medium",
  );
  assert(
    computeAutoReasoningEffort({ ...base, stepIndex: 8 }) === "high",
    "step>=8 → 升到 high",
  );

  // 重复同一工具 → 升级
  assert(
    computeAutoReasoningEffort({ ...base, sameToolStreak: 3 }) === "medium",
    "sameToolStreak>=3 → 升到 medium",
  );

  // 空输出重试 → 升级
  assert(
    computeAutoReasoningEffort({ ...base, emptyOutputRetries: 1 }) === "medium",
    "emptyOutputRetries>=1 → 升到 medium",
  );

  // 压缩触发 → 升级
  assert(
    computeAutoReasoningEffort({ ...base, compressionFired: true }) === "medium",
    "compressionFired → 升到 medium",
  );

  // 多信号叠加 → 封顶 high
  assert(
    computeAutoReasoningEffort({ stepIndex: 10, sameToolStreak: 5, emptyOutputRetries: 3, compressionFired: true }) === "high",
    "多信号叠加封顶 high",
  );

  // 自定义上下界
  assert(
    computeAutoReasoningEffort(base, { minFloor: "medium" }) === "medium",
    "minFloor=medium → 初始即 medium",
  );
  assert(
    computeAutoReasoningEffort({ ...base, stepIndex: 20, sameToolStreak: 9 }, { maxCeiling: "medium" }) === "medium",
    "maxCeiling=medium → 封顶 medium",
  );
  assert(
    computeAutoReasoningEffort({ ...base, stepIndex: 4 }, { escalateAfterSteps: 10 }) === "low",
    "escalateAfterSteps=10 → step4 仍未升级",
  );
}

// ── 5. Runner 透传：auto 覆盖静态 effort ──
async function testRunnerAutoWiring(): Promise<void> {
  console.log("\n=== 5. Runner auto 接线（端到端）===");
  const { ToolLoopAgentRunner, createContextWrapper, EmptyAgentHooks, FunctionToolExecutor, ToolSet } = await import("../src/index.js");

  const seenEfforts: Array<string | undefined> = [];
  const provider = {
    type: "chat_completion",
    providerConfig: { id: "auto-prov", maxContextTokens: 4096, modalities: ["text", "tool_use"] },
    async textChat(params: any) {
      seenEfforts.push(params.reasoningEffort);
      return { role: "assistant", completionText: "ok", isChunk: false };
    },
  } as any;

  const runner = new ToolLoopAgentRunner();
  await runner.reset(createContextWrapper<null>(null), new EmptyAgentHooks(), {
    provider,
    request: { prompt: "hi", imageUrls: [], audioUrls: [], contexts: [], extraUserContentParts: [] },
    toolExecutor: new FunctionToolExecutor(),
    agentHooks: new EmptyAgentHooks(),
    streaming: false,
    reasoningEffort: "minimal",
    autoReasoning: { enabled: true, minFloor: "low", maxCeiling: "high", escalateAfterSteps: 2 },
  });
  (runner as any).req.funcTool = new ToolSet([]);

  // 运行若干步：step 索引增长 → auto 应在 step>=2 时升到 medium 并覆盖静态 minimal。
  for await (const _ of runner.stepUntilDone(1)) { void _; }

  assert(seenEfforts.length > 0, `LLM 被调用 (calls=${seenEfforts.length})`);
  assert(seenEfforts[0] === "low", `首步 auto 取 minFloor=low（覆盖静态 minimal，实际 ${seenEfforts[0]}）`);

  // 静态 effort（无 auto）应原样透传
  const seenStatic: Array<string | undefined> = [];
  const provider2 = {
    type: "chat_completion",
    providerConfig: { id: "static-prov", maxContextTokens: 4096, modalities: ["text", "tool_use"] },
    async textChat(params: any) {
      seenStatic.push(params.reasoningEffort);
      return { role: "assistant", completionText: "ok", isChunk: false };
    },
  } as any;
  const runner2 = new ToolLoopAgentRunner();
  await runner2.reset(createContextWrapper<null>(null), new EmptyAgentHooks(), {
    provider: provider2,
    request: { prompt: "hi", imageUrls: [], audioUrls: [], contexts: [], extraUserContentParts: [] },
    toolExecutor: new FunctionToolExecutor(),
    agentHooks: new EmptyAgentHooks(),
    streaming: false,
    reasoningEffort: "high",
  });
  (runner2 as any).req.funcTool = new ToolSet([]);
  for await (const _ of runner2.stepUntilDone(1)) { void _; }
  assert(seenStatic.every((e) => e === "high"), `无 auto 时静态 effort 原样透传（${JSON.stringify(seenStatic)}）`);
}

// ── 6. 子代理继承父级 live effort ──
async function testSubAgentInheritsLiveEffort(): Promise<void> {
  console.log("\n=== 6. 子代理继承父级 live effort ===");
  const { createAgent, createHandoffTool, createContextWrapper, EmptyAgentHooks, FunctionToolExecutor, ToolLoopAgentRunner, ToolSet } = await import("../src/index.js");

  // 子代理 provider 记录其收到的 effort。
  const subEfforts: Array<string | undefined> = [];
  const subProvider = {
    type: "chat_completion",
    providerConfig: { id: "sub-prov", maxContextTokens: 4096, modalities: ["text", "tool_use"] },
    async textChat(params: any) {
      subEfforts.push(params.reasoningEffort);
      return { role: "assistant", completionText: "sub done", isChunk: false };
    },
  } as any;

  // 父级：auto 开启，先执行若干步把 effort 升到 medium，再触发 handoff。
  // 这里直接构造一个已升档的 runContext 来验证继承逻辑（不必真跑多步）。
  const executor = new FunctionToolExecutor();
  const subAgent = createAgent({ name: "child", instructions: "x" });
  const handoff = createHandoffTool(subAgent);

  const parentCtx = createContextWrapper<Record<string, unknown>>({}, { toolCallTimeout: 120 });
  parentCtx._provider = subProvider;
  // 模拟父级 auto 控制器已升档并写入 live effort。
  parentCtx._reasoningEffort = "minimal";
  parentCtx._currentReasoningEffort = "medium";

  const gen = executor.execute(handoff, parentCtx, { input: "do work" });
  for await (const _ of gen) { void _; }

  assert(subEfforts.length > 0, `子代理被调用 (calls=${subEfforts.length})`);
  assert(
    subEfforts.every((e) => e === "medium"),
    `子代理继承父级 live effort=medium（而非静态 minimal，实际 ${JSON.stringify(subEfforts)}）`,
  );
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
    await testAutoController();
    await testRunnerAutoWiring();
    await testSubAgentInheritsLiveEffort();

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
