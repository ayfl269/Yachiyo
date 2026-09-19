import Database from "better-sqlite3";
import { SqliteMemoryStore, MEMORY_MIGRATIONS } from "../packages/agent/src/sqlite-memory-store.js";
import { SqliteConversationStore, CHAT_MIGRATIONS } from "../packages/conversation/src/sqlite-conversation-store.js";
import { ConversationManager } from "../packages/conversation/src/manager.js";
import { MemoryConsolidator } from "../packages/agent/src/memory-consolidator.js";
import type { Provider, ProviderChatParams, LLMResponse } from "../packages/agent/src/types.js";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  }
  console.log(`  PASS: ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class MockProvider implements Provider {
  readonly name = "mock-periodic";
  readonly providerConfig = { id: "mock-periodic" };
  readonly type = "chat_completion";
  calls = 0;

  async textChat(_params: ProviderChatParams): Promise<LLMResponse> {
    this.calls++;
    return {
      role: "assistant",
      isChunk: false,
      completionText: JSON.stringify({
        profile: { preferences: "p", background: "b", style: "s" },
        memories: [{ key: "periodic_mem", value: "定时提取的记忆", tags: ["periodic"], priority: 5 }],
        index: { title: "定时索引标题", topics: ["定时", "周期"], summary: "由周期定时器触发生成的索引。" },
      }),
    };
  }

  async testConnection(): Promise<boolean> {
    return true;
  }
}

async function run() {
  console.log("=== 周期定时索引端到端测试 ===");
  const memDb = new Database(":memory:");
  const convDb = new Database(":memory:");
  for (const m of MEMORY_MIGRATIONS) {
    if (typeof m.up === "function") m.up(memDb); else memDb.exec(m.up);
  }
  for (const m of CHAT_MIGRATIONS) {
    if (typeof m.up === "function") m.up(convDb); else convDb.exec(m.up);
  }

  const memoryStore = new SqliteMemoryStore(memDb);
  const convStore = new SqliteConversationStore(convDb);
  const convManager = new ConversationManager(convStore);
  await convManager.initialize();

  const provider = new MockProvider();
  const consolidator = new MemoryConsolidator(memoryStore, {
    interval: "2s",
    enabled: true,
    memoryEnabled: true,
    bufferMinMessages: 2,
  });
  consolidator.setProvider(provider);
  consolidator.setConversationSource(convManager);
  convManager.setMemoryConsolidator(consolidator);

  // Seed an unindexed conversation with enough messages.
  const umo = "periodic-test:user";
  await convManager.newConversation(umo, { title: "周期测试会话" });
  for (let i = 1; i <= 3; i++) {
    await convManager.addMessagePair(umo, `用户第${i}问`, `助手第${i}答`);
  }

  const before = await convManager.getUnindexedConversations();
  assert(before.length === 1, "定时启动前存在 1 个未索引会话");

  console.log("\n启动周期定时器（间隔 2s），等待真实 setTimeout 触发...");
  consolidator.startPeriodic();
  assert(consolidator.isRunning(), "定时器已启动");

  // The timer is unref()'d, so keep the loop alive and poll for the effect.
  let indices = memoryStore.listConversationIndices(10);
  for (let waited = 0; waited < 8000 && indices.length === 0; waited += 250) {
    await sleep(250);
    indices = memoryStore.listConversationIndices(10);
  }

  assert(provider.calls > 0, `周期定时器实际调用了 provider（calls=${provider.calls}）`);
  assert(indices.length === 1, `周期定时器自动生成了 1 条记忆索引（实际=${indices.length}）`);
  assert(indices[0].title === "定时索引标题", "索引标题来自 LLM 输出");
  assert(memoryStore.recall("periodic_mem") != null, "周期定时器同时写入了长期记忆");

  const after = await convManager.getUnindexedConversations();
  assert(after.length === 0, "周期索引后水位线推进，未索引会话归零");

  // Critical: the timer must RECUR, not fire once and die. Add a new message
  // (advancing updated_at past last_indexed_at) and wait for the next tick.
  console.log("\n新增消息，验证定时器会再次触发（递归调度）...");
  const callsAfterFirst = provider.calls;
  await convManager.addMessagePair(umo, "新的用户提问", "新的助手回答");
  const reUnindexed = await convManager.getUnindexedConversations();
  assert(reUnindexed.length === 1, "新消息使会话重新变为未索引");

  for (let waited = 0; waited < 8000 && provider.calls === callsAfterFirst; waited += 250) {
    await sleep(250);
  }
  assert(provider.calls > callsAfterFirst, `定时器递归触发了第二次整理（calls=${provider.calls}）`);
  const afterSecond = await convManager.getUnindexedConversations();
  assert(afterSecond.length === 0, "第二次周期索引后水位线再次推进");

  console.log("\n验证 stop() 后定时器不再触发...");
  consolidator.stop();
  assert(!consolidator.isRunning(), "stop() 后定时器停止");
  const callsAfterStop = provider.calls;
  await sleep(3000);
  assert(provider.calls === callsAfterStop, `stop() 后不再触发整理（calls 保持 ${callsAfterStop}）`);

  console.log("\n==============================================");
  console.log("周期定时记忆索引端到端测试全部通过！");
  console.log("==============================================");
  memDb.close();
  convDb.close();
}

run().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
