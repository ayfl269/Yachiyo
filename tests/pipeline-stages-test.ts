/**
 * Pipeline stages 单元测试
 * 验证 8 个 pipeline stage 的核心逻辑
 */
import {
  ComponentType,
  MessageType,
  PlatformMessage,
  MessageSession,
  MessageEvent,
  EventResult,
  ResultContentType,
  SessionLockManager,
  SessionServiceManager,
  ContentSafetyStrategySelector,
  KeywordsStrategy,
  PipelineStage,
} from "../src/index.js";
import { WakingCheckStage } from "@yachiyo/pipeline/stages/waking-check.js";
import { RateLimitStage } from "@yachiyo/pipeline/stages/rate-limit.js";
import { ContentSafetyCheckStage } from "@yachiyo/pipeline/stages/content-safety-check.js";
import { SessionStatusCheckStage } from "@yachiyo/pipeline/stages/session-status-check.js";
import { ResultDecorateStage } from "@yachiyo/pipeline/stages/result-decorate.js";
import type { PipelineContext } from "@yachiyo/pipeline/context.js";

// ── Test framework ──
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

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
  } catch (e) {
    failCount++;
    console.error(`  ❌ Unexpected error: ${e}`);
  }
}

// ── Mock MessageEvent ──

class MockMessageEvent extends MessageEvent {
  private _umo: string;

  constructor(opts: {
    messageStr?: string;
    selfId?: string;
    senderId?: string;
    isPrivate?: boolean;
    components?: import("@yachiyo/message/components.js").MessageComponent[];
    unifiedMsgOrigin?: string;
  }) {
    const umo = opts.unifiedMsgOrigin ?? "test:group:session1";
    const components = opts.components ?? [];
    const messageObj: PlatformMessage = {
      type: opts.isPrivate ? MessageType.FRIEND_MESSAGE : MessageType.GROUP_MESSAGE,
      messageId: "test-msg-1",
      selfId: opts.selfId ?? "bot123",
      sender: { userId: opts.senderId ?? "user456", nickname: "TestUser" },
      components,
      rawMessage: opts.messageStr ?? "",
    };
    super(
      opts.messageStr ?? "",
      messageObj,
      {
        name: "test",
        description: "test",
        id: "test-platform",
        supportStreamingMessage: false,
        supportProactiveMessage: false,
      },
      MessageSession.fromStr(umo),
    );
    this._umo = umo;
  }

  get unifiedMsgOrigin(): string {
    return this._umo;
  }
}

// ── Mock stores ──

class MockDisabledStore {
  private disabled = new Set<string>();
  isDisabled(umo: string): boolean { return this.disabled.has(umo); }
  disable(umo: string): void { this.disabled.add(umo); }
  enable(umo: string): void { this.disabled.delete(umo); }
}

class MockWhitelistStore {
  private whitelisted = new Set<string>();
  isWhitelisted(umo: string): boolean { return this.whitelisted.has(umo); }
  add(umo: string): void { this.whitelisted.add(umo); }
  remove(umo: string): void { this.whitelisted.delete(umo); }
  listAll(): Array<{ unified_msg_origin: string; added_at: string }> {
    return [...this.whitelisted].map(umo => ({ unified_msg_origin: umo, added_at: new Date().toISOString() }));
  }
}

// ── Mock plugin manager for WakingCheckStage ──

function createMockPluginManager(handlers: unknown[] = []) {
  return {
    getHandlerRegistry: () => ({
      getHandlersByEventType: () => handlers,
    }),
  };
}

// ── Tests ──

async function testContentSafetyStrategySelector(): Promise<void> {
  // 1. Keywords strategy — basic matching
  const selector = new ContentSafetyStrategySelector({
    safetyKeywords: ["spam", "bad word"],
    safetyCheckResponse: true,
  });

  assert(selector.checkResponse === true, "checkResponse should be true");

  const ok = selector.check("hello world");
  assert(ok.passed === true, "Clean text should pass");

  const blocked1 = selector.check("this is spam");
  assert(blocked1.passed === false, "Text containing 'spam' should be blocked");

  // Case insensitive
  const blocked2 = selector.check("THIS IS SPAM");
  assert(blocked2.passed === false, "Keyword matching should be case-insensitive");

  // Multi-word keyword
  const blocked3 = selector.check("this is a bad word here");
  assert(blocked3.passed === false, "Multi-word keyword should match");

  // 2. No keywords configured
  const emptySelector = new ContentSafetyStrategySelector({});
  const emptyResult = emptySelector.check("anything goes");
  assert(emptyResult.passed === true, "Empty strategy should pass everything");
  assert(emptySelector.checkResponse === false, "checkResponse default should be false");
}

