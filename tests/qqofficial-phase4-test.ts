/**
 * Unit tests for QQ Official Bot adapter Phase 4 APIs.
 *
 * Tests:
 * - Gateway API: getGateway, getGatewayBot
 * - User API: getBotSelfInfo
 * - Channel Message: listChannelMessages, getChannelMessage, patchChannelMessage
 * - Role CRUD: createGuildRole, updateGuildRole, deleteGuildRole
 * - Pins: addPinMessage, deletePinMessage, listPinMessages
 * - Speak Settings: getSpeakPrivilegeSettings, updateSpeakPrivilegeSettings, getMessageSetting
 * - Forum: listThreads, getThread, publishThread, deleteThread, listThreadComments
 * - Audio: controlAudio, playAudio/pauseAudio/resumeAudio/stopAudio, onMic, offMic
 *
 * Strategy: Mock global fetch to capture requests and return controlled responses.
 */

import { QQOfficialAdapter } from "@yachiyo/platform/implementations/qqofficial-adapter.js";
import type { QQOfficialAdapterConfig } from "@yachiyo/platform/implementations/qqofficial-adapter.js";
import { AsyncQueue } from "@yachiyo/common/async-queue.js";
import { MessageEvent } from "@yachiyo/message/event.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  \u2714 ${message}`);
  } else {
    failed++;
    console.error(`  \u2718 ${message}`);
  }
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

class FetchMock {
  private calls: FetchCall[] = [];
  private responseMap = new Map<string, (call: FetchCall) => { status: number; body: unknown }>();

  install(): void {
    this.calls = [];
    const originalFetch = globalThis.fetch;
    (globalThis.fetch as unknown) = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      let body: unknown = undefined;
      if (init?.body) {
        try { body = JSON.parse(init.body as string); } catch { body = init.body; }
      }
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers as Record<string, string>;
        for (const k of Object.keys(h)) headers[k] = h[k];
      }
      const call: FetchCall = { url, method, body, headers };
      this.calls.push(call);

      let result = { status: 200, body: {} as unknown };
      for (const [pattern, handler] of this.responseMap) {
        if (url.includes(pattern)) {
          result = handler(call);
          break;
        }
      }

      const responseHeaders = new Headers({ "Content-Type": "application/json" });
      const responseBody = result.status === 204 ? null : JSON.stringify(result.body);
      return new Response(responseBody, {
        status: result.status,
        headers: responseHeaders,
      });
    };
    (this as unknown as { _original: typeof fetch })._original = originalFetch;
  }

  restore(): void {
    const original = (this as unknown as { _original?: typeof fetch })._original;
    if (original) (globalThis.fetch as unknown) = original;
  }

  route(pattern: string, handler: (call: FetchCall) => { status: number; body: unknown }): void {
    this.responseMap.set(pattern, handler);
  }

  getLastCall(): FetchCall | undefined {
    return this.calls.at(-1);
  }
}

async function createAdapter(): Promise<{ adapter: QQOfficialAdapter; fetchMock: FetchMock }> {
  const config: QQOfficialAdapterConfig = {
    type: "qqofficial",
    id: "test-qq-official-p4",
    appId: "test-app-id",
    appSecret: "test-secret",
  };
  const eventQueue = new AsyncQueue<MessageEvent>();
  const adapter = new QQOfficialAdapter(config, eventQueue);
  await adapter.initialize();

  const fetchMock = new FetchMock();
  fetchMock.install();
  fetchMock.route("getAppAccessToken", () => ({
    status: 200,
    body: { access_token: "mock-token-xyz", expires_in: 7200 },
  }));

  const adapterWithInternals = adapter as unknown as {
    accessToken: string;
    tokenExpiresAt: number;
    _status: string;
  };
  adapterWithInternals.accessToken = "mock-token-xyz";
  adapterWithInternals.tokenExpiresAt = Date.now() + 7200000;
  adapterWithInternals._status = "running";

  return { adapter, fetchMock };
}

