/**
 * QQ Official Bot Adapter — 统一单元测试
 *
 * 合并自: qqofficial-extended-test, qqofficial-phase2-test,
 *         qqofficial-phase4-test, qqofficial-phase5-test
 *
 * 测试模块:
 *  1. Rich Media Upload (群/C2C 富媒体上传)
 *  2. Extended Send (markdown/ark/embed/media/keyboard/is_wakeup)
 *  3. Message Recall (群/C2C/频道消息撤回)
 *  4. Emoji Reactions (添加/删除/获取表态用户)
 *  5. Guild API (频道/成员/身份组 CRUD)
 *  6. Channel API (子频道 CRUD/权限/在线人数)
 *  7. Announces & Schedule (公告/日程 CRUD)
 *  8. API Permissions (权限查询/申请)
 *  9. Gateway & User (网关/机器人自身信息)
 * 10. Channel Message Management (列表/获取/修改)
 * 11. Role CRUD (身份组创建/修改/删除)
 * 12. Pins (置顶消息)
 * 13. Speak & Message Settings (发言权限/频度设置)
 * 14. Forum (帖子/评论)
 * 15. Audio (音频控制/麦克风)
 * 16. Sandbox Environment (沙箱 URL 切换)
 * 17. Sharding (分片配置/IDENTIFY)
 * 18. Intents (事件订阅位掩码)
 * 19. onRawEvent (原生事件分发)
 *
 * Strategy: Mock global fetch to capture requests and return controlled responses.
 */

import { QQOfficialAdapter } from "@yachiyo/platform/implementations/qqofficial-adapter.js";
import type { QQOfficialAdapterConfig } from "@yachiyo/platform/implementations/qqofficial-adapter.js";
import { AsyncQueue } from "@yachiyo/common/async-queue.js";
import { MessageEvent } from "@yachiyo/message/event.js";

// ── Test Infrastructure ──

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
      return new Response(responseBody, { status: result.status, headers: responseHeaders });
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

  getCalls(): FetchCall[] {
    return [...this.calls];
  }

  getLastCall(): FetchCall | undefined {
    return this.calls.at(-1);
  }

  reset(): void {
    this.calls = [];
  }
}

/** 适配器内部字段类型 (用于直接访问私有成员) */
interface AdapterInternals {
  accessToken: string;
  tokenExpiresAt: number;
  _status: string;
  ws: { send: (data: string) => void; close: () => void; readyState: number } | null;
  config: QQOfficialAdapterConfig;
  getApiBase: () => string;
  getWsUrl: () => string;
  getShard: () => [number, number] | undefined;
  getIntents: () => number;
  sendIdentify: () => void;
  handleDispatch: (eventType: string | undefined, seq: number | undefined, data: unknown) => void;
}

async function createAdapter(configOverrides: Partial<QQOfficialAdapterConfig> = {}): Promise<{
  adapter: QQOfficialAdapter;
  fetchMock: FetchMock;
  internals: AdapterInternals;
}> {
  const config: QQOfficialAdapterConfig = {
    type: "qqofficial",
    id: "test-qqofficial",
    appId: "test-app-id",
    appSecret: "test-secret",
    ...configOverrides,
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

  const internals = adapter as unknown as AdapterInternals;
  internals.accessToken = "mock-token-xyz";
  internals.tokenExpiresAt = Date.now() + 7200000;
  internals._status = "running";

  return { adapter, fetchMock, internals };
}

/** 模拟 WebSocket 以测试 sendIdentify() */
function mockWs(internals: AdapterInternals): { sentPayloads: unknown[] } {
  const sentPayloads: unknown[] = [];
  internals.ws = {
    send: (data: string) => { sentPayloads.push(JSON.parse(data)); },
    close: () => {},
    readyState: 1, // WebSocket.OPEN
  };
  return { sentPayloads };
}

async function cleanup(adapter: QQOfficialAdapter, fetchMock: FetchMock): Promise<void> {
  fetchMock.restore();
  await adapter.stop();
  await new Promise(r => setTimeout(r, 50));
}

// ══════════════════════════════════════════════════════
// 1. Rich Media Upload
// ══════════════════════════════════════════════════════

async function testRichMediaUpload(): Promise<void> {
  console.log("\n=== Rich Media Upload (Group) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/v2/groups/", (call) => {
      if (call.url.includes("/files") && call.method === "POST") {
        return { status: 200, body: { file_uuid: "uuid-001", file_info: "file_info_abc", ttl: 300 } };
      }
      return { status: 200, body: {} };
    });

    const result = await adapter.uploadGroupRichMedia("group_open_123", 1, "https://example.com/image.png");
    assert(result.file_uuid === "uuid-001", "Should return file_uuid");
    assert(result.file_info === "file_info_abc", "Should return file_info");
    assert(result.ttl === 300, "Should return ttl");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "POST", "Should use POST method");
    assert(lastCall?.body?.file_type === 1, "Should pass file_type=1 (image)");
    assert(lastCall?.body?.url === "https://example.com/image.png", "Should pass url");
    assert(lastCall?.url.includes("/v2/groups/group_open_123/files"), "Should target group files endpoint");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Rich Media Upload (C2C) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/v2/users/", (call) => {
      if (call.url.includes("/files") && call.method === "POST") {
        return { status: 200, body: { file_uuid: "uuid-002", file_info: "file_info_def", ttl: 0 } };
      }
      return { status: 200, body: {} };
    });

    const result = await adapter.uploadC2CRichMedia("user_open_456", 4, "https://example.com/doc.pdf");
    assert(result.file_uuid === "uuid-002", "Should return file_uuid");
    assert(result.ttl === 0, "Should return ttl=0 (long-term)");
    assert(result.file_info === "file_info_def", "Should return file_info");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.file_type === 4, "Should pass file_type=4 (file)");
    assert(lastCall?.url.includes("/v2/users/user_open_456/files"), "Should target C2C files endpoint");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Rich Media Upload with base64 file_data ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/files", () => ({
      status: 200, body: { file_uuid: "uuid-003", file_info: "info", ttl: 100 },
    }));

    await adapter.uploadGroupRichMedia("g1", 3, "https://example.com/audio.silk", "base64data==");
    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.file_data === "base64data==", "Should pass file_data when provided");
    assert(lastCall?.body?.file_type === 3, "Should pass file_type=3 (voice)");

    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 2. Extended Send (all msg_types)
// ══════════════════════════════════════════════════════

