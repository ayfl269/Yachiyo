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

async function mockFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  lastRequestUrl = typeof url === "string" ? url : (url as any).url || url.toString();
  lastRequestInit = init || null;
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

    assert(lastRequestUrl?.includes("/cachedContents"), "Gemini createContextCache URL");
    const cacheBody = JSON.parse(lastRequestInit?.body as string);
    assert(cacheBody.model === "models/gemini-1.5-flash", "Gemini createContextCache body model");
    assert(Array.isArray(cacheBody.contents), "Gemini createContextCache body contents");
    assert(cacheBody.ttl === "600s", "Gemini createContextCache TTL matches config");
    assert(cacheName?.name === "cachedContents/mock-cache-id", "Gemini createContextCache response cachedContent name parsed");

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
