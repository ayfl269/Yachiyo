/**
 * Conversation 包集成测试
 * 测试 ConversationManager、SqliteConversationStore、InMemoryConversationStore
 */
import Database from "better-sqlite3";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { ConversationManager, type ConversationRecord } from "@yachiyo/conversation/manager.js";
import { SqliteConversationStore, CHAT_MIGRATIONS } from "@yachiyo/conversation/sqlite-conversation-store.js";
import { InMemoryConversationStore, type ConversationMetadata } from "@yachiyo/conversation/store.js";

// ── Test helpers ──

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

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    const detail = `${message} (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})`;
    failures.push(detail);
    console.error(`  FAIL: ${detail}`);
  }
}

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  for (const migration of CHAT_MIGRATIONS) {
    const row = db.prepare("SELECT version FROM _migrations WHERE version = ?").get(migration.version) as { version: number } | undefined;
    if (!row) {
      db.exec(migration.up);
      db.prepare("INSERT INTO _migrations (version, name) VALUES (?, ?)").run(migration.version, migration.name);
    }
  }
}

// ── Tests ──

async function testSqliteStoreCRUD(): Promise<void> {
  console.log("\n── Test: SqliteConversationStore CRUD ──");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteConversationStore(db);
  await store.initialize();

  const now = new Date();
  const conv: ConversationRecord = {
    id: "test-conv-1",
    unifiedMsgOrigin: "platform:user:session1",
    personaId: null,
    history: "[]",
    platformId: "webchat",
    title: "Test Conversation",
    createdAt: now,
    updatedAt: now,
    tokenUsage: null,
  };

  // Create
  await store.createConversation(conv);
  console.log("  PASS: createConversation succeeded");

  // Read
  const retrieved = await store.getConversationById("test-conv-1");
  assert(retrieved !== null, "getConversationById returns the conversation");
  assertEqual(retrieved?.title, "Test Conversation", "title matches");
  assertEqual(retrieved?.unifiedMsgOrigin, "platform:user:session1", "umo matches");
  assertEqual(retrieved?.history, "[]", "history matches");

  // Update
  await store.updateConversation("test-conv-1", { title: "Updated Title", history: '[{"role":"user","content":"hi"}]' });
  const updated = await store.getConversationById("test-conv-1");
  assertEqual(updated?.title, "Updated Title", "updateConversation changes title");
  assertEqual(updated?.history, '[{"role":"user","content":"hi"}]', "updateConversation changes history");

  // Delete
  await store.deleteConversation("test-conv-1");
  const deleted = await store.getConversationById("test-conv-1");
  assert(deleted === null, "deleteConversation removes the conversation");

  db.close();
}

async function testGetFilteredConversations(): Promise<void> {
  console.log("\n── Test: getFilteredConversations (pagination, search, platform) ──");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteConversationStore(db);
  await store.initialize();

  // Create 15 conversations across 2 platforms
  for (let i = 0; i < 15; i++) {
    await store.createConversation({
      id: `conv-${i}`,
      unifiedMsgOrigin: `umo-${i}`,
      personaId: null,
      history: "[]",
      platformId: i < 7 ? "webchat" : "telegram",
      title: i % 3 === 0 ? `Special Topic ${i}` : `Chat ${i}`,
      createdAt: new Date(2026, 0, i + 1),
      updatedAt: new Date(2026, 0, i + 1),
      tokenUsage: null,
    });
  }

  // Test pagination
  const [page1, total1] = await store.getFilteredConversations({ page: 1, pageSize: 10 });
  assertEqual(page1.length, 10, "page 1 returns 10 results");
  assertEqual(total1, 15, "total count is 15");

  const [page2, total2] = await store.getFilteredConversations({ page: 2, pageSize: 10 });
  assertEqual(page2.length, 5, "page 2 returns 5 results");
  assertEqual(total2, 15, "total count is still 15");

  // Test platform filter
  const [webchatOnly, webchatTotal] = await store.getFilteredConversations({ platformIds: ["webchat"] });
  assertEqual(webchatOnly.length, 7, "webchat filter returns 7 results");
  assertEqual(webchatTotal, 7, "webchat total is 7");

  const [telegramOnly, telegramTotal] = await store.getFilteredConversations({ platformIds: ["telegram"] });
  assertEqual(telegramOnly.length, 8, "telegram filter returns 8 results");
  assertEqual(telegramTotal, 8, "telegram total is 8");

  // Test search query (title)
  const [searchResults, searchTotal] = await store.getFilteredConversations({ searchQuery: "Special" });
  assertEqual(searchResults.length, 5, "search 'Special' returns 5 results (i=0,3,6,9,12)");
  assertEqual(searchTotal, 5, "search total is 5");

  // Test combined filter
  const [combined, combinedTotal] = await store.getFilteredConversations({
    platformIds: ["webchat"],
    searchQuery: "Special",
  });
  assertEqual(combined.length, 3, "webchat + Special returns 3 results (i=0,3,6)");
  assertEqual(combinedTotal, 3, "combined total is 3");

  db.close();
}

