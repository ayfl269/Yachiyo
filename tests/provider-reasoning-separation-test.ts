/**
 * 思考内容分离与签名回传回归测试
 *
 * 覆盖各 provider 的流式/非流式路径：
 * - 思考内容必须归入 reasoningContent，不得混入 completionText（用户可见回复）
 * - 思考签名 / 加密载荷必须捕获，并在回传历史时原样保留
 *   （Anthropic signature、Gemini thoughtSignature、Responses encrypted_content）
 * - Anthropic redacted_thinking 必须保持块类型回传
 * - 不得再把思考内容降级成 `[Thinking] ...` 纯文本
 */
import { OpenAIProvider } from "@yachiyo/provider/implementations/openai-provider.js";
import { OpenAIResponsesProvider } from "@yachiyo/provider/implementations/openai-responses-provider.js";
import { GeminiProvider } from "@yachiyo/provider/implementations/gemini-provider.js";
import { AnthropicProvider } from "@yachiyo/provider/implementations/anthropic-provider.js";
import { messageToAnthropic } from "@yachiyo/provider/converters/anthropic-converter.js";
import { messageToGemini } from "@yachiyo/provider/converters/gemini-converter.js";
import { messageToOpenAI } from "@yachiyo/provider/converters/openai-converter.js";
import { messageToResponsesInput } from "@yachiyo/provider/converters/openai-responses-converter.js";
import { parseAnthropicStream } from "@yachiyo/provider/parsers/anthropic-stream-parser.js";
import { parseGeminiStream } from "@yachiyo/provider/parsers/gemini-stream-parser.js";
import { parseResponsesStream } from "@yachiyo/provider/parsers/openai-responses-stream-parser.js";
import type { Message } from "@yachiyo/common/llm-message.js";

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

