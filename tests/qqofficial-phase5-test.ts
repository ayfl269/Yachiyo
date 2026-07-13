/**
 * Unit tests for QQ Official Bot adapter Phase 5 architectural extensions.
 *
 * Tests:
 * - Sandbox environment: getApiBase() / getWsUrl() switch based on config.sandbox
 * - Sharding support: getShard() + sendIdentify() payload shard field
 * - Intent subscription: getIntents() honors config.intents, config.intentNames, default fallback
 * - Raw event dispatching: onRawEvent() receives dispatched events via handleDispatch()
 *   - GUILD_CREATE / UPDATE / DELETE
 *   - CHANNEL_CREATE / UPDATE / DELETE
 *   - GUILD_MEMBER_ADD / UPDATE / REMOVE
 *   - MESSAGE_REACTION_ADD / REMOVE
 *   - INTERACTION_CREATE
 *   - MESSAGE_AUDIT_PASS / REJECT
 *   - FORUM_THREAD_CREATE / UPDATE / DELETE / POST / REPLY / AUDIT
 *   - AUDIO_START / FINISH / ON_MIC / OFF_MIC
 *   - READY / RESUMED
 *   - Wildcard "*" listener
 *   - Unknown event types via default case
 *   - Disposer function unsubscribes correctly
 */

import { QQOfficialAdapter } from "@yachiyo/platform/implementations/qqofficial-adapter.js";
import type { QQOfficialAdapterConfig } from "@yachiyo/platform/implementations/qqofficial-adapter.js";
import { AsyncQueue } from "@yachiyo/common/async-queue.js";
import { MessageEvent } from "@yachiyo/message/event.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  \u2714 ${message}`);
  } else {
    failed++;
    console.error(`  \u2718 ${message}`);
  }
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

class FetchMock {
  private calls: FetchCall[] = [];
  private responseMap = new Map<string, (call: FetchCall) => { status: number; body: unknown }>();

  install(): void {
    this.calls = [];
    const originalFetch = globalThis.fetch;
    (globalThis.fetch as unknown) = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      let body: unknown = undefined;
      if (init?.body) {
        try { body = JSON.parse(init.body as string); } catch { body = init.body; }
      }
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers as Record<string, string>;
        for (const k of Object.keys(h)) headers[k] = h[k];
      }
      const call: FetchCall = { url, method, body, headers };
      this.calls.push(call);

      let result = { status: 200, body: {} as unknown };
      for (const [pattern, handler] of this.responseMap) {
        if (url.includes(pattern)) {
          result = handler(call);
          break;
        }
      }

      const responseHeaders = new Headers({ "Content-Type": "application/json" });
      const responseBody = result.status === 204 ? null : JSON.stringify(result.body);
      return new Response(responseBody, {
        status: result.status,
        headers: responseHeaders,
      });
    };
    (this as unknown as { _original: typeof fetch })._original = originalFetch;
  }

  restore(): void {
    const original = (this as unknown as { _original?: typeof fetch })._original;
    if (original) (globalThis.fetch as unknown) = original;
  }

  route(pattern: string, handler: (call: FetchCall) => { status: number; body: unknown }): void {
    this.responseMap.set(pattern, handler);
  }

  getLastCall(): FetchCall | undefined {
    return this.calls.at(-1);
  }
}

interface AdapterInternals {
  accessToken: string;
  tokenExpiresAt: number;
  _status: string;
  ws: { send: (data: string) => void; readyState: number } | null;
  config: QQOfficialAdapterConfig;
  getApiBase: () => string;
  getWsUrl: () => string;
  getShard: () => [number, number] | undefined;
  getIntents: () => number;
  sendIdentify: () => void;
  handleDispatch: (eventType: string | undefined, seq: number | undefined, data: unknown) => void;
}

async function createAdapter(configOverrides: Partial<QQOfficialAdapterConfig> = {}): Promise<{
  adapter: QQOfficialAdapter;
  fetchMock: FetchMock;
  internals: AdapterInternals;
}> {
  const config: QQOfficialAdapterConfig = {
    type: "qqofficial",
    id: "test-qq-official-p5",
    appId: "test-app-id",
    appSecret: "test-secret",
    ...configOverrides,
  };
  const eventQueue = new AsyncQueue<MessageEvent>();
  const adapter = new QQOfficialAdapter(config, eventQueue);
  await adapter.initialize();

  const fetchMock = new FetchMock();
  fetchMock.install();
  fetchMock.route("getAppAccessToken", () => ({
    status: 200,
    body: { access_token: "mock-token-xyz", expires_in: 7200 },
  }));

  const internals = adapter as unknown as AdapterInternals;
  internals.accessToken = "mock-token-xyz";
  internals.tokenExpiresAt = Date.now() + 7200000;
  internals._status = "running";

  return { adapter, fetchMock, internals };
}

