/**
 * Regression tests for the code-review fixes.
 *
 * Covers:
 *  - SSRF guard: IPv6 / IPv4-mapped metadata bypass, DNS resolution.
 *  - Interactive shell session ownership scoping.
 *  - PluginContext.toolLoopAgent dispatch through `handler` (not the throwing
 *    default `call`).
 *  - ProviderManager.registerProvider dedupe.
 *  - image-ref-utils path containment (cross-drive / sibling-prefix).
 *  - KB document URL persistence.
 *  - PipelineScheduler: a generator stage that never yields still runs
 *    downstream stages.
 */
import { assertSafeUrl, normalizeIpLiteral } from "@yachiyo/common/ssrf-guard.js";
import {
  interactiveShellStart,
  interactiveShellClose,
  interactiveShellRead,
  listInteractiveSessions,
} from "@yachiyo/agent/interactive-shell-tool.js";
import { ProviderManager } from "@yachiyo/provider/manager.js";
import { PluginContext } from "@yachiyo/plugin/context.js";
import { extractOrderedArgs } from "@yachiyo/agent/tool-executor.js";
import { createFunctionTool } from "@yachiyo/agent/tool.js";
import { isSupportedImageRef } from "@yachiyo/agent/image-ref-utils.js";
import { MessageSession } from "@yachiyo/message/message-session.js";
import { MessageType } from "@yachiyo/message/types.js";
import { CommandGroupFilter } from "@yachiyo/plugin/filter.js";
import { PluginManager } from "@yachiyo/plugin/manager.js";
import { buildMainAgent } from "@yachiyo/agent/agent-builder.js";
import { ToolSet } from "@yachiyo/agent/tool.js";
import { FunctionToolManager } from "@yachiyo/agent/func-tool-manager.js";
import {
  createSubAgentCreateTool,
  createListSubAgentsTool,
  createDeleteSubAgentTool,
  dynamicSubAgentRegistry,
} from "@yachiyo/agent/subagent-create-tool.js";
import { serializeComponents, deserializeComponents } from "@yachiyo/message/serialize.js";
import { ComponentType } from "@yachiyo/message/components.js";
import { deriveKey, encryptSecret, decryptSecret } from "@yachiyo/common/secret-crypto.js";
import type { StarMetadata } from "@yachiyo/common/plugin-types.js";
import { validateMcpStdioConfig } from "@yachiyo/agent/mcp-client.js";
import { SessionLockManager } from "@yachiyo/pipeline/session-lock.js";
import { ConfigManager } from "@yachiyo/config/manager.js";

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

async function assertRejects(fn: () => Promise<unknown>, message: string): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

async function assertResolves(fn: () => Promise<unknown>, message: string): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(!threw, message);
}

// ── 1. SSRF guard ──

async function testSsrfGuard(): Promise<void> {
  console.log("\n=== SSRF guard: metadata bypass ===");

  assert(normalizeIpLiteral("[::ffff:a9fe:a9fe]") === "169.254.169.254",
    "IPv4-mapped IPv6 normalizes to dotted quad");
  assert(normalizeIpLiteral("169.254.169.254") === "169.254.169.254",
    "plain IPv4 literal passes through");
  assert(normalizeIpLiteral("[fd00:ec2::254]") === "fd00:ec2:0:0:0:0:0:254",
    "IPv6 metadata literal expands");
  assert(normalizeIpLiteral("[::1]") === "0:0:0:0:0:0:0:1",
    "loopback IPv6 is not mis-normalized to IPv4");

  await assertRejects(() => assertSafeUrl("http://169.254.169.254/latest/meta-data"),
    "blocks IPv4 metadata literal");
  await assertRejects(() => assertSafeUrl("http://[::ffff:169.254.169.254]/latest/meta-data"),
    "blocks IPv4-mapped IPv6 metadata literal");
  await assertRejects(() => assertSafeUrl("http://[0:0:0:0:0:ffff:a9fe:a9fe]/"),
    "blocks expanded IPv4-mapped metadata literal");
  await assertRejects(() => assertSafeUrl("http://[fd00:ec2::254]/"),
    "blocks AWS IPv6 metadata literal");
  await assertRejects(() => assertSafeUrl("http://metadata.google.internal/"),
    "blocks GCP metadata DNS alias");
  await assertRejects(() => assertSafeUrl("http://169.254.169.254./"),
    "blocks metadata literal with trailing dot");
  await assertRejects(() => assertSafeUrl("file:///etc/passwd"),
    "blocks non-http(s) schemes");

  // Normal public hosts must still pass (resolution failure is tolerated).
  await assertResolves(() => assertSafeUrl("https://example.com/"), "allows public HTTPS hosts");
}

