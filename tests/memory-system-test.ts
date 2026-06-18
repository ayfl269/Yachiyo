/**
 * 记忆系统集成测试
 * 测试分层记忆架构、整理机制、对话索引分离、System Prompt 注入
 */
import Database from "better-sqlite3";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { SqliteMemoryStore, MEMORY_MIGRATIONS, type MemoryType, type MemoryScope } from "../src/agent/sqlite-memory-store.js";
import { MemoryConsolidator, DEFAULT_CONSOLIDATION_CONFIG, type ConsolidationConfig } from "../src/agent/memory-consolidator.js";

// ── Helpers ──

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
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  for (const migration of MEMORY_MIGRATIONS) {
    const row = db.prepare("SELECT version FROM _migrations WHERE version = ?").get(migration.version) as any;
    if (!row) {
      db.exec(migration.up);
      db.prepare("INSERT INTO _migrations (version, name) VALUES (?, ?)").run(migration.version, migration.name);
    }
  }
}

// ── Mock Provider ──

function createMockProvider(responseJson: object) {
  return {
    textChat: async () => ({
      completionText: JSON.stringify(responseJson),
    }),
  };
}

// ── Tests ──

async function testMemoryStoreBasic() {
  console.log("\n=== SqliteMemoryStore 基础操作 ===");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteMemoryStore(db);

  // 1. Save & Recall
  store.save("test_key", "test value", ["tag1", "tag2"], { memoryType: "long_term", scope: "global", priority: 5 });
  const entry = store.recall("test_key");
  assert(entry !== null, "recall 返回非 null");
  assertEqual(entry!.key, "test_key", "key 正确");
  assertEqual(entry!.value, "test value", "value 正确");
  assertEqual(entry!.memoryType, "long_term", "memoryType 正确");
  assertEqual(entry!.priority, 5, "priority 正确");
  assertEqual(entry!.tags, ["tag1", "tag2"], "tags 正确");
  assertEqual(entry!.accessCount, 1, "recall 后 accessCount 为 1");

  // 2. Update existing key
  store.save("test_key", "updated value", ["tag1", "tag3"], { memoryType: "long_term", priority: 8 });
  const updated = store.recall("test_key");
  assertEqual(updated!.value, "updated value", "更新后 value 正确");
  assertEqual(updated!.priority, 8, "更新后 priority 正确");
  assertEqual(updated!.tags, ["tag1", "tag3"], "更新后 tags 正确");

  // 3. Delete
  const deleted = store.delete("test_key");
  assert(deleted, "delete 返回 true");
  assert(store.recall("nonexistent") === null, "删除后 recall 返回 null");

  db.close();
}

async function testMemoryStoreLayered() {
  console.log("\n=== 分层记忆架构 ===");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteMemoryStore(db);

  // 创建不同类型的记忆
  store.save("st_1", "短期记忆1", ["conversation"], { memoryType: "short_term", scope: "session", scopeId: "session_1" });
  store.save("st_2", "短期记忆2", ["conversation"], { memoryType: "short_term", scope: "session", scopeId: "session_1" });
  store.save("lt_1", "长期记忆1", ["important"], { memoryType: "long_term", scope: "global", priority: 7 });
  store.save("lt_2", "长期记忆2", ["fact"], { memoryType: "long_term", scope: "global", priority: 3 });
  store.save("persona_1", "角色记忆1", ["persona"], { memoryType: "persona", scope: "persona", scopeId: "p1" });
  store.save("profile_pref", "偏好暗色主题", ["profile"], { memoryType: "user_profile", scope: "user", scopeId: "user1" });

  // 按类型筛选
  const shortTerm = store.list(50, { memoryType: "short_term" });
  assertEqual(shortTerm.length, 2, "short_term 数量为 2");

  const longTerm = store.list(50, { memoryType: "long_term" });
  assertEqual(longTerm.length, 2, "long_term 数量为 2");

  const persona = store.list(50, { memoryType: "persona" });
  assertEqual(persona.length, 1, "persona 数量为 1");

  const profile = store.list(50, { memoryType: "user_profile" });
  assertEqual(profile.length, 1, "user_profile 数量为 1");

  // 按作用域筛选
  const sessionMemories = store.list(50, { scope: "session", scopeId: "session_1" });
  assertEqual(sessionMemories.length, 2, "session 作用域记忆数量为 2");

  // 统计
  const stats = store.stats();
  assertEqual(stats.total, 6, "总记忆数为 6");
  assertEqual(stats.byType.short_term, 2, "byType.short_term = 2");
  assertEqual(stats.byType.long_term, 2, "byType.long_term = 2");
  assertEqual(stats.byType.persona, 1, "byType.persona = 1");
  assertEqual(stats.byType.user_profile, 1, "byType.user_profile = 1");

  // history_index 不再是 MemoryType
  const typeKeys = Object.keys(stats.byType);
  assert(!typeKeys.includes("history_index"), "stats.byType 不包含 history_index");

  db.close();
}

