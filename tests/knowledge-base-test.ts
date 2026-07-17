/**
 * Knowledge Base 深入测试
 *
 * 基于 packages/knowledge-base/src 实际源码编写，覆盖：
 * - TextChunker 分块逻辑
 * - InMemoryVectorStore 余弦相似度/维度校验/过滤
 * - SqliteKBMetadataStore CRUD（:memory: SQLite）
 * - SqliteVectorStore 向量序列化与检索
 * - KnowledgeBaseManager 全生命周期（KB-01~KB-15）
 * - KBHelper uploadText/search 错误路径
 * - KBHelper uploadFromUrl（本地 HTTP 服务器）
 * - retrieve 多 KB 融合/去重/topM 截断/输出格式
 */
import Database from "better-sqlite3";
import { createServer, type Server } from "http";

// ── Assert helpers ──
let passCount = 0;
let failCount = 0;
let skipCount = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passCount++;
    console.log(`  ✅ ${message}`);
  } else {
    failCount++;
    console.error(`  ❌ ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr === expectedStr) {
    passCount++;
    console.log(`  ✅ ${message}`);
  } else {
    failCount++;
    console.error(`  ❌ ${message} (expected ${expectedStr}, got ${actualStr})`);
  }
}

function skip(message: string): void {
  skipCount++;
  console.log(`  ⏭ ${message}`);
}

// ── Mock Embedding Provider ──
// 基于词袋模型生成确定性向量：相同文本→相同向量，共享词的文本→高余弦相似度
const MOCK_DIM = 8;
class MockEmbeddingProvider {
  providerConfig = { id: "mock-embedding" };

  async getEmbedding(text: string): Promise<number[]> {
    return this.bagOfWords(text);
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.bagOfWords(t));
  }

  getDim(): number {
    return MOCK_DIM;
  }

  private bagOfWords(text: string): number[] {
    const vec = new Array(MOCK_DIM).fill(0);
    // 简单 hash：每个词贡献到固定维度
    const words = text.toLowerCase().split(/\W+/).filter(Boolean);
    for (const w of words) {
      let hash = 0;
      for (let i = 0; i < w.length; i++) {
        hash = (hash * 31 + w.charCodeAt(i)) | 0;
      }
      const idx = Math.abs(hash) % MOCK_DIM;
      vec[idx] += 1;
    }
    // 全零向量时给一个默认值，避免 norm=0
    if (vec.every((v) => v === 0)) vec[0] = 1;
    return vec;
  }
}

// ── Mock Rerank Provider ──
class MockRerankProvider {
  providerConfig = { id: "mock-rerank" };

  async rerank(query: string, documents: string[], topN?: number): Promise<Array<{ index: number; relevanceScore: number; document: { text: string } }>> {
    const qWords = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
    const scored = documents.map((doc, index) => {
      const dWords = doc.toLowerCase().split(/\W+/).filter(Boolean);
      let overlap = 0;
      for (const w of dWords) if (qWords.has(w)) overlap++;
      const score = dWords.length > 0 ? overlap / dWords.length : 0;
      return { index, relevanceScore: score, document: { text: doc } };
    });
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return topN ? scored.slice(0, topN) : scored;
  }
}

// ── 本地 HTTP 服务器（用于 uploadFromUrl 测试）──
function startLocalServer(): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/text/doc1") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Hello world from doc one. This is a test document.");
      } else if (url === "/json/data") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ key: "value", items: [1, 2, 3] }));
      } else if (url === "/binary") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      } else if (url === "/large") {
        res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "6000000" });
        res.end(Buffer.alloc(6000000, 0x61)); // 6MB of 'a'
      } else if (url === "/404") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server,
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ── 主测试 ──
async function main(): Promise<void> {
  // 1. TextChunker
  await testTextChunker();

  // 2. InMemoryVectorStore
  await testInMemoryVectorStore();

  // 3. SqliteKBMetadataStore
  await testSqliteKBMetadataStore();

  // 4. SqliteVectorStore
  await testSqliteVectorStore();

  // 5. KnowledgeBaseManager
  await testKnowledgeBaseManager();

  // 6. KBHelper 错误路径
  await testKBHelperErrors();

  // 7. KBHelper uploadFromUrl（本地 HTTP 服务器）
  await testUploadFromUrl();

  // 8. retrieve 高级特性（多 KB 融合、去重、topM、输出格式）
  await testRetrieveAdvanced();

  // 汇总
  console.log("\n" + "=".repeat(60));
  console.log(`  知识库深入测试结果: 通过 ${passCount}, 失败 ${failCount}, 跳过 ${skipCount}`);
  console.log("=".repeat(60));
  if (failCount > 0) {
    process.exitCode = 1;
  }
}

// ============================================================
// 1. TextChunker
// ============================================================
async function testTextChunker(): Promise<void> {
  console.log("\n=== 测试: TextChunker ===");
  const { TextChunker } = await import("@yachiyo/knowledge-base/chunker.js");

  // 1.1 默认配置
  const chunker = new TextChunker();
  const chunks = chunker.chunk("短文本");
  assert(chunks.length === 1, "短文本产生 1 个 chunk");
  assertEqual(chunks[0], "短文本", "chunk 内容正确");

  // 1.2 多段落切分
  const multiPara = "段落一\n\n段落二\n\n段落三";
  const chunks2 = chunker.chunk(multiPara);
  assert(chunks2.length === 1, "3 个短段落合并为 1 个 chunk（未超 chunkSize）");
  assert(chunks2[0].includes("段落一"), "包含段落一");
  assert(chunks2[0].includes("段落二"), "包含段落二");
  assert(chunks2[0].includes("段落三"), "包含段落三");

  // 1.3 自定义 chunkSize 触发切分
  const smallChunker = new TextChunker({ chunkSize: 10, chunkOverlap: 0 });
  const longText = "abcdefghijklmnopqrstuvwxyz";
  const chunks3 = smallChunker.chunk(longText);
  assert(chunks3.length >= 2, "超长文本（无分隔符）触发 hardSplit 切多个 chunk");
  assertEqual(chunks3[0], "abcdefghij", "首 chunk 是 hardSplit 的第一段（10 字符）");
  // overlap=0 时 chunks 之间无重叠内容（修复 getOverlapTail 边界 bug 后的行为）
  if (chunks3.length >= 2) {
    assert(!chunks3[1].startsWith(chunks3[0]), "overlap=0 时第二个 chunk 不含第一个 chunk 的内容（无重复）");
  }
  // 验证无内容丢失
  const combined3 = chunks3.join("");
  assert(combined3.length === longText.length, "overlap=0 切分后内容完整不丢失");

  // 1.3.1 使用 overlap=0 + 多段落验证内容不丢失
  const multiParaChunker = new TextChunker({ chunkSize: 10, chunkOverlap: 0, separator: "\n\n" });
  const paraText = "aaaaa\n\nbbbbb\n\nccccc";
  const chunks3b = multiParaChunker.chunk(paraText);
  const combined3b = chunks3b.join("");
  assert(combined3b.includes("aaaaa") && combined3b.includes("bbbbb") && combined3b.includes("ccccc"), "多段落切分后内容不丢失");

  // 1.4 chunkOverlap 重叠
  const overlapChunker = new TextChunker({ chunkSize: 20, chunkOverlap: 5, separator: "\n\n" });
  const text = "1234567890\n\n0987654321\n\nabcdefghij";
  const chunks4 = overlapChunker.chunk(text);
  assert(chunks4.length >= 2, "带 overlap 的切分产生 >=2 个 chunk");
  // 验证第二个 chunk 以第一个 chunk 的尾部开头（overlap）
  if (chunks4.length >= 2) {
    const overlapTail = chunks4[0].slice(-5);
    assert(chunks4[1].startsWith(overlapTail), "第二个 chunk 以第一个 chunk 的尾部 overlap 开头");
  }

  // 1.5 空段落跳过
  const emptyPara = "内容一\n\n\n\n内容二";
  const chunks5 = chunker.chunk(emptyPara);
  assert(chunks5.length === 1, "空段落被跳过，合并为 1 个 chunk");
  assert(chunks5[0].includes("内容一") && chunks5[0].includes("内容二"), "非空段落保留");

  // 1.6 空文本
  const emptyChunks = chunker.chunk("");
  assert(emptyChunks.length === 0, "空文本产生 0 个 chunk");

  // 1.7 自定义 separator
  const customChunker = new TextChunker({ chunkSize: 5, chunkOverlap: 0, separator: "|" });
  const pipeText = "aaaa|bbbb|cccc";
  const chunks6 = customChunker.chunk(pipeText);
  assert(chunks6.length >= 2, "自定义分隔符 | 触发切分");

  console.log("  ✅ TextChunker 测试通过");
}

// ============================================================
// 2. InMemoryVectorStore
// ============================================================
async function testInMemoryVectorStore(): Promise<void> {
  console.log("\n=== 测试: InMemoryVectorStore ===");
  const { InMemoryVectorStore } = await import("@yachiyo/knowledge-base/stores/in-memory-vector-store.js");

  const store = new InMemoryVectorStore();
  await store.initialize();

  // 2.1 upsert & search
  await store.upsert("c1", [1, 0, 0], "chunk one", "d1", "doc1", 0, "kb1");
  await store.upsert("c2", [0, 1, 0], "chunk two", "d1", "doc1", 1, "kb1");
  await store.upsert("c3", [1, 1, 0], "chunk three", "d2", "doc2", 0, "kb2");

  const results = await store.search([1, 0, 0], 10);
  assert(results.length === 3, "search 返回全部 3 个向量");
  assertEqual(results[0].chunkId, "c1", "最相似的是 c1（与 query 相同）");
  assert(results[0].score > results[1].score, "score 降序排列");

  // 2.2 余弦相似度：正交向量 score=0
  const orthoResults = await store.search([1, 0, 0], 10);
  const c2Result = orthoResults.find((r) => r.chunkId === "c2");
  assert(c2Result !== undefined, "找到 c2");
  assert(Math.abs(c2Result!.score) < 1e-9, "正交向量 [0,1,0] vs [1,0,0] 余弦相似度≈0");

  // 2.3 kbId 过滤
  const kb1Results = await store.search([1, 0, 0], 10, "kb1");
  assert(kb1Results.length === 2, "kbId=kb1 过滤后仅返回 2 个");
  assert(kb1Results.every((r) => r.chunkId !== "c3"), "不包含 kb2 的 c3");

  // 2.4 维度不匹配抛错
  let dimError = false;
  try {
    await store.search([1, 0], 10);
  } catch (e) {
    dimError = (e as Error).message.includes("Dimension mismatch");
  }
  assert(dimError, "维度不匹配抛出 Dimension mismatch 错误");

  // 2.5 queryNorm=0 返回空
  const zeroResults = await store.search([0, 0, 0], 10);
  assert(zeroResults.length === 0, "零向量查询返回空数组");

  // 2.6 topK 截断
  const top1Results = await store.search([1, 0, 0], 1);
  assert(top1Results.length === 1, "topK=1 仅返回 1 个");

  // 2.7 batchUpsert
  await store.batchUpsert([
    { chunkId: "b1", embedding: [1, 1, 1], content: "batch1", docId: "d3", docName: "doc3", index: 0, kbId: "kb1" },
    { chunkId: "b2", embedding: [2, 2, 2], content: "batch2", docId: "d3", docName: "doc3", index: 1, kbId: "kb1" },
  ]);
  const batchResults = await store.search([1, 1, 1], 10, "kb1");
  assert(batchResults.some((r) => r.chunkId === "b1"), "batchUpsert 的 b1 可被搜索到");
  assert(batchResults.some((r) => r.chunkId === "b2"), "batchUpsert 的 b2 可被搜索到");

  // 2.8 count
  const total = await store.count();
  assert(total === 5, "count() 返回总数 5");
  const kb1Count = await store.count("kb1");
  assert(kb1Count === 4, "count(kb1) 返回 4");

  // 2.9 deleteByDocId
  await store.deleteByDocId("d3");
  const afterDocDelete = await store.count("kb1");
  assert(afterDocDelete === 2, "deleteByDocId(d3) 后 kb1 剩 2 个");

  // 2.10 deleteByKbId
  await store.deleteByKbId("kb2");
  const afterKbDelete = await store.count();
  assert(afterKbDelete === 2, "deleteByKbId(kb2) 后总数 2");

  // 2.11 close 清空
  await store.close();
  const afterClose = await store.count();
  assert(afterClose === 0, "close() 后 store 清空");

  console.log("  ✅ InMemoryVectorStore 测试通过");
}

// ============================================================
// 3. SqliteKBMetadataStore
// ============================================================
async function testSqliteKBMetadataStore(): Promise<void> {
  console.log("\n=== 测试: SqliteKBMetadataStore ===");
  const { SqliteKBMetadataStore, KNOWLEDGE_MIGRATIONS } = await import("@yachiyo/knowledge-base/stores/sqlite-kb-store.js");

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  // 手动执行迁移
  for (const m of KNOWLEDGE_MIGRATIONS) {
    db.exec(m.up);
  }

  const store = new SqliteKBMetadataStore(db);

  // 3.1 saveKb & getKb
  const kb = {
    id: "kb-test-1",
    name: "测试知识库",
    description: "用于测试",
    emoji: "📚",
    embeddingProviderId: "emb-1",
    rerankProviderId: "rr-1",
    chunkSize: 500,
    chunkOverlap: 50,
    topKDense: 10,
    topKSparse: 10,
    topMFinal: 5,
  };
  store.saveKb(kb);
  const got = store.getKb("kb-test-1");
  assert(got !== null, "getKb 返回非 null");
  assertEqual(got!.name, "测试知识库", "name 正确");
  assertEqual(got!.emoji, "📚", "emoji 正确");
  assertEqual(got!.embeddingProviderId, "emb-1", "embeddingProviderId 正确");
  assertEqual(got!.rerankProviderId, "rr-1", "rerankProviderId 正确");
  assertEqual(got!.chunkSize, 500, "chunkSize 默认值 500");

  // 3.2 getKbByName
  const byName = store.getKbByName("测试知识库");
  assert(byName !== null, "getKbByName 命中");
  assertEqual(byName!.id, "kb-test-1", "byName id 正确");

  // 3.3 getAllKbs
  const all = store.getAllKbs();
  assert(all.length === 1, "getAllKbs 返回 1 个");

  // 3.4 saveDocument & getDocumentsByKb
  const doc = {
    id: "doc-1",
    kbId: "kb-test-1",
    name: "test.txt",
    url: "http://example.com/test.txt",
    type: "text",
    chunkCount: 5,
    createdAt: Date.now(),
  };
  store.saveDocument(doc);
  const docs = store.getDocumentsByKb("kb-test-1");
  assert(docs.length === 1, "getDocumentsByKb 返回 1 个");
  assertEqual(docs[0].name, "test.txt", "文档 name 正确");
  assertEqual(docs[0].chunkCount, 5, "文档 chunkCount 正确");

  // 3.5 saveChunk & saveChunks（需在 deleteDocument 之前，因为外键约束）
  const chunk1 = { id: "ch-1", docId: "doc-1", kbId: "kb-test-1", content: "内容一", index: 0 };
  const chunk2 = { id: "ch-2", docId: "doc-1", kbId: "kb-test-1", content: "内容二", index: 1 };
  store.saveChunk(chunk1);
  store.saveChunks([chunk2]);
  // 验证 chunk 写入（通过查 kb_chunks 表）
  const chunkRows = db.prepare("SELECT COUNT(*) as cnt FROM kb_chunks WHERE kb_id = ?").get("kb-test-1") as { cnt: number };
  assertEqual(chunkRows.cnt, 2, "saveChunk + saveChunks 共写入 2 个 chunk");

  // 3.6 deleteDocument（在 chunk 之后）
  store.deleteDocument("doc-1");
  const docsAfterDelete = store.getDocumentsByKb("kb-test-1");
  assert(docsAfterDelete.length === 0, "deleteDocument 后文档列表为空");

  // 3.7 deleteKb 级联
  store.deleteKb("kb-test-1");
  const afterKbDelete = store.getKb("kb-test-1");
  assert(afterKbDelete === null, "deleteKb 后 getKb 返回 null");

  // 3.8 迁移幂等：再次执行迁移不报错
  let idempotentOk = true;
  try {
    for (const m of KNOWLEDGE_MIGRATIONS) {
      db.exec(m.up);
    }
  } catch {
    idempotentOk = false;
  }
  // CREATE TABLE IF NOT EXISTS 是幂等的，但 INSERT 没有 OR IGNORE 的部分会失败
  // 我们的迁移全是 CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS，应该幂等
  // 注意：第 2 个迁移含 INSERT INTO conversations_fts，但 knowledge 迁移只有 v1 且全是 CREATE IF NOT EXISTS
  assert(idempotentOk, "迁移幂等（CREATE TABLE IF NOT EXISTS 重复执行不报错）");

  db.close();
  console.log("  ✅ SqliteKBMetadataStore 测试通过");
}

// ============================================================
// 4. SqliteVectorStore
// ============================================================
async function testSqliteVectorStore(): Promise<void> {
  console.log("\n=== 测试: SqliteVectorStore ===");
  const { SqliteVectorStore, SqliteKBMetadataStore, KNOWLEDGE_MIGRATIONS } = await import("@yachiyo/knowledge-base/stores/sqlite-kb-store.js");

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  for (const m of KNOWLEDGE_MIGRATIONS) {
    db.exec(m.up);
  }

  const store = new SqliteVectorStore(db);
  await store.initialize();

  // 先创建 KB 元数据（upsert 的 kb_documents 有外键约束 kb_id → knowledge_bases.id）
  const metaStore = new SqliteKBMetadataStore(db);
  metaStore.saveKb({
    id: "kb1",
    name: "KB1",
    description: "",
    emoji: "",
    embeddingProviderId: "emb",
    rerankProviderId: null,
    chunkSize: 500,
    chunkOverlap: 50,
    topKDense: 10,
    topKSparse: 10,
    topMFinal: 5,
  });
  metaStore.saveKb({
    id: "kb2",
    name: "KB2",
    description: "",
    emoji: "",
    embeddingProviderId: "emb",
    rerankProviderId: null,
    chunkSize: 500,
    chunkOverlap: 50,
    topKDense: 10,
    topKSparse: 10,
    topMFinal: 5,
  });

  // 4.1 upsert
  // 验证修复后的 upsert 行为：两次 upsert 共用同一 docId 不再触发级联删除。
  // 修复前：INSERT OR REPLACE 触发 kb_chunks.doc_id 的 ON DELETE CASCADE，第二次会删除第一次的 chunks。
  // 修复后：使用 ON CONFLICT(id) DO UPDATE，不触发 DELETE，原有 chunks 保留。
  await store.upsert("c1", [1, 0, 0], "chunk one", "d1", "doc1", 0, "kb1");
  await store.upsert("c2", [0, 1, 0], "chunk two", "d1", "doc1", 1, "kb1");

  // 4.2 search
  const results = await store.search([1, 0, 0], 10);
  assert(results.length === 2, "search 返回 2 个（共用 docId 不再丢失 c1）");
  assertEqual(results[0].chunkId, "c1", "最相似的是 c1");
  assert(results[0].score > 0.99, "c1 余弦相似度接近 1");

  // 4.3 向量 Buffer 序列化（Float32Array）
  // 验证存储的 embedding 是 Float32Array 转换的 Buffer
  const vecRow = db.prepare("SELECT embedding FROM kb_vectors WHERE chunk_id = ?").get("c1") as { embedding: Buffer };
  const floats = new Float32Array(vecRow.embedding.buffer, vecRow.embedding.byteOffset, vecRow.embedding.byteLength / 4);
  assertEqual(floats[0], 1, "Buffer 反序列化为 Float32Array 后第一个元素=1");
  assertEqual(floats[1], 0, "第二个元素=0");

  // 4.4 batchUpsert
  await store.batchUpsert([
    { chunkId: "b1", embedding: [1, 1, 0], content: "batch1", docId: "d3", docName: "doc3", index: 0, kbId: "kb2" },
    { chunkId: "b2", embedding: [0, 1, 1], content: "batch2", docId: "d3", docName: "doc3", index: 1, kbId: "kb2" },
  ]);
  const batchResults = await store.search([1, 1, 0], 10, "kb2");
  assert(batchResults.length === 2, "batchUpsert 后 kb2 搜索返回 2 个");
  assertEqual(batchResults[0].chunkId, "b1", "b1 最相似");

  // 4.5 kbId 过滤
  const kb1Results = await store.search([1, 0, 0], 10, "kb1");
  assert(kb1Results.length === 2, "kb1 过滤返回 2 个");
  assert(kb1Results.every((r) => r.chunkId.startsWith("c")), "kb1 仅含 c1/c2，不含 kb2 的 b1/b2");

  // 4.6 维度不匹配跳过（不抛错，只 warn）
  const mixedDimResults = await store.search([1, 0, 0, 0], 10);
  assert(mixedDimResults.length === 0, "维度不匹配的查询跳过所有 3 维向量，返回 0 个");

  // 4.7 零向量查询返回空
  const zeroResults = await store.search([0, 0, 0], 10);
  assert(zeroResults.length === 0, "零向量查询返回空");

  // 4.8 count
  const total = await store.count();
  assert(total === 4, "count() 总数 4");
  const kb2Count = await store.count("kb2");
  assertEqual(kb2Count, 2, "count(kb2)=2");

  // 4.9 deleteByDocId
  await store.deleteByDocId("d3");
  const afterDocDelete = await store.count("kb2");
  assert(afterDocDelete === 0, "deleteByDocId(d3) 后 kb2 为 0");

  // 4.10 deleteByKbId
  await store.deleteByKbId("kb1");
  const afterKbDelete = await store.count();
  assert(afterKbDelete === 0, "deleteByKbId(kb1) 后总数 0");

  await store.close();
  db.close();
  console.log("  ✅ SqliteVectorStore 测试通过");
}

// ============================================================
// 5. KnowledgeBaseManager 全生命周期
// ============================================================
async function testKnowledgeBaseManager(): Promise<void> {
  console.log("\n=== 测试: KnowledgeBaseManager ===");
  const { KnowledgeBaseManager } = await import("@yachiyo/knowledge-base/manager.js");
  const { InMemoryVectorStore } = await import("@yachiyo/knowledge-base/stores/in-memory-vector-store.js");
  const { SqliteKBMetadataStore, SqliteVectorStore, KNOWLEDGE_MIGRATIONS } = await import("@yachiyo/knowledge-base/stores/sqlite-kb-store.js");
  const { KnowledgeBaseUploadError } = await import("@yachiyo/common/errors.js");

  // 构造 Mock ProviderManager（只需 embeddingInsts 和 rerankInsts）
  const mockEmb = new MockEmbeddingProvider() as any;
  const mockRR = new MockRerankProvider() as any;
  const mockProviderManager = {
    embeddingInsts: [mockEmb],
    rerankInsts: [mockRR],
  } as any;

  // 使用 SQLite 共享数据库（vectorStore 和 metadataStore 共用同一 db，
  // 这样 batchUpsert 写入的 kb_documents 元数据可被 getDocumentsByKb 读取，
  // 这是生产环境的实际配置）
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  for (const m of KNOWLEDGE_MIGRATIONS) db.exec(m.up);
  const metadataStore = new SqliteKBMetadataStore(db);
  const vectorStore = new SqliteVectorStore(db);
  const manager = new KnowledgeBaseManager(mockProviderManager, vectorStore);
  manager.setMetadataStore(metadataStore);
  await manager.initialize();

  // KB-01: createKb 校验 embedding provider（不存在抛错）
  let embNotFoundError = false;
  try {
    await manager.createKb({
      name: "无embedding",
      description: "",
      emoji: "",
      embeddingProviderId: "nonexistent",
    });
  } catch (e) {
    embNotFoundError = e instanceof KnowledgeBaseUploadError && (e as any).userMessage.includes("Embedding provider not found");
  }
  assert(embNotFoundError, "KB-01: createKb 不存在的 embedding provider 抛 KnowledgeBaseUploadError");

  // KB-02: createKb 校验 rerank provider（不存在抛错）
  let rrNotFoundError = false;
  try {
    await manager.createKb({
      name: "无rerank",
      description: "",
      emoji: "",
      embeddingProviderId: "mock-embedding",
      rerankProviderId: "nonexistent-rerank",
    });
  } catch (e) {
    rrNotFoundError = e instanceof KnowledgeBaseUploadError && (e as any).userMessage.includes("Rerank provider not found");
  }
  assert(rrNotFoundError, "KB-02: createKb 不存在的 rerank provider 抛错");

  // KB-03: createKb 持久化
  const kb = await manager.createKb({
    name: "测试KB",
    description: "测试描述",
    emoji: "📖",
    embeddingProviderId: "mock-embedding",
    rerankProviderId: "mock-rerank",
  });
  assert(!!kb.id, "KB-03: createKb 返回带 id 的 KB");
  assertEqual(kb.name, "测试KB", "KB name 正确");
  assertEqual(kb.chunkSize, 500, "KB chunkSize 默认 500");
  assertEqual(kb.chunkOverlap, 50, "KB chunkOverlap 默认 50");
  assertEqual(kb.topKDense, 10, "KB topKDense 默认 10");
  assertEqual(kb.topMFinal, 5, "KB topMFinal 默认 5");
  assertEqual(kb.rerankProviderId, "mock-rerank", "KB rerankProviderId 正确");

  // 验证持久化到 SQLite
  const persisted = metadataStore.getKb(kb.id);
  assert(persisted !== null, "KB-03: KB 已持久化到 SQLite");
  assertEqual(persisted!.name, "测试KB", "持久化的 name 正确");

  // KB-13: listKbs
  const list = manager.listKbs();
  assert(list.length === 1, "KB-13: listKbs 返回 1 个");
  assertEqual(list[0].id, kb.id, "listKbs id 正确");

  // KB-14: getKbByName
  const byName = manager.getKbByName("测试KB");
  assert(byName !== undefined, "KB-14: getKbByName 命中");
  assertEqual(byName!.id, kb.id, "getKbByName id 正确");

  // getKb
  const byId = manager.getKb(kb.id);
  assert(byId !== undefined, "getKb 命中");

  // KB-05: uploadText
  await manager.uploadText(kb.id, "Hello world. This is a test document about cats and dogs.", "doc1.txt");
  const docs = manager.getDocuments(kb.id);
  assert(docs.length === 1, "KB-05: uploadText 后文档数为 1");
  assertEqual(docs[0].name, "doc1.txt", "文档 name 正确");

  // KB-06: retrieve 混合检索（向量+rerank）
  const result = await manager.retrieve("Hello world test", ["测试KB"]);
  assert(result !== null, "KB-06: retrieve 返回非 null");
  assert(result!.includes("测试KB"), "KB-09: 输出包含 kbName");
  assert(result!.includes("doc1.txt"), "KB-09: 输出包含 docName");
  assert(result!.includes("score:"), "KB-09: 输出包含 score");

  // KB-09: 输出格式验证
  const formatMatch = result!.match(/\[(\d+)\] \[([^\]]+) \/ ([^\]]+)\] \(score: ([\d.]+)\)/);
  assert(formatMatch !== null, "KB-09: 输出格式匹配 [i] [kbName / docName] (score: x.xxxx)");

  // KB-08: retrieve topM 截断
  // 上传多个文档产生更多 chunk，然后限制 topM
  await manager.uploadText(kb.id, "Another document about cats and dogs and birds.", "doc2.txt");
  await manager.uploadText(kb.id, "Third document about birds and fish.", "doc3.txt");
  const limited = await manager.retrieve("cats dogs", ["测试KB"], 10, 2);
  assert(limited !== null, "retrieve topM=2 返回非 null");
  // 统计输出中的条目数（[1] [2]）
  const matchCount = (limited!.match(/^\[\d+\] /gm) || []).length;
  assert(matchCount <= 2, "KB-08: topM=2 截断后条目数 <= 2");

  // KB-10: retrieve 无 KB 返回 null
  const noResult = await manager.retrieve("query", ["不存在的KB"]);
  assert(noResult === null, "KB-10: retrieve 无 KB 返回 null");

  // KB-12: deleteDocument
  const docsBefore = manager.getDocuments(kb.id);
  const docCountBefore = docsBefore.length;
  await manager.deleteDocument(docsBefore[0].id);
  const docsAfter = manager.getDocuments(kb.id);
  assertEqual(docsAfter.length, docCountBefore - 1, "KB-12: deleteDocument 后文档数 -1");

  // KB-11: deleteKb
  const kbIdToDelete = kb.id;
  await manager.deleteKb(kbIdToDelete);
  assert(manager.getKb(kbIdToDelete) === undefined, "KB-11: deleteKb 后 getKb 返回 undefined");
  assert(manager.getKbByName("测试KB") === undefined, "KB-11: deleteKb 后 getKbByName 返回 undefined");
  const deletedPersisted = metadataStore.getKb(kbIdToDelete);
  assert(deletedPersisted === null, "KB-11: deleteKb 后 SQLite 中也删除");

  // KB-15: initialize 恢复
  // 先创建一个 KB，然后用新 manager initialize 恢复
  const kb2 = await manager.createKb({
    name: "恢复KB",
    description: "用于测试 initialize 恢复",
    emoji: "🔄",
    embeddingProviderId: "mock-embedding",
  });
  await manager.uploadText(kb2.id, "Recovery test document content.", "recovery.txt");

  // 新 manager（共享 metadataStore；新 vectorStore 仅用于 KBHelper 构造，
  // 因为 initialize 只从 metadataStore 恢复 KB 元数据，向量数据由原 vectorStore 持有）
  const newVectorStore = new InMemoryVectorStore();
  await newVectorStore.initialize();
  const newManager = new KnowledgeBaseManager(mockProviderManager, newVectorStore);
  newManager.setMetadataStore(metadataStore);
  await newManager.initialize();
  const recoveredKbs = newManager.listKbs();
  assert(recoveredKbs.length >= 1, "KB-15: initialize 后恢复 KB");
  const recovered = newManager.getKbByName("恢复KB");
  assert(recovered !== undefined, "KB-15: 恢复的 KB 可通过 getKbByName 查到");

  await manager.terminate();
  await newManager.terminate();
  db.close();
  console.log("  ✅ KnowledgeBaseManager 测试通过");
}

// ============================================================
// 6. KBHelper 错误路径
// ============================================================
async function testKBHelperErrors(): Promise<void> {
  console.log("\n=== 测试: KBHelper 错误路径 ===");
  const { KBHelper } = await import("@yachiyo/knowledge-base/kb-helper.js");
  const { TextChunker } = await import("@yachiyo/knowledge-base/chunker.js");
  const { InMemoryVectorStore } = await import("@yachiyo/knowledge-base/stores/in-memory-vector-store.js");
  const { KnowledgeBaseUploadError } = await import("@yachiyo/common/errors.js");

  const kb = {
    id: "kb-err",
    name: "错误测试KB",
    description: "",
    emoji: "",
    embeddingProviderId: "mock-embedding",
    rerankProviderId: null,
    chunkSize: 500,
    chunkOverlap: 50,
    topKDense: 10,
    topKSparse: 10,
    topMFinal: 5,
  };

  // 6.1 chunk 空（空文本）
  const emb = new MockEmbeddingProvider() as any;
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize();
  const chunker = new TextChunker();
  const helper = new KBHelper(kb, emb, null, vectorStore, chunker);

  let emptyChunkError = false;
  try {
    await helper.uploadText("", "empty.txt");
  } catch (e) {
    emptyChunkError = e instanceof KnowledgeBaseUploadError && (e as any).userMessage.includes("No chunks produced");
  }
  assert(emptyChunkError, "空文本抛 'No chunks produced' 错误");

  // 6.2 embedding 失败
  const failingEmb = {
    providerConfig: { id: "fail-emb" },
    getEmbedding: async () => { throw new Error("embedding API down"); },
    getEmbeddings: async () => { throw new Error("embedding API down"); },
    getDim: () => 8,
  } as any;
  const helper2 = new KBHelper(kb, failingEmb, null, vectorStore, chunker);
  let embError = false;
  try {
    await helper2.uploadText("Some content here for testing.", "fail.txt");
  } catch (e) {
    embError = e instanceof KnowledgeBaseUploadError && (e as any).userMessage.includes("Failed to generate embeddings");
  }
  assert(embError, "embedding 失败抛 'Failed to generate embeddings' 错误");

  // 6.3 upsert 失败
  const failingVectorStore = {
    initialize: async () => {},
    close: async () => {},
    upsert: async () => { throw new Error("storage full"); },
    batchUpsert: async () => { throw new Error("storage full"); },
    search: async () => [],
    deleteByDocId: async () => {},
    deleteByKbId: async () => {},
    count: async () => 0,
  } as any;
  const helper3 = new KBHelper(kb, emb, null, failingVectorStore, chunker);
  let upsertError = false;
  try {
    await helper3.uploadText("Some content here for testing upsert failure.", "upsert-fail.txt");
  } catch (e) {
    upsertError = e instanceof KnowledgeBaseUploadError && (e as any).userMessage.includes("Failed to store chunks");
  }
  assert(upsertError, "upsert 失败抛 'Failed to store chunks' 错误");

  // 6.4 search 无 rerank（直接返回向量搜索结果）
  const goodHelper = new KBHelper(kb, emb, null, vectorStore, chunker);
  await goodHelper.uploadText("Hello world cats dogs.", "doc1.txt");
  const searchResults = await goodHelper.search("Hello cats");
  assert(searchResults.length > 0, "search 无 rerank 返回结果");
  assert(searchResults.every((r) => typeof r.score === "number"), "每个结果有 score");

  // 6.5 search 有 rerank
  const rr = new MockRerankProvider() as any;
  const helperWithRR = new KBHelper(kb, emb, rr, vectorStore, chunker);
  await helperWithRR.uploadText("Birds and fish in the ocean.", "doc2.txt");
  const rrResults = await helperWithRR.search("birds fish");
  assert(rrResults.length > 0, "search 有 rerank 返回结果");
  // rerank 后的 score 应该是 relevanceScore（0-1 之间）
  assert(rrResults.every((r) => r.score >= 0 && r.score <= 1), "rerank score 在 0-1 之间");

  // 6.6 search 空结果（向量库为空）
  const emptyStore = new InMemoryVectorStore();
  await emptyStore.initialize();
  const helperEmpty = new KBHelper(kb, emb, null, emptyStore, chunker);
  const emptyResults = await helperEmpty.search("anything");
  assert(emptyResults.length === 0, "空向量库 search 返回空");

  console.log("  ✅ KBHelper 错误路径测试通过");
}

// ============================================================
// 7. KBHelper uploadFromUrl（本地 HTTP 服务器）
// ============================================================
async function testUploadFromUrl(): Promise<void> {
  console.log("\n=== 测试: KBHelper uploadFromUrl ===");
  const { KBHelper } = await import("@yachiyo/knowledge-base/kb-helper.js");
  const { TextChunker } = await import("@yachiyo/knowledge-base/chunker.js");
  const { InMemoryVectorStore } = await import("@yachiyo/knowledge-base/stores/in-memory-vector-store.js");
  const { KnowledgeBaseUploadError } = await import("@yachiyo/common/errors.js");

  const { server, port, close } = await startLocalServer();

  try {
    const kb = {
      id: "kb-url",
      name: "URL测试KB",
      description: "",
      emoji: "",
      embeddingProviderId: "mock-embedding",
      rerankProviderId: null,
      chunkSize: 500,
      chunkOverlap: 50,
      topKDense: 10,
      topKSparse: 10,
      topMFinal: 5,
    };
    const emb = new MockEmbeddingProvider() as any;
    const vectorStore = new InMemoryVectorStore();
    await vectorStore.initialize();
    const chunker = new TextChunker();
    const helper = new KBHelper(kb, emb, null, vectorStore, chunker);

    // 7.1 成功下载 text/plain
    let success = false;
    try {
      await helper.uploadFromUrl(`http://127.0.0.1:${port}/text/doc1`);
      success = true;
    } catch (e) {
      console.error("  意外失败:", (e as Error).message);
    }
    assert(success, "uploadFromUrl 成功下载 text/plain 文档");

    // 验证向量已写入
    const count = await vectorStore.count("kb-url");
    assert(count > 0, "uploadFromUrl 后向量库非空");

    // 7.2 成功下载 application/json
    let jsonSuccess = false;
    try {
      await helper.uploadFromUrl(`http://127.0.0.1:${port}/json/data`, { docName: "data.json" });
      jsonSuccess = true;
    } catch (e) {
      console.error("  JSON 下载失败:", (e as Error).message);
    }
    assert(jsonSuccess, "uploadFromUrl 成功下载 application/json 文档");

    // 7.3 Content-Type 不允许（image/png）
    let ctError = false;
    try {
      await helper.uploadFromUrl(`http://127.0.0.1:${port}/binary`);
    } catch (e) {
      ctError = e instanceof KnowledgeBaseUploadError && (e as any).userMessage.includes("Unsupported Content-Type");
    }
    assert(ctError, "不支持的 Content-Type (image/png) 抛 'Unsupported Content-Type' 错误");

    // 7.4 HTTP 404
    let httpError = false;
    try {
      await helper.uploadFromUrl(`http://127.0.0.1:${port}/404`);
    } catch (e) {
      httpError = e instanceof KnowledgeBaseUploadError && (e as any).userMessage.includes("Failed to download");
    }
    assert(httpError, "HTTP 404 抛 'Failed to download' 错误");

    // 7.5 超大文档（6MB > 5MB 限制）
    let largeError = false;
    try {
      await helper.uploadFromUrl(`http://127.0.0.1:${port}/large`);
    } catch (e) {
      largeError = e instanceof KnowledgeBaseUploadError && (
        (e as any).userMessage.includes("too large") || (e as any).userMessage.includes("Failed to download")
      );
    }
    assert(largeError, "超大文档（6MB）被拒绝");

    // 7.6 自动提取 docName
    const helper2 = new KBHelper(kb, emb, null, vectorStore, chunker);
    let autoNameSuccess = false;
    try {
      await helper2.uploadFromUrl(`http://127.0.0.1:${port}/text/doc1`);
      autoNameSuccess = true;
    } catch {
      // 可能因为 docName 重复无所谓
    }
    assert(autoNameSuccess, "未指定 docName 时自动从 URL 提取");
  } finally {
    await close();
  }
  console.log("  ✅ KBHelper uploadFromUrl 测试通过");
}