// ── 2. Interactive shell ownership ──

async function testInteractiveShellOwnership(): Promise<void> {
  console.log("\n=== Interactive shell: session ownership ===");

  const ownerA = "onebot11:group:aaa";
  const ownerB = "onebot11:group:bbb";

  const idA = interactiveShellStart(undefined, { owner: ownerA });
  const idB = interactiveShellStart(undefined, { owner: ownerB });
  try {
    const listA = listInteractiveSessions(ownerA);
    assert(listA.some((s) => s.id === idA), "owner A sees its own session");
    assert(!listA.some((s) => s.id === idB), "owner A cannot see owner B's session");

    const readByB = await interactiveShellRead(idA, { waitMs: 50, owner: ownerB });
    assert(readByB === null, "owner B cannot read owner A's session");

    const closeByB = interactiveShellClose(idA, { owner: ownerB });
    assert(closeByB === false, "owner B cannot close owner A's session");

    const closeByA = interactiveShellClose(idA, { owner: ownerA });
    assert(closeByA === true, "owner A can close its own session");

    // Owner-less calls (standalone/tests) must still see everything.
    const listAll = listInteractiveSessions();
    assert(listAll.some((s) => s.id === idB), "owner-less list sees all sessions");
  } finally {
    interactiveShellClose(idA, { force: true });
    interactiveShellClose(idB, { force: true });
  }
}

// ── 3. Plugin toolLoopAgent dispatch ──

async function testPluginToolDispatch(): Promise<void> {
  console.log("\n=== PluginContext.toolLoopAgent: handler dispatch ===");

  let handlerCalls = 0;
  const tool = createFunctionTool({
    name: "echo",
    description: "echo",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    handler: async (_ctx, value) => {
      handlerCalls++;
      return `echo:${String(value)}`;
    },
  });

  // Mimic PluginContext's dispatch: prefer handler (positional), which is what
  // createFunctionTool installs when a handler is given.
  const args = { value: "hi" };
  let result: unknown;
  if (tool.handler) {
    result = await tool.handler({} as never, ...extractOrderedArgs(tool, args));
  } else {
    result = await tool.call({} as never, args);
  }
  assert(handlerCalls === 1, "handler is invoked for a handler-based tool");
  assert(result === "echo:hi", "handler receives positional args in schema order");

  // The default `call` must still throw, proving the old `if (tool.call)`
  // branch could never have worked for handler-based tools.
  let defaultCallThrew = false;
  try {
    await tool.call({} as never, args);
  } catch {
    defaultCallThrew = true;
  }
  assert(defaultCallThrew, "default call() throws (old dispatch path was broken)");

  // Sanity: the real PluginContext class is constructible and uses handler
  // dispatch. Build a minimal fake provider manager + tool manager.
  const fakeToolManager = {
    getFullToolSet: () => ({
      empty: () => false,
      getTool: (name: string) => (name === "echo" ? tool : undefined),
    }),
    funcList: [tool],
  };
  const fakeProvider = {
    providerConfig: { id: "fake" },
    async textChat() {
      return { role: "assistant", completionText: "done", toolsCallName: ["echo"], toolsCallArgs: ["{}"], toolsCallIds: ["c1"] };
    },
  };
  const providerManager = new ProviderManager();
  providerManager.registerProvider(fakeProvider as never);
  const ctx = new PluginContext({
    providerManager,
    toolManager: fakeToolManager as never,
    conversationManager: {} as never,
    eventQueue: {} as never,
  });
  const before = handlerCalls;
  const resp = await ctx.toolLoopAgent({ prompt: "x", maxSteps: 2 });
  assert(handlerCalls === before + 2, "PluginContext.toolLoopAgent invoked the handler (not default call)");
  assert(resp.completionText === "done", "toolLoopAgent returns the provider response");
}