async function testConversationIndices() {
  console.log("\n=== 对话索引独立表 ===");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteMemoryStore(db);

  // 添加对话索引（使用不同时间戳确保排序稳定）
  const id1 = store.addConversationIndex({
    title: "讨论项目架构",
    topics: ["架构", "微服务", "数据库"],
    conversationId: "conv_001",
    timestamp: new Date(Date.now() - 3600000).toISOString(), // 1小时前
  });
  const id2 = store.addConversationIndex({
    title: "用户偏好设置",
    topics: ["UI", "主题", "暗色模式"],
    conversationId: "conv_002",
    timestamp: new Date().toISOString(), // 现在
  });

  assert(id1 > 0, "addConversationIndex 返回有效 id");
  assert(id2 > id1, "第二个 id 递增");

  // 列出索引（按时间倒序，最新的在前）
  const indices = store.listConversationIndices(10);
  assertEqual(indices.length, 2, "对话索引数量为 2");
  assertEqual(indices[0].title, "用户偏好设置", "最新索引排在前面");
  assertEqual(indices[0].topics, ["UI", "主题", "暗色模式"], "最新索引 topics 正确");
  assertEqual(indices[0].conversationId, "conv_002", "最新索引 conversationId 正确");
  assertEqual(indices[1].title, "讨论项目架构", "较早索引排在后面");
  assertEqual(indices[1].topics, ["架构", "微服务", "数据库"], "较早索引 topics 正确");
  assertEqual(indices[1].conversationId, "conv_001", "较早索引 conversationId 正确");

  // 搜索索引
  const searchResults = store.searchConversationIndices("架构");
  assertEqual(searchResults.length, 1, "搜索'架构'返回 1 条");
  assertEqual(searchResults[0].title, "讨论项目架构", "搜索结果标题正确");

  const searchByTopic = store.searchConversationIndices("主题");
  assertEqual(searchByTopic.length, 1, "搜索'主题'返回 1 条");

  // 计数
  assertEqual(store.countConversationIndices(), 2, "对话索引计数为 2");

  // 删除索引
  const delResult = store.deleteConversationIndex(id1);
  assert(delResult, "deleteConversationIndex 返回 true");
  assertEqual(store.countConversationIndices(), 1, "删除后计数为 1");

  db.close();
}