async function testKeywordsStrategyDirectly(): Promise<void> {
  const strategy = new KeywordsStrategy(["evil", "恶意"]);

  assert(strategy.check("good").passed === true, "Clean text passes");
  assert(strategy.check("evil text").passed === false, "English keyword blocks");
  assert(strategy.check("包含恶意的文本").passed === false, "Chinese keyword blocks");
  assert(strategy.check("EVIL").passed === false, "Case insensitive");

  // Regex special characters should be escaped
  const specialStrategy = new KeywordsStrategy(["a.b", "c*d"]);
  assert(specialStrategy.check("a.b").passed === false, "Literal dot matches");
  assert(specialStrategy.check("axb").passed === true, "Dot is literal, not wildcard");
}

async function testSessionServiceManager(): Promise<void> {
  // 1. No stores — everything allowed
  const noStoreMgr = new SessionServiceManager();
  assert(await noStoreMgr.isSessionEnabled("umo1", false) === true, "No store: should allow");
  assert(await noStoreMgr.isSessionEnabled("umo1", true) === true, "No store whitelist: should allow (no store to check)");

  // 2. Blacklist
  const disabledStore = new MockDisabledStore();
  const blacklistMgr = new SessionServiceManager(disabledStore as unknown as Parameters<typeof SessionServiceManager>[0]);
  assert(await blacklistMgr.isSessionEnabled("umo1", false) === true, "Non-blacklisted UMO allowed");
  disabledStore.disable("umo1");
  assert(await blacklistMgr.isSessionEnabled("umo1", false) === false, "Blacklisted UMO blocked");
  assert(await blacklistMgr.isSessionEnabled("umo2", false) === true, "Other UMO still allowed");

  // 3. Global disable
  disabledStore.enable("umo1");
  await blacklistMgr.disableSession(); // disables SINGLE_USER_UMO
  assert(await blacklistMgr.isSessionEnabled("any_umo", false) === false, "Global disable blocks all");

  // 4. Whitelist mode
  await blacklistMgr.enableSession(); // un-global-disable
  const wlStore = new MockWhitelistStore();
  const whitelistMgr = new SessionServiceManager(
    disabledStore as unknown as Parameters<typeof SessionServiceManager>[0],
    wlStore as unknown as Parameters<typeof SessionServiceManager>[1],
  );

  assert(await whitelistMgr.isSessionEnabled("umo1", false) === true, "Whitelist off: all allowed");
  assert(await whitelistMgr.isSessionEnabled("umo1", true) === false, "Whitelist on: non-listed blocked");

  wlStore.add("umo_whitelisted");
  assert(await whitelistMgr.isSessionEnabled("umo_whitelisted", true) === true, "Whitelisted UMO allowed");
  assert(await whitelistMgr.isSessionEnabled("umo_other", true) === false, "Non-whitelisted UMO blocked");

  // 5. Blacklist takes priority over whitelist
  wlStore.add("umo_blacklisted");
  disabledStore.disable("umo_blacklisted");
  assert(await whitelistMgr.isSessionEnabled("umo_blacklisted", true) === false, "Blacklisted + whitelisted: blacklist wins");
}

async function testRateLimitStage(): Promise<void> {
  // 1. Disabled — no limiting
  const disabledStage = new RateLimitStage();
  await disabledStage.initialize({
    config: { rateLimitEnabled: false },
  } as unknown as PipelineContext);

  const event1 = new MockMessageEvent({ messageStr: "hi" });
  await disabledStage.process(event1);
  assert(!event1.isStopped(), "Disabled rate limit should not stop events");
  disabledStage.destroy();

  // 2. DISCARD strategy
  const discardStage = new RateLimitStage();
  await discardStage.initialize({
    config: {
      rateLimitEnabled: true,
      rateLimitMaxRequests: 3,
      rateLimitWindowSeconds: 60,
      rateLimitStrategy: "DISCARD",
    },
  } as unknown as PipelineContext);

  // First 3 should pass
  for (let i = 0; i < 3; i++) {
    const e = new MockMessageEvent({ messageStr: `msg${i}`, unifiedMsgOrigin: "test:umo:1" });
    await discardStage.process(e);
    assert(!e.isStopped(), `Request ${i + 1} should pass (within limit)`);
  }
  // 4th should be discarded
  const e4 = new MockMessageEvent({ messageStr: "msg4", unifiedMsgOrigin: "test:umo:1" });
  await discardStage.process(e4);
  assert(e4.isStopped(), "4th request should be discarded (over limit)");

  // Different UMO should have its own counter
  const e5 = new MockMessageEvent({ messageStr: "msg5", unifiedMsgOrigin: "test:umo:2" });
  await discardStage.process(e5);
  assert(!e5.isStopped(), "Different UMO should have separate counter");
  discardStage.destroy();

  // 3. Window reset (use fake timers via short window)
  const shortWindowStage = new RateLimitStage();
  await shortWindowStage.initialize({
    config: {
      rateLimitEnabled: true,
      rateLimitMaxRequests: 1,
      rateLimitWindowSeconds: 0.1, // 100ms
      rateLimitStrategy: "DISCARD",
    },
  } as unknown as PipelineContext);

  const eA = new MockMessageEvent({ messageStr: "a", unifiedMsgOrigin: "test:reset:1" });
  await shortWindowStage.process(eA);
  assert(!eA.isStopped(), "First request passes");

  const eB = new MockMessageEvent({ messageStr: "b", unifiedMsgOrigin: "test:reset:1" });
  await shortWindowStage.process(eB);
  assert(eB.isStopped(), "Second request blocked (same window)");

  // Wait for window to reset
  await new Promise(resolve => setTimeout(resolve, 150));

  const eC = new MockMessageEvent({ messageStr: "c", unifiedMsgOrigin: "test:reset:1" });
  await shortWindowStage.process(eC);
  assert(!eC.isStopped(), "Request after window reset passes");
  shortWindowStage.destroy();
}