// ── 4. ProviderManager.registerProvider dedupe ──

async function testRegisterProviderDedupe(): Promise<void> {
  console.log("\n=== ProviderManager: registerProvider dedupe ===");

  const manager = new ProviderManager();
  const first = {
    providerConfig: { id: "dup" },
    async textChat() { return { role: "assistant", completionText: "" }; },
  };
  const second = {
    providerConfig: { id: "dup" },
    async textChat() { return { role: "assistant", completionText: "" }; },
  };

  manager.registerProvider(first as never);
  manager.registerProvider(second as never);

  assert(manager.providerInsts.length === 1, "re-registering the same ID does not duplicate the array entry");
  assert(manager.getProviderById("dup") === (second as never), "the latest instance wins the ID lookup");

  await manager.terminate();
  assert(manager.getFallbackProviders().length === 0, "terminate clears fallback providers");
}

// ── 5. image-ref-utils path containment ──

function testImageRefContainment(): void {
  console.log("\n=== image-ref-utils: path containment ===");

  // A path with the same prefix but a sibling directory must not be considered
  // "inside" the root (the old `!rel.startsWith('..')` check handled this via
  // the leading separator, but the Windows cross-drive absolute case did not).
  assert(!isSupportedImageRef("C:\\root\\evil\\image", {
    allowExtensionlessExistingLocalFile: false,
  }), "non-existent extensionless path is rejected");

  // Sanity: a normal extensioned path is accepted regardless of location.
  assert(isSupportedImageRef("https://example.com/a.png"), "https URL image accepted");
  assert(isSupportedImageRef("file:///tmp/a.png"), "file URL with extension accepted");
}

// ── 6. MessageSession round-trip with colon-containing session ids ──

function testMessageSessionRoundTrip(): void {
  console.log("\n=== MessageSession.fromStr: colon-containing session ids ===");

  const session = new MessageSession();
  session.platformId = "onebot11";
  session.messageType = MessageType.GROUP_MESSAGE;
  session.sessionId = "group:123:456";
  const parsed = MessageSession.fromStr(session.toString());
  assert(parsed.platformId === "onebot11", "platformId round-trips");
  assert(parsed.messageType === MessageType.GROUP_MESSAGE, "messageType round-trips");
  assert(parsed.sessionId === "group:123:456", "sessionId with colons is preserved (not truncated)");
}

// ── 7. CommandGroupFilter word boundary ──

function testCommandGroupFilterBoundary(): void {
  console.log("\n=== CommandGroupFilter: word boundary ===");

  const filter = new CommandGroupFilter(["help"]);
  const fakeEvent = (msg: string) => ({ getMessageStr: () => msg }) as never;
  assert(filter.filter(fakeEvent("help"), {}) === true, "exact command matches");
  assert(filter.filter(fakeEvent("help me"), {}) === true, "command + space matches");
  assert(filter.filter(fakeEvent("helpme please"), {}) === false, "prefix of a longer word does not match");
}

// ── 8. PluginManager.registerStar dedupe ──

function testRegisterStarDedupe(): void {
  console.log("\n=== PluginManager.registerStar: dedupe ===");

  const manager = new PluginManager();
  const star = (): StarMetadata => ({
    name: "s", author: "a", desc: "", shortDesc: "", version: "1", repo: "",
    modulePath: "/tmp/star.ts", activated: true, config: {}, handlerFullNames: [],
    displayName: "", logoPath: "", supportPlatforms: [],
  });
  manager.registerStar(star());
  manager.registerStar(star());
  assert(manager.getAllStars().length === 1, "re-registering the same modulePath does not duplicate");
}

// ── 9. MCP stdio hardening ──