function anthropicSseResponse(events: Array<[string, object]>): Response {
  const body = events.map(([type, payload]) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

async function collect(gen: AsyncGenerator<unknown>): Promise<any[]> {
  const out: any[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

// ── 1. Anthropic：思考签名（非流式） ──
function testAnthropicNonStream() {
  console.log("\n=== Anthropic 非流式：签名与 redacted_thinking ===");
  const provider = new AnthropicProvider({ apiKey: "k", model: "m" });
  const parse = (provider as any).parseResponse.bind(provider);

  const withSig = parse({
    content: [
      { type: "thinking", thinking: "内部推理", signature: "SIG-123" },
      { type: "text", text: "可见回复" },
    ],
  });
  assert(withSig.reasoningContent === "内部推理", "thinking 归入 reasoningContent");
  assert(withSig.completionText === "可见回复", "text 归入 completionText");
  assert(withSig.reasoningSignature === "SIG-123", "thinking 签名被捕获");

  const redacted = parse({
    content: [
      { type: "redacted_thinking", data: "BLOB-XYZ" },
      { type: "text", text: "可见回复" },
    ],
  });
  assert(redacted.reasoningSignature === "BLOB-XYZ", "redacted_thinking 的 data 被捕获");
  assert(redacted.reasoningRedacted === true, "redacted_thinking 标记为 redacted");
  assert(!redacted.completionText?.includes("BLOB"), "redacted 载荷未混入回复");
}

// ── 2. Anthropic：思考签名（流式 signature_delta） ──
async function testAnthropicStreamSignature() {
  console.log("\n=== Anthropic 流式：signature_delta ===");
  const events: Array<[string, object]> = [
    ["content_block_start", { index: 0, content_block: { type: "thinking" } }],
    ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "内部推理" } }],
    ["content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "SIG-STREAM" } }],
    ["content_block_stop", { index: 0 }],
    ["content_block_start", { index: 1, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { index: 1, delta: { type: "text_delta", text: "可见回复" } }],
    ["message_delta", { usage: { output_tokens: 5 } }],
  ];
  const results = await collect(parseAnthropicStream(anthropicSseResponse(events)));
  const sig = results.find((r) => r.reasoningSignature)?.reasoningSignature;
  assert(sig === "SIG-STREAM", "signature_delta 归入 reasoningSignature");
  assert(!results.some((r) => r.completionText?.includes("SIG")), "签名未混入正文");

  const redactedEvents: Array<[string, object]> = [
    ["content_block_start", { index: 0, content_block: { type: "redacted_thinking", data: "BLOB-1" } }],
    ["message_delta", { usage: { output_tokens: 1 } }],
  ];
  const redacted = await collect(parseAnthropicStream(anthropicSseResponse(redactedEvents)));
  assert(redacted.find((r) => r.reasoningRedacted)?.reasoningSignature === "BLOB-1",
    "流式 redacted_thinking 被捕获");
}

// ── 3. Anthropic：回传历史保留签名/redacted ──
function testAnthropicReplay() {
  console.log("\n=== Anthropic：历史回传保留签名 ===");
  const { messages } = messageToAnthropic([
    {
      role: "assistant", content: [
        { type: "think", think: "推理", encrypted: "SIG-123" },
        { type: "text", text: "回复" },
      ]
    },
    {
      role: "assistant", content: [
        { type: "think", think: "", encrypted: "BLOB-XYZ", redacted: true },
      ]
    },
    {
      role: "assistant", content: [
        { type: "think", think: "无签名的思考" },
      ]
    },
  ]);

  const signed = messages[0].content as any[];
  const thinkingBlock = signed.find((b) => b.type === "thinking");
  assert(thinkingBlock?.signature === "SIG-123", "回传的 thinking 块带 signature");
  assert(!JSON.stringify(signed).includes("[Thinking]"), "思考未降级为 [Thinking] 文本");

  const redacted = messages[1].content as any[];
  assert(redacted[0]?.type === "redacted_thinking" && redacted[0]?.data === "BLOB-XYZ",
    "回传的 redacted_thinking 保持块类型与数据");

  const unsigned = messages[2].content as any[];
  assert(unsigned[0]?.type === "text" && unsigned[0]?.text === "无签名的思考",
    "无签名思考降级为 text 块（避免 Anthropic 400）");
}

// ── 4. Gemini：thoughtSignature 捕获与回传 ──
async function testGeminiSignature() {
  console.log("\n=== Gemini：thoughtSignature ===");
  const provider = new GeminiProvider({ apiKey: "k", model: "m" });
  const parse = (provider as any).parseResponse.bind(provider);

  const nonStream = parse({
    candidates: [{
      content: {
        parts: [
          { text: "推理", thought: true, thoughtSignature: "GSIG" },
          { text: "回复" },
        ]
      }
    }],
  });
  assert(nonStream.reasoningContent === "推理", "thought:true 归入 reasoningContent");
  assert(nonStream.completionText === "回复", "普通 text 归入 completionText");
  assert(nonStream.reasoningSignature === "GSIG", "非流式捕获 thoughtSignature");

  const fc = parse({
    candidates: [{
      content: {
        parts: [
          { functionCall: { name: "f", args: { x: 1 } }, thoughtSignature: "FSIG" },
        ]
      }
    }],
  });
  assert(fc.toolsCallExtraContent?.[0]?.thoughtSignature === "FSIG",
    "functionCall 的 thoughtSignature 随工具调用捕获");

  const chunks = [
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "推理", thought: true, thoughtSignature: "GSIG-S" }] } }] }),
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "回复" }] } }] }),
  ];
  const stream = await collect(parseGeminiStream(sseResponse(chunks)));
  assert(stream.find((r) => r.reasoningSignature)?.reasoningSignature === "GSIG-S",
    "流式捕获 thoughtSignature");
  assert(!stream.some((r) => r.completionText?.includes("GSIG")), "签名未混入正文");

  const { contents } = messageToGemini([
    { role: "assistant", content: [{ type: "think", think: "推理", encrypted: "GSIG" }] },
  ]);
  const part = contents[0].parts[0] as any;
  assert(part.thought === true && part.text === "推理", "回传思考为原生 thought part");
  assert(part.thoughtSignature === "GSIG", "回传保留 thoughtSignature");
  assert(!JSON.stringify(contents).includes("[Thinking]"), "思考未降级为 [Thinking] 文本");
}