async function testV3MigrationFromHistoryIndex() {
  console.log("\n=== V3 迁移：history_index → conversation_indices ===");
  const db = createTestDb();

  // 先只跑 v1 + v2 迁移，手动插入 history_index 数据
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  for (const m of MEMORY_MIGRATIONS.filter(m => m.version <= 2)) {
    db.exec(m.up);
    db.prepare("INSERT INTO _migrations (version, name) VALUES (?, ?)").run(m.version, m.name);
  }

  // 插入旧的 history_index 记忆
  db.prepare(`
    INSERT INTO memories (key, value, created_at, updated_at, memory_type, scope, scope_id, priority, access_count)
    VALUES (?, ?, datetime('now'), datetime('now'), 'history_index', 'global', '', 3, 0)
  `).run(
    "history_index_old_1",
    JSON.stringify({ title: "旧对话索引", topics: ["旧话题"], timestamp: Date.now() })
  );

  db.prepare(`
    INSERT INTO memories (key, value, created_at, updated_at, memory_type, scope, scope_id, priority, access_count)
    VALUES (?, ?, datetime('now'), datetime('now'), 'history_index', 'global', '', 3, 0)
  `).run(
    "history_index_old_2",
    JSON.stringify({ title: "另一个索引", topics: ["测试"], timestamp: Date.now() })
  );

  // 确认旧数据存在
  const oldCount = (db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE memory_type = 'history_index'").get() as any).cnt;
  assertEqual(oldCount, 2, "迁移前有 2 条 history_index 记忆");

  // 跑 v3 迁移
  const v3 = MEMORY_MIGRATIONS.find(m => m.version === 3)!;
  db.exec(v3.up);
  db.prepare("INSERT INTO _migrations (version, name) VALUES (?, ?)").run(v3.version, v3.name);

  // 验证迁移结果
  const remaining = (db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE memory_type = 'history_index'").get() as any).cnt;
  assertEqual(remaining, 0, "迁移后 memories 表无 history_index 记忆");

  const indexCount = (db.prepare("SELECT COUNT(*) as cnt FROM conversation_indices").get() as any).cnt;
  assertEqual(indexCount, 2, "迁移后 conversation_indices 有 2 条记录");

  // 验证数据完整性
  const indices = db.prepare("SELECT * FROM conversation_indices ORDER BY title").all() as any[];
  assertEqual(indices[0].title, "另一个索引", "迁移后第一条标题正确");
  assertEqual(indices[1].title, "旧对话索引", "迁移后第二条标题正确");

  // 验证 topics JSON 解析
  const topics0 = JSON.parse(indices[0].topics);
  assertEqual(topics0, ["测试"], "迁移后 topics 正确解析");

  db.close();
}

async function testArchiveShortTermMemories() {
  console.log("\n=== 短期记忆归档 ===");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteMemoryStore(db);

  // 创建短期记忆
  store.save("st_a", "重要短期记忆", ["important"], { memoryType: "short_term", scope: "session", scopeId: "sess_1", priority: 5 });
  store.save("st_b", "普通短期记忆", ["chat"], { memoryType: "short_term", scope: "session", scopeId: "sess_1" });
  store.save("st_c", "另一个会话", ["chat"], { memoryType: "short_term", scope: "session", scopeId: "sess_2" });

  // 归档 sess_1 的短期记忆（提升为长期）
  const result = store.archiveShortTermMemories("sess_1", { promoteToLongTerm: true });
  assertEqual(result.promoted, 2, "2 条短期记忆被提升");
  assertEqual(result.deleted, 0, "0 条被删除");

  // 验证提升后的记忆
  const promoted = store.recall("st_a");
  assertEqual(promoted!.memoryType, "long_term", "提升后类型为 long_term");
  assertEqual(promoted!.scope, "global", "提升后作用域为 global");

  // sess_2 的记忆不受影响
  const otherSession = store.list(10, { memoryType: "short_term", scope: "session", scopeId: "sess_2" });
  assertEqual(otherSession.length, 1, "其他会话的短期记忆不受影响");

  // 测试不提升直接删除
  store.save("st_d", "临时记忆", [], { memoryType: "short_term", scope: "session", scopeId: "sess_3" });
  const delResult = store.archiveShortTermMemories("sess_3", { promoteToLongTerm: false });
  assertEqual(delResult.promoted, 0, "不提升时 promoted 为 0");
  assertEqual(delResult.deleted, 1, "不提升时 deleted 为 1");

  db.close();
}

async function testMemoryAging() {
  console.log("\n=== 记忆老化机制 ===");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteMemoryStore(db);

  // 创建一条长期记忆，设置很早的更新时间和低优先级（会被降权+归档）
  const veryOldDate = new Date(Date.now() - 200 * 86400000).toISOString(); // 200天前
  db.prepare(`
    INSERT INTO memories (key, value, created_at, updated_at, memory_type, scope, scope_id, priority, access_count)
    VALUES (?, ?, ?, ?, 'long_term', 'global', '', -1, 0)
  `).run("very_old_memory", "极旧且低优先级的记忆", veryOldDate, veryOldDate);

  // 创建一条较旧但高优先级的记忆（只会被降权，不会被归档）
  const oldDate = new Date(Date.now() - 120 * 86400000).toISOString(); // 120天前
  db.prepare(`
    INSERT INTO memories (key, value, created_at, updated_at, memory_type, scope, scope_id, priority, access_count)
    VALUES (?, ?, ?, ?, 'long_term', 'global', '', 5, 0)
  `).run("old_memory", "很旧的记忆", oldDate, oldDate);

  // 创建一条经常访问的记忆
  store.save("active_memory", "活跃记忆", [], { memoryType: "long_term", priority: 5 });
  store.recall("active_memory"); // access_count = 2 (save + recall)

  // 执行老化
  const result = store.applyAging({ accessThreshold: 1, maxAgeDays: 90 });
  assertEqual(result.demoted, 1, "1 条记忆被降权（priority=5 > -1 的旧记忆）");
  assertEqual(result.archived, 1, "1 条极旧低优先级记忆被归档（删除）");

  // 活跃记忆不受影响
  const active = store.recall("active_memory");
  assert(active !== null, "活跃记忆仍存在");

  db.close();
}

async function testMemoryExpiry() {
  console.log("\n=== 记忆过期清理 ===");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteMemoryStore(db);

  // 创建已过期的记忆
  const pastDate = new Date(Date.now() - 86400000).toISOString(); // 1天前
  store.save("expired_mem", "已过期", [], { memoryType: "long_term", expiresAt: pastDate });

  // 创建未过期的记忆
  const futureDate = new Date(Date.now() + 7 * 86400000).toISOString(); // 7天后
  store.save("valid_mem", "未过期", [], { memoryType: "long_term", expiresAt: futureDate });

  // 创建无过期时间的记忆
  store.save("permanent_mem", "永久记忆", [], { memoryType: "long_term" });

  // 清理过期
  const deleted = store.deleteExpired();
  assertEqual(deleted, 1, "1 条过期记忆被删除");

  // 验证
  assert(store.recall("expired_mem") === null, "过期记忆已被删除");
  assert(store.recall("valid_mem") !== null, "未过期记忆仍存在");
  assert(store.recall("permanent_mem") !== null, "永久记忆仍存在");

  db.close();
}

async function testMemoryDedup() {
  console.log("\n=== 记忆去重合并 ===");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteMemoryStore(db);

  // 创建相似记忆（相同 key 前缀 + 标签重叠）
  store.save("user_pref_theme", "偏好暗色主题", ["偏好", "UI"], { memoryType: "long_term", priority: 5 });
  store.save("user_pref_color", "偏好蓝色配色", ["偏好", "UI"], { memoryType: "long_term", priority: 3 });

  // 手动合并
  const merged = store.merge("user_pref_theme", "user_pref_color", "偏好暗色主题和蓝色配色");
  assert(merged, "merge 返回 true");

  const result = store.recall("user_pref_theme");
  assertEqual(result!.value, "偏好暗色主题和蓝色配色", "合并后 value 正确");
  assert(result!.tags.includes("偏好"), "合并后包含共同标签");
  assert(result!.tags.includes("UI"), "合并后包含 UI 标签");

  // 被合并的源应被删除
  assert(store.recall("user_pref_color") === null, "被合并的源记忆已删除");

  db.close();
}

async function testMemorySearch() {
  console.log("\n=== FTS5 全文搜索 ===");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteMemoryStore(db);

  store.save("python_skill", "擅长 Python 编程", ["编程", "Python"], { memoryType: "long_term" });
  store.save("rust_skill", "正在学习 Rust", ["编程", "Rust"], { memoryType: "long_term" });
  store.save("food_pref", "喜欢吃辣", ["饮食", "偏好"], { memoryType: "user_profile" });

  // 搜索内容
  const results = store.search("Python");
  assertEqual(results.length, 1, "搜索 Python 返回 1 条");
  assertEqual(results[0].key, "python_skill", "搜索结果 key 正确");

  // 搜索标签
  const tagResults = store.search("编程");
  assert(tagResults.length >= 2, "搜索'编程'返回至少 2 条");

  // 按类型筛选搜索
  const filteredSearch = store.search("辣", 20, { memoryType: "user_profile" });
  assertEqual(filteredSearch.length, 1, "按类型筛选搜索返回 1 条");

  db.close();
}

async function testConsolidatorWithMockProvider() {
  console.log("\n=== MemoryConsolidator 整理流程（Mock Provider）===");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteMemoryStore(db);

  // 创建短期对话缓冲
  for (let i = 0; i < 8; i++) {
    store.save(
      `short_term_sess_${Date.now()}_${i}_${i % 2 === 0 ? 'user' : 'assistant'}`,
      i % 2 === 0 ? `用户消息${i}` : `AI回复${i}`,
      ["conversation", "short_term"],
      { memoryType: "short_term", scope: "session", scopeId: "sess_test" }
    );
  }

  // Mock Provider 返回结构化提取结果
  const mockProvider = createMockProvider({
    profile: {
      preferences: "偏好简洁的回复风格",
      background: "软件工程师",
      style: "技术性强，喜欢代码示例",
    },
    memories: [
      { key: "job_info", value: "软件工程师，擅长后端开发", tags: ["职业"], priority: 7 },
      { key: "reply_style", value: "偏好简洁的回复风格", tags: ["偏好"], priority: 5 },
    ],
    index: {
      title: "技术讨论",
      topics: ["编程", "后端", "架构"],
    },
  });

  const consolidator = new MemoryConsolidator(store, {
    ...DEFAULT_CONSOLIDATION_CONFIG,
    bufferMinMessages: 6,
  });
  consolidator.setProvider(mockProvider as any);

  // 运行整理
  const result = await consolidator.consolidate();

  assertEqual(result.extractionFailed, false, "提取未失败");
  assert(result.extracted > 0, `提取了 ${result.extracted} 条记忆`);

  // 验证用户画像
  const profileEntry = store.recall("user_profile");
  assert(profileEntry !== null, "user_profile 记录存在");
  const profile = JSON.parse(profileEntry!.value);
  assertEqual(profile.background, "软件工程师", "画像背景正确");
  assertEqual(profile.preferences, "偏好简洁的回复风格", "画像偏好正确");
  assertEqual(profile.style, "技术性强，喜欢代码示例", "画像风格正确");

  // 验证长期记忆
  const longTerm = store.list(10, { memoryType: "long_term" });
  assertEqual(longTerm.length, 2, "2 条长期记忆");

  // 验证对话索引写入 conversation_indices 表
  const indices = store.listConversationIndices(10);
  assertEqual(indices.length, 1, "1 条对话索引");
  assertEqual(indices[0].title, "技术讨论", "索引标题正确");
  assertEqual(indices[0].topics, ["编程", "后端", "架构"], "索引 topics 正确");

  // 验证短期缓冲区被清空
  const shortTerm = store.list(50, { memoryType: "short_term" });
  const convShortTerm = shortTerm.filter(m => m.tags.includes("conversation"));
  assertEqual(convShortTerm.length, 0, "对话短期记忆已被清空");

  db.close();
}

async function testConsolidatorFailureProtection() {
  console.log("\n=== LLM 提取失败保护 ===");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteMemoryStore(db);

  // 创建短期对话缓冲
  for (let i = 0; i < 8; i++) {
    store.save(
      `short_term_fail_${i}`,
      `消息${i}`,
      ["conversation", "short_term"],
      { memoryType: "short_term", scope: "session", scopeId: "sess_fail" }
    );
  }

  // Mock Provider 返回空响应（模拟失败）
  const failProvider = {
    textChat: async () => ({ completionText: "" }),
  };

  const consolidator = new MemoryConsolidator(store, {
    ...DEFAULT_CONSOLIDATION_CONFIG,
    bufferMinMessages: 6,
    maxRetries: 3,
  });
  consolidator.setProvider(failProvider as any);

  // 第一次整理应该失败但保留缓冲区
  const result1 = await consolidator.consolidate();
  assertEqual(result1.extractionFailed, true, "第一次提取失败");
  assertEqual(result1.extracted, 0, "提取数为 0");

  // 短期缓冲区应保留
  const shortTerm = store.list(50, { memoryType: "short_term" });
  const convBuffer = shortTerm.filter(m => m.tags.includes("conversation"));
  assert(convBuffer.length > 0, "失败后短期缓冲区保留");

  db.close();
}

async function testMemoryLengthTruncation() {
  console.log("\n=== 记忆长度截断 ===");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteMemoryStore(db);

  const longValue = "A".repeat(500);
  store.save("long_mem", longValue, [], { memoryType: "long_term" });

  // 使用 Consolidator 的截断配置
  const consolidator = new MemoryConsolidator(store, {
    ...DEFAULT_CONSOLIDATION_CONFIG,
    maxMemoryLength: 100,
  });

  // Mock Provider 返回超长记忆
  const mockProvider = createMockProvider({
    profile: { preferences: "", background: "", style: "" },
    memories: [
      { key: "truncated_mem", value: "B".repeat(500), tags: [], priority: 0 },
    ],
    index: { title: "测试", topics: ["测试"] },
  });
  consolidator.setProvider(mockProvider as any);
  for (let i = 0; i < 8; i++) {
    store.save(
      `short_term_trunc_${i}`,
      `消息${i}`,
      ["conversation", "short_term"],
      { memoryType: "short_term", scope: "session", scopeId: "sess_trunc" }
    );
  }

  await consolidator.consolidate();

  // 验证截断
  const mem = store.recall("truncated_mem");
  if (mem) {
    assert(mem.value.length <= 103, `截断后长度 ${mem.value.length} <= 103 (100 + "...")`);
  }

  db.close();
}

async function testMemoryTypeNoHistoryIndex() {
  console.log("\n=== MemoryType 不包含 history_index ===");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteMemoryStore(db);

  // 尝试使用 history_index 类型应仍能存储（SQLite 不强制 CHECK 约束）
  // 但 stats() 不应统计它
  db.prepare(`
    INSERT INTO memories (key, value, created_at, updated_at, memory_type, scope, scope_id, priority, access_count)
    VALUES (?, ?, datetime('now'), datetime('now'), 'history_index', 'global', '', 3, 0)
  `).run("legacy_index", "遗留数据");

  const stats = store.stats();
  assertEqual(stats.byType.short_term, 0, "short_term = 0");
  assertEqual(stats.byType.long_term, 0, "long_term = 0");
  assertEqual(stats.byType.persona, 0, "persona = 0");
  assertEqual(stats.byType.user_profile, 0, "user_profile = 0");
  // history_index 不在 byType 中
  assert(!("history_index" in stats.byType), "byType 不包含 history_index 键");

  db.close();
}

async function testClearAllMemories() {
  console.log("\n=== 清空所有记忆 ===");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteMemoryStore(db);

  store.save("m1", "v1", [], { memoryType: "long_term" });
  store.save("m2", "v2", [], { memoryType: "short_term" });
  store.addConversationIndex({ title: "idx1", topics: ["t1"] });

  const count = store.clear();
  assertEqual(count, 2, "清空了 2 条记忆");
  assertEqual(store.count(), 0, "清空后 count 为 0");

  // conversation_indices 不受 clear() 影响
  assertEqual(store.countConversationIndices(), 1, "对话索引不受 clear() 影响");

  db.close();
}

async function testMemoryDisabledConfiguration() {
  console.log("\n=== 停用记忆系统与配置验证 ===");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteMemoryStore(db);

  // 1. 写入一些测试短期记忆
  store.save("st_a", "重要短期记忆", ["important"], { memoryType: "short_term", scope: "session", scopeId: "sess_1", priority: 5 });
  store.save("st_b", "普通短期记忆", ["chat"], { memoryType: "short_term", scope: "session", scopeId: "sess_1" });

  // 2. 初始化整理器，设置 memoryEnabled: false
  const consolidator = new MemoryConsolidator(store, {
    ...DEFAULT_CONSOLIDATION_CONFIG,
    memoryEnabled: false,
  });

  // 3. 测试 consolidate() 应当跳过
  const result = await consolidator.consolidate();
  assertEqual(result.extracted, 0, "memoryEnabled为false时，consolidate不提取记忆");
  assertEqual(result.merged, 0, "memoryEnabled为false时，consolidate不合并记忆");
  assertEqual(result.expired, 0, "memoryEnabled为false时，consolidate不清理过期记忆");
  assertEqual(result.aged.demoted, 0, "memoryEnabled为false时，consolidate不降权老记忆");

  // 4. 测试 archiveSession() 应当跳过
  const archiveResult = consolidator.archiveSession("sess_1");
  assertEqual(archiveResult.promoted, 0, "memoryEnabled为false时，archiveSession不提升记忆");
  assertEqual(archiveResult.deleted, 0, "memoryEnabled为false时，archiveSession不删除记忆");

  // 验证数据库数据没有被修改或删除
  const shortTerm = store.list(10, { memoryType: "short_term" });
  assertEqual(shortTerm.length, 2, "归档被阻止，短期记忆依然存在 2 条");

  // 5. 测试周期定时器启动
  consolidator.startPeriodic();
  assertEqual(consolidator.isRunning(), false, "memoryEnabled为false时，startPeriodic不启动定时器");
  consolidator.stop();

  // 6. 测试 enabled: false (整理功能停用，记忆系统启用)
  consolidator.updateConfig({ memoryEnabled: true, enabled: false });
  const result2 = await consolidator.consolidate();
  assertEqual(result2.extracted, 0, "enabled为false时，consolidate不提取记忆");
  const archiveResult2 = consolidator.archiveSession("sess_1");
  assertEqual(archiveResult2.promoted, 0, "enabled为false时，archiveSession不提升记忆");
  consolidator.startPeriodic();
  assertEqual(consolidator.isRunning(), false, "enabled为false时，startPeriodic不启动定时器");
  consolidator.stop();

  db.close();
}

async function testMemoryRefinements() {
  console.log("\n=== 记忆系统优化细节验证 ===");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteMemoryStore(db);

  // --- 1. 去重合并 Jaccard 相似度测试 ---
  // (a) 不应合并前缀相同但单词不同的 Key
  store.save("hobby_reading", "喜欢看书", ["hobby"], { memoryType: "long_term" });
  store.save("hobby_gaming", "喜欢玩游戏", ["hobby"], { memoryType: "long_term" });

  // (b) 应该合并单词顺序不同但单词完全相同的 Key
  store.save("reading_hobby", "爱好是阅读", ["hobby"], { memoryType: "long_term" });

  // (c) 应该合并单复数形式不同的相似 Key
  store.save("favorite_books", "最喜欢的书是《三体》", ["book"], { memoryType: "long_term" });
  store.save("favorite_book", "最爱书是《哈利波特》", ["book"], { memoryType: "long_term" });

  const consolidator = new MemoryConsolidator(store, {
    ...DEFAULT_CONSOLIDATION_CONFIG,
  });

  // 执行整理去重
  await consolidator.consolidate();

  // 验证 (a) 没有被误合并
  assert(store.recall("hobby_reading") !== null, "hobby_reading 依然存在");
  assert(store.recall("hobby_gaming") !== null, "hobby_gaming 依然存在");

  // 验证 (b) 发生了合并 (reading_hobby 合并到了 hobby_reading 里)
  assert(store.recall("reading_hobby") === null, "reading_hobby 被成功合并并删除");
  const mergedHobby = store.recall("hobby_reading");
  assert(mergedHobby!.value.includes("爱好是阅读"), "hobby_reading 合并了 reading_hobby 的内容");

  // 验证 (c) 发生了合并 (favorite_books 合并到了 favorite_book 里)
  assert(store.recall("favorite_books") === null, "favorite_books 被成功合并并删除");
  const mergedBook = store.recall("favorite_book");
  assert(mergedBook !== null, "favorite_book 依然存在");
  assert(mergedBook!.value.includes("最喜欢的书是《三体》"), "favorite_book 合并了 favorite_books 的内容");

  // --- 2. 短期缓冲区精准清理测试 ---
  // 写入 55 条短期记忆
  for (let i = 0; i < 55; i++) {
    store.save(`short_term_test_${i}`, `消息内容${i}`, ["conversation"], { memoryType: "short_term" });
  }
  assertEqual(store.count({ memoryType: "short_term" }), 55, "初始写入了 55 条短期记忆");

  // 设置 Mock Provider 提取 1 条长期记忆
  const mockProvider = createMockProvider({
    profile: { preferences: "", background: "", style: "" },
    memories: [
      { key: "extracted_mem_1", value: "提取内容1", tags: ["提取"], priority: 5 },
    ],
    index: { title: "提取标题", topics: ["提取话题"] },
  });
  consolidator.setProvider(mockProvider as any);

  // 运行整理，它会提取最前面的 50 条并清理这 50 条，剩余 5 条应该保存在数据库中
  await consolidator.consolidate();
  assertEqual(store.count({ memoryType: "short_term" }), 5, "整理后精准清理了 50 条，剩下 5 条未被误删");

  // --- 3. 定时器稳定度与间隔解析测试 ---
  // 测试解析数字秒数与数字字符串
  assertEqual(MemoryConsolidator.parseInterval(10), 10000, "parseInterval 支持数字型秒数");
  assertEqual(MemoryConsolidator.parseInterval("30"), 30000, "parseInterval 支持字符串型秒数");
  assertEqual(MemoryConsolidator.parseInterval("2h30m"), 2.5 * 60 * 60 * 1000, "parseInterval 支持常规时间单位字符串");
  // 测试无效值与非法输入降级
  assertEqual(MemoryConsolidator.parseInterval("invalid_string"), 12 * 60 * 60 * 1000, "parseInterval 非法字符串应降级为 12h");
  assertEqual(MemoryConsolidator.parseInterval(-5), 12 * 60 * 60 * 1000, "parseInterval 负数应降级为 12h");

  let stopCount = 0;
  const originalStop = consolidator.stop;
  consolidator.stop = function() {
    stopCount++;
    return originalStop.apply(this);
  };

  // 首次启动定时器
  consolidator.startPeriodic();
  assertEqual(stopCount, 1, "首次启动定时器调用了 1 次 stop");

  // 重复启动定时器（配置未发生变化），应当直接跳过 stop 与重启
  consolidator.startPeriodic();
  assertEqual(stopCount, 1, "配置未变时重复调用 startPeriodic 不重启定时器");

  // 修改配置后启动定时器，应当触发 stop 重置定时器
  consolidator.updateConfig({ interval: "2h" });
  consolidator.startPeriodic();
  assertEqual(stopCount, 2, "配置发生变更时 startPeriodic 重启定时器");

  // 清理
  consolidator.stop();

  // --- 4. 老化逻辑采用时间戳判定测试 ---
  // 创建一条已被降权（priority = -1）且极旧但被访问过（access_count = 5）的长期记忆
  const veryOldDate = new Date(Date.now() - 200 * 86400000).toISOString(); // 200天前
  db.prepare(`
    INSERT INTO memories (key, value, created_at, updated_at, memory_type, scope, scope_id, priority, access_count, last_accessed_at)
    VALUES (?, ?, ?, ?, 'long_term', 'global', '', -1, 5, ?)
  `).run("very_old_accessed_mem", "极旧且被访问过的记忆", veryOldDate, veryOldDate, veryOldDate);

  // 创建一条已被降权（priority = -1）但最近刚访问过（last_accessed_at = today）的长期记忆
  const todayDate = new Date().toISOString();
  db.prepare(`
    INSERT INTO memories (key, value, created_at, updated_at, memory_type, scope, scope_id, priority, access_count, last_accessed_at)
    VALUES (?, ?, ?, ?, 'long_term', 'global', '', -1, 5, ?)
  `).run("recent_accessed_mem", "最近刚访问过的记忆", veryOldDate, todayDate, todayDate);

  // 运行老化归档（两倍周期是 180 天）
  const agingResult = store.applyAging({ accessThreshold: 1, maxAgeDays: 90 });
  assertEqual(agingResult.archived, 1, "1 条极旧访问记忆被归档");

  assert(store.recall("very_old_accessed_mem") === null, "非常旧且无最近访问的记忆已被物理删除");
  assert(store.recall("recent_accessed_mem") !== null, "最近刚被访问过的降权记忆依然保留");

  db.close();
}

async function testCheckAndConsolidate() {
  console.log("\n=== checkAndConsolidate 自动触发条件测试 ===");
  const db = createTestDb();
  runMigrations(db);
  const store = new SqliteMemoryStore(db);

  const consolidator = new MemoryConsolidator(store, {
    ...DEFAULT_CONSOLIDATION_CONFIG,
    interval: "1h",
    bufferMinMessages: 6,
    autoConsolidateBufferCount: 10,
  });

  const mockProvider = createMockProvider({
    profile: { preferences: "p", background: "b", style: "s" },
    memories: [],
    index: { title: "title", topics: [] },
  });
  consolidator.setProvider(mockProvider as any);

  // 1. 初始状态下，last_consolidate_time 不存在，缓冲区为空
  let checkResult = await consolidator.checkAndConsolidate();
  assertEqual(checkResult, null, "空缓冲区不应触发整理");

  // 2. 添加 4 条消息（小于 bufferMinMessages (6) 且小于 autoConsolidateBufferCount (10)）
  for (let i = 0; i < 4; i++) {
    store.save(`short_term_${i}`, `msg ${i}`, ["conversation", "short_term"], { memoryType: "short_term", scope: "session", scopeId: "sess" });
  }
  checkResult = await consolidator.checkAndConsolidate();
  assertEqual(checkResult, null, "消息数 (4) 未达任何阈值，不应触发");

  // 3. 达到 bufferMinMessages (6)，且由于上次时间为 0 (极旧)，应当触发时间条件整理
  for (let i = 4; i < 8; i++) {
    store.save(`short_term_${i}`, `msg ${i}`, ["conversation", "short_term"], { memoryType: "short_term", scope: "session", scopeId: "sess" });
  }
  checkResult = await consolidator.checkAndConsolidate();
  assert(checkResult !== null, "时间条件满足且达到最小消息数 (8 >= 6)，应触发整理");
  assertEqual(checkResult!.extractionFailed, false, "提取成功");

  // 确认写入了 system_last_consolidate_time
  const lastTimeEntry = store.recall("system_last_consolidate_time");
  assert(lastTimeEntry !== null, "整理成功后应写入 system_last_consolidate_time");

  // 4. 重置 system_last_consolidate_time 为当前时间，从而模拟时间间隔未到
  store.save("system_last_consolidate_time", Date.now().toString(), [], { memoryType: "long_term" });

  // 写入 8 条新消息（已达 bufferMinMessages，但时间未到，因此不应触发时间整理，且未到 10 条自动阈值）
  for (let i = 0; i < 8; i++) {
    store.save(`short_term_new_${i}`, `msg ${i}`, ["conversation", "short_term"], { memoryType: "short_term", scope: "session", scopeId: "sess" });
  }
  checkResult = await consolidator.checkAndConsolidate();
  assertEqual(checkResult, null, "时间未到且消息数未达自动触发阈值 (8 < 10)，不应触发");

  // 5. 写入 2 条新消息使得总数达到 10 (>= autoConsolidateBufferCount)
  // 即使时间间隔未满，也应该触发自动整理！
  for (let i = 8; i < 10; i++) {
    store.save(`short_term_new_${i}`, `msg ${i}`, ["conversation", "short_term"], { memoryType: "short_term", scope: "session", scopeId: "sess" });
  }
  checkResult = await consolidator.checkAndConsolidate();
  assert(checkResult !== null, "消息数达到自动触发阈值 (10 >= 10)，即使时间未到也应触发整理");

  db.close();
}

// ── Main ──

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   记忆系统集成测试                    ║");
  console.log("╚══════════════════════════════════════╝");

  try {
    await testMemoryStoreBasic();
    await testMemoryStoreLayered();
    await testConversationIndices();
    await testV3MigrationFromHistoryIndex();
    await testArchiveShortTermMemories();
    await testMemoryAging();
    await testMemoryExpiry();
    await testMemoryDedup();
    await testMemorySearch();
    await testConsolidatorWithMockProvider();
    await testConsolidatorFailureProtection();
    await testMemoryLengthTruncation();
    await testMemoryTypeNoHistoryIndex();
    await testClearAllMemories();
    await testMemoryDisabledConfiguration();
    await testMemoryRefinements();
    await testCheckAndConsolidate();
  } catch (e) {
    console.error("\n!!! 测试执行异常 !!!", e);
    failed++;
  }

  console.log("\n══════════════════════════════════════");
  console.log(`总计: ${passed + failed} | 通过: ${passed} | 失败: ${failed}`);
  if (failures.length > 0) {
    console.log("\n失败列表:");
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
  }
  console.log("══════════════════════════════════════");

  process.exit(failed > 0 ? 1 : 0);
}

main();