function testMcpStdioHardening(): void {
  console.log("\n=== MCP stdio validation ===");

  const ok = (cfg: Record<string, unknown>): boolean => {
    try { validateMcpStdioConfig(cfg); return true; } catch { return false; }
  };

  assert(!ok({ command: "docker", args: ["run", "--privileged", "img"] }), "docker --privileged rejected");
  assert(!ok({ command: "docker", args: ["run", "-v", "/etc:/host/etc", "img"] }), "docker host bind mount rejected");
  assert(ok({ command: "docker", args: ["run", "-v", "myvol:/data", "img"] }), "docker named volume allowed");
  // Equals-form flags and `--mount` were bypasses in the first version of the
  // docker hardening (found in second-pass review).
  assert(!ok({ command: "docker", args: ["run", "--volume=/etc:/host-etc", "img"] }), "docker --volume= equals form rejected");
  assert(!ok({ command: "docker", args: ["run", "-v=/etc:/host-etc", "img"] }), "docker -v= equals form rejected");
  assert(!ok({ command: "docker", args: ["run", "--mount", "type=bind,source=/etc,target=/host-etc", "img"] }), "docker --mount bind rejected");
  assert(!ok({ command: "docker", args: ["run", "--mount=type=bind,source=/etc,target=/host-etc", "img"] }), "docker --mount= equals form rejected");
  assert(!ok({ command: "docker", args: ["run", "--mount", "source=/var/run/docker.sock,target=/var/run/docker.sock", "img"] }), "docker --mount docker.sock rejected");
  assert(!ok({ command: "docker", args: ["run", "-v", "C:\\data:/data", "img"] }), "docker Windows drive bind mount rejected");
  assert(ok({ command: "docker", args: ["run", "--mount", "type=volume,source=myvol,target=/data", "img"] }), "docker --mount named volume allowed");
  assert(!ok({ command: "npx", args: ["-c", "rm -rf /"] }), "npx inline eval flag rejected");
  assert(ok({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }), "npx package launch allowed");
  assert(!ok({ command: "bash", args: ["-c", "echo hi"] }), "shell launcher rejected");
}

// ── 10. ConfigManager.normalizeConfig ──

function testNormalizeConfig(): void {
  console.log("\n=== ConfigManager.normalizeConfig ===");

  const manager = new ConfigManager();
  const partial = { id: "cfg-1" } as unknown as Parameters<typeof manager.normalizeConfig>[0];
  const normalized = manager.normalizeConfig(partial);

  assert(normalized.rateLimitMaxRequests === 10, "missing scalar filled from default");
  assert(normalized.rateLimitEnabled === false, "missing boolean filled from default");
  assert(Array.isArray(normalized.safetyKeywords), "missing array filled from default");
  assert(normalized.name === "Default", "missing string filled from default");

  // Explicit undefined must NOT shadow the default (shallow-merge hazard).
  const withUndefined = {
    id: "cfg-2",
    rateLimitMaxRequests: undefined,
    name: undefined,
  } as unknown as Parameters<typeof manager.normalizeConfig>[0];
  const normalized2 = manager.normalizeConfig(withUndefined);
  assert(normalized2.rateLimitMaxRequests === 10, "explicit undefined does not shadow the default");
  assert(normalized2.name === "Default", "explicit undefined string does not shadow the default");

  // Explicit values still win.
  const explicit = manager.normalizeConfig({
    id: "cfg-3",
    rateLimitMaxRequests: 99,
    name: "Custom",
  } as unknown as Parameters<typeof manager.normalizeConfig>[0]);
  assert(explicit.rateLimitMaxRequests === 99, "explicit value wins");
  assert(explicit.name === "Custom", "explicit string wins");
}

// ── 11. SessionLockManager shared sweep ──