async function testExtendedSend(): Promise<void> {
  console.log("\n=== Extended Send: Markdown (msg_type=2) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/messages", () => ({ status: 200, body: { id: "msg_id_100", seq: 1 } }));

    const result = await adapter.sendGroupMessageEx("group_open_1", {
      msg_type: 2,
      markdown: { content: "# Hello\nThis is **markdown**" },
      msg_id: "event_abc",
    });

    assert(result.id === "msg_id_100", "Should return message id");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.msg_type === 2, "Should send msg_type=2");
    assert(lastCall?.body?.markdown?.content === "# Hello\nThis is **markdown**", "Should pass markdown content");
    assert(lastCall?.body?.msg_id === "event_abc", "Should pass msg_id for passive reply");
    assert(typeof lastCall?.body?.msg_seq === "number", "Should include msg_seq");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Extended Send: Ark (msg_type=3) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/messages", () => ({ status: 200, body: { id: "msg_ark_1" } }));

    const ark = {
      template_id: 1,
      kv: [{ key: "title", value: "Hello" } as { key: string; value: string }],
    };
    await adapter.sendC2CMessageEx("user_open_1", { msg_type: 3, ark });

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.msg_type === 3, "Should send msg_type=3");
    assert(lastCall?.body?.ark?.template_id === 1, "Should pass ark template_id");
    assert(lastCall?.url.includes("/v2/users/user_open_1/messages"), "Should target C2C messages endpoint");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Extended Send: Embed (msg_type=4) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/", () => ({ status: 200, body: { id: "msg_embed_1" } }));

    const embed = { title: "Test", description: "Embed content", fields: [{ name: "f1", value: "v1" }] };
    await adapter.sendGuildMessageEx("channel_1", { msg_type: 4, embed });

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.msg_type === 4, "Should send msg_type=4");
    assert(lastCall?.body?.embed?.title === "Test", "Should pass embed title");
    assert(lastCall?.url.includes("/channels/channel_1/messages"), "Should target channel messages endpoint");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Extended Send: Media (msg_type=7) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/messages", () => ({ status: 200, body: { id: "msg_media_1" } }));

    await adapter.sendGroupMessageEx("group_1", {
      msg_type: 7,
      media: { file_info: "preuploaded_file_info" },
    });

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.msg_type === 7, "Should send msg_type=7");
    assert(lastCall?.body?.media?.file_info === "preuploaded_file_info", "Should pass media file_info");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Extended Send: Keyboard (message buttons) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/messages", () => ({ status: 200, body: { id: "msg_kb_1" } }));

    const keyboard = {
      content: {
        rows: [{
          buttons: [{
            id: "btn1",
            render_data: { label: "Click me", visited_label: "Clicked", style: 1 as 0 | 1 },
            action: {
              type: 1 as 0 | 1 | 2,
              permission: { type: 2 as 0 | 1 | 2 | 3 },
              data: "callback_data",
              unsupport_tips: "Not supported",
            },
          }],
        }],
      },
    };
    await adapter.sendC2CMessageEx("user_1", { msg_type: 2, markdown: { content: "Please choose" }, keyboard });

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.keyboard?.content?.rows?.length === 1, "Should pass keyboard with 1 row");
    assert(lastCall?.body?.keyboard?.content?.rows[0].buttons[0].id === "btn1", "Should pass button id");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Extended Send: is_wakeup (interactive recall) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/messages", () => ({ status: 200, body: { id: "msg_wake_1" } }));

    await adapter.sendC2CMessageEx("user_1", { content: "Wake up reminder", msg_type: 0, is_wakeup: true });

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.is_wakeup === true, "Should pass is_wakeup=true");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Extended Send: Guild/Direct with msg_id ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/", () => ({ status: 200, body: { id: "msg_guild_1" } }));

    await adapter.sendGuildMessageEx("channel_1", { content: "Hello guild", msg_id: "evt_123" });

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.msg_id === "evt_123", "Should pass msg_id for passive guild reply");
    assert(lastCall?.body?.content === "Hello guild", "Should pass content");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Backward compatible sendGroupMessage returns result ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/messages", () => ({ status: 200, body: { id: "bc_msg_1" } }));

    const result = await adapter.sendGroupMessage("group_1", "hello", "evt_1");
    assert(result.id === "bc_msg_1", "Backward compatible sendGroupMessage should return result");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Auth header & msg_seq auto-increment ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/messages", () => ({ status: 200, body: { id: "x" } }));

    await adapter.sendGroupMessageEx("g1", { content: "test" });
    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.headers?.Authorization === "QQBot mock-token-xyz", "Should include correct Authorization header");
    assert(lastCall?.headers?.["Content-Type"] === "application/json", "Should include JSON content type");

    const seq1 = fetchMock.getLastCall()?.body?.msg_seq;
    await adapter.sendGroupMessageEx("g1", { content: "msg2" });
    const seq2 = fetchMock.getLastCall()?.body?.msg_seq;
    assert(typeof seq1 === "number" && typeof seq2 === "number", "msg_seq should be numbers");
    assert(seq2! > seq1!, "msg_seq should auto-increment");

    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 3. Message Recall
// ══════════════════════════════════════════════════════

async function testMessageRecall(): Promise<void> {
  console.log("\n=== Message Recall: C2C ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/messages/", (call) => {
      if (call.method === "DELETE") return { status: 200, body: {} };
      return { status: 200, body: {} };
    });

    await adapter.deleteC2CMessage("user_open_1", "msg_123");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "DELETE", "Should use DELETE method");
    assert(lastCall?.url.includes("/v2/users/user_open_1/messages/msg_123"), "Should target correct C2C delete endpoint");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Message Recall: Group ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/messages/", (call) => {
      if (call.method === "DELETE") return { status: 200, body: {} };
      return { status: 200, body: {} };
    });

    await adapter.deleteGroupMessage("group_open_1", "msg_456");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "DELETE", "Should use DELETE method");
    assert(lastCall?.url.includes("/v2/groups/group_open_1/messages/msg_456"), "Should target correct group delete endpoint");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Message Recall: Guild (with hideTip) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/", (call) => {
      if (call.method === "DELETE") return { status: 200, body: {} };
      return { status: 200, body: {} };
    });

    await adapter.deleteGuildMessage("channel_1", "msg_789", true);

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "DELETE", "Should use DELETE method");
    assert(lastCall?.url.includes("/channels/channel_1/messages/msg_789"), "Should target channel delete endpoint");
    assert(lastCall?.url.includes("hidetip=true"), "Should pass hidetip=true");

    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 4. Emoji Reactions
// ══════════════════════════════════════════════════════

async function testEmojiReactions(): Promise<void> {
  console.log("\n=== Add Reaction (PUT) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/reactions/", (call) => {
      if (call.method === "PUT") return { status: 204, body: {} };
      return { status: 200, body: {} };
    });

    await adapter.addReaction("channel_1", "msg_100", 1, "203");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "PUT", "Should use PUT method for add reaction");
    assert(lastCall?.url.includes("/channels/channel_1/messages/msg_100/reactions/1/203"), "Should target correct reaction endpoint");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Delete Reaction (DELETE) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/reactions/", (call) => {
      if (call.method === "DELETE") return { status: 204, body: {} };
      return { status: 200, body: {} };
    });

    await adapter.deleteReaction("channel_1", "msg_100", 1, "203");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "DELETE", "Should use DELETE method for delete reaction");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Get Reaction Users (GET with pagination) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/reactions/", (call) => {
      if (call.method === "GET") {
        return {
          status: 200,
          body: {
            users: [{ user_id: "u1", username: "Alice" }, { user_id: "u2", username: "Bob" }],
            is_end: false,
            cookie: "next_page_cookie",
          },
        };
      }
      return { status: 200, body: {} };
    });

    const result = await adapter.getReactionUsers("channel_1", "msg_100", 1, "203", { limit: 20 });
    assert(result.users.length === 2, "Should return 2 users");
    assert(result.users[0].username === "Alice", "First user should be Alice");
    assert(result.is_end === false, "Should return is_end=false");
    assert(result.cookie === "next_page_cookie", "Should return cookie for pagination");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "GET", "Should use GET method");
    assert(lastCall?.url.includes("limit=20"), "Should pass limit query param");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Get Reaction Users (second page with cookie) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/reactions/", (call) => {
      if (call.method === "GET") {
        return { status: 200, body: { users: [{ user_id: "u3" }], is_end: true } };
      }
      return { status: 200, body: {} };
    });

    const result = await adapter.getReactionUsers("ch1", "m1", 1, "4", { cookie: "prev_cookie" });
    assert(result.is_end === true, "Should return is_end=true on last page");
    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.url.includes("cookie=prev_cookie"), "Should pass cookie query param");

    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 5. Guild API
