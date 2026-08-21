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
