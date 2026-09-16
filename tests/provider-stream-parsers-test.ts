/**
 * 流式解析器思考内容(reasoning)分离回归测试
 * 验证启用流式输出时思考内容不会混入用户可见正文(completionText)
 */
import { parseOpenAIStream } from "@yachiyo/provider/parsers/openai-stream-parser.js";
import { parseGeminiStream } from "@yachiyo/provider/parsers/gemini-stream-parser.js";
import { parseAnthropicStream } from "@yachiyo/provider/parsers/anthropic-stream-parser.js";

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

function sseResponse(events: string[]): Response {
  const body = events.map((e) => `data: ${e}\n\n`).join("") + "data: [DONE]\n\n";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const out = [];
  for await (const item of gen) out.push(item);
  return out;
}

// ── 1. OpenAI 流式：reasoning_content 分离 ──
async function testOpenAIStream() {
  console.log("\n=== OpenAI 流式解析器 ===");
  const chunks = [
    JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "思考片段1" } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "思考片段2" } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { content: "正文片段1" } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { content: "正文片段2" }, finish_reason: "stop" }] }),
  ];
  const results = await collect(parseOpenAIStream(sseResponse(chunks)));
  const reasoning = results.filter((r) => r.reasoningContent).map((r) => r.reasoningContent).join("");
  const text = results.filter((r) => r.completionText).map((r) => r.completionText).join("");
  assert(reasoning === "思考片段1思考片段2", "reasoning_content 累积到 reasoningContent");
  assert(text === "正文片段1正文片段2", "content 累积到 completionText");
  assert(!text.includes("思考"), "思考内容未混入正文");
  // 流末必须恰好产生一个终结（非 chunk）响应，供上层聚合收尾。
  assert(results.filter((r) => !r.isChunk).length === 1, "流末产生唯一终结响应");
}

// ── 1b. OpenAI 流式：include_usage 的 usage-only chunk 必须被解析 ──
async function testOpenAIStreamUsage() {
  console.log("\n=== OpenAI 流式解析器 - usage ===");
  // include_usage 开启后，OpenAI 会额外发一条 choices 为空、只带 usage 的 chunk。
  // 该分片在旧的实现中因 `!choice` 短路被直接丢弃，导致 token 统计丢失。
  const chunks = [
    JSON.stringify({ choices: [{ index: 0, delta: { content: "你好" } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13, prompt_tokens_details: { cached_tokens: 5 } } }),
  ];
  const results = await collect(parseOpenAIStream(sseResponse(chunks)));
  const usageChunk = results.find((r) => r.usage);
  assert(usageChunk !== undefined, "usage-only chunk 被解析而非丢弃");
  assert(usageChunk?.usage?.promptTokens === 11 && usageChunk?.usage?.completionTokens === 2,
    "usage 字段解析正确");
  assert(usageChunk?.usage?.cacheReadInputTokens === 5, "cached_tokens 映射到 cacheReadInputTokens");
  assert(results.filter((r) => !r.isChunk).length === 1, "usage 场景流末仍只有一个终结响应");
}

// ── 1c. OpenAI 流式：无 usage 时回退本地估算 ──
async function testOpenAIStreamUsageFallback() {
  console.log("\n=== OpenAI 流式解析器 - 无 usage 兜底 ===");
  // 代理/网关忽略 stream_options.include_usage 时不返回任何 usage，
  // 且可能连 finish_reason 都没有。解析器应回退本地估算并输出终结响应。
  const chunks = [
    JSON.stringify({ choices: [{ index: 0, delta: { content: "abcdef ghij" } }] }),
  ];
  const results = await collect(
    parseOpenAIStream(sseResponse(chunks), undefined, [{ role: "user", content: "hi there" } as never])
  );
  const terminal = results.find((r) => !r.isChunk);
  assert(terminal !== undefined, "无 finish_reason 时仍产生终结响应");
  assert(terminal?.usage !== undefined && terminal.usage.total > 0, "无 usage 时回退本地 token 估算");
}

// ── 1d. OpenAI 流式：工具调用在终结响应中完整输出 ──
async function testOpenAIStreamToolCalls() {
  console.log("\n=== OpenAI 流式解析器 - 工具调用 ===");
  // finish_reason:"tool_calls" 与 usage 分片可能分开到达；工具调用与 usage
  // 必须都能被下游捕获，不能因提前终结而丢失其一。
  const withUsage = [
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "f", arguments: "{\"x\":" } }] } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }),
  ];
  const results = await collect(parseOpenAIStream(sseResponse(withUsage)));
  const toolChunk = results.find((r) => r.toolsCallName);
  assert(toolChunk?.toolsCallName?.[0] === "f", "tool_calls 名称正确解析");
  assert(JSON.stringify(toolChunk?.toolsCallArgs?.[0]) === JSON.stringify({ x: 1 }),
    "tool_calls 参数拼接后 JSON 解析正确");
  assert(results.some((r) => r.usage), "同批流中 usage 未被工具调用分片挤掉");
  assert(results.filter((r) => !r.isChunk).length === 1, "工具调用场景流末仍只有一个终结响应");

  // 网关不发 finish_reason:"tool_calls" 时，流末兜底 flush 工具调用。
  const noFinish = [
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c2", function: { name: "g", arguments: "{}" } }] } }] }),
  ];
  const results2 = await collect(parseOpenAIStream(sseResponse(noFinish)));
  const terminal = results2.find((r) => !r.isChunk);
  assert(terminal?.toolsCallName?.[0] === "g", "缺失 finish_reason 时流末兜底输出工具调用");
}

