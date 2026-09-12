import Database from "better-sqlite3";
import { SqliteMemoryStore, MEMORY_MIGRATIONS } from "../packages/agent/src/sqlite-memory-store.js";
import { SqliteConversationStore, CHAT_MIGRATIONS } from "../packages/conversation/src/sqlite-conversation-store.js";
import { ConversationManager } from "../packages/conversation/src/manager.js";
import { MemoryConsolidator } from "../packages/agent/src/memory-consolidator.js";
import { createConversationSearchTool } from "../packages/agent/src/conversation-search-tool.js";
import type { Provider, ProviderChatParams, LLMResponse } from "../packages/agent/src/types.js";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  }
  console.log(`  PASS: ${msg}`);
}

class MockIndexingProvider implements Provider {
  readonly name = "mock-indexing-provider";
  readonly providerConfig = { id: "mock-indexing-provider" };
  readonly type = "chat_completion";

  async textChat(_params: ProviderChatParams): Promise<LLMResponse> {
    // 不解析入参：这个 stub 永远返回同一份结构化载荷，便于断言最终落库内容。
    const result = {
      profile: {
        preferences: "喜欢简洁直接的代码风格，使用 TypeScript",
        background: "正在重构 Yachiyo 记忆系统",
        style: "严谨高效",
      },
      memories: [
        {
          key: "user_fav_lang",
          value: "用户主要使用 TypeScript 进行核心系统开发",
          tags: ["preference", "tech"],
          priority: 8,
        },
      ],
      index: {
        title: "探讨记忆系统优化与索引架构",
        topics: ["记忆系统", "上下文压缩", "索引架构"],
        summary: "讨论了将短期记忆移至上下文压缩层，并由后台异步建立全量对话索引的实施方案。",
      },
    };

    return {
      role: "assistant",
      isChunk: false,
      completionText: JSON.stringify(result),
    };
  }

  async testConnection(): Promise<boolean> {
    return true;
  }
}