// ══════════════════════════════════════════════════════

async function testGuildApi(): Promise<void> {
  console.log("\n=== getGuild ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/guild_123", (call) => {
      if (call.method === "GET") {
        return { status: 200, body: { id: "guild_123", name: "测试频道", icon: "icon_hash", owner_id: "owner_1", member_count: 100 } };
      }
      return { status: 200, body: {} };
    });

    const guild = await adapter.getGuild("guild_123");
    assert(guild.id === "guild_123", "Should return guild id");
    assert(guild.name === "测试频道", "Should return guild name");
    assert(guild.member_count === 100, "Should return member_count");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "GET", "Should use GET method");
    assert(lastCall?.url.includes("/guilds/guild_123"), "Should target guild endpoint");
    assert(lastCall?.headers["Authorization"] === "QQBot mock-token-xyz", "Should include auth header");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== getGuilds (with pagination) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/users/@me/guilds", () => ({
      status: 200,
      body: [{ id: "g1", name: "频道1", icon: "" }, { id: "g2", name: "频道2", icon: "" }],
    }));

    const guilds = await adapter.getGuilds({ after: "g0", limit: 50 });
    assert(guilds.length === 2, "Should return 2 guilds");
    assert(guilds[0].id === "g1", "First guild id should be g1");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.url.includes("after=g0"), "Should include after param");
    assert(lastCall?.url.includes("limit=50"), "Should include limit param");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== getGuildMembers ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_main/members", () => ({
      status: 200,
      body: [
        { user: { id: "u1", username: "Alice" }, nick: "", roles: ["1"], joined_at: "2024-01-01T00:00:00+08:00" },
        { user: { id: "u2", username: "Bob" }, nick: "bob昵称", roles: ["4"], joined_at: "2024-02-01T00:00:00+08:00" },
      ],
    }));

    const members = await adapter.getGuildMembers("g_main", { after: "0", limit: 2 });
    assert(members.length === 2, "Should return 2 members");
    assert(members[0].user.id === "u1", "First member id should be u1");
    assert(members[1].nick === "bob昵称", "Second member nick should be 'bob昵称'");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== getGuildMember ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_x/members/u_y", (call) => {
      if (call.method === "GET") {
        return { status: 200, body: { user: { id: "u_y", username: "Charlie" }, nick: "查理", roles: ["5"], joined_at: "2024-03-01" } };
      }
      return { status: 200, body: {} };
    });

    const member = await adapter.getGuildMember("g_x", "u_y");
    assert(member.user.username === "Charlie", "Should return member username");
    assert(member.nick === "查理", "Should return member nick");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== deleteGuildMember ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_k/members/u_k", (call) => {
      if (call.method === "DELETE") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    await adapter.deleteGuildMember("g_k", "u_k", { addBlacklist: true, deleteMessageDays: 7 });

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "DELETE", "Should use DELETE method");
    assert(lastCall?.url.includes("add_blacklist=true"), "Should include add_blacklist=true param");
    assert(lastCall?.url.includes("delete_message_days=7"), "Should include delete_message_days=7 param");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== modifyGuildMember (mute) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_m/members/u_m", (call) => {
      if (call.method === "PATCH") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    await adapter.modifyGuildMember("g_m", "u_m", { nick: "新昵称", mute_seconds: "600" });

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "PATCH", "Should use PATCH method");
    assert(lastCall?.body?.nick === "新昵称", "Should send nick");
    assert(lastCall?.body?.mute_seconds === "600", "Should send mute_seconds=600");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== muteGuildMember / unmuteGuildMember ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_mu/members/u_mu", (call) => {
      if (call.method === "PATCH") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    await adapter.muteGuildMember("g_mu", "u_mu", 300);
    assert(fetchMock.getLastCall()?.body?.mute_seconds === "300", "muteGuildMember should send mute_seconds=300");

    await adapter.unmuteGuildMember("g_mu", "u_mu");
    assert(fetchMock.getLastCall()?.body?.mute_seconds === "0", "unmuteGuildMember should send mute_seconds=0");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== getGuildRoles ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_r/roles", () => ({
      status: 200,
      body: {
        roles: [
          { id: "1", name: "全体成员", color: 0, hoist: false, number: 100, member_limit: 1000, permissions: "1" },
          { id: "5", name: "管理员", color: 4294967295, hoist: true, number: 3, member_limit: 10, permissions: "8" },
        ],
      },
    }));

    const roles = await adapter.getGuildRoles("g_r");
    assert(roles.length === 2, "Should return 2 roles");
    assert(roles[0].id === "1", "First role id should be 1");
    assert(roles[1].name === "管理员", "Second role name should be '管理员'");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== getRoleMembers ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_rm/roles/5/members", () => ({
      status: 200,
      body: {
        members: [{ user: { id: "admin1", username: "管理员1" }, nick: "", roles: ["5"], joined_at: "2024-01-01" }],
        next_start_index: "admin1",
      },
    }));

    const result = await adapter.getRoleMembers("g_rm", "5", { startIndex: "0", limit: 10 });
    assert(result.members.length === 1, "Should return 1 member");
    assert(result.members[0].user.id === "admin1", "Member id should be admin1");
    assert(result.next_start_index === "admin1", "Should return next_start_index");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.url.includes("start_index=0"), "Should include start_index param");
    assert(lastCall?.url.includes("limit=10"), "Should include limit=10 param");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== addRoleToMember / removeRoleFromMember ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_ar/members/u_ar/roles/7", (call) => {
      if (call.method === "PUT" || call.method === "DELETE") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    await adapter.addRoleToMember("g_ar", "u_ar", "7");
    assert(fetchMock.getLastCall()?.method === "PUT", "addRoleToMember should use PUT");

    await adapter.removeRoleFromMember("g_ar", "u_ar", "7");
    assert(fetchMock.getLastCall()?.method === "DELETE", "removeRoleFromMember should use DELETE");

    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 6. Channel API
// ══════════════════════════════════════════════════════

