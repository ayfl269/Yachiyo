import { AnthropicProvider } from "@yachiyo/provider/implementations/anthropic-provider.js";
import { GeminiProvider } from "@yachiyo/provider/implementations/gemini-provider.js";
import { OpenAIResponsesProvider } from "@yachiyo/provider/implementations/openai-responses-provider.js";
import { Message } from "@yachiyo/common/llm-message.js";

// ── Assert helpers ───────────────────────────────────────────────────
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

// Global mock fetch to intercept requests
const originalFetch = globalThis.fetch;
let lastRequestUrl: string | null = null;
let lastRequestInit: RequestInit | null = null;
let requestLog: { url: string; body: any; method?: string }[] = [];
let cacheCreateCount = 0;
let cacheDeleteCount = 0;

async function mockFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const requestUrl = typeof url === "string" ? url : (url as any).url || url.toString();
  lastRequestUrl = requestUrl;
  lastRequestInit = init || null;
  requestLog.push({
    url: requestUrl,
    body: init?.body ? JSON.parse(init.body as string) : null,
    method: init?.method,
  });
  if (requestUrl.includes("/cachedContents") && init?.method === "POST") {
    cacheCreateCount++;
  }
  if (requestUrl.includes("/cachedContents/") && init?.method === "DELETE") {
    cacheDeleteCount++;
  }
  return new Response(JSON.stringify({
    // Standard response mocks
    choices: [{ message: { content: "Mock OpenAI response" } }],
    content: [{ type: "text", text: "Mock Anthropic response" }],
    candidates: [{ content: { parts: [{ text: "Mock Gemini response" }] } }],
    name: "cachedContents/mock-cache-id",
    expireTime: new Date(Date.now() + 600000).toISOString(),
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 80,
      cache_read_input_tokens: 20,
      prompt_tokens_details: {
        cached_tokens: 45
      }
    },
    usageMetadata: {
      promptTokenCount: 1000,
      candidatesTokenCount: 500,
      totalTokenCount: 1500,
      cachedContentTokenCount: 800
    }
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function runTests() {
  console.log("=== Running Prompt Caching Tests ===");
  (globalThis as any).fetch = mockFetch;

  try {
    // 1. Anthropic Provider Caching Test
    console.log("\n--- Testing Anthropic Caching ---");
    const anthropic = new AnthropicProvider({
      apiKey: "test-anthropic-key",
      model: "claude-3-5-sonnet-20240620",
    });

    const anthropicParams = {
      contexts: [
        { role: "system", content: "System instruction" },
        { role: "user", content: "Hello" }
      ] as Message[],
      enableCaching: true,
    };

    const anthropicResp = await anthropic.textChat(anthropicParams);

    // Validate Headers
    const headers = lastRequestInit?.headers as Record<string, string>;
    assert(headers["anthropic-beta"] === "prompt-caching-2024-07-31", "Anthropic Beta Header present");

    // Validate request body structure
    const body = JSON.parse(lastRequestInit?.body as string);
    assert(Array.isArray(body.system) && body.system[0].cache_control?.type === "ephemeral", "Anthropic System Prompt cached");
    assert(Array.isArray(body.messages[0].content) && body.messages[0].content[0].cache_control?.type === "ephemeral", "Anthropic Last Message cached");

    // Validate parsed token usage
    assert(anthropicResp.usage?.promptTokens === 100, "Anthropic promptTokens parsed");
    assert(anthropicResp.usage?.cacheCreationInputTokens === 80, "Anthropic cacheCreationInputTokens parsed");
    assert(anthropicResp.usage?.cacheReadInputTokens === 20, "Anthropic cacheReadInputTokens parsed");

    // 2. Gemini Provider Caching Test (with Configurable TTL)
    console.log("\n--- Testing Gemini Caching with Configurable TTL ---");
    const gemini = new GeminiProvider({
      apiKey: "test-gemini-key",
      model: "gemini-1.5-flash",
      cacheTtl: "600s" // Test configurable TTL
    });

    // Mock Context Cache Creation
    const cacheName = await (gemini as any).createContextCache(
      "gemini-1.5-flash",
      [{ role: "user", parts: [{ text: "Cached message" }] }],
      { parts: [{ text: "Cached system instruction" }] },
      [{ functionDeclarations: [{ name: "test_tool" }] }],
      "600s"
    );

    assert(lastRequestUrl?.includes("/cachedContents") === true, "Gemini createContextCache URL");
    const cacheBody = JSON.parse(lastRequestInit?.body as string);
    assert(cacheBody.model === "models/gemini-1.5-flash", "Gemini createContextCache body model");
    assert(Array.isArray(cacheBody.contents), "Gemini createContextCache body contents");
    assert(cacheBody.ttl === "600s", "Gemini createContextCache TTL matches config");
    assert(cacheName?.name === "cachedContents/mock-cache-id", "Gemini createContextCache response cachedContent name parsed");

    // 2b. Gemini cache reuse must not drop the messages between the cached
    // prefix and the latest turn. Regression test: previously the reuse branch
    // sent only `[lastMessage]`, silently dropping everything in between.
    console.log("\n--- Testing Gemini Cache Reuse (no dropped messages) ---");
    requestLog = [];
    cacheCreateCount = 0;
    const geminiReuse = new GeminiProvider({
      apiKey: "test-gemini-key",
      model: "gemini-1.5-flash",
      enableCaching: true,
      cacheThreshold: 10,
      cacheTtlSeconds: 600,
    } as any);

    const pad = (s: string) => s + " lorem ipsum dolor sit amet consectetur adipiscing elit".repeat(3);
    const systemMsg = { role: "system", content: pad("SYS") } as Message;
    const u1 = { role: "user", content: pad("U1") } as Message;
    const a1 = { role: "assistant", content: pad("A1") } as Message;
    const u2 = { role: "user", content: "U2" } as Message;
    const a2 = { role: "assistant", content: "A2" } as Message;
    const u3 = { role: "user", content: "U3" } as Message;

    const funcTool = {
      empty: () => false,
      openaiSchema: () => [{ type: "function", function: { name: "test_tool" } }],
      anthropicSchema: () => [{ name: "test_tool" }],
      googleSchema: () => ({ functionDeclarations: [{ name: "test_tool" }] }),
    };

    await geminiReuse.textChat({
      contexts: [systemMsg, u1, a1, u2],
      enableCaching: true,
      sessionId: "reuse-session",
      funcTool,
    });
    await geminiReuse.textChat({
      contexts: [systemMsg, u1, a1, u2, a2, u3],
      enableCaching: true,
      sessionId: "reuse-session",
      funcTool,
    });

    const genReqs = requestLog.filter((r) => r.url.includes("generateContent"));
    assert(cacheCreateCount === 1, "Gemini cache created exactly once across turns");
    assert(genReqs[1]?.body?.cachedContent === "cachedContents/mock-cache-id", "Gemini second turn reuses cachedContent");
    assert(
      Array.isArray(genReqs[1]?.body?.contents) && genReqs[1].body.contents.length === 3,
      `Gemini reuse sends cached prefix delta (expected 3 contents, got ${genReqs[1]?.body?.contents?.length})`,
    );
    assert(
      genReqs[1]?.body?.contents?.[0]?.parts?.[0]?.text === "U2",
      "Gemini reuse keeps the message immediately after the cached prefix",
    );
    // Gemini bakes systemInstruction/tools into the cachedContent object and
    // rejects requests that also carry them alongside `cachedContent`.
    assert(genReqs[1]?.body?.tools === undefined, "Gemini reuse omits tools when cachedContent is sent");
    assert(genReqs[1]?.body?.systemInstruction === undefined, "Gemini reuse omits systemInstruction when cachedContent is sent");
    // The cache-creation request itself must carry the tools.
    const createReq = requestLog.find((r) => r.url.includes("/cachedContents") && r.method === "POST");
    assert(createReq?.body?.tools !== undefined, "Gemini cache creation embeds tools in the cachedContent object");

    // 2c. A changed system instruction invalidates the cache and rebuilds it,
    // and the stale server-side cache must be deleted (not leaked).
    console.log("\n--- Testing Gemini Cache Invalidation on System Change ---");
    requestLog = [];
    cacheCreateCount = 0;
    cacheDeleteCount = 0;
    await geminiReuse.textChat({
      contexts: [{ role: "system", content: pad("SYS-CHANGED") } as Message, u1, a1, u2, a2, u3],
      enableCaching: true,
      sessionId: "reuse-session",
      funcTool,
    });
    const genReqs2 = requestLog.filter((r) => r.url.includes("generateContent"));
    assert(cacheCreateCount === 1, "Gemini rebuilds cache when system instruction changes");
    assert(cacheDeleteCount === 1, "Gemini deletes the stale server-side cache on invalidation");
    assert(genReqs2[0]?.body?.cachedContent !== undefined || genReqs2[0]?.body?.contents?.length === 6,
      "Gemini changed-system request is served (cached or inline)");

    // 2d. A rebuild that cannot happen (below threshold) must still release the
    // now-unusable server-side cache rather than leaking it.
    console.log("\n--- Testing Gemini Stale Cache Release When Below Threshold ---");
    requestLog = [];
    cacheCreateCount = 0;
    cacheDeleteCount = 0;
    const geminiSmall = new GeminiProvider({
      apiKey: "test-gemini-key",
      model: "gemini-1.5-flash",
      enableCaching: true,
      cacheThreshold: 10,
      cacheTtlSeconds: 600,
    } as any);
    // Seed a cache under one session...
    await geminiSmall.textChat({
      contexts: [systemMsg, u1, a1, u2],
      enableCaching: true,
      sessionId: "small-session",
      funcTool,
    });
    assert(cacheCreateCount === 1, "Gemini seeds cache for the small-session");
    // ...then issue a changed request whose prefix is too small to rebuild
    // (below cacheThreshold): the old cache must be deleted instead of
    // lingering until its remote TTL.
    const tinySystem = { role: "system", content: "S" } as Message;
    const tinyU1 = { role: "user", content: "a" } as Message;
    const tinyA1 = { role: "assistant", content: "b" } as Message;
    const tinyU2 = { role: "user", content: "c" } as Message;
    await geminiSmall.textChat({
      contexts: [tinySystem, tinyU1, tinyA1, tinyU2],
      enableCaching: true,
      sessionId: "small-session",
      funcTool,
    });
    assert(cacheDeleteCount >= 1, "Gemini releases stale server-side cache when it cannot be rebuilt");

    // 3. OpenAI Responses Provider Caching Test
    console.log("\n--- Testing OpenAI Responses Caching ---");
    const openaiResponses = new OpenAIResponsesProvider({
      apiKey: "test-openai-key",
      model: "gpt-4o",
    });

    const responsesResp = await openaiResponses.textChat({
      contexts: [{ role: "user", content: "Hello" }] as Message[],
    });

    assert(responsesResp.usage?.promptTokens === 100, "OpenAI Responses promptTokens parsed");
    assert(responsesResp.usage?.cacheReadInputTokens === 45, "OpenAI Responses cacheReadInputTokens parsed");

    console.log(`\n结果: ${passCount} 通过, ${failCount} 失败`);
    if (failCount > 0) {
      process.exit(1);
    }
    console.log("🎉 All caching unit tests completed successfully!");
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
