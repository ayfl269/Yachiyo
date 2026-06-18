/**
 * Context System Special Tests
 * Verifies round-based truncation, soft/hard compression limit double-checking,
 * and trustedTokenUsage cache invalidation on truncation.
 */
import {
  createContextConfig,
  ContextManager,
  ContextTruncator,
  splitIntoRounds,
} from "../src/index.js";
import type { Message, TokenCounter, ContextCompressor } from "../src/index.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ============================================================
// 1. Test: Precise round-based turn truncation
// ============================================================
function testPreciseRoundTruncation(): void {
  console.log("\n--- Test 1: Precise round-based turn truncation ---");

  const truncator = new ContextTruncator();

  // Create a mixed turn dialogue with tools and assistant replies
  // System: You are assistant.
  // Round 1: User "Q1" -> Assistant tool_calls "get_weather" -> Tool response "Sunny" -> Assistant "Here is the weather"
  // Round 2: User "Q2" -> Assistant tool_calls "calc" -> Tool response "42" -> Assistant "Result is 42"
  // Round 3: User "Q3" -> Assistant "No tools reply"
  // Round 4: User "Q4" -> Assistant "Final reply"
  const messages: Message[] = [
    { role: "system", content: "You are a helpful assistant." },
    // Round 1
    { role: "user", content: "Q1" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ type: "function", id: "tc-1", function: { name: "get_weather", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "tc-1", content: "Sunny" },
    { role: "assistant", content: "Here is the weather" },
    // Round 2
    { role: "user", content: "Q2" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ type: "function", id: "tc-2", function: { name: "calc", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "tc-2", content: "42" },
    { role: "assistant", content: "Result is 42" },
    // Round 3
    { role: "user", content: "Q3" },
    { role: "assistant", content: "No tools reply" },
    // Round 4
    { role: "user", content: "Q4" },
    { role: "assistant", content: "Final reply" },
  ];

  // Test keepMostRecentTurns = 2
  // We expect Round 3 and Round 4 to be kept, plus System.
  const truncated2 = truncator.truncateByTurns(messages, 2, 1);
  console.log("  keepMostRecentTurns = 2, messages count:", truncated2.length);

  const rounds2 = splitIntoRounds(truncated2.filter(m => m.role !== "system"));
  console.log("  Remaining rounds count:", rounds2.length);
  assert(rounds2.length === 2, "Expected exactly 2 rounds left");
  assert(rounds2[0][0].role === "user" && rounds2[0][0].content === "Q3", "Expected first remaining round to start with Q3");
  assert(rounds2[1][0].role === "user" && rounds2[1][0].content === "Q4", "Expected second remaining round to start with Q4");

  // Test keepMostRecentTurns = 3
  // We expect Round 2, Round 3 and Round 4 to be kept, plus System.
  const truncated3 = truncator.truncateByTurns(messages, 3, 1);
  console.log("  keepMostRecentTurns = 3, messages count:", truncated3.length);

  const rounds3 = splitIntoRounds(truncated3.filter(m => m.role !== "system"));
  console.log("  Remaining rounds count:", rounds3.length);
  assert(rounds3.length === 3, "Expected exactly 3 rounds left");
  assert(rounds3[0][0].role === "user" && rounds3[0][0].content === "Q2", "Expected first remaining round to start with Q2");
  // Check that the tool calls and responses in Round 2 were preserved intact
  assert(rounds3[0].length === 4, "Expected Round 2 to have all 4 messages preserved intact (user + assistant tool_calls + tool + assistant)");
  assert(rounds3[0][1].tool_calls !== undefined, "Expected assistant tool call message to be preserved");
  assert(rounds3[0][2].role === "tool", "Expected tool response message to be preserved");

  console.log("  ✅ Precise round-based turn truncation passed");
}

// ============================================================
// 2. Test: Soft Limit vs Hard Limit in runCompression
// ============================================================
class MockTokenCounter implements TokenCounter {
  countTokens(messages: Message[], trustedTokenUsage = 0): number {
    // Return different tokens depending on message array size to simulate compression
    if (messages.length === 2) {
      return 850; // Compressed size: 85% of maxContextTokens (1000)
    }
    return 1200; // Original size: 120% of maxContextTokens (1000)
  }
}

class MockCompressor implements ContextCompressor {
  shouldCompress(messages: Message[], currentTokens: number, maxTokens: number): boolean {
    // Trigger compression if above 82%
    return currentTokens / maxTokens > 0.82;
  }
  async compress(messages: Message[]): Promise<Message[]> {
    // Simulates compression by returning a smaller list of 2 messages
    return [
      { role: "system", content: "System" },
      { role: "user", content: "Compressed message" }
    ];
  }
}

async function testSoftVsHardLimit(): Promise<void> {
  console.log("\n--- Test 2: Soft Limit vs Hard Limit in runCompression ---");

  const counter = new MockTokenCounter();
  const compressor = new MockCompressor();

  const config = createContextConfig({
    maxContextTokens: 1000,
    customTokenCounter: counter,
    customCompressor: compressor,
  });

  const manager = new ContextManager(config);

  const originalMessages: Message[] = [
    { role: "system", content: "System" },
    { role: "user", content: "Many messages here..." },
    { role: "assistant", content: "Response..." },
  ];

  // Process the messages
  const processed = await manager.process(originalMessages);

  // If the bug exists:
  // 1. totalTokens = 1200 > 1000. compressor.shouldCompress(1200, 1000) returns true.
  // 2. runCompression is called.
  // 3. compress() returns a list of length 2.
  // 4. tokensAfter = 850.
  // 5. If double check uses shouldCompress(850, 1000): 850/1000 = 85% > 82%, so it returns true!
  //    It would call truncateByHalving(), changing the list to length < 2 or dropping elements.
  // If the bug is fixed:
  // 5. Double check uses tokensAfter > maxContextTokens (850 > 1000 = false).
  //    It will NOT call truncateByHalving.
  // Thus, processed messages length should be exactly 2 (the compressed output).
  console.log("  Processed message count:", processed.length);
  assert(processed.length === 2, `Expected messages count to be exactly 2 (no halving), but got ${processed.length}`);
  assert(processed[1].content === "Compressed message", "Expected to contain compressed message");

  console.log("  ✅ Soft Limit vs Hard Limit in runCompression passed");
}

// ============================================================
// 3. Test: Invalidation of trustedTokenUsage on Truncation
// ============================================================
class SpyTokenCounter implements TokenCounter {
  lastTrustedTokenUsage: number | null = null;
  countTokens(messages: Message[], trustedTokenUsage = 0): number {
    this.lastTrustedTokenUsage = trustedTokenUsage;
    if (trustedTokenUsage > 0) {
      return trustedTokenUsage;
    }
    // Simple estimation when trustedTokenUsage is 0
    return messages.length * 10;
  }
}

async function testTrustedTokenUsageInvalidation(): Promise<void> {
  console.log("\n--- Test 3: trustedTokenUsage invalidation on truncation ---");

  const spyCounter = new SpyTokenCounter();
  const config = createContextConfig({
    maxContextTokens: 1000,
    enforceMaxTurns: 2,
    customTokenCounter: spyCounter,
  });

  const manager = new ContextManager(config);

  const messages: Message[] = [
    { role: "system", content: "System" },
    // Turn 1
    { role: "user", content: "Q1" },
    { role: "assistant", content: "A1" },
    // Turn 2
    { role: "user", content: "Q2" },
    { role: "assistant", content: "A2" },
    // Turn 3
    { role: "user", content: "Q3" },
    { role: "assistant", content: "A3" },
  ];

  // We pass a very large trustedTokenUsage (e.g. 5000), simulating a cached count from the full history.
  // Since messages have 3 turns, and enforceMaxTurns = 2, truncation WILL occur in Step 1.
  // The manager should set the trustedTokenUsage to 0 before calling tokenCounter.countTokens in Step 2.
  const processed = await manager.process(messages, 5000);

  console.log("  Processed message count:", processed.length);
  console.log("  Last trustedTokenUsage passed to counter:", spyCounter.lastTrustedTokenUsage);

  assert(processed.length === 5, `Expected 5 messages left (system + 2 turns), got ${processed.length}`);
  assert(spyCounter.lastTrustedTokenUsage === 0, `Expected trustedTokenUsage to be reset to 0, but got ${spyCounter.lastTrustedTokenUsage}`);

  console.log("  ✅ trustedTokenUsage invalidation on truncation passed");
}

// ============================================================
// Run All Tests
// ============================================================
async function main() {
  try {
    testPreciseRoundTruncation();
    await testSoftVsHardLimit();
    await testTrustedTokenUsageInvalidation();
    console.log("\n==============================================");
    console.log("🎉 All Context System Special Tests Passed!");
    console.log("==============================================\n");
  } catch (e) {
    console.error("❌ Test failed:", e);
    process.exit(1);
  }
}

main();