async function testChannelApi(): Promise<void> {
  console.log("\n=== getGuildChannels ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_c/channels", () => ({
      status: 200,
      body: [{ id: "ch1", guild_id: "g_c", name: "文字频道1", type: 0 }, { id: "ch2", guild_id: "g_c", name: "语音频道", type: 2 }],
    }));

    const channels = await adapter.getGuildChannels("g_c");
    assert(channels.length === 2, "Should return 2 channels");
    assert(channels[0].id === "ch1", "First channel id should be ch1");
    assert(channels[1].type === 2, "Second channel type should be 2 (voice)");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== getChannel ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_detail", (call) => {
      if (call.method === "GET") {
        return { status: 200, body: { id: "ch_detail", guild_id: "g_c", name: "公告板", type: 0, sub_type: 2 } };
      }
      return { status: 200, body: {} };
    });

    const channel = await adapter.getChannel("ch_detail");
    assert(channel.id === "ch_detail", "Should return channel id");
    assert(channel.name === "公告板", "Should return channel name");
    assert(channel.sub_type === 2, "Should return sub_type=2 (公告)");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== createChannel ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_nc/channels", (call) => {
      if (call.method === "POST") {
        return { status: 200, body: { id: "new_ch", guild_id: "g_nc", name: call.body?.name, type: call.body?.type } };
      }
      return { status: 200, body: {} };
    });

    const channel = await adapter.createChannel("g_nc", { name: "新频道", type: 0, sub_type: 0 });
    assert(channel.id === "new_ch", "Should return new channel id");
    assert(channel.name === "新频道", "Should return new channel name");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "POST", "Should use POST");
    assert(lastCall?.body?.name === "新频道", "Should send name");
    assert(lastCall?.body?.type === 0, "Should send type=0");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== updateChannel ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_upd", (call) => {
      if (call.method === "PATCH") {
        return { status: 200, body: { id: "ch_upd", guild_id: "g", name: call.body?.name, type: 0 } };
      }
      return { status: 200, body: {} };
    });

    const channel = await adapter.updateChannel("ch_upd", { name: "改名后" });
    assert(channel.name === "改名后", "Should return updated name");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "PATCH", "Should use PATCH");
    assert(lastCall?.body?.name === "改名后", "Should send name in body");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== deleteChannel ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_del", (call) => {
      if (call.method === "DELETE") return { status: 200, body: {} };
      return { status: 200, body: {} };
    });

    await adapter.deleteChannel("ch_del");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "DELETE", "Should use DELETE");
    assert(lastCall?.url.includes("/channels/ch_del"), "Should target channel endpoint");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== getChannelOnlineNums ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_on/online_nums", () => ({
      status: 200,
      body: { online_count: 50, online_member_count: 45, online_robot_count: 5 },
    }));

    const nums = await adapter.getChannelOnlineNums("ch_on");
    assert(nums.online_count === 50, "Should return online_count=50");
    assert(nums.online_member_count === 45, "Should return online_member_count=45");
    assert(nums.online_robot_count === 5, "Should return online_robot_count=5");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== getChannelUserPermissions / updateChannelUserPermissions ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_p/permissions/", (call) => {
      if (call.method === "GET") return { status: 200, body: { permissions: "5" } };
      if (call.method === "PUT" || call.method === "PATCH") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    const perms = await adapter.getChannelUserPermissions("ch_p", "u_p");
    assert(perms.permissions === "5", "Should return permissions='5'");

    await adapter.updateChannelUserPermissions("ch_up", "u_up", { permissions: "8" }, false);
    assert(fetchMock.getLastCall()?.method === "PUT", "Default should use PUT (overwrite)");
    assert(fetchMock.getLastCall()?.body?.add === "8", "Should send add=8");

    await adapter.updateChannelUserPermissions("ch_up", "u_up", { permissions: "16" }, true);
    assert(fetchMock.getLastCall()?.method === "PATCH", "additive=true should use PATCH");
    assert(fetchMock.getLastCall()?.body?.add === "16", "Should send add=16");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== getChannelRolePermissions / updateChannelRolePermissions ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_rp/permissions/r_5", (call) => {
      if (call.method === "GET") return { status: 200, body: { permissions: "16" } };
      if (call.method === "PUT" || call.method === "PATCH") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    const perms = await adapter.getChannelRolePermissions("ch_rp", "r_5");
    assert(perms.permissions === "16", "Should return role permissions='16'");

    await adapter.updateChannelRolePermissions("ch_urp", "r_5", { permissions: "64" });
    assert(fetchMock.getLastCall()?.method === "PUT", "Default should use PUT");
    assert(fetchMock.getLastCall()?.body?.add === "64", "Should send add=64");

    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 7. Announces & Schedule
// ══════════════════════════════════════════════════════

async function testAnnouncesAndSchedule(): Promise<void> {
  console.log("\n=== getAnnounces ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_a/announces", (call) => {
      if (call.method === "GET") {
        return { status: 200, body: [{ guild_id: "g_a", channel_id: "ch_a", message_id: "msg_a" }, { guild_id: "g_a", channel_id: "ch_b", message_id: "msg_b" }] };
      }
      return { status: 200, body: {} };
    });

    const announces = await adapter.getAnnounces("g_a");
    assert(announces.length === 2, "Should return 2 announces");
    assert(announces[0].message_id === "msg_a", "First announce message_id should be msg_a");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== createAnnounce ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_ca/announces", (call) => {
      if (call.method === "POST") {
        return { status: 200, body: { guild_id: "g_ca", channel_id: call.body?.channel_id, message_id: call.body?.message_id } };
      }
      return { status: 200, body: {} };
    });

    const announce = await adapter.createAnnounce("g_ca", { channel_id: "ch_ca", message_id: "msg_ca" });
    assert(announce.message_id === "msg_ca", "Should return message_id");
    assert(announce.channel_id === "ch_ca", "Should return channel_id");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "POST", "Should use POST");
    assert(lastCall?.body?.channel_id === "ch_ca", "Should send channel_id");
    assert(lastCall?.body?.message_id === "msg_ca", "Should send message_id");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== deleteAnnounce ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_da/announces/msg_da", (call) => {
      if (call.method === "DELETE") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    await adapter.deleteAnnounce("g_da", "msg_da");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "DELETE", "Should use DELETE");
    assert(lastCall?.url.includes("/announces/msg_da"), "Should target announce endpoint");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== getSchedules ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_s/schedules", (call) => {
      if (call.method === "GET") {
        return {
          status: 200,
          body: [{
            id: "sch_1", name: "会议1", description: "周会",
            start_timestamp: "1700000000000", end_timestamp: "1700003600000",
            creator: { id: "u_1", username: "Organizer" }, jump_channel_id: "ch_meeting", remind_type: "1",
          }],
        };
      }
      return { status: 200, body: {} };
    });

    const schedules = await adapter.getSchedules("ch_s", "1700000000000");
    assert(schedules.length === 1, "Should return 1 schedule");
    assert(schedules[0].id === "sch_1", "Schedule id should be sch_1");
    assert(schedules[0].name === "会议1", "Schedule name should be '会议1'");
    assert(fetchMock.getLastCall()?.url.includes("since=1700000000000"), "Should include since param");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== createSchedule ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_cs/schedules", (call) => {
      if (call.method === "POST") {
        const sched = (call.body as { schedule: { name: string } }).schedule;
        return { status: 200, body: { id: "new_sch", name: sched.name, description: "", start_timestamp: "0", end_timestamp: "0", creator: { id: "bot" }, jump_channel_id: "", remind_type: "0" } };
      }
      return { status: 200, body: {} };
    });

    const schedule = await adapter.createSchedule("ch_cs", {
      name: "新日程", description: "描述", start_timestamp: "1700000000000",
      end_timestamp: "1700003600000", jump_channel_id: "ch_j", remind_type: "2",
    });
    assert(schedule.id === "new_sch", "Should return new schedule id");
    assert(schedule.name === "新日程", "Should return schedule name");
    assert(fetchMock.getLastCall()?.method === "POST", "Should use POST");
    assert((fetchMock.getLastCall()?.body as { schedule: { name: string } }).schedule.name === "新日程", "Should wrap in schedule object");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== updateSchedule ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_us/schedules/sch_us", (call) => {
      if (call.method === "PATCH") {
        return { status: 200, body: { id: "sch_us", name: (call.body as { schedule: { name: string } }).schedule.name, description: "", start_timestamp: "0", end_timestamp: "0", creator: { id: "bot" }, jump_channel_id: "", remind_type: "0" } };
      }
      return { status: 200, body: {} };
    });

    const schedule = await adapter.updateSchedule("ch_us", "sch_us", {
      name: "改名日程", description: "", start_timestamp: "1700000000000",
      end_timestamp: "1700003600000", jump_channel_id: "ch_j", remind_type: "0",
    });
    assert(schedule.name === "改名日程", "Should return updated schedule name");
    assert(fetchMock.getLastCall()?.method === "PATCH", "Should use PATCH");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== deleteSchedule ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_ds/schedules/sch_ds", (call) => {
      if (call.method === "DELETE") return { status: 200, body: {} };
      return { status: 200, body: {} };
    });

    await adapter.deleteSchedule("ch_ds", "sch_ds");
    assert(fetchMock.getLastCall()?.method === "DELETE", "Should use DELETE");
    assert(fetchMock.getLastCall()?.url.includes("/schedules/sch_ds"), "Should target schedule endpoint");

    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 8. API Permissions