async function testSessionLockManager(): Promise<void> {
  const mgr = new SessionLockManager({ defaultTtlMs: 5000, watchdogIntervalMs: 1000 });

  // 1. Basic acquire/release
  const release1 = await mgr.acquireLock("umo1");
  assert(release1 !== undefined, "acquireLock returns release function");

  // 2. Same UMO blocks (test with timeout)
  const acquirePromise = mgr.acquireLock("umo1");
  const quickResult = await Promise.race([
    acquirePromise.then(() => "acquired"),
    new Promise(resolve => setTimeout(() => resolve("timeout"), 100)),
  ]);
  assert(quickResult === "timeout", "Second acquire on same UMO should block");

  // 3. Release unblocks
  release1();
  const acquireResult = await acquirePromise;
  assert(typeof acquireResult === "function", "Second acquire succeeds after release");
  acquireResult();

  // 4. Different UMO doesn't block
  const release3 = await mgr.acquireLock("umo2");
  assert(release3 !== undefined, "Different UMO acquires immediately");
  release3();

  // 5. Renew extends TTL
  const release4 = await mgr.acquireLock("umo3");
  const renewed = mgr.renewLock("umo3");
  assert(renewed === true, "renewLock returns true for held lock");

  const renewMissing = mgr.renewLock("nonexistent");
  assert(renewMissing === false, "renewLock returns false for non-held lock");
  release4();
}

async function testWakingCheckStage(): Promise<void> {
  const stage = new WakingCheckStage();
  await stage.initialize({
    config: {
      wakePrefix: "/ai",
      friendMessageNeedsWakePrefix: false,
    },
    pluginManager: createMockPluginManager([]),
  } as unknown as PipelineContext);

  // 1. Self-message should be stopped
  const selfEvent = new MockMessageEvent({ messageStr: "hi", selfId: "123", senderId: "123" });
  await stage.process(selfEvent);
  assert(selfEvent.isStopped(), "Self-message should be stopped");

  // 2. Wake prefix triggers wake
  const wakeEvent = new MockMessageEvent({ messageStr: "/ai hello", selfId: "bot", senderId: "user" });
  await stage.process(wakeEvent);
  assert(wakeEvent.isWake === true, "Wake prefix should trigger wake");
  assert(wakeEvent.messageStr === "hello", "Wake prefix should be stripped from messageStr");

  // 3. No wake prefix in group → not woken
  const noWakeEvent = new MockMessageEvent({ messageStr: "hello", selfId: "bot", senderId: "user", isPrivate: false });
  await stage.process(noWakeEvent);
  assert(noWakeEvent.isStopped(), "Group message without prefix should be stopped");
  assert(noWakeEvent.isWake === false, "Should not wake without prefix in group");

  // 4. Private message auto-wakes (friendMessageNeedsWakePrefix=false)
  const privateEvent = new MockMessageEvent({ messageStr: "hello", selfId: "bot", senderId: "user", isPrivate: true });
  await stage.process(privateEvent);
  assert(privateEvent.isWake === true, "Private message should auto-wake");
  assert(!privateEvent.isStopped(), "Private message should not be stopped");

  // 5. @bot triggers wake
  const atBotEvent = new MockMessageEvent({
    messageStr: "hi",
    selfId: "bot123",
    senderId: "user",
    components: [{ type: ComponentType.At, qq: "bot123", toDict: () => ({}) } as never],
  });
  await stage.process(atBotEvent);
  assert(atBotEvent.isWake === true, "@bot should trigger wake");

  // 6. @all triggers wake
  const atAllEvent = new MockMessageEvent({
    messageStr: "hi",
    selfId: "bot123",
    senderId: "user",
    components: [{ type: ComponentType.AtAll, qq: "all", toDict: () => ({}) } as never],
  });
  await stage.process(atAllEvent);
  assert(atAllEvent.isWake === true, "@all should trigger wake");

  // 7. friendMessageNeedsWakePrefix=true → private needs prefix
  const strictStage = new WakingCheckStage();
  await strictStage.initialize({
    config: {
      wakePrefix: "/ai",
      friendMessageNeedsWakePrefix: true,
    },
    pluginManager: createMockPluginManager([]),
  } as unknown as PipelineContext);
  const strictPrivate = new MockMessageEvent({ messageStr: "hello", selfId: "bot", senderId: "user", isPrivate: true });
  await strictStage.process(strictPrivate);
  assert(strictPrivate.isStopped(), "Private without prefix should be stopped when friendMessageNeedsWakePrefix=true");
  assert(strictPrivate.isWake === false, "Should not wake without prefix even in private");
}

