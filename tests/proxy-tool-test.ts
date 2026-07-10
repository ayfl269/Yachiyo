/**
 * ProxyManager 和 proxy_manage 工具测试
 *
 * 测试内容：
 * 1. ProxyManager 基本状态管理（getStatus, enable, disable）
 * 2. URL 规范化（无 scheme 时补 http://）
 * 3. 代理变更监听器（onChange 注册和触发）
 * 4. proxy_manage 工具属性
 * 5. 工具 action=get 获取状态
 * 6. 工具 action=set 设置代理
 * 7. 工具 action=disable 禁用代理
 * 8. 工具 action=test 测试连通性
 * 9. 工具无效 action 返回错误
 * 10. 工具 set 缺少 url 参数返回错误
 * 11. 工具 set 无效 url 返回错误
 * 12. FunctionToolExecutor 集成调用
 */
import {
  proxyManager,
  createProxyTool,
  type ProxyToolContext,
} from "@yachiyo/agent/index.js";
import { FunctionToolExecutor } from "@yachiyo/agent/tool-executor.js";
import type { ContextWrapper, CallToolResult } from "@yachiyo/agent/types.js";

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
    const detail = `${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
    failures.push(detail);
    console.error(`  FAIL: ${detail}`);
  }
}

function createWrapper(ctx: ProxyToolContext): ContextWrapper<ProxyToolContext> {
  return {
    context: ctx,
    messages: [],
    toolCallTimeout: 60,
  };
}

function resultText(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// ── Tests ──

async function testProxyManagerBasicState(): Promise<void> {
  console.log("\n── Test: ProxyManager 基本状态管理 ──");

  // 先禁用确保干净状态
  await proxyManager.disable();
  assert(!proxyManager.enabled, "初始状态禁用");
  assertEqual(proxyManager.url, null, "url 为 null");

  // 启用代理
  await proxyManager.enable("http://127.0.0.1:7890");
  assert(proxyManager.enabled, "启用后状态为启用");
  assertEqual(proxyManager.url, "http://127.0.0.1:7890", "url 正确设置");

  const status = proxyManager.getStatus();
  assertEqual(status.enabled, true, "getStatus enabled = true");
  assertEqual(status.url, "http://127.0.0.1:7890", "getStatus url 正确");
  assertEqual(status.source, "runtime", "getStatus source = runtime");

  // 禁用代理
  await proxyManager.disable();
  assert(!proxyManager.enabled, "禁用后状态为禁用");
  assertEqual(proxyManager.url, null, "url 恢复为 null");
}

async function testUrlNormalization(): Promise<void> {
  console.log("\n── Test: URL 规范化 ──");

  // 无 scheme 时自动补 http://
  await proxyManager.setProxy("127.0.0.1:8080");
  assertEqual(proxyManager.url, "http://127.0.0.1:8080", "无 scheme 时补 http://");

  // socks5 scheme 保留
  await proxyManager.setProxy("socks5://127.0.0.1:1080");
  assertEqual(proxyManager.url, "socks5://127.0.0.1:1080", "socks5 scheme 保留");

  // https scheme 保留
  await proxyManager.setProxy("https://proxy.example.com:443");
  assertEqual(proxyManager.url, "https://proxy.example.com:443", "https scheme 保留");

  // 空字符串等价于禁用
  await proxyManager.setProxy("");
  assertEqual(proxyManager.url, null, "空字符串等价于禁用");

  // null 显式禁用
  await proxyManager.setProxy(null);
  assertEqual(proxyManager.url, null, "null 显式禁用");
}

async function testChangeListener(): Promise<void> {
  console.log("\n── Test: 代理变更监听器 ──");

  let callCount = 0;
  let receivedUrl: string | null = "initial";

  const unsubscribe = proxyManager.onChange((url) => {
    callCount++;
    receivedUrl = url;
  });

  // 设置代理 — 应触发监听器
  await proxyManager.setProxy("http://test-proxy:9999", "runtime");
  assertEqual(callCount, 1, "设置代理时触发监听器");
  assertEqual(receivedUrl, "http://test-proxy:9999", "监听器收到新 URL");

  // 禁用代理 — 应再次触发
  await proxyManager.disable();
  assertEqual(callCount, 2, "禁用代理时触发监听器");
  assertEqual(receivedUrl, null, "监听器收到 null");

  // 设置相同 URL — 不应触发（去重）
  await proxyManager.setProxy(null);
  assertEqual(callCount, 2, "设置相同值不触发监听器");

  // 取消订阅后再变更 — 不应触发
  unsubscribe();
  await proxyManager.setProxy("http://another:1234");
  assertEqual(callCount, 2, "取消订阅后不再触发");

  // 清理
  await proxyManager.disable();
}

async function testToolProperties(): Promise<void> {
  console.log("\n── Test: proxy_manage 工具属性 ──");
  const tool = createProxyTool();

  assertEqual(tool.name, "proxy_manage", "工具名称为 proxy_manage");
  assert(tool.description.length > 0, "工具描述非空");
  assert(tool.active === true, "工具默认启用");
  assert(typeof tool.handler === "function", "handler 已定义");

  const params = tool.parameters as Record<string, unknown>;
  const props = params.properties as Record<string, unknown>;
  assert("action" in props, "包含 action 参数");
  assert("url" in props, "包含 url 参数");
  assert("test_url" in props, "包含 test_url 参数");
  assert("timeout" in props, "包含 timeout 参数");
  assertEqual(params.required, ["action"], "required = [action]");
}

async function testToolActionGet(): Promise<void> {
  console.log("\n── Test: 工具 action=get ──");
  const tool = createProxyTool();
  const wrapper = createWrapper({});

  await proxyManager.disable();
  const result = (await tool.handler!(wrapper, "get")) as CallToolResult;

  assert(!result.isError, "不是错误结果");
  const text = resultText(result);
  assert(text.includes("Enabled: no"), "显示禁用状态");
  assert(text.includes("direct connection"), "显示直连");

  // 启用后再查询
  await proxyManager.enable("http://test:7777");
  const result2 = (await tool.handler!(wrapper, "get")) as CallToolResult;
  const text2 = resultText(result2);
  assert(text2.includes("Enabled: yes"), "显示启用状态");
  assert(text2.includes("http://test:7777"), "显示代理 URL");

  await proxyManager.disable();
}

async function testToolActionSet(): Promise<void> {
  console.log("\n── Test: 工具 action=set ──");
  const tool = createProxyTool();
  const wrapper = createWrapper({});

  await proxyManager.disable();
  const result = (await tool.handler!(wrapper, "set", "http://set-test:3128")) as CallToolResult;

  assert(!result.isError, "不是错误结果");
  assert(proxyManager.enabled, "代理已启用");
  assertEqual(proxyManager.url, "http://set-test:3128", "URL 正确设置");

  const text = resultText(result);
  assert(text.includes("Proxy enabled successfully"), "返回成功消息");
  assert(text.includes("browser"), "提示浏览器已关闭");

  await proxyManager.disable();
}

async function testToolActionDisable(): Promise<void> {
  console.log("\n── Test: 工具 action=disable ──");
  const tool = createProxyTool();
  const wrapper = createWrapper({});

  // 先启用
  await proxyManager.enable("http://to-disable:5555");
  assert(proxyManager.enabled, "预先启用代理");

  const result = (await tool.handler!(wrapper, "disable")) as CallToolResult;

  assert(!result.isError, "不是错误结果");
  assert(!proxyManager.enabled, "代理已禁用");
  const text = resultText(result);
  assert(text.includes("Proxy disabled"), "返回禁用消息");

  // 再次禁用（已经是禁用状态）
  const result2 = (await tool.handler!(wrapper, "disable")) as CallToolResult;
  const text2 = resultText(result2);
  assert(text2.includes("already disabled"), "已禁用时提示无需变更");
}

async function testToolActionTest(): Promise<void> {
  console.log("\n── Test: 工具 action=test ──");
  const tool = createProxyTool();
  const wrapper = createWrapper({});

  await proxyManager.disable();
  // 使用 RFC 5737 TEST-NET-1 不可路由 IP 确保连接失败，短超时避免长时间等待
  // 通过 executor 调用以传入 timeout 参数
  const executor = new FunctionToolExecutor<ProxyToolContext>();
  const results: CallToolResult[] = [];
  for await (const r of executor.execute(tool, wrapper, {
    action: "test",
    test_url: "http://192.0.2.1/nope",
    timeout: 2,
  })) {
    if (r) results.push(r);
  }

  assertEqual(results.length, 1, "返回 1 个结果");
  // 连接不可路由 IP 必定失败
  assertEqual(results[0].isError, true, "连接不可路由 IP 返回 isError");
  const text = resultText(results[0]);
  assert(text.includes("FAILED"), "包含 FAILED 标记");
  assert(text.includes("Error:"), "包含错误信息");
}

async function testToolInvalidAction(): Promise<void> {
  console.log("\n── Test: 工具无效 action ──");
  const tool = createProxyTool();
  const wrapper = createWrapper({});

  const result = (await tool.handler!(wrapper, "invalid_action")) as CallToolResult;

  assertEqual(result.isError, true, "无效 action 返回 isError");
  const text = resultText(result);
  assert(text.includes("Unknown action"), "包含 Unknown action 提示");
  assert(text.includes("get, set, disable, test"), "列出支持的 action");
}

async function testToolSetMissingUrl(): Promise<void> {
  console.log("\n── Test: 工具 set 缺少 url ──");
  const tool = createProxyTool();
  const wrapper = createWrapper({});

  const result = (await tool.handler!(wrapper, "set")) as CallToolResult;

  assertEqual(result.isError, true, "缺少 url 返回 isError");
  const text = resultText(result);
  assert(text.includes("required"), "包含 required 提示");
}

async function testToolSetInvalidUrl(): Promise<void> {
  console.log("\n── Test: 工具 set 无效 url ──");
  const tool = createProxyTool();
  const wrapper = createWrapper({});

  const result = (await tool.handler!(wrapper, "set", "not a valid url !!!")) as CallToolResult;

  assertEqual(result.isError, true, "无效 url 返回 isError");
  const text = resultText(result);
  assert(text.includes("Invalid proxy URL"), "包含 Invalid proxy URL 提示");
}

async function testExecutorIntegration(): Promise<void> {
  console.log("\n── Test: FunctionToolExecutor 集成 ──");
  const tool = createProxyTool();
  const wrapper = createWrapper({});

  const executor = new FunctionToolExecutor<ProxyToolContext>();

  // 测试 get action
  const results: CallToolResult[] = [];
  for await (const r of executor.execute(tool, wrapper, { action: "get" })) {
    if (r) results.push(r);
  }

  assertEqual(results.length, 1, "executor 产生 1 个结果");
  const text = resultText(results[0]);
  assert(text.includes("proxy status") || text.includes("Enabled:"), "返回状态信息");
  assert(!results[0].isError, "不是错误结果");
}

// ── Main ──

async function main(): Promise<void> {
  console.log("═══ ProxyManager / proxy_manage 工具测试 ═══");

  try {
    await testProxyManagerBasicState();
    await testUrlNormalization();
    await testChangeListener();
    await testToolProperties();
    await testToolActionGet();
    await testToolActionSet();
    await testToolActionDisable();
    await testToolActionTest();
    await testToolInvalidAction();
    await testToolSetMissingUrl();
    await testToolSetInvalidUrl();
    await testExecutorIntegration();
  } catch (e) {
    console.error("\n═══ UNEXPECTED ERROR ═══");
    console.error(e);
    failed++;
    failures.push(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // 清理：确保测试后代理被禁用
    await proxyManager.disable();
  }

  console.log("\n═══════════════════════════════════");
  console.log(`通过: ${passed}  失败: ${failed}  总计: ${passed + failed}`);
  if (failures.length > 0) {
    console.log("\n失败详情:");
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
  }
  console.log(failed === 0 ? "\n✅ 所有代理管理测试通过!" : "\n❌ 存在失败的测试");
  process.exit(failed === 0 ? 0 : 1);
}

main();