// ══════════════════════════════════════════════════════

async function testApiPermissions(): Promise<void> {
  console.log("\n=== getApiPermissions ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_ap/api_permission", (call) => {
      if (call.method === "GET") {
        return { status: 200, body: { apis: [{ path: "/guilds/{guild_id}", method: "GET", desc: "获取频道信息" }, { path: "/channels/{channel_id}", method: "GET", desc: "获取子频道信息" }] } };
      }
      return { status: 200, body: {} };
    });

    const apis = await adapter.getApiPermissions("g_ap");
    assert(apis.length === 2, "Should return 2 apis");
    assert(apis[0].path === "/guilds/{guild_id}", "First api path should be /guilds/{guild_id}");
    assert(apis[0].method === "GET", "First api method should be GET");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== createApiPermissionDemand ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_apd/api_permission/demand", (call) => {
      if (call.method === "POST") {
        return { status: 200, body: { guild_id: "g_apd", channel_id: call.body?.channel_id, api_identify: call.body?.api_identify, title: "申请权限", desc: call.body?.desc } };
      }
      return { status: 200, body: {} };
    });

    const demand = await adapter.createApiPermissionDemand("g_apd", {
      channel_id: "ch_apd", api_identify: { path: "/guilds/{guild_id}", method: "GET" }, desc: "显示频道信息",
    });
    assert(demand.guild_id === "g_apd", "Should return guild_id");
    assert(demand.channel_id === "ch_apd", "Should return channel_id");
    assert(demand.api_identify.path === "/guilds/{guild_id}", "Should return api_identify.path");
    assert(demand.desc === "显示频道信息", "Should return desc");
    assert(fetchMock.getLastCall()?.method === "POST", "Should use POST");
    assert(fetchMock.getLastCall()?.body?.api_identify?.method === "GET", "Should send api_identify.method");

    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 9. Gateway & User
// ══════════════════════════════════════════════════════

async function testGatewayAndUser(): Promise<void> {
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
    assert(fetchMock.getLastCall()?.method === "GET", "Should use GET");
    assert(fetchMock.getLastCall()?.headers["Authorization"] === "QQBot mock-token-xyz", "Should include auth header");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== getGatewayBot ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/gateway/bot", () => ({
      status: 200,
      body: { url: "wss://api.sgroup.qq.com/websockets", shards: 3, session_start_limit: { total: 1000, remaining: 980, reset_after: 3600000, max_concurrency: 1 } },
    }));

    const gwBot = await adapter.getGatewayBot();
    assert(gwBot.url === "wss://api.sgroup.qq.com/websockets", "Should return WSS URL");
    assert(gwBot.shards === 3, "Should return shards=3");
    assert(gwBot.session_start_limit.remaining === 980, "Should return remaining=980");
    assert(gwBot.session_start_limit.max_concurrency === 1, "Should return max_concurrency=1");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== getBotSelfInfo ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/users/@me", (call) => {
      if (call.method === "GET") {
        return { status: 200, body: { id: "bot_123", username: "测试机器人", bot: true, avatar: "http://avatar.png" } };
      }
      return { status: 200, body: {} };
    });

    const bot = await adapter.getBotSelfInfo();
    assert(bot.id === "bot_123", "Should return bot id");
    assert(bot.username === "测试机器人", "Should return bot username");
    assert(bot.bot === true, "Should return bot=true");

    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 10. Channel Message Management
// ══════════════════════════════════════════════════════

async function testChannelMessageManagement(): Promise<void> {
  console.log("\n=== listChannelMessages ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_m/messages", (call) => {
      if (call.method === "GET") {
        return { status: 200, body: [
          { id: "msg1", channel_id: "ch_m", content: "Hello", timestamp: "2024-01-01T00:00:00+08:00", author: { id: "u1", username: "Alice" } },
          { id: "msg2", channel_id: "ch_m", content: "World", timestamp: "2024-01-02T00:00:00+08:00", author: { id: "u2", username: "Bob" } },
        ] };
      }
      return { status: 200, body: {} };
    });

    const messages = await adapter.listChannelMessages("ch_m", { before: "msg3", limit: 20, type: 1 });
    assert(messages.length === 2, "Should return 2 messages");
    assert(messages[0].id === "msg1", "First message id should be msg1");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.url.includes("before=msg3"), "Should include before param");
    assert(lastCall?.url.includes("limit=20"), "Should include limit=20");
    assert(lastCall?.url.includes("type=1"), "Should include type=1");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== getChannelMessage ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_gm/messages/msg_x", (call) => {
      if (call.method === "GET") {
        return { status: 200, body: { id: "msg_x", channel_id: "ch_gm", content: "消息详情", timestamp: "2024-01-01", author: { id: "u1", username: "Alice" } } };
      }
      return { status: 200, body: {} };
    });

    const msg = await adapter.getChannelMessage("ch_gm", "msg_x");
    assert(msg.id === "msg_x", "Should return message id");
    assert(msg.content === "消息详情", "Should return content");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== patchChannelMessage ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_pm/messages/msg_p", (call) => {
      if (call.method === "PATCH") {
        return { status: 200, body: { id: "msg_p", channel_id: "ch_pm", content: call.body?.content ?? "", timestamp: "2024-01-01", author: { id: "bot" } } };
      }
      return { status: 200, body: {} };
    });

    const msg = await adapter.patchChannelMessage("ch_pm", "msg_p", { content: "修改后内容" });
    assert(msg.id === "msg_p", "Should return message id");
    assert(fetchMock.getLastCall()?.method === "PATCH", "Should use PATCH");
    assert(fetchMock.getLastCall()?.body?.content === "修改后内容", "Should send content in body");

    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 11. Role CRUD
// ══════════════════════════════════════════════════════

async function testRoleCrud(): Promise<void> {
  console.log("\n=== createGuildRole ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_cr/roles", (call) => {
      if (call.method === "POST") {
        return { status: 200, body: { role: { id: "100", name: call.body?.name, color: call.body?.color, hoist: call.body?.hoist, number: 0, member_limit: 50, permissions: "0" }, role_id: "100" } };
      }
      return { status: 200, body: {} };
    });

    const result = await adapter.createGuildRole("g_cr", { name: "新身份组", color: 16711680, hoist: true });
    assert(result.role_id === "100", "Should return role_id=100");
    assert(result.role.name === "新身份组", "Should return role name");
    assert(result.role.color === 16711680, "Should return color");
    assert(fetchMock.getLastCall()?.method === "POST", "Should use POST");
    assert(fetchMock.getLastCall()?.body?.name === "新身份组", "Should send name");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== updateGuildRole ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_ur/roles/r_100", (call) => {
      if (call.method === "PATCH") {
        return { status: 200, body: { role: { id: "100", name: call.body?.name, color: call.body?.color, hoist: call.body?.hoist, number: 5, member_limit: 50, permissions: "0" }, role_id: "100" } };
      }
      return { status: 200, body: {} };
    });

    const result = await adapter.updateGuildRole("g_ur", "r_100", { name: "改名身份组", color: 0, hoist: false });
    assert(result.role.name === "改名身份组", "Should return updated name");
    assert(fetchMock.getLastCall()?.method === "PATCH", "Should use PATCH");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== deleteGuildRole ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_dr/roles/r_100", (call) => {
      if (call.method === "DELETE") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    await adapter.deleteGuildRole("g_dr", "r_100");
    assert(fetchMock.getLastCall()?.method === "DELETE", "Should use DELETE");
    assert(fetchMock.getLastCall()?.url.includes("/roles/r_100"), "Should target role endpoint");

    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 12. Pins
