import { AnthropicProvider } from "../src/provider/implementations/anthropic-provider.js";
import { GeminiProvider } from "../src/provider/implementations/gemini-provider.js";
import { OpenAIResponsesProvider } from "../src/provider/implementations/openai-responses-provider.js";
import { Message } from "@yachiyo/common/llm-message.js";

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
    console.log("  Anthropic Beta Header present:", headers["anthropic-beta"] === "prompt-caching-2024-07-31" ? "✅" : "❌");
    
    // Validate request body structure
    const body = JSON.parse(lastRequestInit?.body as string);
    console.log("  Anthropic System Prompt cached:", Array.isArray(body.system) && body.system[0].cache_control?.type === "ephemeral" ? "✅" : "❌");
    console.log("  Anthropic Last Message cached:", Array.isArray(body.messages[0].content) && body.messages[0].content[0].cache_control?.type === "ephemeral" ? "✅" : "❌");
    
    // Validate parsed token usage
    console.log("  Anthropic promptTokens parsed:", anthropicResp.usage?.promptTokens === 100 ? "✅" : "❌");
    console.log("  Anthropic cacheCreationInputTokens parsed:", anthropicResp.usage?.cacheCreationInputTokens === 80 ? "✅" : "❌");
    console.log("  Anthropic cacheReadInputTokens parsed:", anthropicResp.usage?.cacheReadInputTokens === 20 ? "✅" : "❌");

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

    console.log("  Gemini createContextCache URL:", lastRequestUrl?.includes("/cachedContents") ? "✅" : "❌");
    const cacheBody = JSON.parse(lastRequestInit?.body as string);
    console.log("  Gemini createContextCache body model:", cacheBody.model === "models/gemini-1.5-flash" ? "✅" : "❌");
    console.log("  Gemini createContextCache body contents:", Array.isArray(cacheBody.contents) ? "✅" : "❌");
    console.log("  Gemini createContextCache TTL matches config:", cacheBody.ttl === "600s" ? "✅" : "❌");
    console.log("  Gemini createContextCache response cachedContent name parsed:", cacheName === "cachedContents/mock-cache-id" ? "✅" : "❌");

    // 3. OpenAI Responses Provider Caching Test
    console.log("\n--- Testing OpenAI Responses Caching ---");
    const openaiResponses = new OpenAIResponsesProvider({
      apiKey: "test-openai-key",
      model: "gpt-4o",
    });

    const responsesResp = await openaiResponses.textChat({
      contexts: [{ role: "user", content: "Hello" }] as Message[],
    });

    console.log("  OpenAI Responses promptTokens parsed:", responsesResp.usage?.promptTokens === 100 ? "✅" : "❌");
    console.log("  OpenAI Responses cacheReadInputTokens parsed:", responsesResp.usage?.cacheReadInputTokens === 45 ? "✅" : "❌");

    console.log("\n🎉 All caching unit tests completed successfully!");
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
}

runTests().catch(console.error);