async function testContentSafetyCheckStage(): Promise<void> {
  const stage = new ContentSafetyCheckStage();
  await stage.initialize({
    config: {
      safetyKeywords: ["banned"],
      safetyCheckResponse: false,
    },
  } as unknown as PipelineContext);

  // 1. Safe input passes pre-check
  const safeEvent = new MockMessageEvent({ messageStr: "hello world", selfId: "bot", senderId: "user", isPrivate: true });
  // ContentSafetyCheckStage.process is an async generator (onion model)
  const gen = stage.process(safeEvent);
  const genResult = await gen.next();
  assert(genResult.done === false, "Safe input yields (pre-check passes, enters onion)");

  // Consume remaining generator
  await gen.next();

  // 2. Unsafe input blocked
  const unsafeEvent = new MockMessageEvent({ messageStr: "this is banned", selfId: "bot", senderId: "user", isPrivate: true });
  const gen2 = stage.process(unsafeEvent);
  await gen2.next(); // Should stop event and return
  assert(unsafeEvent.isStopped(), "Unsafe input should be stopped");
}

async function testSessionStatusCheckStage(): Promise<void> {
  const disabledStore = new MockDisabledStore();
  const wlStore = new MockWhitelistStore();
  const sessionMgr = new SessionServiceManager(
    disabledStore as unknown as Parameters<typeof SessionServiceManager>[0],
    wlStore as unknown as Parameters<typeof SessionServiceManager>[1],
  );

  const stage = new SessionStatusCheckStage();
  await stage.initialize({
    config: { sessionWhitelistEnabled: false },
    sessionServiceManager: sessionMgr,
  } as unknown as PipelineContext);

  // 1. Normal session passes
  const normalEvent = new MockMessageEvent({ messageStr: "hi", unifiedMsgOrigin: "test:normal:1" });
  await stage.process(normalEvent);
  assert(!normalEvent.isStopped(), "Normal session should pass");

  // 2. Blacklisted session blocked
  disabledStore.disable("test:blacklisted:1");
  const blockedEvent = new MockMessageEvent({ messageStr: "hi", unifiedMsgOrigin: "test:blacklisted:1" });
  await stage.process(blockedEvent);
  assert(blockedEvent.isStopped(), "Blacklisted session should be blocked");

  // 3. Whitelist mode
  const wlStage = new SessionStatusCheckStage();
  await wlStage.initialize({
    config: { sessionWhitelistEnabled: true },
    sessionServiceManager: sessionMgr,
  } as unknown as PipelineContext);

  const nonWlEvent = new MockMessageEvent({ messageStr: "hi", unifiedMsgOrigin: "test:nonwl:1" });
  await wlStage.process(nonWlEvent);
  assert(nonWlEvent.isStopped(), "Non-whitelisted session blocked in whitelist mode");

  wlStore.add("test:wl:1");
  const wlEvent = new MockMessageEvent({ messageStr: "hi", unifiedMsgOrigin: "test:wl:1" });
  await wlStage.process(wlEvent);
  assert(!wlEvent.isStopped(), "Whitelisted session passes in whitelist mode");
}

