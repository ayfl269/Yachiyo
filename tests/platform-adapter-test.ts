import { OneBot11Adapter } from "@yachiyo/platform/implementations/onebot11-adapter.js";
import { AdapterRegistry, registerBuiltinAdapterFactories } from "@yachiyo/platform/registry.js";
import { PlatformAdapter, type AdapterStatus } from "@yachiyo/platform/adapter.js";
import { AsyncQueue } from "@yachiyo/common/async-queue.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import type { OneBot11AdapterConfig } from "@yachiyo/platform/config.js";
import { validateAdapterConfig } from "@yachiyo/platform/config.js";
import { EventResult } from "@yachiyo/message/event-result.js";
import { ComponentType } from "@yachiyo/message/components.js";
import { WebSocket } from "ws";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  OK ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failed++;
  }
  passed += condition ? 1 : 0;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  const resp = await fetch(url);
  const body = await resp.text();
  return { status: resp.status, body };
}

async function httpPost(url: string, body: any): Promise<{ status: number; body: string }> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  return { status: resp.status, body: text };
}

async function main() {

// ============================================================
console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║          消息平台适配器集成测试                          ║");
console.log("╚══════════════════════════════════════════════════════════╝");

// === 测试 1: AdapterConfig 验证 ===
console.log("\n=== 测试: AdapterConfig 验证 ===");
{
  const valid = validateAdapterConfig({ type: "onebot11", id: "test" });
  assert(valid.type === "onebot11", "validateAdapterConfig type");
  assert(valid.id === "test", "validateAdapterConfig id");

  let threw = false;
  try { validateAdapterConfig(null); } catch { threw = true; }
  assert(threw, "validateAdapterConfig rejects null");

  threw = false;
  try { validateAdapterConfig({}); } catch { threw = true; }
  assert(threw, "validateAdapterConfig rejects empty object");
}
console.log("✓ AdapterConfig 验证测试通过");

// === 测试 2: AdapterRegistry ===
console.log("\n=== 测试: AdapterRegistry ===");
{
  const registry = new AdapterRegistry();
  const eventQueue = new AsyncQueue<MessageEvent>();

  let factoryCalled = false;
  registry.registerFactory("test_type", (config, eq) => {
    factoryCalled = true;
    return new (class extends PlatformAdapter {
      async run() { this._status = "running"; }
      meta() { return { name: "test", description: "", id: config.id as string, supportStreamingMessage: false, supportProactiveMessage: false }; }
    })(config, eq);
  });

  const adapter = registry.createAdapter("test_type", { type: "test_type", id: "test-1" }, eventQueue);
  assert(factoryCalled, "AdapterFactory called");
  assert(adapter.meta().id === "test-1", "created adapter id");
  assert(registry.getAdapter("test-1") === adapter, "getAdapter returns same instance");
  assert(registry.getAllAdapters().length === 1, "getAllAdapters count");

  let unknownThrew = false;
  try { registry.createAdapter("unknown", {}, eventQueue); } catch { unknownThrew = true; }
  assert(unknownThrew, "unknown type throws");

  const removed = await registry.removeAdapter("test-1");
  assert(removed, "removeAdapter returns true");
  assert(registry.getAllAdapters().length === 0, "adapter removed");
}
console.log("✓ AdapterRegistry 测试通过");

// === 测试 3: PlatformAdapter 生命周期 ===
console.log("\n=== 测试: PlatformAdapter 生命周期 ===");
{
  const eventQueue = new AsyncQueue<MessageEvent>();
  const adapter = new (class extends PlatformAdapter {
    async run() { this._status = "running"; }
    meta() { return { name: "lifecycle", description: "", id: "lifecycle-test", supportStreamingMessage: false, supportProactiveMessage: false }; }
  })({}, eventQueue);

  assert(adapter.status === "idle", "initial status is idle");
  assert(!adapter.isRunning, "not running initially");

  await adapter.initialize();
  assert(adapter.status === "initialized", "status after initialize");

  await adapter.run();
  assert(adapter.isRunning, "is running after run");
  assert(adapter.status === "running", "status is running");

  const health = await adapter.healthCheck();
  assert(health === null, "healthCheck returns null when running");

  await adapter.stop();
  assert(adapter.status === "stopped", "status after stop");
}
console.log("✓ PlatformAdapter 生命周期测试通过");

// === 测试 4: OneBot11Adapter 正向WS ===
console.log("\n=== 测试: OneBot11Adapter 正向WS ===");
{
  const eventQueue = new AsyncQueue<MessageEvent>();
  const config: OneBot11AdapterConfig = {
    type: "onebot11",
    id: "ob11-forward-test",
    direction: "forward",
    port: 18080,
    host: "127.0.0.1",
    path: "/onebot/v11/ws",
  };

  const adapter = new OneBot11Adapter(config, eventQueue);
  await adapter.initialize();
  assert(adapter.status === "initialized", "OneBot11Adapter initialized");

  const runPromise = adapter.run();
  await sleep(200);
  assert(adapter.isRunning, "OneBot11Adapter is running");

  const health = await adapter.healthCheck();
  assert(health === null, "OneBot11Adapter healthy");

  await adapter.stop();
  assert(adapter.status === "stopped", "OneBot11Adapter stopped");
}
console.log("✓ OneBot11Adapter 正向WS 测试通过");

// === 测试 5: AdapterRegistry 内置工厂 ===
console.log("\n=== 测试: AdapterRegistry 内置工厂 ===");
{
  const registry = new AdapterRegistry();
  registerBuiltinAdapterFactories(registry);

  const eventQueue = new AsyncQueue<MessageEvent>();
  const adapter = registry.createAdapter("onebot11", {
    type: "onebot11",
    id: "factory-test",
    direction: "forward",
    port: 18082,
    host: "127.0.0.1",
    path: "/onebot/v11/ws",
  }, eventQueue);

  assert(adapter.meta().name === "onebot11", "factory created onebot11 adapter");
  assert(adapter.meta().id === "factory-test", "factory adapter id");

  await adapter.initialize();
  assert(adapter.status === "initialized", "factory adapter initialized");

  const runPromise = adapter.run();
  await sleep(200);
  assert(adapter.isRunning, "factory adapter running");

  const health = await adapter.healthCheck();
  assert(health === null, "factory adapter healthy");

  await adapter.stop();
}
console.log("✓ AdapterRegistry 内置工厂测试通过");

// === 测试 6: OneBot11 图片发送 ===
console.log("\n=== 测试: OneBot11 图片发送 ===");
{
  const eventQueue = new AsyncQueue<MessageEvent>();
  const config: OneBot11AdapterConfig = {
    type: "onebot11",
    id: "ob11-img-test",
    direction: "forward",
    port: 18083,
    host: "127.0.0.1",
    path: "/onebot/v11/ws",
  };

  const adapter = new OneBot11Adapter(config, eventQueue);
  await adapter.initialize();
  await adapter.run();

  // 连接 WS 客户端（模拟 OneBot 实现）
  const ws = new WebSocket("ws://127.0.0.1:18083/onebot/v11/ws");
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  assert(ws.readyState === WebSocket.OPEN, "WS client connected");

  // 发送群消息事件（array 格式）
  const msgEvent = {
    time: Math.floor(Date.now() / 1000),
    self_id: 12345,
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: 1,
    user_id: 99999,
    group_id: 88888,
    message: [
      { type: "text", data: { text: "发张图" } },
    ],
    raw_message: "发张图",
    font: 0,
    sender: { user_id: 99999, nickname: "test", role: "member" },
  };
  ws.send(JSON.stringify(msgEvent));

  // 从队列取出事件（适配器已处理并 commitEvent）
  const event = await Promise.race([
    eventQueue.get() as Promise<any>,
    new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout waiting for event")), 3000)),
  ]);
  assert(event !== null, "received event from queue");
  assert(event.messageObj.sessionId === "group_88888", "session id is group_88888");

  // 设置包含文字和图片的结果
  const result = new EventResult()
    .plain("这是回复文字")
    .image("https://example.com/test.png");
  event.setResult(result);

  // 准备捕获 WS 响应
  const responsePromise = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timeout waiting for WS response")), 3000);
    ws.on("message", (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.action === "send_group_msg") {
        clearTimeout(timeout);
        resolve(parsed);
      }
    });
  });

  // 触发发送
  await event.send(result.components);

  // 捕获并验证响应
  const response = await responsePromise;
  assert(response.action === "send_group_msg", "action is send_group_msg");
  assert(response.params.group_id === 88888, "group_id is correct");
  assert(Array.isArray(response.params.message), "message is array format");

  const segments = response.params.message;
  assert(segments.length === 2, "message has 2 segments");

  const textSeg = segments.find((s: any) => s.type === "text");
  assert(!!textSeg, "has text segment");
  assert(textSeg.data.text === "这是回复文字", "text content correct");

  const imgSeg = segments.find((s: any) => s.type === "image");
  assert(!!imgSeg, "has image segment");
  assert(imgSeg.data.url === "https://example.com/test.png", "image url correct");
  assert(imgSeg.data.file === "https://example.com/test.png", "image file correct");

  ws.close();
  await adapter.stop();
}
console.log("✓ OneBot11 图片发送测试通过");