async function main(): Promise<void> {

  // ══════════════════════════════════════════════════════
  // Gateway API
  // ══════════════════════════════════════════════════════

  console.log("\n=== getGateway ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/gateway", (call) => {
      if (call.method === "GET" && !call.url.includes("/gateway/bot")) {
        return { status: 200, body: { url: "wss://api.sgroup.qq.com/websockets" } };
      }
      return { status: 200, body: {} };
    });

    const gw = await adapter.getGateway();
    assert(gw.url === "wss://api.sgroup.qq.com/websockets", "Should return WSS URL");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "GET", "Should use GET");
    assert(lastCall?.headers["Authorization"] === "QQBot mock-token-xyz", "Should include auth header");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== getGatewayBot ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/gateway/bot", () => ({
      status: 200,
      body: {
        url: "wss://api.sgroup.qq.com/websockets",
        shards: 3,
        session_start_limit: {
          total: 1000,
          remaining: 980,
          reset_after: 3600000,
          max_concurrency: 1,
        },
      },
    }));

    const gwBot = await adapter.getGatewayBot();
    assert(gwBot.url === "wss://api.sgroup.qq.com/websockets", "Should return WSS URL");
    assert(gwBot.shards === 3, "Should return shards=3");
    assert(gwBot.session_start_limit.remaining === 980, "Should return remaining=980");
    assert(gwBot.session_start_limit.max_concurrency === 1, "Should return max_concurrency=1");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  // ══════════════════════════════════════════════════════
  // User API
  // ══════════════════════════════════════════════════════

  console.log("\n=== getBotSelfInfo ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/users/@me", (call) => {
      if (call.method === "GET") {
        return {
          status: 200,
          body: { id: "bot_123", username: "测试机器人", bot: true, avatar: "http://avatar.png" },
        };
      }
      return { status: 200, body: {} };
    });

    const bot = await adapter.getBotSelfInfo();
    assert(bot.id === "bot_123", "Should return bot id");
    assert(bot.username === "测试机器人", "Should return bot username");
    assert(bot.bot === true, "Should return bot=true");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  // ══════════════════════════════════════════════════════
  // Channel Message Management
  // ══════════════════════════════════════════════════════

  console.log("\n=== listChannelMessages ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_m/messages", (call) => {
      if (call.method === "GET") {
        return {
          status: 200,
          body: [
            { id: "msg1", channel_id: "ch_m", content: "Hello", timestamp: "2024-01-01T00:00:00+08:00", author: { id: "u1", username: "Alice" } },
            { id: "msg2", channel_id: "ch_m", content: "World", timestamp: "2024-01-02T00:00:00+08:00", author: { id: "u2", username: "Bob" } },
          ],
        };
      }
      return { status: 200, body: {} };
    });

    const messages = await adapter.listChannelMessages("ch_m", { before: "msg3", limit: 20, type: 1 });
    assert(messages.length === 2, "Should return 2 messages");
    assert(messages[0].id === "msg1", "First message id should be msg1");
    assert(messages[1].author.username === "Bob", "Second author should be Bob");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.url.includes("before=msg3"), "Should include before param");
    assert(lastCall?.url.includes("limit=20"), "Should include limit=20");
    assert(lastCall?.url.includes("type=1"), "Should include type=1");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== getChannelMessage ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_gm/messages/msg_x", (call) => {
      if (call.method === "GET") {
        return {
          status: 200,
          body: { id: "msg_x", channel_id: "ch_gm", content: "消息详情", timestamp: "2024-01-01", author: { id: "u1", username: "Alice" } },
        };
      }
      return { status: 200, body: {} };
    });

    const msg = await adapter.getChannelMessage("ch_gm", "msg_x");
    assert(msg.id === "msg_x", "Should return message id");
    assert(msg.content === "消息详情", "Should return content");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== patchChannelMessage ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_pm/messages/msg_p", (call) => {
      if (call.method === "PATCH") {
        return {
          status: 200,
          body: { id: "msg_p", channel_id: "ch_pm", content: call.body?.content ?? "", timestamp: "2024-01-01", author: { id: "bot" } },
        };
      }
      return { status: 200, body: {} };
    });

    const msg = await adapter.patchChannelMessage("ch_pm", "msg_p", { content: "修改后内容" });
    assert(msg.id === "msg_p", "Should return message id");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "PATCH", "Should use PATCH");
    assert(lastCall?.body?.content === "修改后内容", "Should send content in body");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  // ══════════════════════════════════════════════════════
  // Role CRUD
  // ══════════════════════════════════════════════════════

  console.log("\n=== createGuildRole ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_cr/roles", (call) => {
      if (call.method === "POST") {
        return {
          status: 200,
          body: {
            role: { id: "100", name: call.body?.name, color: call.body?.color, hoist: call.body?.hoist, number: 0, member_limit: 50, permissions: "0" },
            role_id: "100",
          },
        };
      }
      return { status: 200, body: {} };
    });

    const result = await adapter.createGuildRole("g_cr", { name: "新身份组", color: 16711680, hoist: true });
    assert(result.role_id === "100", "Should return role_id=100");
    assert(result.role.name === "新身份组", "Should return role name");
    assert(result.role.color === 16711680, "Should return color");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "POST", "Should use POST");
    assert(lastCall?.body?.name === "新身份组", "Should send name");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== updateGuildRole ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_ur/roles/r_100", (call) => {
      if (call.method === "PATCH") {
        return {
          status: 200,
          body: {
            role: { id: "100", name: call.body?.name, color: call.body?.color, hoist: call.body?.hoist, number: 5, member_limit: 50, permissions: "0" },
            role_id: "100",
          },
        };
      }
      return { status: 200, body: {} };
    });

    const result = await adapter.updateGuildRole("g_ur", "r_100", { name: "改名身份组", color: 0, hoist: false });
    assert(result.role.name === "改名身份组", "Should return updated name");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "PATCH", "Should use PATCH");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== deleteGuildRole ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_dr/roles/r_100", (call) => {
      if (call.method === "DELETE") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    await adapter.deleteGuildRole("g_dr", "r_100");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "DELETE", "Should use DELETE");
    assert(lastCall?.url.includes("/roles/r_100"), "Should target role endpoint");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  // ══════════════════════════════════════════════════════
  // Pins API
  // ══════════════════════════════════════════════════════

  console.log("\n=== addPinMessage ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_p/pins/msg_pin", (call) => {
      if (call.method === "PUT") {
        return {
          status: 200,
          body: { message_ids: ["msg_pin", "msg_other"], channel_id: "ch_p" },
        };
      }
      return { status: 200, body: {} };
    });

    const result = await adapter.addPinMessage("ch_p", "msg_pin");
    assert(result.message_ids.length === 2, "Should return 2 pinned message ids");
    assert(result.message_ids[0] === "msg_pin", "First pin should be msg_pin");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "PUT", "Should use PUT");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== deletePinMessage ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_dp/pins/msg_pin", (call) => {
      if (call.method === "DELETE") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    await adapter.deletePinMessage("ch_dp", "msg_pin");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "DELETE", "Should use DELETE");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== listPinMessages ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_lp/pins", (call) => {
      if (call.method === "GET") {
        return {
          status: 200,
          body: { guild_id: "g_x", channel_id: "ch_lp", message_ids: ["p1", "p2", "p3"] },
        };
      }
      return { status: 200, body: {} };
    });

    const result = await adapter.listPinMessages("ch_lp");
    assert(result.message_ids.length === 3, "Should return 3 pinned message ids");
    assert(result.message_ids[0] === "p1", "First pin should be p1");
    assert(result.channel_id === "ch_lp", "Should return channel_id");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  // ══════════════════════════════════════════════════════
  // Speak Privilege Settings API
  // ══════════════════════════════════════════════════════

  console.log("\n=== getSpeakPrivilegeSettings ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_sp/speak_privilege_settings", (call) => {
      if (call.method === "GET") {
        return {
          status: 200,
          body: { ch_1: "5", ch_2: "1" },
        };
      }
      return { status: 200, body: {} };
    });

    const settings = await adapter.getSpeakPrivilegeSettings("g_sp");
    assert(settings["ch_1"] === "5", "Should return ch_1 permission='5'");
    assert(settings["ch_2"] === "1", "Should return ch_2 permission='1'");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== updateSpeakPrivilegeSettings ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_usp/speak_privilege_settings", (call) => {
      if (call.method === "PUT") {
        return { status: 200, body: call.body };
      }
      return { status: 200, body: {} };
    });

    const result = await adapter.updateSpeakPrivilegeSettings("g_usp", { ch_1: "8", ch_2: "4" });
    assert(result["ch_1"] === "8", "Should return updated ch_1=8");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "PUT", "Should use PUT");
    assert(lastCall?.body?.ch_1 === "8", "Should send ch_1 in body");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== getMessageSetting ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_ms/message_setting", () => ({
      status: 200,
      body: { guild_id: "g_ms", channel_id: "ch_ms", max_count: 5, window_seconds: 5 },
    }));

    const setting = await adapter.getMessageSetting("g_ms");
    assert(setting.guild_id === "g_ms", "Should return guild_id");
    assert(setting.max_count === 5, "Should return max_count=5");
    assert(setting.window_seconds === 5, "Should return window_seconds=5");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  // ══════════════════════════════════════════════════════
  // Forum API
  // ══════════════════════════════════════════════════════

  console.log("\n=== listThreads ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_t/threads", (call) => {
      if (call.method === "GET" && !call.url.includes("/threads/")) {
        return {
          status: 200,
          body: {
            threads: [
              {
                channel_id: "ch_t",
                author: { id: "u1", username: "Alice" },
                thread_info: { thread_id: "th_1", title: "帖子1", content: "内容1", date_time: "2024-01-01" },
              },
            ],
          },
        };
      }
      return { status: 200, body: {} };
    });

    const result = await adapter.listThreads("ch_t");
    assert(result.threads.length === 1, "Should return 1 thread");
    assert(result.threads[0].thread_info.thread_id === "th_1", "Thread id should be th_1");
    assert(result.threads[0].thread_info.title === "帖子1", "Thread title should be '帖子1'");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== getThread ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_gt/threads/th_detail", (call) => {
      if (call.method === "GET") {
        return {
          status: 200,
          body: {
            channel_id: "ch_gt",
            author: { id: "u1", username: "Author" },
            thread_info: { thread_id: "th_detail", title: "详细帖子", content: "详细内容", date_time: "2024-02-01" },
            member: { roles: ["1"], joined_at: "2024-01-01" },
          },
        };
      }
      return { status: 200, body: {} };
    });

    const thread = await adapter.getThread("ch_gt", "th_detail");
    assert(thread.thread_info.title === "详细帖子", "Should return thread title");
    assert(thread.member?.roles.length === 1, "Should return member roles");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== publishThread ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_pt/threads", (call) => {
      if (call.method === "PUT") {
        return {
          status: 200,
          body: {
            channel_id: "ch_pt",
            author: { id: "bot", username: "Robot" },
            thread_info: { thread_id: "new_th", title: call.body?.title, content: call.body?.content, date_time: "2024-03-01" },
          },
        };
      }
      return { status: 200, body: {} };
    });

    const thread = await adapter.publishThread("ch_pt", "新帖子", "帖子内容", 1);
    assert(thread.thread_info.thread_id === "new_th", "Should return new thread id");
    assert(thread.thread_info.title === "新帖子", "Should return title");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "PUT", "Should use PUT");
    assert(lastCall?.body?.title === "新帖子", "Should send title");
    assert(lastCall?.body?.format === 1, "Should send format=1");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== deleteThread ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_dt/threads/th_del", (call) => {
      if (call.method === "DELETE") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    await adapter.deleteThread("ch_dt", "th_del");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "DELETE", "Should use DELETE");
    assert(lastCall?.url.includes("/threads/th_del"), "Should target thread endpoint");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== listThreadComments ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_tc/threads/th_1/comments", () => ({
      status: 200,
      body: {
        comments: [
          { comment_id: "c1", content: "评论1", author: { id: "u1", username: "Alice" }, date_time: "2024-01-01" },
          { comment_id: "c2", content: "评论2", author: { id: "u2", username: "Bob" }, date_time: "2024-01-02" },
        ],
      },
    }));

    const result = await adapter.listThreadComments("ch_tc", "th_1");
    assert(result.comments.length === 2, "Should return 2 comments");
    assert(result.comments[0].comment_id === "c1", "First comment id should be c1");
    assert(result.comments[1].author.username === "Bob", "Second author should be Bob");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  // ══════════════════════════════════════════════════════
  // Audio API
  // ══════════════════════════════════════════════════════

  console.log("\n=== controlAudio ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_a/audio", (call) => {
      if (call.method === "POST") return { status: 200, body: {} };
      return { status: 200, body: {} };
    });

    await adapter.controlAudio("ch_a", { audio_url: "http://example.com/song.mp3", text: "播放歌曲", status: 0 });

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "POST", "Should use POST");
    assert(lastCall?.body?.audio_url === "http://example.com/song.mp3", "Should send audio_url");
    assert(lastCall?.body?.status === 0, "Should send status=0");
    assert(lastCall?.body?.text === "播放歌曲", "Should send text");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== playAudio / pauseAudio / resumeAudio / stopAudio ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_au/audio", (call) => {
      if (call.method === "POST") return { status: 200, body: {} };
      return { status: 200, body: {} };
    });

    await adapter.playAudio("ch_au", "http://example.com/a.mp3", "歌名");
    let lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.status === 0, "playAudio should send status=0");
    assert(lastCall?.body?.audio_url === "http://example.com/a.mp3", "playAudio should send audio_url");

    await adapter.pauseAudio("ch_au");
    lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.status === 1, "pauseAudio should send status=1");

    await adapter.resumeAudio("ch_au");
    lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.status === 2, "resumeAudio should send status=2");

    await adapter.stopAudio("ch_au");
    lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.status === 3, "stopAudio should send status=3");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== onMic / offMic ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_mic/mic", (call) => {
      if (call.method === "PUT" || call.method === "DELETE") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    await adapter.onMic("ch_mic");
    let lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "PUT", "onMic should use PUT");

    await adapter.offMic("ch_mic");
    lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "DELETE", "offMic should use DELETE");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  // ══════════════════════════════════════════════════════
  console.log("\n==================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