async function testResultDecorateStage(): Promise<void> {
  const stage = new ResultDecorateStage();

  // Create a minimal mock context
  const mockCtx = {
    config: {
      replyPrefix: "[Bot] ",
      segmentedReply: false,
      ttsEnabled: false,
      t2iEnabled: false,
      displayReasoningText: false,
    },
    providerManager: { getUsingTtsProvider: () => null },
    callEventHook: async () => false,
  };

  await stage.initialize(mockCtx as unknown as PipelineContext);

  // 1. Reply prefix is prepended
  const event1 = new MockMessageEvent({ messageStr: "hi", selfId: "bot", senderId: "user", isPrivate: true });
  event1.setResult(new EventResult().plain("Hello!"));
  await stage.process(event1);
  const result1 = event1.getResult();
  const text1 = result1?.getPlainText();
  assert(text1 === "[Bot] Hello!", `Reply prefix should be prepended (got: "${text1}")`);

  // 2. No result → no-op
  const event2 = new MockMessageEvent({ messageStr: "hi", selfId: "bot", senderId: "user", isPrivate: true });
  // result is null by default
  await stage.process(event2);
  assert(event2.getResult() === null, "No result → stage should be no-op");

  // 3. Streaming result → skipped
  const event3 = new MockMessageEvent({ messageStr: "hi", selfId: "bot", senderId: "user", isPrivate: true });
  event3.setResult(
    new EventResult()
      .setResultContentType(ResultContentType.STREAMING_RESULT)
      .plain("streaming text")
  );
  await stage.process(event3);
  const text3 = event3.getResult()?.getPlainText();
  assert(text3 === "streaming text", "Streaming result should not get reply prefix");

  // 4. Reasoning text injection
  const reasoningStage = new ResultDecorateStage();
  await reasoningStage.initialize({
    ...mockCtx,
    config: {
      ...mockCtx.config,
      replyPrefix: "",
      displayReasoningText: true,
    },
  } as unknown as PipelineContext);

  const event4 = new MockMessageEvent({ messageStr: "hi", selfId: "bot", senderId: "user", isPrivate: true });
  event4.setResult(new EventResult().plain("Answer"));
  event4.setExtra("reasoning_content", "Let me think...");
  await reasoningStage.process(event4);
  const text4 = event4.getResult()?.getPlainText();
  assert(text4?.includes("[思考过程]"), "Reasoning header should be injected");
  assert(text4?.includes("Let me think..."), "Reasoning content should be included");
  assert(text4?.includes("[回复]"), "Reply marker should be present");
  assert(text4?.includes("Answer"), "Original answer should be present");
}

async function testResultDecorateSegmentedReply(): Promise<void> {
  // Test the splitTextToSegments logic indirectly via process()
  const stage = new ResultDecorateStage();
  await stage.initialize({
    config: {
      replyPrefix: "",
      segmentedReply: true,
      ttsEnabled: false,
      t2iEnabled: false,
      displayReasoningText: false,
    },
    providerManager: { getUsingTtsProvider: () => null },
    callEventHook: async () => false,
  } as unknown as PipelineContext);

  // Short text → single segment
  const event1 = new MockMessageEvent({ messageStr: "hi", selfId: "bot", senderId: "user", isPrivate: true });
  event1.setResult(new EventResult().plain("Short text."));
  await stage.process(event1);
  const components1 = event1.getResult()?.components ?? [];
  assert(components1.length === 1, "Short text should produce 1 segment");

  // Long text → multiple segments
  const longText = "First sentence。Second sentence！Third sentence？".repeat(15);
  const event2 = new MockMessageEvent({ messageStr: "hi", selfId: "bot", senderId: "user", isPrivate: true });
  event2.setResult(new EventResult().plain(longText));
  await stage.process(event2);
  const components2 = event2.getResult()?.components ?? [];
  assert(components2.length > 1, "Long text should be split into multiple segments");
}

// ── Main ──

async function main(): Promise<void> {
  console.log("Pipeline Stages Unit Tests\n");

  await test("ContentSafetyStrategySelector", testContentSafetyStrategySelector);
  await test("KeywordsStrategy", testKeywordsStrategyDirectly);
  await test("SessionServiceManager", testSessionServiceManager);
  await test("RateLimitStage", testRateLimitStage);
  await test("SessionLockManager", testSessionLockManager);
  await test("WakingCheckStage", testWakingCheckStage);
  await test("ContentSafetyCheckStage", testContentSafetyCheckStage);
  await test("SessionStatusCheckStage", testSessionStatusCheckStage);
  await test("ResultDecorateStage", testResultDecorateStage);
  await test("ResultDecorateStage - Segmented Reply", testResultDecorateSegmentedReply);

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passCount} passed, ${failCount} failed`);
  console.log(`${"=".repeat(50)}`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