// ── 5. OpenAI Responses：思考解析（流式 + 非流式） ──
async function testResponsesReasoning() {
  console.log("\n=== OpenAI Responses：思考解析 ===");
  const provider = new OpenAIResponsesProvider({ apiKey: "k", model: "m" });
  const parse = (provider as any).parseResponse.bind(provider);

  const nonStream = parse({
    output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "思考摘要" }], encrypted_content: "ESIG" },
      { type: "message", content: [{ type: "output_text", text: "可见回复" }] },
    ],
  });
  assert(nonStream.reasoningContent === "思考摘要", "非流式 reasoning summary 归入 reasoningContent");
  assert(nonStream.completionText === "可见回复", "非流式 output_text 归入 completionText");
  assert(nonStream.reasoningSignature === "ESIG", "非流式捕获 encrypted_content");
  assert(!nonStream.completionText?.includes("思考"), "思考未混入回复");

  const chunks = [
    `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "可见回复" })}`,
    `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ delta: "思考摘要" })}`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ item: { type: "reasoning", encrypted_content: "ESIG" } })}`,
  ];
  const body = chunks.join("\n\n") + "\n\n";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); },
  });
  const results = await collect(parseResponsesStream(new Response(stream, { status: 200 })));
  assert(results.find((r) => r.reasoningContent)?.reasoningContent === "思考摘要",
    "流式 reasoning summary 归入 reasoningContent");
  assert(results.find((r) => r.completionText)?.completionText === "可见回复",
    "流式 output_text 归入 completionText");
  assert(results.find((r) => r.reasoningSignature)?.reasoningSignature === "ESIG",
    "流式捕获 encrypted_content");
}

// ── 6. OpenAI 兼容网关：reasoning 字段与 extra_content ──
function testOpenAICompat() {
  console.log("\n=== OpenAI 兼容网关：reasoning 字段 ===");
  const provider = new OpenAIProvider({ apiKey: "k", model: "m" });
  const parse = (provider as any).parseChatResponse.bind(provider);

  const arrayForm = parse({
    choices: [{
      message: {
        content: [
          { type: "reasoning", text: "思考" },
          { type: "text", text: "回复" },
        ]
      }
    }],
  });
  assert(arrayForm.reasoningContent === "思考", "数组 reasoning 分片归入 reasoningContent");
  assert(arrayForm.completionText === "回复", "数组 text 分片归入 completionText");

  const reasoningField = parse({ choices: [{ message: { content: "回复", reasoning: "思考" } }] });
  assert(reasoningField.reasoningContent === "思考", "reasoning 字段归入 reasoningContent");
  assert(reasoningField.completionText === "回复", "content 归入 completionText");

  const details = parse({
    choices: [{ message: { content: "回复", reasoning_details: [{ text: "r1" }, { summary: "r2" }] } }],
  });
  assert(details.reasoningContent === "r1r2", "reasoning_details 拼接归入 reasoningContent");

  const tc = parse({
    choices: [{
      message: {
        content: "回复", tool_calls: [
          { id: "1", function: { name: "f", arguments: "{}" }, extra_content: { thoughtSignature: "X" } },
        ]
      }
    }],
  });
  assert(tc.toolsCallExtraContent?.[0]?.thoughtSignature === "X",
    "工具调用的 extra_content 被捕获");

  const replay = messageToOpenAI([
    {
      role: "assistant", content: "回复", tool_calls: [
        { type: "function", id: "1", function: { name: "f", arguments: "{}" }, extraContent: { thoughtSignature: "X" } },
      ]
    },
  ]);
  assert((replay[0].tool_calls as any[])[0].extra_content?.thoughtSignature === "X",
    "回传工具调用保留 extra_content");
}

// ── 7. 消息序列化：思考 redacted 与 tool extraContent 往返 ──
async function testSerializationRoundTrip() {
  console.log("\n=== 消息序列化往返 ===");
  const { serializeMessage, validateMessage } = await import("@yachiyo/common/llm-message.js");
  const msg: Message = {
    role: "assistant",
    content: [{ type: "think", think: "", encrypted: "BLOB", redacted: true }],
    tool_calls: [
      { type: "function", id: "1", function: { name: "f", arguments: "{}" }, extraContent: { thoughtSignature: "X" } },
    ],
  };
  const dumped = serializeMessage(msg);
  assert((dumped.content as any[])[0].redacted === true, "序列化保留 think.redacted");
  assert((dumped.tool_calls as any[])[0].extra_content?.thoughtSignature === "X",
    "序列化写出 extra_content");

  const restored = validateMessage(dumped);
  assert((restored.content as any[])[0].redacted === true, "反序列化恢复 think.redacted");
  assert((restored.tool_calls as any[])[0].extraContent?.thoughtSignature === "X",
    "反序列化恢复 extraContent");
}

// ── 8. OpenAI / Responses 转换器：思考不得作为 [Thinking] 文本注入 ──
function testNoThinkingInjection() {
  console.log("\n=== OpenAI 转换器：思考不得注入为文本 ===");
  const msg: Message = {
    role: "assistant",
    content: [
      { type: "think", think: "内部推理", encrypted: "SIG" },
      { type: "text", text: "可见回复" },
    ],
  };
  const chat = messageToOpenAI([msg]);
  assert(!JSON.stringify(chat).includes("[Thinking]"), "Chat Completions 转换不注入 [Thinking]");
  assert(!JSON.stringify(chat).includes("内部推理"), "Chat Completions 转换丢弃思考内容");
  assert(JSON.stringify(chat).includes("可见回复"), "Chat Completions 保留可见回复");

  const responses = messageToResponsesInput([msg]).input;
  assert(!JSON.stringify(responses).includes("[Thinking]"), "Responses 转换不注入 [Thinking]");
  assert(!JSON.stringify(responses).includes("内部推理"), "Responses 转换丢弃思考内容");
  assert(JSON.stringify(responses).includes("可见回复"), "Responses 保留可见回复");
}

// ── 9. OpenAI Responses：工具 schema 必须为扁平结构 ──
async function testResponsesToolSchema() {
  console.log("\n=== OpenAI Responses：工具 schema 扁平化 ===");
  const originalFetch = globalThis.fetch;
  let body: any = null;
  (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
    body = init?.body ? JSON.parse(init.body as string) : null;
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const provider = new OpenAIResponsesProvider({ apiKey: "k", model: "gpt-4o" });
    const funcTool = {
      empty: () => false,
      openaiSchema: () => [{ type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
      anthropicSchema: () => [{ name: "get_weather" }],
      googleSchema: () => ({ functionDeclarations: [{ name: "get_weather" }] }),
    };
    await provider.textChat({ contexts: [{ role: "user", content: "hi" }] as Message[], funcTool } as any);

    const tool = body?.tools?.[0];
    assert(tool?.type === "function", "Responses 工具 type=function");
    assert(tool?.name === "get_weather", "Responses 工具 name 在顶层");
    assert(tool?.function === undefined, "Responses 工具不含嵌套 function 键");
    assert(tool?.parameters?.properties?.city !== undefined, "Responses 工具 parameters 在顶层");
    assert(tool?.description === "d", "Responses 工具 description 在顶层");
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
}

// ── 10. Gemini 非流式：并行同名工具调用 ID 唯一 ──
function testGeminiNonStreamToolIds() {
  console.log("\n=== Gemini 非流式：同名工具调用 ID 唯一 ===");
  const provider = new GeminiProvider({ apiKey: "k", model: "gemini-2.0-flash" });
  const parse = (provider as any).parseResponse.bind(provider);
  const parsed = parse({
    candidates: [{
      content: {
        parts: [
          { functionCall: { name: "search", args: { q: "a" } } },
          { functionCall: { name: "search", args: { q: "b" } } },
        ]
      }
    }],
  });
  assert(parsed.toolsCallIds?.length === 2, "解析出两个工具调用");
  assert(new Set(parsed.toolsCallIds).size === 2, "并行同名工具调用 ID 唯一");
}

// ── 11. Responses：仅工具调用的 assistant 消息不得带空 content ──
function testResponsesToolOnlyAssistant() {
  console.log("\n=== Responses：仅工具调用的 assistant 消息 ===");
  const input = messageToResponsesInput([
    {
      role: "assistant", content: undefined, tool_calls: [
        { type: "function", id: "call_1", function: { name: "f", arguments: "{}" } },
      ]
    },
  ]).input;
  const messages = input.filter((i: any) => i.type === undefined || i.type === "message");
  assert(messages.every((m: any) => m.content !== undefined), "仅工具调用的 assistant 不产出空 content 消息");
  assert(input.some((i: any) => i.type === "function_call"), "function_call 项仍被保留");
}

// ── main ──
(async () => {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   思考内容分离与签名回传回归测试               ║");
  console.log("╚══════════════════════════════════════════════╝");
  try {
    testAnthropicNonStream();
    await testAnthropicStreamSignature();
    testAnthropicReplay();
    await testGeminiSignature();
    await testResponsesReasoning();
    testOpenAICompat();
    await testSerializationRoundTrip();
    testNoThinkingInjection();
    await testResponsesToolSchema();
    testGeminiNonStreamToolIds();
    testResponsesToolOnlyAssistant();
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