// ============================================================
// 8. retrieve 高级特性
// ============================================================
async function testRetrieveAdvanced(): Promise<void> {
  console.log("\n=== 测试: retrieve 高级特性 ===");
  const { KnowledgeBaseManager } = await import("@yachiyo/knowledge-base/manager.js");
  const { InMemoryVectorStore } = await import("@yachiyo/knowledge-base/stores/in-memory-vector-store.js");

  const mockEmb = new MockEmbeddingProvider() as any;
  const mockProviderManager = {
    embeddingInsts: [mockEmb],
    rerankInsts: [],
  } as any;

  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize();
  const manager = new KnowledgeBaseManager(mockProviderManager, vectorStore);
  await manager.initialize();

  // 创建两个 KB
  const kb1 = await manager.createKb({
    name: "KB-one",
    description: "",
    emoji: "",
    embeddingProviderId: "mock-embedding",
  });
  const kb2 = await manager.createKb({
    name: "KB-two",
    description: "",
    emoji: "",
    embeddingProviderId: "mock-embedding",
  });

  // 上传文档（共享一些词以产生相似向量）
  await manager.uploadText(kb1.id, "cats dogs pets animals", "kb1-doc1.txt");
  await manager.uploadText(kb1.id, "fish ocean sea water", "kb1-doc2.txt");
  await manager.uploadText(kb2.id, "cats dogs pets animals", "kb2-doc1.txt"); // 与 kb1-doc1 相同内容
  await manager.uploadText(kb2.id, "birds sky fly wings", "kb2-doc2.txt");

  // 8.1 多 KB 融合检索
  const multiResult = await manager.retrieve("cats dogs pets", ["KB-one", "KB-two"]);
  assert(multiResult !== null, "多 KB 检索返回非 null");
  assert(multiResult!.includes("KB-one"), "结果包含 KB-one");
  assert(multiResult!.includes("KB-two"), "结果包含 KB-two");

  // 8.2 去重：相同内容的 chunk 应被去重（按 chunkId，不同 KB 的 chunk chunkId 不同，所以不会被去重）
  // 实际上 chunkId 是 generateId() 唯一的，所以相同内容的不同 chunk 不会被去重
  // 去重只针对同一 chunkId 出现在多个 KB helper 中的情况（理论上不会发生）
  // 这里验证 topM 截断生效
  const matchCount = (multiResult!.match(/^\[\d+\] /gm) || []).length;
  assert(matchCount <= 5, "默认 topM=5 截断生效");

  // 8.3 topM 自定义
  const topM2 = await manager.retrieve("cats", ["KB-one", "KB-two"], 10, 2);
  if (topM2 !== null) {
    const m2Count = (topM2.match(/^\[\d+\] /gm) || []).length;
    assert(m2Count <= 2, "topM=2 自定义截断生效");
  } else {
    assert(false, "topM=2 检索返回 null（异常）");
  }

  // 8.4 单 KB 检索
  const singleResult = await manager.retrieve("fish ocean", ["KB-one"]);
  assert(singleResult !== null, "单 KB 检索返回非 null");
  assert(singleResult!.includes("KB-one"), "单 KB 结果包含 KB-one");
  // 应该不含 KB-two（虽然 topM 可能截断）
  // 注意：单 KB 检索只查 KB-one，不会返回 KB-two 的内容

  // 8.5 输出格式详细验证
  const lines = multiResult!.split("\n\n---\n\n");
  assert(lines.length >= 1, "结果用 \\n\\n---\\n\\n 分隔");
  const firstLine = lines[0];
  assert(firstLine.includes("[1]"), "第一条以 [1] 开头");
  assert(firstLine.includes("(score:"), "包含 score 标记");
  assert(firstLine.includes("/"), "包含 kbName / docName 分隔符");

  // 8.6 检索不存在的 KB 名（混合存在与不存在）
  const mixedResult = await manager.retrieve("cats", ["KB-one", "不存在KB"]);
  assert(mixedResult !== null, "混合存在/不存在的 KB 名仍返回结果");
  assert(mixedResult!.includes("KB-one"), "结果包含存在的 KB");

  // 8.7 空查询
  const emptyQueryResult = await manager.retrieve("", ["KB-one"]);
  // 空查询的 embedding 可能是默认向量，仍可能返回结果
  // 主要验证不抛错
  assert(emptyQueryResult === null || typeof emptyQueryResult === "string", "空查询不抛错");

  await manager.terminate();
  console.log("  ✅ retrieve 高级特性测试通过");
}

// ── 启动 ──
main().catch((e) => {
  console.error("测试执行出错:", e);
  process.exit(1);
});