async function testGetAllConversationMetadata(): Promise<void> {
  console.log("\n── Test: getAllConversationMetadata (lightweight, no history) ──");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteConversationStore(db);
  await store.initialize();

  // Create conversations with large history
  const largeHistory = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} with some text content` })));
  for (let i = 0; i < 5; i++) {
    await store.createConversation({
      id: `meta-conv-${i}`,
      unifiedMsgOrigin: `meta-umo-${i}`,
      personaId: i % 2 === 0 ? "persona-a" : null,
      history: largeHistory,
      platformId: "webchat",
      title: `Metadata Test ${i}`,
      createdAt: new Date(2026, 0, i + 1),
      updatedAt: new Date(2026, 0, i + 1),
      tokenUsage: i * 100,
    });
  }

  const metadata = await store.getAllConversationMetadata();
  assertEqual(metadata.length, 5, "getAllConversationMetadata returns 5 results");

  // Verify it has the right fields
  const first = metadata[0];
  assert(typeof first.id === "string", "metadata has id");
  assert(typeof first.unifiedMsgOrigin === "string", "metadata has unifiedMsgOrigin");
  assert(typeof first.title === "string", "metadata has title");
  assert(typeof first.platformId === "string", "metadata has platformId");
  assert(first.createdAt instanceof Date, "metadata has createdAt as Date");
  assert(first.updatedAt instanceof Date, "metadata has updatedAt as Date");
  assert(typeof first.tokenUsage === "number", "metadata has tokenUsage");

  // Verify it does NOT have the history field (it's not in the ConversationMetadata type)
  assert(!("history" in first), "metadata does NOT include history field");

  // Verify ordering (most recently updated first)
  assertEqual(metadata[0].id, "meta-conv-4", "first metadata is the most recently updated");

  db.close();
}

async function testConversationManagerLifecycle(): Promise<void> {
  console.log("\n── Test: ConversationManager lifecycle ──");
  const store = new InMemoryConversationStore();
  await store.initialize();
  const manager = new ConversationManager(store);

  // newConversation
  const convId1 = await manager.newConversation("umo:session1", {
    platformId: "webchat",
    title: "First Conversation",
  });
  assert(!!convId1, "newConversation returns a non-empty id");

  // getCurrConversationId
  const currId = await manager.getCurrConversationId("umo:session1");
  assertEqual(currId, convId1, "getCurrConversationId returns the new conversation id");

  // getConversation
  const conv = await manager.getConversation("umo:session1", convId1);
  assert(conv !== null, "getConversation returns the conversation");
  assertEqual(conv?.title, "First Conversation", "title matches");

  // Create a second conversation
  const convId2 = await manager.newConversation("umo:session1", {
    platformId: "webchat",
    title: "Second Conversation",
  });

  // switchConversation
  await manager.switchConversation("umo:session1", convId1);
  const switchedId = await manager.getCurrConversationId("umo:session1");
  assertEqual(switchedId, convId1, "switchConversation changes current conversation");

  // switch to non-existent should throw
  try {
    await manager.switchConversation("umo:session1", "non-existent-id");
    assert(false, "switchConversation to non-existent should throw");
  } catch (e) {
    assert(e instanceof Error && e.message.includes("not found"), "switchConversation throws for non-existent id");
  }

  // updateConversation
  await manager.updateConversation("umo:session1", convId1, {
    title: "Updated Title",
    history: '[{"role":"user","content":"hello"}]',
  });
  const updatedConv = await manager.getConversation("umo:session1", convId1);
  assertEqual(updatedConv?.title, "Updated Title", "updateConversation changes title");

  // deleteConversation
  await manager.deleteConversation("umo:session1", convId1);
  const deletedConv = await manager.getConversation("umo:session1", convId1);
  assert(deletedConv === null, "deleteConversation removes the conversation");

  // After deleting the current session conversation, getCurrConversationId should return null
  const currAfterDelete = await manager.getCurrConversationId("umo:session1");
  assert(currAfterDelete === null, "getCurrConversationId returns null after deleting current conversation");

  // deleteConversation with no explicit id (uses current session)
  await manager.switchConversation("umo:session1", convId2);
  await manager.deleteConversation("umo:session1");
  const conv2AfterDelete = await manager.getConversation("umo:session1", convId2);
  assert(conv2AfterDelete === null, "deleteConversation without explicit id deletes current session conversation");
}

async function testAddMessagePair(): Promise<void> {
  console.log("\n── Test: ConversationManager.addMessagePair ──");
  const store = new InMemoryConversationStore();
  await store.initialize();
  const manager = new ConversationManager(store);

  const umo = "umo:addmsg-test";
  await manager.addMessagePair(umo, "Hello", "Hi there!");

  const convId = await manager.getCurrConversationId(umo);
  assert(!!convId, "addMessagePair auto-creates a conversation if none exists");

  const conv = await manager.getConversation(umo, convId!);
  const history = JSON.parse(conv?.history ?? "[]");
  assertEqual(history.length, 2, "history has 2 messages after one addMessagePair");
  assertEqual(history[0].role, "user", "first message role is user");
  assertEqual(history[0].content, "Hello", "first message content matches");
  assertEqual(history[1].role, "assistant", "second message role is assistant");
  assertEqual(history[1].content, "Hi there!", "second message content matches");

  // Add more messages
  await manager.addMessagePair(umo, "How are you?", "I'm fine, thanks!");
  const conv2 = await manager.getConversation(umo, convId!);
  const history2 = JSON.parse(conv2?.history ?? "[]");
  assertEqual(history2.length, 4, "history has 4 messages after two addMessagePair calls");
}

async function testMaxHistoryMessages(): Promise<void> {
  console.log("\n── Test: ConversationManager maxHistoryMessages truncation ──");
  const store = new InMemoryConversationStore();
  await store.initialize();
  const manager = new ConversationManager(store, { maxHistoryMessages: 4 });
  const umo = "umo:truncation-test";

  // Add 5 message pairs (10 messages total), but max is 4
  for (let i = 0; i < 5; i++) {
    await manager.addMessagePair(umo, `question ${i}`, `answer ${i}`);
  }

  const convId = await manager.getCurrConversationId(umo);
  const conv = await manager.getConversation(umo, convId!);
  const history = JSON.parse(conv?.history ?? "[]");
  assertEqual(history.length, 4, "history is truncated to 4 messages");
  // The last 2 pairs should be kept (4 messages)
  assertEqual(history[0].content, "question 3", "first kept message is question 3");
  assertEqual(history[3].content, "answer 4", "last kept message is answer 4");
}

async function testSessionConversationMapping(): Promise<void> {
  console.log("\n── Test: Session conversation mapping ──");
  const store = new InMemoryConversationStore();
  await store.initialize();

  // set/get session conversation
  await store.setSessionConversation("umo:map1", "conv-aaa");
  const mapped = await store.getSessionConversation("umo:map1");
  assertEqual(mapped, "conv-aaa", "getSessionConversation returns mapped conversation id");

  // Overwrite
  await store.setSessionConversation("umo:map1", "conv-bbb");
  const overwritten = await store.getSessionConversation("umo:map1");
  assertEqual(overwritten, "conv-bbb", "setSessionConversation overwrites previous mapping");

  // Delete
  await store.deleteSessionConversation("umo:map1");
  const deleted = await store.getSessionConversation("umo:map1");
  assert(deleted === null, "getSessionConversation returns null after deleteSessionConversation");

  // Unmapped session returns null
  const unmapped = await store.getSessionConversation("umo:never-mapped");
  assert(unmapped === null, "getSessionConversation returns null for unmapped session");
}

async function testInMemoryStoreBasicOps(): Promise<void> {
  console.log("\n── Test: InMemoryConversationStore basic operations ──");
  const store = new InMemoryConversationStore();
  await store.initialize();

  const now = new Date();
  const conv: ConversationRecord = {
    id: "mem-1",
    unifiedMsgOrigin: "umo:mem1",
    personaId: null,
    history: "[]",
    platformId: "test",
    title: "Memory Test",
    createdAt: now,
    updatedAt: now,
    tokenUsage: null,
  };

  await store.createConversation(conv);

  // getAllConversations
  const all = await store.getAllConversations();
  assertEqual(all.length, 1, "getAllConversations returns 1 conversation");

  // getAllConversationMetadata
  const metadata = await store.getAllConversationMetadata();
  assertEqual(metadata.length, 1, "getAllConversationMetadata returns 1 entry");
  assertEqual(metadata[0].title, "Memory Test", "metadata title matches");
  assert(!("history" in metadata[0]), "metadata does not include history");

  // getFilteredConversations
  const [filtered, total] = await store.getFilteredConversations({ searchQuery: "Memory" });
  assertEqual(filtered.length, 1, "getFilteredConversations search finds 1 result");
  assertEqual(total, 1, "filtered total is 1");

  const [noResults, noTotal] = await store.getFilteredConversations({ searchQuery: "nonexistent" });
  assertEqual(noResults.length, 0, "getFilteredConversations search for nonexistent returns 0");
  assertEqual(noTotal, 0, "filtered total for nonexistent is 0");
}

async function testNoStoreManager(): Promise<void> {
  console.log("\n── Test: ConversationManager without store (no-op) ──");
  const manager = new ConversationManager(); // no store

  const convId = await manager.newConversation("umo:nostore");
  assert(!!convId, "newConversation returns id even without store");

  const currId = await manager.getCurrConversationId("umo:nostore");
  assert(currId === null, "getCurrConversationId returns null without store");

  const conv = await manager.getConversation("umo:nostore", "any-id");
  assert(conv === null, "getConversation returns null without store");

  // These should not throw
  await manager.switchConversation("umo:nostore", "any-id");
  await manager.deleteConversation("umo:nostore");
  await manager.updateConversation("umo:nostore", "any-id", { title: "test" });
  await manager.addMessagePair("umo:nostore", "hi", "hello");
  console.log("  PASS: all no-op methods complete without throwing");
}

// ── Main ──

async function main(): Promise<void> {
  console.log("═══ Conversation Package Tests ═══");

  try {
    await testSqliteStoreCRUD();
    await testGetFilteredConversations();
    await testGetAllConversationMetadata();
    await testConversationManagerLifecycle();
    await testAddMessagePair();
    await testMaxHistoryMessages();
    await testSessionConversationMapping();
    await testInMemoryStoreBasicOps();
    await testNoStoreManager();
  } catch (e) {
    console.error("\n═══ UNEXPECTED ERROR ═══");
    console.error(e);
    failed++;
    failures.push(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log("\n═══════════════════════════════════");
  console.log(`通过: ${passed}  失败: ${failed}  总计: ${passed + failed}`);
  if (failures.length > 0) {
    console.log("\n失败详情:");
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
  }
  console.log(failed === 0 ? "\n✅ 所有会话包测试通过!" : "\n❌ 存在失败的测试");
  process.exit(failed === 0 ? 0 : 1);
}

main();