// ══════════════════════════════════════════════════════

async function testPins(): Promise<void> {
  console.log("\n=== addPinMessage ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_p/pins/msg_pin", (call) => {
      if (call.method === "PUT") return { status: 200, body: { message_ids: ["msg_pin", "msg_other"], channel_id: "ch_p" } };
      return { status: 200, body: {} };
    });

    const result = await adapter.addPinMessage("ch_p", "msg_pin");
    assert(result.message_ids.length === 2, "Should return 2 pinned message ids");
    assert(result.message_ids[0] === "msg_pin", "First pin should be msg_pin");
    assert(fetchMock.getLastCall()?.method === "PUT", "Should use PUT");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== deletePinMessage ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_dp/pins/msg_pin", (call) => {
      if (call.method === "DELETE") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    await adapter.deletePinMessage("ch_dp", "msg_pin");
    assert(fetchMock.getLastCall()?.method === "DELETE", "Should use DELETE");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== listPinMessages ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_lp/pins", (call) => {
      if (call.method === "GET") return { status: 200, body: { guild_id: "g_x", channel_id: "ch_lp", message_ids: ["p1", "p2", "p3"] } };
      return { status: 200, body: {} };
    });

    const result = await adapter.listPinMessages("ch_lp");
    assert(result.message_ids.length === 3, "Should return 3 pinned message ids");
    assert(result.message_ids[0] === "p1", "First pin should be p1");
    assert(result.channel_id === "ch_lp", "Should return channel_id");

    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 13. Speak & Message Settings
// ══════════════════════════════════════════════════════

async function testSpeakAndMessageSettings(): Promise<void> {
  console.log("\n=== getSpeakPrivilegeSettings ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_sp/speak_privilege_settings", (call) => {
      if (call.method === "GET") return { status: 200, body: { ch_1: "5", ch_2: "1" } };
      return { status: 200, body: {} };
    });

    const settings = await adapter.getSpeakPrivilegeSettings("g_sp");
    assert(settings["ch_1"] === "5", "Should return ch_1 permission='5'");
    assert(settings["ch_2"] === "1", "Should return ch_2 permission='1'");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== updateSpeakPrivilegeSettings ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_usp/speak_privilege_settings", (call) => {
      if (call.method === "PUT") return { status: 200, body: call.body };
      return { status: 200, body: {} };
    });

    const result = await adapter.updateSpeakPrivilegeSettings("g_usp", { ch_1: "8", ch_2: "4" });
    assert(result["ch_1"] === "8", "Should return updated ch_1=8");
    assert(fetchMock.getLastCall()?.method === "PUT", "Should use PUT");
    assert(fetchMock.getLastCall()?.body?.ch_1 === "8", "Should send ch_1 in body");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== getMessageSetting ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_ms/message_setting", () => ({
      status: 200, body: { guild_id: "g_ms", channel_id: "ch_ms", max_count: 5, window_seconds: 5 },
    }));

    const setting = await adapter.getMessageSetting("g_ms");
    assert(setting.guild_id === "g_ms", "Should return guild_id");
    assert(setting.max_count === 5, "Should return max_count=5");
    assert(setting.window_seconds === 5, "Should return window_seconds=5");

    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 14. Forum
// ══════════════════════════════════════════════════════

async function testForum(): Promise<void> {
  console.log("\n=== listThreads ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_t/threads", (call) => {
      if (call.method === "GET" && !call.url.includes("/threads/")) {
        return { status: 200, body: { threads: [{ channel_id: "ch_t", author: { id: "u1", username: "Alice" }, thread_info: { thread_id: "th_1", title: "帖子1", content: "内容1", date_time: "2024-01-01" } }] } };
      }
      return { status: 200, body: {} };
    });

    const result = await adapter.listThreads("ch_t");
    assert(result.threads.length === 1, "Should return 1 thread");
    assert(result.threads[0].thread_info.thread_id === "th_1", "Thread id should be th_1");
    assert(result.threads[0].thread_info.title === "帖子1", "Thread title should be '帖子1'");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== getThread ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_gt/threads/th_detail", (call) => {
      if (call.method === "GET") {
        return { status: 200, body: { channel_id: "ch_gt", author: { id: "u1", username: "Author" }, thread_info: { thread_id: "th_detail", title: "详细帖子", content: "详细内容", date_time: "2024-02-01" }, member: { roles: ["1"], joined_at: "2024-01-01" } } };
      }
      return { status: 200, body: {} };
    });

    const thread = await adapter.getThread("ch_gt", "th_detail");
    assert(thread.thread_info.title === "详细帖子", "Should return thread title");
    assert(thread.member?.roles.length === 1, "Should return member roles");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== publishThread ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_pt/threads", (call) => {
      if (call.method === "PUT") {
        return { status: 200, body: { channel_id: "ch_pt", author: { id: "bot", username: "Robot" }, thread_info: { thread_id: "new_th", title: call.body?.title, content: call.body?.content, date_time: "2024-03-01" } } };
      }
      return { status: 200, body: {} };
    });

    const thread = await adapter.publishThread("ch_pt", "新帖子", "帖子内容", 1);
    assert(thread.thread_info.thread_id === "new_th", "Should return new thread id");
    assert(thread.thread_info.title === "新帖子", "Should return title");
    assert(fetchMock.getLastCall()?.method === "PUT", "Should use PUT");
    assert(fetchMock.getLastCall()?.body?.title === "新帖子", "Should send title");
    assert(fetchMock.getLastCall()?.body?.format === 1, "Should send format=1");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== deleteThread ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_dt/threads/th_del", (call) => {
      if (call.method === "DELETE") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    await adapter.deleteThread("ch_dt", "th_del");
    assert(fetchMock.getLastCall()?.method === "DELETE", "Should use DELETE");
    assert(fetchMock.getLastCall()?.url.includes("/threads/th_del"), "Should target thread endpoint");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== listThreadComments ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_tc/threads/th_1/comments", () => ({
      status: 200,
      body: { comments: [
        { comment_id: "c1", content: "评论1", author: { id: "u1", username: "Alice" }, date_time: "2024-01-01" },
        { comment_id: "c2", content: "评论2", author: { id: "u2", username: "Bob" }, date_time: "2024-01-02" },
      ] },
    }));

    const result = await adapter.listThreadComments("ch_tc", "th_1");
    assert(result.comments.length === 2, "Should return 2 comments");
    assert(result.comments[0].comment_id === "c1", "First comment id should be c1");
    assert(result.comments[1].author.username === "Bob", "Second author should be Bob");

    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 15. Audio
// ══════════════════════════════════════════════════════

