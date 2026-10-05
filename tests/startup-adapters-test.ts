import assert from "node:assert/strict";
import { getStartupAdapterConfigs } from "../src/startup-adapters.js";
import { validateAdapterConfig } from "@yachiyo/platform/config.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import { createServer } from "node:net";
import WebSocket from "ws";
import { SqliteSchedulerTaskStore } from "@yachiyo/agent/scheduler-task-store.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

const [adapter] = getStartupAdapterConfigs({ onebot11: {
  port: 18080, host: "192.0.2.1", accessToken: "test-token",
} });
assert.equal(validateAdapterConfig(adapter).type, "onebot11");
assert.equal(adapter.id, "onebot11");
assert.equal(adapter.direction, "forward");
assert.equal(adapter.port, 18080);
assert.equal(adapter.host, "192.0.2.1");
assert.equal(adapter.accessToken, "test-token");
assert.equal(getStartupAdapterConfigs({ onebot11: {} })[0].host, "127.0.0.1");
assert.deepEqual(getStartupAdapterConfigs({}), []);
assert.deepEqual(getStartupAdapterConfigs({ adapters: [], onebot11: {} }), []);
const explicit = [{ type: "onebot11", id: "custom", direction: "reverse", reverseUrl: "ws://localhost:6700" }];
assert.equal(getStartupAdapterConfigs({ adapters: explicit, onebot11: {} }), explicit);
const savedConfig = [{ type: "onebot11", id: "stored", port: 10000, host: "127.0.0.1", accessToken: "old" }];
assert.equal(getStartupAdapterConfigs({ onebot11: {} }, savedConfig)[0].accessToken, "old");
const overridden = getStartupAdapterConfigs({ onebot11: { host: "192.0.2.2", port: 10001, accessToken: "new" } }, savedConfig)[0];
assert.equal(overridden.host, "192.0.2.2");
assert.equal(overridden.port, 10001);
assert.equal(overridden.accessToken, "new");