// ── 2. Gemini 流式：thought 标记分离 ──
async function testGeminiStream() {
  console.log("\n=== Gemini 流式解析器 ===");
  // 布尔 thought:true —— 官方 API 形式，part.text 是思考内容
  const chunks = [
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "让我想想...", thought: true }] } }] }),
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "继续思考", thought: true }] } }] }),
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "这是最终答案" }] } }] }),
  ];
  const results = await collect(parseGeminiStream(sseResponse(chunks)));
  const reasoning = results.filter((r) => r.reasoningContent).map((r) => r.reasoningContent).join("");
  const text = results.filter((r) => r.completionText).map((r) => r.completionText).join("");
  assert(reasoning === "让我想想...继续思考", "thought:true 的 text 归入 reasoningContent（官方布尔形式）");
  assert(text === "这是最终答案", "无 thought 标记的 text 归入 completionText");
  assert(!text.includes("想想"), "思考内容未混入正文");

  // 字符串 thought 形式（代理变体）：thought 字段本身是思考内容
  const chunks2 = [
    JSON.stringify({ candidates: [{ content: { parts: [{ thought: "代理的思考内容" }] } }] }),
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "正常回复" }] } }] }),
  ];
  const results2 = await collect(parseGeminiStream(sseResponse(chunks2)));
  const reasoning2 = results2.filter((r) => r.reasoningContent).map((r) => r.reasoningContent).join("");
  const text2 = results2.filter((r) => r.completionText).map((r) => r.completionText).join("");
  assert(reasoning2 === "代理的思考内容", "字符串 thought 形式归入 reasoningContent");
  assert(text2 === "正常回复", "正文不受影响");

  // 同一 chunk 含多个 part（思考 + 正文）
  const chunks3 = [
    JSON.stringify({ candidates: [{ content: { parts: [
      { text: "thinking part", thought: true },
      { text: "answer part" },
    ] } }] }),
  ];
  const results3 = await collect(parseGeminiStream(sseResponse(chunks3)));
  const chunk = results3[0];
  assert(chunk.reasoningContent === "thinking part" && chunk.completionText === "answer part",
    "同 chunk 多 part 时思考与正文各自归位");
}

// ── 3. Anthropic 流式：thinking_delta 分离 ──
async function testAnthropicStream() {
  console.log("\n=== Anthropic 流式解析器 ===");
  // Anthropic SSE 事件类型在 event: 行，data 为 JSON（不含 type 字段也行）
  const events: Array<[string, object]> = [
    ["message_start", { message: { usage: { input_tokens: 10 } } }],
    ["content_block_start", { index: 0, content_block: { type: "thinking" } }],
    ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "内部推理" } }],
    ["content_block_stop", { index: 0 }],
    ["content_block_start", { index: 1, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { index: 1, delta: { type: "text_delta", text: "可见回复" } }],
    ["content_block_stop", { index: 1 }],
    ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }],
  ];
  const body = events.map(([type, payload]) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  const results = await collect(parseAnthropicStream(new Response(stream, { status: 200 })));
  const reasoning = results.filter((r) => r.reasoningContent).map((r) => r.reasoningContent).join("");
  const text = results.filter((r) => r.completionText).map((r) => r.completionText).join("");
  assert(reasoning === "内部推理", "thinking_delta 归入 reasoningContent");
  assert(text === "可见回复", "text_delta 归入 completionText");
  assert(!text.includes("推理"), "思考内容未混入正文");
}

// ── main ──
(async () => {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   流式解析器思考内容分离回归测试           ║");
  console.log("╚══════════════════════════════════════════╝");
  try {
    await testOpenAIStream();
    await testOpenAIStreamUsage();
    await testOpenAIStreamUsageFallback();
    await testOpenAIStreamToolCalls();
    await testGeminiStream();
    await testAnthropicStream();
    console.log(`\n总计: ${passed + failed} | 通过: ${passed} | 失败: ${failed}`);
    if (failures.length) {
      console.error("失败项:");
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    process.exit(0);
  } catch (e) {
    console.error("测试执行异常:", e);
    process.exit(1);
  }
})();