// === 测试 7: OneBot11 多类型消息发送 ===
console.log("\n=== 测试: OneBot11 多类型消息发送 ===");
{
  const eventQueue = new AsyncQueue<MessageEvent>();
  const config: OneBot11AdapterConfig = {
    type: "onebot11",
    id: "ob11-multi-test",
    direction: "forward",
    port: 18084,
    host: "127.0.0.1",
    path: "/onebot/v11/ws",
  };

  const adapter = new OneBot11Adapter(config, eventQueue);
  await adapter.initialize();
  await adapter.run();

  const ws = new WebSocket("ws://127.0.0.1:18084/onebot/v11/ws");
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });

  // 发送私聊消息
  const msgEvent = {
    time: Math.floor(Date.now() / 1000),
    self_id: 12345,
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: 2,
    user_id: 77777,
    message: [{ type: "text", data: { text: "hello" } }],
    raw_message: "hello",
    font: 0,
    sender: { user_id: 77777, nickname: "priv" },
  };
  ws.send(JSON.stringify(msgEvent));

  const event = await Promise.race([
    eventQueue.get() as Promise<any>,
    new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
  ]);
  assert(event !== null, "received private event");
  assert(event.messageObj.sessionId === "private_77777", "session id is private_77777");

  // 设置纯文字结果
  const result = new EventResult().plain("纯文字回复");
  event.setResult(result);

  const responsePromise = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timeout")), 3000);
    ws.on("message", (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.action === "send_private_msg") {
        clearTimeout(timeout);
        resolve(parsed);
      }
    });
  });

  await event.send(result.components);

  const response = await responsePromise;
  assert(response.action === "send_private_msg", "action is send_private_msg");
  assert(response.params.user_id === 77777, "user_id correct");
  assert(Array.isArray(response.params.message), "message is array");
  assert(response.params.message[0].type === "text", "text segment type");
  assert(response.params.message[0].data.text === "纯文字回复", "text content");

  ws.close();
  await adapter.stop();
}
console.log("✓ OneBot11 多类型消息发送测试通过");

// ============================================================
console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log(`║  ${failed === 0 ? "🎉" : "⚠️ "}  消息平台适配器测试 ${failed === 0 ? "全部通过" : `有 ${failed} 个失败`}!              ║`);
console.log("╚══════════════════════════════════════════════════════════╝");

} // end main()

main().catch((e) => {
  console.error("Test error:", e);
  process.exit(1);
});