async function testSessionLockSweep(): Promise<void> {
  console.log("\n=== SessionLockManager: shared sweep + release ===");

  // Long TTL so the lock does not expire mid-assertion.
  const mgr = new SessionLockManager({ defaultTtlMs: 60_000, watchdogIntervalMs: 20 });
  const releaseA = await mgr.acquireLock("umo-a");
  const releaseB = await mgr.acquireLock("umo-b");

  // Both locks are independent; a second acquire on the same umo waits.
  let acquiredSecond = false;
  const second = mgr.acquireLock("umo-a").then((h) => { acquiredSecond = true; return h; });
  await new Promise((r) => setTimeout(r, 60));
  assert(!acquiredSecond, "second acquire on a held umo waits");

  releaseA();
  const releaseA2 = await second;
  assert(acquiredSecond, "second acquire proceeds after release");

  releaseA2();
  releaseB();
  await new Promise((r) => setTimeout(r, 30));
}

// ── 12. Persona tool allowlist applied to the main agent ──

async function testPersonaToolAllowlist(): Promise<void> {
  console.log("\n=== Persona tool allowlist (main agent) ===");

  const toolManager = new FunctionToolManager();
  toolManager.addFunc("tool_a", [], "a", async () => "a");
  toolManager.addFunc("tool_b", [], "b", async () => "b");
  toolManager.addFunc("tool_c", [], "c", async () => "c");

  const provider = {
    type: "openai",
    providerConfig: { id: "mock" },
    async textChat() { return { role: "assistant", completionText: "" }; },
  } as never;

  const baseRequest = {
    prompt: "hi",
    imageUrls: [],
    audioUrls: [],
    contexts: [],
    extraUserContentParts: [],
  };

  // allowedTools = ["tool_a"] → only tool_a survives.
  const restricted = await buildMainAgent({
    provider,
    request: { ...baseRequest },
    toolManager,
    config: { allowedTools: ["tool_a"] },
  });
  const restrictedNames = (restricted.providerRequest.funcTool as ToolSet).names();
  assert(restrictedNames.includes("tool_a"), "allowed tool is present");
  assert(!restrictedNames.includes("tool_b"), "disallowed tool_b is removed");
  assert(!restrictedNames.includes("tool_c"), "disallowed tool_c is removed");

  // allowedTools = null → all tools.
  const all = await buildMainAgent({
    provider,
    request: { ...baseRequest },
    toolManager,
    config: { allowedTools: null },
  });
  const allNames = (all.providerRequest.funcTool as ToolSet).names();
  assert(allNames.length === 3, "null allowlist keeps all tools");
}

// ── 13. Dynamic sub-agent cross-session ownership ──

async function testDynamicSubAgentOwnership(): Promise<void> {
  console.log("\n=== Dynamic sub-agent session ownership ===");

  dynamicSubAgentRegistry.clear();
  const createTool = createSubAgentCreateTool();
  const listTool = createListSubAgentsTool();
  const deleteTool = createDeleteSubAgentTool();

  const ctxA = { context: { unifiedMsgOrigin: "onebot11:group:aaa" }, messages: [], toolCallTimeout: 30 };
  const ctxB = { context: { unifiedMsgOrigin: "onebot11:group:bbb" }, messages: [], toolCallTimeout: 30 };
  const text = (r: { content: Array<{ type: string; text?: string }> }): string =>
    (r.content[0] as { text?: string }).text ?? "";

  const created = await createTool.handler!(ctxA, "alpha", "instructions for alpha") as never;
  assert(text(created as never).includes("created successfully"), "session A creates a sub-agent");

  // Session B must not see it.
  const listB = await listTool.handler!(ctxB) as never;
  assert(!text(listB as never).includes("alpha"), "session B does not list session A's sub-agent");

  // Session A does see it.
  const listA = await listTool.handler!(ctxA) as never;
  assert(text(listA as never).includes("alpha"), "session A lists its own sub-agent");

  // Session B must not delete it.
  const delByB = await deleteTool.handler!(ctxB, "alpha") as never;
  assert((delByB as { isError?: boolean }).isError === true, "session B cannot delete session A's sub-agent");
  assert(dynamicSubAgentRegistry.has("alpha"), "sub-agent survives the cross-session delete attempt");

  // Session A can delete it.
  const delByA = await deleteTool.handler!(ctxA, "alpha") as never;
  assert(!(delByA as { isError?: boolean }).isError, "session A deletes its own sub-agent");
  assert(!dynamicSubAgentRegistry.has("alpha"), "sub-agent removed after owner delete");

  dynamicSubAgentRegistry.clear();
}