async function testAudio(): Promise<void> {
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

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== playAudio / pauseAudio / resumeAudio / stopAudio ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_au/audio", (call) => {
      if (call.method === "POST") return { status: 200, body: {} };
      return { status: 200, body: {} };
    });

    await adapter.playAudio("ch_au", "http://example.com/a.mp3", "歌名");
    assert(fetchMock.getLastCall()?.body?.status === 0, "playAudio should send status=0");
    assert(fetchMock.getLastCall()?.body?.audio_url === "http://example.com/a.mp3", "playAudio should send audio_url");

    await adapter.pauseAudio("ch_au");
    assert(fetchMock.getLastCall()?.body?.status === 1, "pauseAudio should send status=1");

    await adapter.resumeAudio("ch_au");
    assert(fetchMock.getLastCall()?.body?.status === 2, "resumeAudio should send status=2");

    await adapter.stopAudio("ch_au");
    assert(fetchMock.getLastCall()?.body?.status === 3, "stopAudio should send status=3");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== onMic / offMic ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_mic/mic", (call) => {
      if (call.method === "PUT" || call.method === "DELETE") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    await adapter.onMic("ch_mic");
    assert(fetchMock.getLastCall()?.method === "PUT", "onMic should use PUT");

    await adapter.offMic("ch_mic");
    assert(fetchMock.getLastCall()?.method === "DELETE", "offMic should use DELETE");

    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 16. Sandbox Environment
// ══════════════════════════════════════════════════════