// Exercise the actual bootstrap branch against fresh temporary databases.
// Port zero binds an ephemeral loopback port and avoids fixed-port conflicts.
const tempRoot = await mkdtemp(join(tmpdir(), "yachiyo-startup-test-"));
try {
  const options = {
    dataDir: join(tempRoot, "data"), workspaceDir: tempRoot,
    dashboard: { enabled: false },
    onebot11: { id: "startup-bot", port: 0, host: "127.0.0.1", accessToken: "test-token" },
  };
  const first = await bootstrap(options);
  try {
    assert.equal(first.adapterRegistry.getAdapter("startup-bot")?.isRunning, true);
    const saved = first.adapterStore?.loadAll();
    assert.equal(saved?.length, 1);
    assert.equal(saved?.[0].port, 0);
    assert.equal(saved?.[0].host, "127.0.0.1");
    assert.equal(saved?.[0].accessToken, "test-token");
  } finally {
    await first.shutdown();
  }
  const restored = await bootstrap({ ...options, onebot11: { id: "replacement-bot", port: 0 } });
  try {
    assert.equal(restored.adapterRegistry.getAdapter("startup-bot")?.isRunning, true);
    assert.equal(restored.adapterRegistry.getAdapter("replacement-bot"), undefined);
  } finally {
    await restored.shutdown();
  }

  const port = await freePort();
  const updated = await bootstrap({ ...options, onebot11: { port, host: "127.0.0.1", accessToken: "rotated-token" } });
  try {
    const wrong = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, {
      headers: { Authorization: "Bearer test-token" }, handshakeTimeout: 1000,
    });
    const rejectedCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { wrong.terminate(); reject(new Error("Old token was not rejected")); }, 2000);
      wrong.once("close", (code) => { clearTimeout(timer); resolve(code); });
      wrong.once("error", reject);
    });
    assert.equal(rejectedCode, 4001);
    const valid = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, {
      headers: { Authorization: "Bearer rotated-token" }, handshakeTimeout: 1000,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { valid.terminate(); reject(new Error("New token was not accepted")); }, 2000);
      valid.once("open", () => valid.ping());
      valid.once("pong", () => { clearTimeout(timer); resolve(); });
      valid.once("error", reject);
    });
    valid.close();
    await new Promise<void>((resolve) => valid.once("close", () => resolve()));
  } finally {
    await updated.shutdown();
  }

  // Scheduler HTTP routes are global admin operations, protected by login.
  // Their trigger endpoint must use delivery, rather than forging completion.
  const oldPassword = process.env.DASHBOARD_DEFAULT_PASSWORD;
  const oldUsername = process.env.DASHBOARD_DEFAULT_USER;
  process.env.DASHBOARD_DEFAULT_PASSWORD = "temporary-test-password";
  process.env.DASHBOARD_DEFAULT_USER = "testadmin";
  try {
    const dashboardPort = await freePort();
    const runtime = await bootstrap({ ...options, dashboard: { enabled: true, port: dashboardPort, host: "127.0.0.1" } });
    try {
      const base = `http://127.0.0.1:${dashboardPort}`;
      assert.equal((await fetch(`${base}/api/scheduler/tasks`)).status, 401);
      const login = await fetch(`${base}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "testadmin", password: "temporary-test-password" }),
      });
      assert.equal(login.status, 200);
      const initial = await login.json() as { token: string };
      const changed = await fetch(`${base}/api/auth/change-credentials`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${initial.token}` },
        body: JSON.stringify({ newUsername: "testadmin", newPassword: "rotated-test-password", confirmPassword: "rotated-test-password" }),
      });
      assert.equal(changed.status, 200);
      const auth = await changed.json() as { token: string };
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` };
      const create = await fetch(`${base}/api/scheduler/tasks`, {
        method: "POST", headers,
        body: JSON.stringify({ id: "http-task", title: "HTTP delivery", scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
          umo: "startup-bot:private:1", session_id: "private_1", platform_id: "startup-bot" }),
      });
      assert.equal(create.status, 201);
      let deliveries = 0;
      const bot = runtime.adapterRegistry.getAdapter("startup-bot")!;
      bot.sendProactiveMessage = async () => { deliveries++; return true; };
      const store = new SqliteSchedulerTaskStore(runtime.dbManager.getDb("scheduler"));
      store.save({ ...store.get("http-task")!, id: "http-edit", nextFireAt: new Date(Date.now() - 1000).toISOString() });
      const editingTask = store.get("http-edit")!;
      assert(store.markNotifying(editingTask.id, editingTask.occurrenceId));
      const edited = await fetch(`${base}/api/scheduler/tasks/http-edit`, {
        method: "PATCH", headers, body: JSON.stringify({ title: "Edited title", description: "Edited description", tags: ["edited"],
          status: "notifying", scheduled_at: editingTask.scheduledAt, recurrence: editingTask.recurrence }),
      });
      assert.equal(edited.status, 200);
      assert.equal(store.get(editingTask.id)?.occurrenceId, editingTask.occurrenceId);
      assert.equal(store.get(editingTask.id)?.title, "Edited title");
      assert.equal(store.get(editingTask.id)?.status, "notifying");
      assert(store.markFired(editingTask.id, new Date(), editingTask.occurrenceId));
      await runtime.taskScheduler.tick();
      assert.equal(deliveries, 0, "Metadata edits must not cause fallback redelivery after the model responds");
      const fired = await fetch(`${base}/api/scheduler/tasks/http-task/fire`, { method: "POST", headers });
      assert.equal(fired.status, 200);
      const result = await fired.json() as { task: { status: string }; queued: boolean };
      assert.equal(result.task.status, "completed");
      assert.equal(deliveries, 1);
      assert.equal(result.queued, false);
      assert.equal((await fetch(`${base}/api/scheduler/tasks/http-task/fire`, { method: "POST", headers })).status, 409);
      assert.equal(deliveries, 1);
      // Unowned dashboard tasks stay manageable by admins but cannot be sent without a route.
      assert.equal((await fetch(`${base}/api/scheduler/tasks`, { method: "POST", headers,
        body: JSON.stringify({ id: "http-unowned", title: "Unowned", scheduled_at: new Date().toISOString() }) })).status, 201);
      assert.equal((await fetch(`${base}/api/scheduler/tasks/http-unowned`, { headers })).status, 200);
      assert.equal((await fetch(`${base}/api/scheduler/tasks/http-unowned/fire`, { method: "POST", headers })).status, 409);
      const unowned = await (await fetch(`${base}/api/scheduler/tasks/http-unowned`, { headers })).json() as { task: { status: string; lastFiredAt: string | null } };
      assert.equal(unowned.task.status, "pending");
      assert.equal(unowned.task.lastFiredAt, null);
    } finally {
      await runtime.shutdown();
    }
  } finally {
    if (oldPassword === undefined) delete process.env.DASHBOARD_DEFAULT_PASSWORD;
    else process.env.DASHBOARD_DEFAULT_PASSWORD = oldPassword;
    if (oldUsername === undefined) delete process.env.DASHBOARD_DEFAULT_USER;
    else process.env.DASHBOARD_DEFAULT_USER = oldUsername;
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
console.log("Startup adapter configuration and bootstrap tests passed.");