async function run() {
  console.log("=== 1. 初始化数据库与组件 ===");
  const memDb = new Database(":memory:");
  const convDb = new Database(":memory:");

  for (const m of MEMORY_MIGRATIONS) {
    if (typeof m.up === "function") {
      m.up(memDb);
    } else {
      memDb.exec(m.up);
    }
  }
  for (const m of CHAT_MIGRATIONS) {
    if (typeof m.up === "function") {
      m.up(convDb);
    } else {
      convDb.exec(m.up);
    }
  }

  const memoryStore = new SqliteMemoryStore(memDb);
  const convStore = new SqliteConversationStore(convDb);
  const convManager = new ConversationManager(convStore);

  const consolidator = new MemoryConsolidator(memoryStore, {
    bufferMinMessages: 2,
  });
  consolidator.setProvider(new MockIndexingProvider());
  consolidator.setConversationSource(convManager);
  convManager.setMemoryConsolidator(consolidator);

  await convManager.initialize();

  console.log("\n=== 2. 测试全量会话持久化（无物理截断） ===");
  const umo = "test-platform:user-123";
  const convId = await convManager.newConversation(umo, { title: "测试对话" });
  const conv = (await convManager.getConversation(umo, convId))!;
  assert(conv.lastIndexedAt === null || conv.lastIndexedAt === undefined, "初始 lastIndexedAt 应该为 null");

  // 添加超过 250 条消息（130 对）。注意 addMessagePair 的签名是
  // (umo, userMessage, assistantMessage) —— 此前这里多传了一个 conv.id，
  // 导致 userMessage 变成了会话 id、assistantMessage 变成了用户提问（且第 4 个
  // 参数被静默忽略）。类型检查（tsconfig.tests.json）暴露了这个 bug。
  for (let i = 1; i <= 130; i++) {
    await convManager.addMessagePair(umo, `这是用户的第 ${i} 条提问`, `这是助手的第 ${i} 条回答`);
  }

  const updatedConv = await convManager.getConversation(umo, conv.id);
  const history = JSON.parse(updatedConv!.history);
  assert(history.length === 260, `历史记录完整保留 260 条消息，未被 200 条物理截断 (实际=${history.length})`);

  console.log("\n=== 3. 验证未索引会话发现与记忆索引生成 ===");
  const unindexed = await convManager.getUnindexedConversations();
  assert(unindexed.length === 1, `成功发现 1 个未索引会话 (id=${unindexed[0].id})`);

  const consolidationRes = await consolidator.consolidate({ force: true });
  assert(consolidationRes.extracted > 0, `consolidate 成功提取了 ${consolidationRes.extracted} 项内容`);
  assert(!consolidationRes.extractionFailed, "提取无错误");

  // 验证水位线已推进
  const recheckUnindexed = await convManager.getUnindexedConversations();
  assert(recheckUnindexed.length === 0, "更新 lastIndexedAt 后，未索引会话应为 0");

  const refreshedConv = await convManager.getConversation(umo, conv.id);
  assert(refreshedConv?.lastIndexedAt != null, "会话记录中的 lastIndexedAt 已被盖上时间戳");

  console.log("\n=== 4. 验证画像与长期记忆正确持久化 ===");
  const profileEntry = memoryStore.recall("user_profile");
  assert(profileEntry != null, "成功持久化 user_profile");
  const profileData = JSON.parse(profileEntry!.value);
  assert(profileData.preferences.includes("TypeScript"), "画像偏好包含 TypeScript");

  const longTermMem = memoryStore.recall("user_fav_lang");
  assert(longTermMem != null, "成功提取长期记忆 user_fav_lang");
  assert(longTermMem!.memoryType === "long_term", "类型为 long_term");

  console.log("\n=== 5. 验证高层次记忆索引与全文检索 (FTS5) ===");
  const indices = memoryStore.listConversationIndices(10);
  assert(indices.length === 1, `conversation_indices 表中存在 1 条索引 (实际=${indices.length})`);
  assert(indices[0].title === "探讨记忆系统优化与索引架构", "索引标题正确");
  assert(indices[0].summary?.includes("上下文压缩") === true, "索引摘要正确包含关键主题");
  assert(indices[0].messageCount === 260, `索引准确统计了消息总数 (${indices[0].messageCount})`);

  // 索引检索。v9 迁移（memory_fts_trigram）已把 conversation_indices_fts 换成
  // trigram 分词器，所以 ≥3 字符的中文子串能真正走 FTS 命中——在旧的 unicode61
  // 分词器下，这些查询恒为 0 行、只能靠 LIKE 兜底。
  const searchIndexRes = memoryStore.searchConversationIndices("上下文压缩");
  assert(searchIndexRes.length === 1, "≥3 字中文子串经 FTS5(trigram) 命中索引");

  // 反向验证"上面那条不是 LIKE 兜底的假阳性"：查询里带一个空格，sanitizeFtsQuery
  // 会把它拆成 `"记忆系统" OR "索引"`，FTS 侧能命中；而 LIKE 是按原始字符串
  // `%记忆系统 索引%`（含空格）匹配，摘要里并不存在这个字面量。因此只有 FTS
  // 真正生效时这条才会返回 1 行。
  const ftsOnlyRes = memoryStore.searchConversationIndices("记忆系统 索引");
  assert(ftsOnlyRes.length === 1, "含空格查询仅 FTS 能命中（证明 FTS 通道生效，非 LIKE 兜底）");

  // 兜底路径仍然必须可用：trigram 无法处理 <3 字符的查询（"压缩" 只有 2 字），
  // 此时由 searchConversationIndices 的 LIKE 分支接管。
  const shortQueryRes = memoryStore.searchConversationIndices("压缩");
  assert(shortQueryRes.length === 1, "2 字查询 trigram 无法命中，由 LIKE 兜底返回");

  console.log("\n=== 6. 验证 search_conversations 工具集成 ===");
  const searchTool = createConversationSearchTool({
    store: convStore,
    memoryStore: memoryStore,
  });

  const toolOutput = (await searchTool.handler!("上下文压缩")) as any;

  const textOutput = toolOutput.content[0].type === "text" ? toolOutput.content[0].text : "";
  assert(textOutput.includes("会话记忆索引"), "搜索结果包含 会话记忆索引 章节");
  assert(textOutput.includes("探讨记忆系统优化与索引架构"), "搜索结果展示了索引标题");
  assert(textOutput.includes("这是助手的第 1 条回答") || textOutput.includes("对话原文匹配") || textOutput.includes("上下文压缩"), "检索正常完成");

  console.log("\n==============================================");
  console.log("🎉 全部新记忆系统索引与检索集成测试通过！");
  console.log("==============================================");
}

run().catch((e) => {
  console.error("Test failed with error:", e);
  process.exit(1);
});