async function testSandbox(): Promise<void> {
  console.log("\n=== Sandbox: production URL by default ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    assert(internals.getApiBase() === "https://api.sgroup.qq.com", "Default API base should be production URL");
    assert(internals.getWsUrl() === "wss://api.sgroup.qq.com/websocket", "Default WebSocket URL should be production URL");
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Sandbox: sandbox URL when sandbox:true ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter({ sandbox: true });
    assert(internals.getApiBase() === "https://sandbox.api.sgroup.qq.com", "Sandbox API base should be sandbox URL");
    assert(internals.getWsUrl() === "wss://sandbox.api.sgroup.qq.com/websocket", "Sandbox WebSocket URL should be sandbox URL");
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Sandbox: REST requests hit correct host ===");
  {
    const { adapter, fetchMock } = await createAdapter({ sandbox: true });
    fetchMock.route("/gateway", () => ({ status: 200, body: { url: "wss://sandbox.api.sgroup.qq.com/websocket" } }));
    await adapter.getGateway();
    assert(/^https:\/\/sandbox\.api\.sgroup\.qq\.com[\/]/.test(fetchMock.getLastCall()?.url ?? ""), "getGateway() should hit sandbox URL");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 50));

    const prod = await createAdapter({ sandbox: false });
    prod.fetchMock.route("/gateway", () => ({ status: 200, body: { url: "wss://api.sgroup.qq.com/websocket" } }));
    await prod.adapter.getGateway();
    assert(/^https:\/\/api\.sgroup\.qq\.com[\/]/.test(prod.fetchMock.getLastCall()?.url ?? ""), "getGateway() should hit production URL");
    await cleanup(prod.adapter, prod.fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 17. Sharding
// ══════════════════════════════════════════════════════

async function testSharding(): Promise<void> {
  console.log("\n=== Sharding: getShard() default ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    assert(internals.getShard() === undefined, "getShard() should return undefined by default");
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Sharding: getShard() with config ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter({ shard: [1, 3] });
    const shard = internals.getShard();
    assert(Array.isArray(shard), "getShard() should return an array");
    assert(shard?.[0] === 1, "Shard ID should be 1");
    assert(shard?.[1] === 3, "Total shards should be 3");
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Sharding: sendIdentify() default shard [0,1] ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    const { sentPayloads } = mockWs(internals);

    internals.sendIdentify();
    assert(sentPayloads.length === 1, "sendIdentify() should send one payload");
    const payload = sentPayloads[0] as { op: number; d: { shard: [number, number]; intents: number; token: string } };
    assert(payload.op === 2, "Opcode should be IDENTIFY (2)");
    assert(payload.d.shard[0] === 0, "Default shard ID should be 0");
    assert(payload.d.shard[1] === 1, "Default total shards should be 1");
    assert(payload.d.token === "QQBot mock-token-xyz", "Token should be included in IDENTIFY");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Sharding: sendIdentify() with custom shard ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter({ shard: [2, 5] });
    const { sentPayloads } = mockWs(internals);

    internals.sendIdentify();
    const payload = sentPayloads[0] as { d: { shard: [number, number] } };
    assert(payload.d.shard[0] === 2, "Shard ID should be 2 (from config)");
    assert(payload.d.shard[1] === 5, "Total shards should be 5 (from config)");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Sharding: sendIdentify() no-op when ws not open ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    internals.ws = null;
    internals.sendIdentify(); // should not throw
    assert(true, "sendIdentify() with null ws should not throw");
    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 18. Intents
// ══════════════════════════════════════════════════════

async function testIntents(): Promise<void> {
  console.log("\n=== Intents: default = GUILDS | PUBLIC_GUILD_MESSAGES ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    const expected = (1 << 0) | (1 << 30);
    assert(internals.getIntents() === expected, `Default intents should be ${expected}, got ${internals.getIntents()}`);
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Intents: config.intents overrides ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter({ intents: 42 });
    assert(internals.getIntents() === 42, `config.intents=42 should take precedence, got ${internals.getIntents()}`);
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Intents: intentNames converts to bitfield ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter({ intentNames: ["GUILDS", "GUILD_MEMBERS", "DIRECT_MESSAGE"] });
    const expected = (1 << 0) | (1 << 1) | (1 << 12);
    assert(internals.getIntents() === expected, `intentNames should be ${expected}, got ${internals.getIntents()}`);
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Intents: GROUP_AT_MESSAGE_CREATE contributes 0 ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter({ intentNames: ["GROUP_AT_MESSAGE_CREATE", "C2C_MESSAGE_CREATE"] });
    assert(internals.getIntents() === 0, `GROUP_AT_MESSAGE_CREATE + C2C_MESSAGE_CREATE should be 0, got ${internals.getIntents()}`);
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Intents: full set combines all bits ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter({
      intentNames: ["GUILDS", "GUILD_MEMBERS", "GUILD_MESSAGES", "GUILD_MESSAGE_REACTIONS", "DIRECT_MESSAGE", "INTERACTION", "MESSAGE_AUDIT", "FORUMS_EVENT", "AUDIO_ACTION", "PUBLIC_GUILD_MESSAGES"],
    });
    const expected = (1<<0)|(1<<1)|(1<<9)|(1<<10)|(1<<12)|(1<<26)|(1<<27)|(1<<28)|(1<<29)|(1<<30);
    assert(internals.getIntents() === expected, `All intentNames should be ${expected}, got ${internals.getIntents()}`);
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== Intents: sendIdentify() includes intents ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter({ intentNames: ["GUILDS", "INTERACTION"] });
    const { sentPayloads } = mockWs(internals);

    internals.sendIdentify();
    const payload = sentPayloads[0] as { d: { intents: number } };
    const expected = (1 << 0) | (1 << 26);
    assert(payload.d.intents === expected, `IDENTIFY payload intents should be ${expected}, got ${payload.d.intents}`);
    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// 19. onRawEvent
// ══════════════════════════════════════════════════════

async function testOnRawEvent(): Promise<void> {
  console.log("\n=== onRawEvent: GUILD_CREATE dispatched ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    let received: unknown = null;
    const dispose = adapter.onRawEvent("GUILD_CREATE", (data) => { received = data; });

    const testData = { id: "guild_123", name: "Test Guild" };
    internals.handleDispatch("GUILD_CREATE", 5, testData);
    assert(received === testData, "GUILD_CREATE handler should receive the data object");

    dispose();
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== onRawEvent: CHANNEL/GUILD/MEMBER/REACTION events ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    const events: string[] = [];

    const eventTypes = ["CHANNEL_CREATE", "CHANNEL_UPDATE", "CHANNEL_DELETE", "GUILD_CREATE", "GUILD_UPDATE", "GUILD_DELETE", "GUILD_MEMBER_ADD", "GUILD_MEMBER_UPDATE", "GUILD_MEMBER_REMOVE", "MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE"];
    for (const ev of eventTypes) {
      adapter.onRawEvent(ev, () => { events.push(ev); });
    }
    for (const ev of eventTypes) {
      internals.handleDispatch(ev, 1, {});
    }

    assert(events.length === eventTypes.length, `All ${eventTypes.length} events should fire, got ${events.length}`);
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== onRawEvent: INTERACTION_CREATE ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    let received: unknown = null;
    adapter.onRawEvent("INTERACTION_CREATE", (data) => { received = data; });

    const interactionData = { id: "i1", data: { cmd: "click" }, type: 11 };
    internals.handleDispatch("INTERACTION_CREATE", 1, interactionData);
    assert(received === interactionData, "INTERACTION_CREATE data should be passed to handler");
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== onRawEvent: MESSAGE_AUDIT_PASS / REJECT ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    const results: string[] = [];
    adapter.onRawEvent("MESSAGE_AUDIT_PASS", () => { results.push("PASS"); });
    adapter.onRawEvent("MESSAGE_AUDIT_REJECT", () => { results.push("REJECT"); });

    internals.handleDispatch("MESSAGE_AUDIT_PASS", 1, { audit_id: "a1" });
    internals.handleDispatch("MESSAGE_AUDIT_REJECT", 2, { audit_id: "a2" });
    assert(results.length === 2, `Both audit events should fire, got ${results.length}`);
    assert(results[0] === "PASS", "First should be PASS");
    assert(results[1] === "REJECT", "Second should be REJECT");
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== onRawEvent: FORUM events ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    const events: string[] = [];
    const forumEvents = ["FORUM_THREAD_CREATE", "FORUM_THREAD_UPDATE", "FORUM_THREAD_DELETE", "FORUM_POST_CREATE", "FORUM_POST_DELETE", "FORUM_REPLY_CREATE", "FORUM_REPLY_DELETE", "FORUM_PUBLISH_AUDIT_RESULT"];
    for (const ev of forumEvents) { adapter.onRawEvent(ev, () => { events.push(ev); }); }
    for (const ev of forumEvents) { internals.handleDispatch(ev, 1, { id: "t1" }); }
    assert(events.length === forumEvents.length, `All ${forumEvents.length} forum events should fire, got ${events.length}`);
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== onRawEvent: AUDIO events ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    const events: string[] = [];
    const audioEvents = ["AUDIO_START", "AUDIO_FINISH", "AUDIO_ON_MIC", "AUDIO_OFF_MIC"];
    for (const ev of audioEvents) { adapter.onRawEvent(ev, () => { events.push(ev); }); }
    for (const ev of audioEvents) { internals.handleDispatch(ev, 1, {}); }
    assert(events.length === 4, `All 4 audio events should fire, got ${events.length}`);
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== onRawEvent: READY / RESUMED ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    let readyReceived: unknown = null;
    let resumedReceived = false;
    adapter.onRawEvent("READY", (data) => { readyReceived = data; });
    adapter.onRawEvent("RESUMED", () => { resumedReceived = true; });

    const readyData = { user: { id: "bot1", username: "TestBot" }, session_id: "sess-xyz" };
    internals.handleDispatch("READY", 1, readyData);
    assert(readyReceived === readyData, "READY data should be passed to handler");
    assert((adapter as unknown as { sessionId: string }).sessionId === "sess-xyz", "READY should set sessionId internally");

    internals.handleDispatch("RESUMED", 2, {});
    assert(resumedReceived, "RESUMED event should fire");
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== onRawEvent: wildcard '*' ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    const allEvents: Array<{ type: string; data: unknown }> = [];
    adapter.onRawEvent("*", (envelope) => { allEvents.push(envelope as { type: string; data: unknown }); });

    internals.handleDispatch("GUILD_CREATE", 1, { id: "g1" });
    internals.handleDispatch("INTERACTION_CREATE", 2, { id: "i1" });
    internals.handleDispatch("AUDIO_START", 3, {});

    assert(allEvents.length === 3, `Wildcard should receive all 3 events, got ${allEvents.length}`);
    assert(allEvents[0].type === "GUILD_CREATE", "First wildcard event should be GUILD_CREATE");
    assert(allEvents[1].type === "INTERACTION_CREATE", "Second should be INTERACTION_CREATE");
    assert(allEvents[2].type === "AUDIO_START", "Third should be AUDIO_START");
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== onRawEvent: unknown event via default case ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    let received: unknown = null;
    adapter.onRawEvent("CUSTOM_UNKNOWN_EVENT", (data) => { received = data; });

    const customData = { foo: "bar", baz: 42 };
    internals.handleDispatch("CUSTOM_UNKNOWN_EVENT", 1, customData);
    assert(received === customData, "Unknown event types should be dispatched via default case");
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== onRawEvent: disposer unsubscribes ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    let callCount = 0;
    const dispose = adapter.onRawEvent("GUILD_CREATE", () => { callCount++; });

    internals.handleDispatch("GUILD_CREATE", 1, {});
    assert(callCount === 1, `First dispatch should call handler (count=${callCount})`);

    dispose();
    internals.handleDispatch("GUILD_CREATE", 2, {});
    assert(callCount === 1, `After dispose, handler should not be called (count=${callCount})`);
    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== onRawEvent: multiple handlers + undefined eventType + error safety ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    let count1 = 0, count2 = 0;
    adapter.onRawEvent("GUILD_CREATE", () => { count1++; });
    adapter.onRawEvent("GUILD_CREATE", () => { count2++; });
    internals.handleDispatch("GUILD_CREATE", 1, {});
    assert(count1 === 1 && count2 === 1, "Multiple handlers for same event should all fire");

    let wildcardCount = 0;
    adapter.onRawEvent("*", () => { wildcardCount++; });
    internals.handleDispatch(undefined, 1, {});
    assert(wildcardCount === 0, "Undefined eventType should not fire any handler");

    adapter.onRawEvent("GUILD_CREATE", () => { throw new Error("Handler error"); });
    internals.handleDispatch("GUILD_CREATE", 1, {}); // should not crash
    assert(true, "handleDispatch should not propagate handler exceptions");

    await cleanup(adapter, fetchMock);
  }

  console.log("\n=== onRawEvent: seq tracked in lastSeq ===");
  {
    const { adapter, fetchMock, internals } = await createAdapter();
    internals.handleDispatch("GUILD_CREATE", 42, {});
    assert((adapter as unknown as { lastSeq: number | null }).lastSeq === 42, "lastSeq should be 42 after dispatch with seq=42");
    await cleanup(adapter, fetchMock);
  }
}

// ══════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║   QQ Official Bot Adapter — Unit Tests           ║");
  console.log("╚══════════════════════════════════════════════════╝");

  await testRichMediaUpload();
  await testExtendedSend();
  await testMessageRecall();
  await testEmojiReactions();
  await testGuildApi();
  await testChannelApi();
  await testAnnouncesAndSchedule();
  await testApiPermissions();
  await testGatewayAndUser();
  await testChannelMessageManagement();
  await testRoleCrud();
  await testPins();
  await testSpeakAndMessageSettings();
  await testForum();
  await testAudio();
  await testSandbox();
  await testSharding();
  await testIntents();
  await testOnRawEvent();

  console.log("\n==================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("==================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