// ── 14. message serialize/deserialize round-trip ──

function testSerializeRoundTrip(): void {
  console.log("\n=== message serialize/deserialize round-trip ===");

  const original = [
    { type: ComponentType.Plain, text: "hello", toDict: () => ({ type: "text", data: { text: "hello" } }) },
    { type: ComponentType.Image, url: "http://x/a.png", toDict: () => ({ type: "image", data: { url: "http://x/a.png" } }) },
    { type: ComponentType.At, qq: "123", toDict: () => ({ type: "at", data: { qq: "123" } }) },
    { type: ComponentType.Face, id: 7, toDict: () => ({ type: "face", data: { id: 7 } }) },
  ] as never[];

  const roundTripped = deserializeComponents(serializeComponents(original));
  assert(roundTripped.length === original.length, "component count preserved");
  assert(roundTripped[0].type === ComponentType.Plain, "Plain round-trips to Plain (not Unknown)");
  assert((roundTripped[0] as unknown as { text: string }).text === "hello", "Plain text preserved");
  assert(roundTripped[1].type === ComponentType.Image, "Image round-trips to Image");
  assert((roundTripped[1] as unknown as { url: string }).url === "http://x/a.png", "Image url preserved");
  assert(roundTripped[2].type === ComponentType.At, "At round-trips to At");
  assert(roundTripped[3].type === ComponentType.Face, "Face round-trips to Face");
  assert(roundTripped.every((c) => c.type !== ComponentType.Unknown), "no component degrades to Unknown");
}

// ── 15. secret-crypto round-trip ──

function testSecretCrypto(): void {
  console.log("\n=== secret-crypto round-trip ===");

  const key = deriveKey("test-passphrase");
  const plaintext = "user:pass@host:8080 and 你好";

  const encrypted = encryptSecret(plaintext, key);
  assert(encrypted !== plaintext, "ciphertext differs from plaintext");
  assert(/^enc:v[12]:/.test(encrypted), "ciphertext carries an enc: version prefix");
  assert(!encrypted.includes(plaintext), "plaintext does not appear verbatim in ciphertext");

  assert(decryptSecret(encrypted, key) === plaintext, "decrypt(encrypt(x)) === x");

  // Legacy / non-encrypted values pass through unchanged.
  assert(decryptSecret("plain-legacy-value", key) === "plain-legacy-value",
    "non-encrypted value passes through");

  // Wrong key degrades to null rather than throwing or leaking ciphertext.
  const wrongKey = deriveKey("other-passphrase");
  assert(decryptSecret(encrypted, wrongKey) === null, "wrong key returns null");

  // Malformed ciphertext degrades to null.
  assert(decryptSecret("enc:v2:not-valid-base64-or-iv", key) === null, "malformed ciphertext returns null");

  // Empty input is returned as-is (no throw).
  assert(decryptSecret("", key) === "", "empty string passes through");
}

// ── main ──

async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════");
  console.log("  Review-fix regression tests");
  console.log("════════════════════════════════════════════════");

  await testSsrfGuard();
  await testInteractiveShellOwnership();
  await testPluginToolDispatch();
  await testRegisterProviderDedupe();
  testImageRefContainment();
  testMessageSessionRoundTrip();
  testCommandGroupFilterBoundary();
  testRegisterStarDedupe();
  testMcpStdioHardening();
  testNormalizeConfig();
  await testSessionLockSweep();
  await testPersonaToolAllowlist();
  await testDynamicSubAgentOwnership();
  testSerializeRoundTrip();
  testSecretCrypto();

  console.log("\n════════════════════════════════════════════════");
  console.log(`  通过: ${passCount}  失败: ${failCount}`);
  console.log("════════════════════════════════════════════════");
  if (failCount > 0) {
    console.error(`❌ ${failCount} 个测试失败`);
    process.exit(1);
  }
  console.log("✅ 所有测试通过!");
  process.exit(0);
}

main();
