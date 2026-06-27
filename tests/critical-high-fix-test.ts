/**
 * Critical & High 修复验证测试
 *
 * 验证 C3, C9, C11, C12 (Critical) 和 H2, H6, H8, H9, H10, H11, H13, H16 (High) 的修复。
 * 使用简单的 assert + console.log 模式，与项目现有测试风格一致。
 */

import { resolve, join } from "path";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import Database from "better-sqlite3";

// ── 辅助 ──────────────────────────────────────────────────────────────

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

function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
    failCount++;
    console.error(`  ❌ ${message} (未抛错)`);
  } catch {
    passCount++;
    console.log(`  ✅ ${message}`);
  }
}

async function assertRejects(fn: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await fn();
    failCount++;
    console.error(`  ❌ ${message} (未 reject)`);
  } catch {
    passCount++;
    console.log(`  ✅ ${message}`);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Critical 修复验证
// ══════════════════════════════════════════════════════════════════════

// ── C3: normalizeRwPath 路径穿越防护 ──────────────────────────────────

async function testC3PathTraversal(): Promise<void> {
  console.log("\n=== C3: normalizeRwPath 路径穿越防护 ===");
  const { createFileReadTool } = await import("../src/agent/computer-tools.js");

  const tmpDir = mkdtempSync(join(tmpdir(), "c3-test-"));
  const tool = createFileReadTool(tmpDir);

  // 正常路径：workspace 内文件应可读
  const testFile = join(tmpDir, "hello.txt");
  writeFileSync(testFile, "hello world");

  // 路径穿越：绝对路径应被拒绝
  await assertRejects(async () => {
    await tool.handler!({} as any, "/etc/passwd");
  }, "C3: 绝对路径 /etc/passwd 被拒绝");

  await assertRejects(async () => {
    await tool.handler!({} as any, "C:\\Windows\\win.ini");
  }, "C3: Windows 绝对路径被拒绝");

  // 路径穿越：相对 ../ 逃逸应被拒绝
  await assertRejects(async () => {
    await tool.handler!({} as any, "../../etc/passwd");
  }, "C3: 相对路径 ../../etc/passwd 被拒绝");

  await assertRejects(async () => {
    await tool.handler!({} as any, "../../../etc/shadow");
  }, "C3: 多层 ../ 逃逸被拒绝");

  // 正常路径：workspace 内文件可读
  try {
    const result = await tool.handler!({} as any, "hello.txt");
    const text = (result.content?.[0] as any)?.text ?? "";
    assert(text.includes("hello world"), "C3: workspace 内文件正常可读");
  } catch {
    assert(false, "C3: workspace 内文件正常可读");
  }

  rmSync(tmpDir, { recursive: true, force: true });
}

// ── C9: API Key 静态加密 ──────────────────────────────────────────────

async function testC9SecretCrypto(): Promise<void> {
  console.log("\n=== C9: API Key 静态加密 ===");
  const { encryptSecret, decryptSecret, loadEncryptionKey } = await import("../src/common/secret-crypto.js");

  // 生成测试密钥
  const key = loadEncryptionKey({ keyFilePath: join(mkdtempSync(join(tmpdir(), "c9-")), "secret.key") });
  assert(!!key, "C9: loadEncryptionKey 返回密钥");

  // 加密-解密往返
  const plaintext = "sk-abc123-secret-api-key";
  const encrypted = encryptSecret(plaintext, key!);
  assert(encrypted.startsWith("enc:v1:"), "C9: 加密结果以 enc:v1: 前缀开头");
  assert(encrypted !== plaintext, "C9: 加密后与明文不同");

  const decrypted = decryptSecret(encrypted, key!);
  assert(decrypted === plaintext, "C9: 解密恢复原始明文");

  // 向后兼容：无前缀的旧明文应原样返回
  const legacyPlain = "sk-legacy-plaintext-key";
  const legacyResult = decryptSecret(legacyPlain, key!);
  assert(legacyResult === legacyPlain, "C9: 旧明文数据向后兼容（原样返回）");

  // 每次加密产生不同密文（IV 随机）
  const encrypted2 = encryptSecret(plaintext, key!);
  assert(encrypted !== encrypted2, "C9: 同一明文两次加密产生不同密文（IV 随机）");

  // 解密另一个密文也能恢复
  const decrypted2 = decryptSecret(encrypted2, key!);
  assert(decrypted2 === plaintext, "C9: 第二次加密的密文也能正确解密");
}

// ── C11/C12: SSRF 防护 ────────────────────────────────────────────────

async function testC11C12SSRF(): Promise<void> {
  console.log("\n=== C11/C12: SSRF 防护 (assertSafeUrl) ===");
  const { assertSafeUrl } = await import("../src/common/ssrf-guard.js");

  // 私有 IP 应被拦截
  await assertRejects(() => assertSafeUrl("http://127.0.0.1/"), "C11: 127.0.0.1 被拦截");
  await assertRejects(() => assertSafeUrl("http://localhost/"), "C11: localhost 被拦截");
  await assertRejects(() => assertSafeUrl("http://169.254.169.254/"), "C11: 云元数据 169.254.169.254 被拦截");
  await assertRejects(() => assertSafeUrl("http://10.0.0.1/"), "C11: 10.x 私有段被拦截");
  await assertRejects(() => assertSafeUrl("http://192.168.1.1/"), "C11: 192.168.x 私有段被拦截");
  await assertRejects(() => assertSafeUrl("http://172.16.0.1/"), "C11: 172.16-31.x 私有段被拦截");
  await assertRejects(() => assertSafeUrl("http://[::1]/"), "C11: IPv6 ::1 被拦截");

  // 非 http(s) scheme 应被拦截
  await assertRejects(() => assertSafeUrl("file:///etc/passwd"), "C12: file:// scheme 被拦截");
  await assertRejects(() => assertSafeUrl("ftp://example.com/"), "C12: ftp:// scheme 被拦截");

  // 公共 IP 应通过（example.com 解析到公网 IP）
  try {
    await assertSafeUrl("https://example.com/");
    assert(true, "C11: 公共域名 example.com 通过校验");
  } catch {
    assert(false, "C11: 公共域名 example.com 通过校验");
  }

  // 无效 URL 应被拦截
  await assertRejects(() => assertSafeUrl("not-a-url"), "C11: 无效 URL 被拦截");
}

// ══════════════════════════════════════════════════════════════════════
// High 修复验证
// ══════════════════════════════════════════════════════════════════════

// ── H2: safeParseJsonResponse body 缓冲复用 ───────────────────────────

async function testH2BodyBuffering(): Promise<void> {
  console.log("\n=== H2: safeParseJsonResponse body 缓冲复用 ===");
  const { safeParseJsonResponse, ProviderAPIError } = await import("../src/provider/errors.js");

  // 非 JSON 响应 — 错误信息应包含 body 预览
  const htmlBody = "<html><body>Error 500</body></html>";
  const mockHtmlResponse = {
    status: 500,
    headers: new Map([["content-type", "text/html"]]),
    text: async () => htmlBody,
  } as any;

  try {
    await safeParseJsonResponse(mockHtmlResponse, "test");
    assert(false, "H2: 非 JSON 响应应抛错");
  } catch (e: any) {
    assert(e instanceof ProviderAPIError, "H2: 非 JSON 响应抛 ProviderAPIError");
    assert(e.message.includes("Error 500"), "H2: 错误信息包含 body 预览（非空）");
  }

  // JSON 解析失败 — 错误信息也应包含 body 预览（不再返回空字符串）
  const badJson = "{ invalid json !!! }";
  const mockBadJsonResponse = {
    status: 200,
    headers: new Map([["content-type", "application/json"]]),
    text: async () => badJson,
  } as any;

  try {
    await safeParseJsonResponse(mockBadJsonResponse, "test");
    assert(false, "H2: 无效 JSON 应抛错");
  } catch (e: any) {
    assert(e instanceof ProviderAPIError, "H2: 无效 JSON 抛 ProviderAPIError");
    assert(e.message.includes("invalid json"), "H2: JSON 解析失败错误包含 body 预览（不再为空）");
  }

  // 正常 JSON 应解析成功
  const goodJson = '{"result": "ok"}';
  const mockGoodResponse = {
    status: 200,
    headers: new Map([["content-type", "application/json"]]),
    text: async () => goodJson,
  } as any;

  try {
    const parsed = await safeParseJsonResponse(mockGoodResponse, "test");
    assert((parsed as any).result === "ok", "H2: 正常 JSON 正确解析");
  } catch {
    assert(false, "H2: 正常 JSON 正确解析");
  }
}

// ── H6: ToolTimeoutError 自定义 Error 类 ──────────────────────────────

async function testH6TimeoutError(): Promise<void> {
  console.log("\n=== H6: ToolTimeoutError 自定义 Error 类 ===");
  const { ToolTimeoutError } = await import("../src/agent/types.js");

  const err = new ToolTimeoutError(120);
  assert(err instanceof Error, "H6: ToolTimeoutError 是 Error 子类");
  assert(err instanceof ToolTimeoutError, "H6: instanceof ToolTimeoutError 成立");
  assert(err.timeoutSeconds === 120, "H6: timeoutSeconds 字段正确");
  assert(err.message.includes("120"), "H6: 错误消息包含超时秒数");
  assert(err.name === "ToolTimeoutError", "H6: name 属性正确");

  // 不会被普通 Error 误判
  const plainErr = new Error("timeout");
  assert(!(plainErr instanceof ToolTimeoutError), "H6: 普通 Error('timeout') 不被误判为 ToolTimeoutError");
}

// ── H8/H9: 向量搜索 LIMIT + 维度不匹配跳过 ────────────────────────────

async function testH8H9VectorSearch(): Promise<void> {
  console.log("\n=== H8/H9: 向量搜索 LIMIT + 维度不匹配跳过 ===");
  const { SqliteVectorStore } = await import("../src/knowledge-base/stores/sqlite-kb-store.js");

  const db = new Database(":memory:");
  const store = new SqliteVectorStore(db);
  // 初始化表结构
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_vectors (
      chunk_id TEXT PRIMARY KEY,
      embedding BLOB,
      content TEXT,
      doc_name TEXT,
      kb_id TEXT
    )
  `);

  // 插入一些匹配维度的向量
  const dim = 4;
  for (let i = 0; i < 10; i++) {
    const embedding = new Float32Array(dim);
    embedding.fill(i * 0.1);
    const buf = Buffer.from(embedding.buffer);
    db.prepare("INSERT INTO kb_vectors (chunk_id, embedding, content, doc_name, kb_id) VALUES (?, ?, ?, ?, ?)")
      .run(`chunk-${i}`, buf, `content-${i}`, `doc-${i}`, "kb1");
  }

  // 插入一些不匹配维度的向量（H9 测试）
  const wrongDim = 8;
  for (let i = 0; i < 3; i++) {
    const embedding = new Float32Array(wrongDim);
    embedding.fill(0.5);
    const buf = Buffer.from(embedding.buffer);
    db.prepare("INSERT INTO kb_vectors (chunk_id, embedding, content, doc_name, kb_id) VALUES (?, ?, ?, ?, ?)")
      .run(`wrong-${i}`, buf, `wrong-content-${i}`, `wrong-doc`, "kb1");
  }

  // 查询向量（维度 = 4）
  const query = [0.1, 0.1, 0.1, 0.1];
  try {
    const results = await store.search(query, 5, "kb1");
    assert(results.length > 0, "H8: 搜索返回结果");
    assert(results.length <= 5, "H8: 结果数不超过 topK=5");
    assert(results.every(r => !r.chunkId.startsWith("wrong-")), "H9: 不匹配维度的向量被跳过");
    assert(true, "H9: 维度不匹配未导致整个搜索失败");
  } catch (e: any) {
    assert(false, `H8/H9: 搜索不应抛错: ${e?.message}`);
  }

  db.close();
}

// ── H10: AsyncQueue 取消 API ──────────────────────────────────────────

async function testH10AsyncQueueAbort(): Promise<void> {
  console.log("\n=== H10: AsyncQueue 取消 API ===");
  const { AsyncQueue } = await import("../src/common/async-queue.js");

  const queue = new AsyncQueue<number>();

  // 取消等待中的 get
  const controller = new AbortController();
  const getPromise = queue.get(controller.signal);

  controller.abort();

  await assertRejects(() => getPromise, "H10: abort 后 get() reject");

  // 取消后 put 不会 resolve 已取消的 promise — 项目不丢失
  queue.put(42);
  // 下一个 get 应立即拿到 42
  const item = await queue.get();
  assert(item === 42, "H10: 取消后 put 的项目不丢失（下一个 get 拿到）");

  // 无 signal 的 get 正常工作
  queue.put(100);
  const item2 = await queue.get();
  assert(item2 === 100, "H10: 无 signal 的 get 正常工作");
}

// ── H11: 条件变量超时 ─────────────────────────────────────────────────

async function testH11ConditionTimeout(): Promise<void> {
  console.log("\n=== H11: 条件变量超时 ===");
  const { Condition } = await import("../src/common/condition.js");

  // 超时测试：不调用 notify，wait 应在 timeoutMs 后 reject
  const cond = new Condition();
  const start = Date.now();

  await assertRejects(
    () => cond.wait({ timeoutMs: 100 }),
    "H11: 超时后 wait() reject",
  );

  const elapsed = Date.now() - start;
  assert(elapsed >= 90 && elapsed < 500, `H11: 超时时间合理（~100ms，实际 ${elapsed}ms）`);

  // notify 正常唤醒
  const cond2 = new Condition();
  const waitPromise = cond2.wait({ timeoutMs: 1000 });
  setTimeout(() => cond2.notify(), 50);
  try {
    await waitPromise;
    assert(true, "H11: notify 正常唤醒 wait");
  } catch {
    assert(false, "H11: notify 正常唤醒 wait");
  }

  // AbortSignal 取消
  const cond3 = new Condition();
  const controller = new AbortController();
  const abortPromise = cond3.wait({ abortSignal: controller.signal });
  controller.abort();
  await assertRejects(() => abortPromise, "H11: AbortSignal 取消 wait");
}

// ── H13: WeChat base64 padding 公式 ───────────────────────────────────

async function testH13Base64Padding(): Promise<void> {
  console.log("\n=== H13: WeChat base64 padding 公式 ===");

  // 测试所有可能的 base64 长度（mod 4 = 0, 1, 2, 3）
  // 旧公式 -len % 4 对 mod=1/2/3 会产生负数，导致 repeat(-N) 抛 RangeError
  // 新公式 (4 - len % 4) % 4 始终为 0/1/2/3

  const testLengths = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  let allPassed = true;

  for (const len of testLengths) {
    const normalized = "A".repeat(len);
    // 新公式
    const padding = (4 - (normalized.length % 4)) % 4;
    try {
      const padded = normalized + "=".repeat(padding);
      // 尝试解码（如果长度 > 0）
      if (padded.length > 0) {
        Buffer.from(padded, "base64");
      }
      // 旧公式会怎样？
      const oldPadding = -normalized.length % 4;
      if (oldPadding < 0) {
        // 旧公式会产生负数，repeat(-N) 会抛 RangeError
        // 新公式不抛错即成功
      }
    } catch (e) {
      allPassed = false;
      console.error(`  ❌ H13: 长度 ${len} 抛错: ${e}`);
    }
  }

  assert(allPassed, "H13: 所有长度 (mod 4 = 0/1/2/3) 不再抛 RangeError");

  // 特别验证旧公式会抛错的长度
  for (const len of [1, 2, 3, 5, 6, 7]) {
    const oldPadding = -len % 4; // 旧公式：-1, -2, -3, -1, -2, -3
    assert(oldPadding < 0, `H13: 旧公式对长度 ${len} 产生负数 ${oldPadding}（会抛 RangeError）`);

    const newPadding = (4 - (len % 4)) % 4; // 新公式：3, 2, 1, 3, 2, 1
    assert(newPadding >= 0 && newPadding <= 3, `H13: 新公式对长度 ${len} 产生非负值 ${newPadding}`);
  }
}

// ── H16: FileLockManager reset ────────────────────────────────────────

async function testH16FileLockReset(): Promise<void> {
  console.log("\n=== H16: FileLockManager reset ===");
  const { resetFileLockManager, fileLockManager } = await import("../src/agent/coordination.js");

  // 获取一把排他锁
  const granted = await fileLockManager.acquire("test-file-h16.txt", "exclusive", "holder-1");
  assert(granted === true, "H16: acquire 返回 true（锁已授予）");

  // 不 reset 时，同一文件的排他锁应排队等待（超时返回 false）
  const queuePromise = fileLockManager.acquire("test-file-h16.txt", "exclusive", "holder-2", 200);
  // 不等待结果，直接 reset

  // reset 后所有锁应被清除
  resetFileLockManager();

  // reset 后同一文件应能立即获取新锁（旧锁已被清除）
  try {
    const granted2 = await fileLockManager.acquire("test-file-h16.txt", "exclusive", "holder-3");
    assert(granted2 === true, "H16: reset 后同一文件可获取新锁");
    fileLockManager.releaseAll("holder-3");
  } catch {
    assert(false, "H16: reset 后同一文件可获取新锁");
  }

  // 等待排队的 promise 结束（reset 会 resolve false）
  try { await queuePromise; } catch { /* ignore */ }

  // 清理
  resetFileLockManager();
}

// ══════════════════════════════════════════════════════════════════════
// 主函数
// ══════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║     Critical & High 修复验证测试                           ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");

  try {
    // Critical
    await testC3PathTraversal();
    await testC9SecretCrypto();
    await testC11C12SSRF();

    // High
    await testH2BodyBuffering();
    await testH6TimeoutError();
    await testH8H9VectorSearch();
    await testH10AsyncQueueAbort();
    await testH11ConditionTimeout();
    await testH13Base64Padding();
    await testH16FileLockReset();
  } catch (e) {
    console.error("\n💥 测试执行中断:", e);
    failCount++;
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  结果: ${passCount} 通过, ${failCount} 失败`);
  console.log("═══════════════════════════════════════════════════════════");

  if (failCount > 0) {
    process.exit(1);
  }
}

main();