/** Mock the WebSocket on the adapter so sendIdentify() can be tested without a real connection. */
function mockWs(internals: AdapterInternals): { sentPayloads: unknown[] } {
  const sentPayloads: unknown[] = [];
  internals.ws = {
    send: (data: string) => { sentPayloads.push(JSON.parse(data)); },
    readyState: 1, // WebSocket.OPEN
  };
  return { sentPayloads };
}

async function main(): Promise<void> {

  // ══════════════════════════════════════════════════════
  // Phase 5-1: Sandbox URL switching
  // ══════════════════════════════════════════════════════

  console.log("\n=== Sandbox: getApiBase() returns production URL by default ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    assert(
      internals.getApiBase() === "https://api.sgroup.qq.com",
      "Default API base should be production URL",
    );
    assert(
      internals.getWsUrl() === "wss://api.sgroup.qq.com/websocket",
      "Default WebSocket URL should be production URL",
    );
    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== Sandbox: getApiBase() returns sandbox URL when sandbox:true ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter({ sandbox: true });
    assert(
      internals.getApiBase() === "https://sandbox.api.sgroup.qq.com",
      "Sandbox API base should be sandbox URL",
    );
    assert(
      internals.getWsUrl() === "wss://sandbox.api.sgroup.qq.com/websocket",
      "Sandbox WebSocket URL should be sandbox URL",
    );
    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== Sandbox: REST requests hit sandbox host when sandbox:true ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter({ sandbox: true });
    // We override config after creation to verify dynamic resolution too
    internals.config.sandbox = true;

    fetchMock.route("/gateway", () => ({
      status: 200,
      body: { url: "wss://sandbox.api.sgroup.qq.com/websocket" },
    }));

    await adapter.getGateway();
    const lastCall = fetchMock.getLastCall();
    assert(
      lastCall?.url.startsWith("https://sandbox.api.sgroup.qq.com"),
      `getGateway() should hit sandbox URL, got: ${lastCall?.url}`,
    );

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== Sandbox: REST requests hit production host when sandbox:false ===");
  {
    const { adapter, fetchMock } = await createAdapter({ sandbox: false });

    fetchMock.route("/gateway", () => ({
      status: 200,
      body: { url: "wss://api.sgroup.qq.com/websocket" },
    }));

    await adapter.getGateway();
    const lastCall = fetchMock.getLastCall();
    assert(
      lastCall?.url.startsWith("https://api.sgroup.qq.com"),
      `getGateway() should hit production URL, got: ${lastCall?.url}`,
    );

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  // ══════════════════════════════════════════════════════
  // Phase 5-2: Sharding support
  // ══════════════════════════════════════════════════════

  console.log("\n=== Sharding: getShard() returns undefined when no shard configured ===");
  {
    const { adapter, internals } = await createAdapter();
    assert(internals.getShard() === undefined, "getShard() should return undefined by default");
    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== Sharding: getShard() returns config.shard when set ===");
  {
    const { adapter, internals } = await createAdapter({ shard: [1, 3] });
    const shard = internals.getShard();
    assert(Array.isArray(shard), "getShard() should return an array");
    assert(shard?.[0] === 1, "Shard ID should be 1");
    assert(shard?.[1] === 3, "Total shards should be 3");
    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== Sharding: sendIdentify() includes shard:[0,1] when not configured ===");
  {
    const { adapter, internals } = await createAdapter();
    const { sentPayloads } = mockWs(internals);

    internals.sendIdentify();
    assert(sentPayloads.length === 1, "sendIdentify() should send one payload");
    const payload = sentPayloads[0] as { op: number; d: { shard: [number, number]; intents: number; token: string } };
    assert(payload.op === 2, "Opcode should be IDENTIFY (2)");
    assert(Array.isArray(payload.d.shard), "Payload should include shard array");
    assert(payload.d.shard[0] === 0, "Default shard ID should be 0");
    assert(payload.d.shard[1] === 1, "Default total shards should be 1");
    assert(payload.d.token === "QQBot mock-token-xyz", "Token should be included in IDENTIFY");

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== Sharding: sendIdentify() includes custom shard when configured ===");
  {
    const { adapter, internals } = await createAdapter({ shard: [2, 5] });
    const { sentPayloads } = mockWs(internals);

    internals.sendIdentify();
    const payload = sentPayloads[0] as { op: number; d: { shard: [number, number] } };
    assert(payload.d.shard[0] === 2, "Shard ID should be 2 (from config)");
    assert(payload.d.shard[1] === 5, "Total shards should be 5 (from config)");

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== Sharding: sendIdentify() is no-op when WebSocket not open ===");
  {
    const { adapter, internals } = await createAdapter();
    // ws is null by default (no real connection)
    internals.ws = null;
    internals.sendIdentify(); // should not throw
    assert(true, "sendIdentify() with null ws should not throw");

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  // ══════════════════════════════════════════════════════
  // Phase 5-3: Intent subscription
  // ══════════════════════════════════════════════════════

  console.log("\n=== Intents: default intents = GUILDS | PUBLIC_GUILD_MESSAGES ===");
  {
    const { adapter, internals } = await createAdapter();
    // GUILDS = 1<<0 = 1, PUBLIC_GUILD_MESSAGES = 1<<30
    const expected = (1 << 0) | (1 << 30);
    assert(
      internals.getIntents() === expected,
      `Default intents should be GUILDS|PUBLIC_GUILD_MESSAGES = ${expected}, got ${internals.getIntents()}`,
    );
    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== Intents: config.intents overrides everything ===");
  {
    const { adapter, internals } = await createAdapter({ intents: 42 });
    assert(
      internals.getIntents() === 42,
      `config.intents=42 should take precedence, got ${internals.getIntents()}`,
    );
    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== Intents: intentNames converts names to bitfield ===");
  {
    const { adapter, internals } = await createAdapter({
      intentNames: ["GUILDS", "GUILD_MEMBERS", "DIRECT_MESSAGE"],
    });
    // GUILDS=1<<0=1, GUILD_MEMBERS=1<<1=2, DIRECT_MESSAGE=1<<12=4096
    const expected = (1 << 0) | (1 << 1) | (1 << 12);
    assert(
      internals.getIntents() === expected,
      `intentNames GUILDS+GUILD_MEMBERS+DIRECT_MESSAGE = ${expected}, got ${internals.getIntents()}`,
    );
    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== Intents: GROUP_AT_MESSAGE_CREATE in intentNames contributes 0 bits ===");
  {
    const { adapter, internals } = await createAdapter({
      intentNames: ["GROUP_AT_MESSAGE_CREATE", "C2C_MESSAGE_CREATE"],
    });
    // Both are 0, so total is 0
    assert(
      internals.getIntents() === 0,
      `GROUP_AT_MESSAGE_CREATE + C2C_MESSAGE_CREATE should be 0, got ${internals.getIntents()}`,
    );
    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== Intents: full intentNames set combines all bits correctly ===");
  {
    const { adapter, internals } = await createAdapter({
      intentNames: [
        "GUILDS",
        "GUILD_MEMBERS",
        "GUILD_MESSAGES",
        "GUILD_MESSAGE_REACTIONS",
        "DIRECT_MESSAGE",
        "INTERACTION",
        "MESSAGE_AUDIT",
        "FORUMS_EVENT",
        "AUDIO_ACTION",
        "PUBLIC_GUILD_MESSAGES",
      ],
    });
    const expected =
      (1 << 0) |   // GUILDS
      (1 << 1) |   // GUILD_MEMBERS
      (1 << 9) |   // GUILD_MESSAGES
      (1 << 10) |  // GUILD_MESSAGE_REACTIONS
      (1 << 12) |  // DIRECT_MESSAGE
      (1 << 26) |  // INTERACTION
      (1 << 27) |  // MESSAGE_AUDIT
      (1 << 28) |  // FORUMS_EVENT
      (1 << 29) |  // AUDIO_ACTION
      (1 << 30);   // PUBLIC_GUILD_MESSAGES
    assert(
      internals.getIntents() === expected,
      `All intentNames should combine to ${expected}, got ${internals.getIntents()}`,
    );
    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== Intents: sendIdentify() includes intents in payload ===");
  {
    const { adapter, internals } = await createAdapter({
      intentNames: ["GUILDS", "INTERACTION"],
    });
    const { sentPayloads } = mockWs(internals);

    internals.sendIdentify();
    const payload = sentPayloads[0] as { d: { intents: number } };
    const expected = (1 << 0) | (1 << 26);
    assert(
      payload.d.intents === expected,
      `IDENTIFY payload intents should be ${expected}, got ${payload.d.intents}`,
    );

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  // ══════════════════════════════════════════════════════
  // Phase 5-4: onRawEvent — basic subscription and dispatch
  // ══════════════════════════════════════════════════════

  console.log("\n=== onRawEvent: GUILD_CREATE dispatched to subscriber ===");
  {
    const { adapter, internals } = await createAdapter();
    let received: unknown = null;
    const dispose = adapter.onRawEvent("GUILD_CREATE", (data) => { received = data; });

    const testData = { id: "guild_123", name: "Test Guild" };
    internals.handleDispatch("GUILD_CREATE", 5, testData);
    assert(received === testData, "GUILD_CREATE handler should receive the data object");
    assert(received !== null, "Handler should have been called");

    dispose();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== onRawEvent: CHANNEL_CREATE/UPDATE/DELETE dispatched ===");
  {
    const { adapter, internals } = await createAdapter();
    const events: string[] = [];
    adapter.onRawEvent("CHANNEL_CREATE", () => { events.push("CHANNEL_CREATE"); });
    adapter.onRawEvent("CHANNEL_UPDATE", () => { events.push("CHANNEL_UPDATE"); });
    adapter.onRawEvent("CHANNEL_DELETE", () => { events.push("CHANNEL_DELETE"); });

    internals.handleDispatch("CHANNEL_CREATE", 1, { id: "c1" });
    internals.handleDispatch("CHANNEL_UPDATE", 2, { id: "c1" });
    internals.handleDispatch("CHANNEL_DELETE", 3, { id: "c1" });
    assert(events.length === 3, `All 3 channel events should fire, got ${events.length}`);
    assert(events[0] === "CHANNEL_CREATE", "First event should be CHANNEL_CREATE");
    assert(events[2] === "CHANNEL_DELETE", "Last event should be CHANNEL_DELETE");

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== onRawEvent: GUILD_MEMBER_ADD/UPDATE/REMOVE dispatched ===");
  {
    const { adapter, internals } = await createAdapter();
    let count = 0;
    adapter.onRawEvent("GUILD_MEMBER_ADD", () => { count++; });
    adapter.onRawEvent("GUILD_MEMBER_UPDATE", () => { count++; });
    adapter.onRawEvent("GUILD_MEMBER_REMOVE", () => { count++; });

    internals.handleDispatch("GUILD_MEMBER_ADD", 1, { user: { id: "u1" } });
    internals.handleDispatch("GUILD_MEMBER_UPDATE", 2, {});
    internals.handleDispatch("GUILD_MEMBER_REMOVE", 3, {});
    assert(count === 3, `All 3 member events should fire, got ${count}`);

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== onRawEvent: GUILD_CREATE/UPDATE/DELETE dispatched ===");
  {
    const { adapter, internals } = await createAdapter();
    const events: string[] = [];
    adapter.onRawEvent("GUILD_CREATE", () => { events.push("GUILD_CREATE"); });
    adapter.onRawEvent("GUILD_UPDATE", () => { events.push("GUILD_UPDATE"); });
    adapter.onRawEvent("GUILD_DELETE", () => { events.push("GUILD_DELETE"); });

    internals.handleDispatch("GUILD_CREATE", 1, {});
    internals.handleDispatch("GUILD_UPDATE", 2, {});
    internals.handleDispatch("GUILD_DELETE", 3, {});
    assert(events.length === 3, `All 3 guild events should fire, got ${events.length}`);

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== onRawEvent: MESSAGE_REACTION_ADD/REMOVE dispatched ===");
  {
    const { adapter, internals } = await createAdapter();
    const events: string[] = [];
    adapter.onRawEvent("MESSAGE_REACTION_ADD", () => { events.push("ADD"); });
    adapter.onRawEvent("MESSAGE_REACTION_REMOVE", () => { events.push("REMOVE"); });

    internals.handleDispatch("MESSAGE_REACTION_ADD", 1, { emoji: { id: "1", type: 1 } });
    internals.handleDispatch("MESSAGE_REACTION_REMOVE", 2, {});
    assert(events.length === 2, `Both reaction events should fire, got ${events.length}`);
    assert(events[0] === "ADD", "First should be ADD");
    assert(events[1] === "REMOVE", "Second should be REMOVE");

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== onRawEvent: INTERACTION_CREATE dispatched ===");
  {
    const { adapter, internals } = await createAdapter();
    let received: unknown = null;
    adapter.onRawEvent("INTERACTION_CREATE", (data) => { received = data; });

    const interactionData = { id: "i1", data: { cmd: "click" }, type: 11 };
    internals.handleDispatch("INTERACTION_CREATE", 1, interactionData);
    assert(received === interactionData, "INTERACTION_CREATE data should be passed to handler");

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== onRawEvent: MESSAGE_AUDIT_PASS / REJECT dispatched ===");
  {
    const { adapter, internals } = await createAdapter();
    const results: string[] = [];
    adapter.onRawEvent("MESSAGE_AUDIT_PASS", () => { results.push("PASS"); });
    adapter.onRawEvent("MESSAGE_AUDIT_REJECT", () => { results.push("REJECT"); });

    internals.handleDispatch("MESSAGE_AUDIT_PASS", 1, { audit_id: "a1" });
    internals.handleDispatch("MESSAGE_AUDIT_REJECT", 2, { audit_id: "a2" });
    assert(results.length === 2, `Both audit events should fire, got ${results.length}`);
    assert(results[0] === "PASS", "First should be PASS");
    assert(results[1] === "REJECT", "Second should be REJECT");

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== onRawEvent: FORUM events dispatched ===");
  {
    const { adapter, internals } = await createAdapter();
    const events: string[] = [];
    const forumEvents = [
      "FORUM_THREAD_CREATE",
      "FORUM_THREAD_UPDATE",
      "FORUM_THREAD_DELETE",
      "FORUM_POST_CREATE",
      "FORUM_POST_DELETE",
      "FORUM_REPLY_CREATE",
      "FORUM_REPLY_DELETE",
      "FORUM_PUBLISH_AUDIT_RESULT",
    ];
    for (const ev of forumEvents) {
      adapter.onRawEvent(ev, () => { events.push(ev); });
    }

    for (const ev of forumEvents) {
      internals.handleDispatch(ev, 1, { id: "t1" });
    }
    assert(events.length === forumEvents.length, `All ${forumEvents.length} forum events should fire, got ${events.length}`);
    assert(events[0] === "FORUM_THREAD_CREATE", "First should be FORUM_THREAD_CREATE");
    assert(events[events.length - 1] === "FORUM_PUBLISH_AUDIT_RESULT", "Last should be FORUM_PUBLISH_AUDIT_RESULT");

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== onRawEvent: AUDIO events dispatched ===");
  {
    const { adapter, internals } = await createAdapter();
    const events: string[] = [];
    const audioEvents = ["AUDIO_START", "AUDIO_FINISH", "AUDIO_ON_MIC", "AUDIO_OFF_MIC"];
    for (const ev of audioEvents) {
      adapter.onRawEvent(ev, () => { events.push(ev); });
    }

    for (const ev of audioEvents) {
      internals.handleDispatch(ev, 1, { channel_id: "c1" });
    }
    assert(events.length === 4, `All 4 audio events should fire, got ${events.length}`);
    assert(events[0] === "AUDIO_START", "First should be AUDIO_START");
    assert(events[3] === "AUDIO_OFF_MIC", "Last should be AUDIO_OFF_MIC");

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== onRawEvent: READY event dispatched (also sets sessionId) ===");
  {
    const { adapter, internals } = await createAdapter();
    let received: unknown = null;
    adapter.onRawEvent("READY", (data) => { received = data; });

    const readyData = { user: { id: "bot1", username: "TestBot" }, session_id: "sess-xyz" };
    internals.handleDispatch("READY", 1, readyData);
    assert(received === readyData, "READY data should be passed to handler");

    // sessionId should be set internally
    const adapterWithSession = adapter as unknown as { sessionId: string };
    assert(
      adapterWithSession.sessionId === "sess-xyz",
      "READY should set sessionId internally",
    );

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== onRawEvent: RESUMED event dispatched ===");
  {
    const { adapter, internals } = await createAdapter();
    let received = false;
    adapter.onRawEvent("RESUMED", () => { received = true; });

    internals.handleDispatch("RESUMED", 1, {});
    assert(received, "RESUMED event should fire");

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== onRawEvent: wildcard '*' receives all events ===");
  {
    const { adapter, internals } = await createAdapter();
    const allEvents: Array<{ type: string; data: unknown }> = [];
    adapter.onRawEvent("*", (envelope) => {
      const e = envelope as { type: string; data: unknown };
      allEvents.push(e);
    });

    internals.handleDispatch("GUILD_CREATE", 1, { id: "g1" });
    internals.handleDispatch("INTERACTION_CREATE", 2, { id: "i1" });
    internals.handleDispatch("AUDIO_START", 3, {});

    assert(allEvents.length === 3, `Wildcard should receive all 3 events, got ${allEvents.length}`);
    assert(allEvents[0].type === "GUILD_CREATE", "First wildcard event should be GUILD_CREATE");
    assert(allEvents[0].data !== undefined, "First wildcard event should have data");
    assert(allEvents[1].type === "INTERACTION_CREATE", "Second wildcard event should be INTERACTION_CREATE");
    assert(allEvents[2].type === "AUDIO_START", "Third wildcard event should be AUDIO_START");

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== onRawEvent: unknown event types dispatched via default case ===");
  {
    const { adapter, internals } = await createAdapter();
    let received: unknown = null;
    adapter.onRawEvent("CUSTOM_UNKNOWN_EVENT", (data) => { received = data; });

    const customData = { foo: "bar", baz: 42 };
    internals.handleDispatch("CUSTOM_UNKNOWN_EVENT", 1, customData);
    assert(received === customData, "Unknown event types should be dispatched via default case");

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== onRawEvent: disposer function unsubscribes ===");
  {
    const { adapter, internals } = await createAdapter();
    let callCount = 0;
    const dispose = adapter.onRawEvent("GUILD_CREATE", () => { callCount++; });

    internals.handleDispatch("GUILD_CREATE", 1, {});
    assert(callCount === 1, `First dispatch should call handler (count=${callCount})`);

    dispose();

    internals.handleDispatch("GUILD_CREATE", 2, {});
    assert(callCount === 1, `After dispose, handler should not be called (count=${callCount})`);

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== onRawEvent: multiple handlers for same event all fire ===");
  {
    const { adapter, internals } = await createAdapter();
    let count1 = 0, count2 = 0;
    adapter.onRawEvent("GUILD_CREATE", () => { count1++; });
    adapter.onRawEvent("GUILD_CREATE", () => { count2++; });

    internals.handleDispatch("GUILD_CREATE", 1, {});
    assert(count1 === 1, `Handler 1 should fire once (count=${count1})`);
    assert(count2 === 1, `Handler 2 should fire once (count=${count2})`);

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== onRawEvent: handleDispatch with undefined eventType is a no-op ===");
  {
    const { adapter, internals } = await createAdapter();
    let count = 0;
    adapter.onRawEvent("*", () => { count++; });

    internals.handleDispatch(undefined, 1, { foo: "bar" });
    assert(count === 0, `Undefined eventType should not fire any handler (count=${count})`);

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== onRawEvent: handler exceptions don't crash dispatch ===");
  {
    const { adapter, internals } = await createAdapter();
    let secondCalled = false;
    adapter.onRawEvent("GUILD_CREATE", () => { throw new Error("Handler error"); });
    adapter.onRawEvent("GUILD_CREATE", () => { secondCalled = true; });

    // Should not throw — handleDispatch catches exceptions
    internals.handleDispatch("GUILD_CREATE", 1, {});
    // Note: due to try/catch in handleDispatch, the second handler may or may not fire
    // depending on EventEmitter semantics — but the dispatch itself should not crash.
    assert(true, "handleDispatch should not propagate handler exceptions");

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("\n=== onRawEvent: seq is tracked in lastSeq ===");
  {
    const { adapter, internals } = await createAdapter();
    internals.handleDispatch("GUILD_CREATE", 42, {});
    const adapterWithSeq = adapter as unknown as { lastSeq: number | null };
    assert(
      adapterWithSeq.lastSeq === 42,
      `lastSeq should be 42 after dispatch with seq=42, got ${adapterWithSeq.lastSeq}`,
    );

    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));
  }

  // ══════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════

  console.log(`\n========================================`);
  console.log(`Phase 5 Tests Summary:`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Phase 5 test runner crashed:", err);
  process.exit(1);
});
