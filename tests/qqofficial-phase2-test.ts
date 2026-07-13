/**
 * Unit tests for QQ Official Bot adapter Phase 2 APIs.
 *
 * Tests:
 * - Guild API: getGuild, getGuilds, getGuildMembers, getGuildMember,
 *              deleteGuildMember, modifyGuildMember, mute/unmute,
 *              getGuildRoles, getRoleMembers, addRoleToMember, removeRoleFromMember
 * - Channel API: getGuildChannels, getChannel, createChannel, updateChannel,
 *                deleteChannel, getChannelOnlineNums,
 *                getChannelUserPermissions, updateChannelUserPermissions,
 *                getChannelRolePermissions, updateChannelRolePermissions
 * - Announces API: getAnnounces, createAnnounce, deleteAnnounce
 * - Schedule API: getSchedules, createSchedule, updateSchedule, deleteSchedule
 * - API Permissions: getApiPermissions, createApiPermissionDemand
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

async function createAdapter(): Promise<{ adapter: QQOfficialAdapter; fetchMock: FetchMock }> {
  const config: QQOfficialAdapterConfig = {
    type: "qqofficial",
    id: "test-qq-official-p2",
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
  // Guild API
  // ══════════════════════════════════════════════════════

  console.log("\n=== getGuild ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/guild_123", (call) => {
      if (call.method === "GET") {
        return {
          status: 200,
          body: { id: "guild_123", name: "测试频道", icon: "icon_hash", owner_id: "owner_1", member_count: 100 },
        };
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== getGuilds (with pagination) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/users/@me/guilds", () => ({
      status: 200,
      body: [
        { id: "g1", name: "频道1", icon: "" },
        { id: "g2", name: "频道2", icon: "" },
      ],
    }));

    const guilds = await adapter.getGuilds({ after: "g0", limit: 50 });
    assert(guilds.length === 2, "Should return 2 guilds");
    assert(guilds[0].id === "g1", "First guild id should be g1");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.url.includes("after=g0"), "Should include after param");
    assert(lastCall?.url.includes("limit=50"), "Should include limit param");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== getGuildMember ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_x/members/u_y", (call) => {
      if (call.method === "GET") {
        return {
          status: 200,
          body: { user: { id: "u_y", username: "Charlie" }, nick: "查理", roles: ["5"], joined_at: "2024-03-01" },
        };
      }
      return { status: 200, body: {} };
    });

    const member = await adapter.getGuildMember("g_x", "u_y");
    assert(member.user.username === "Charlie", "Should return member username");
    assert(member.nick === "查理", "Should return member nick");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== muteGuildMember / unmuteGuildMember ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_mu/members/u_mu", (call) => {
      if (call.method === "PATCH") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    await adapter.muteGuildMember("g_mu", "u_mu", 300);
    let lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.mute_seconds === "300", "muteGuildMember should send mute_seconds=300");

    await adapter.unmuteGuildMember("g_mu", "u_mu");
    lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.mute_seconds === "0", "unmuteGuildMember should send mute_seconds=0");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== getRoleMembers ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_rm/roles/5/members", () => ({
      status: 200,
      body: {
        members: [
          { user: { id: "admin1", username: "管理员1" }, nick: "", roles: ["5"], joined_at: "2024-01-01" },
        ],
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== addRoleToMember / removeRoleFromMember ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_ar/members/u_ar/roles/7", (call) => {
      if (call.method === "PUT" || call.method === "DELETE") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    await adapter.addRoleToMember("g_ar", "u_ar", "7");
    let lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "PUT", "addRoleToMember should use PUT");

    await adapter.removeRoleFromMember("g_ar", "u_ar", "7");
    lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "DELETE", "removeRoleFromMember should use DELETE");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  // ══════════════════════════════════════════════════════
  // Channel API
  // ══════════════════════════════════════════════════════

  console.log("\n=== getGuildChannels ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_c/channels", () => ({
      status: 200,
      body: [
        { id: "ch1", guild_id: "g_c", name: "文字频道1", type: 0 },
        { id: "ch2", guild_id: "g_c", name: "语音频道", type: 2 },
      ],
    }));

    const channels = await adapter.getGuildChannels("g_c");
    assert(channels.length === 2, "Should return 2 channels");
    assert(channels[0].id === "ch1", "First channel id should be ch1");
    assert(channels[1].type === 2, "Second channel type should be 2 (voice)");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== getChannel ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_detail", (call) => {
      if (call.method === "GET") {
        return {
          status: 200,
          body: { id: "ch_detail", guild_id: "g_c", name: "公告板", type: 0, sub_type: 2 },
        };
      }
      return { status: 200, body: {} };
    });

    const channel = await adapter.getChannel("ch_detail");
    assert(channel.id === "ch_detail", "Should return channel id");
    assert(channel.name === "公告板", "Should return channel name");
    assert(channel.sub_type === 2, "Should return sub_type=2 (公告)");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== createChannel ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_nc/channels", (call) => {
      if (call.method === "POST") {
        return {
          status: 200,
          body: { id: "new_ch", guild_id: "g_nc", name: call.body?.name, type: call.body?.type },
        };
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== updateChannel ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_upd", (call) => {
      if (call.method === "PATCH") {
        return {
          status: 200,
          body: { id: "ch_upd", guild_id: "g", name: call.body?.name, type: 0 },
        };
      }
      return { status: 200, body: {} };
    });

    const channel = await adapter.updateChannel("ch_upd", { name: "改名后" });
    assert(channel.name === "改名后", "Should return updated name");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "PATCH", "Should use PATCH");
    assert(lastCall?.body?.name === "改名后", "Should send name in body");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== getChannelUserPermissions ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_p/permissions/u_p", (call) => {
      if (call.method === "GET") {
        return { status: 200, body: { permissions: "5" } };
      }
      return { status: 200, body: {} };
    });

    const perms = await adapter.getChannelUserPermissions("ch_p", "u_p");
    assert(perms.permissions === "5", "Should return permissions='5'");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== updateChannelUserPermissions (PUT/PATCH) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_up/permissions/u_up", (call) => {
      if (call.method === "PUT" || call.method === "PATCH") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    await adapter.updateChannelUserPermissions("ch_up", "u_up", { permissions: "8" }, false);
    let lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "PUT", "Default should use PUT (overwrite)");
    assert(lastCall?.body?.add === "8", "Should send add=8");

    await adapter.updateChannelUserPermissions("ch_up", "u_up", { permissions: "16" }, true);
    lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "PATCH", "additive=true should use PATCH");
    assert(lastCall?.body?.add === "16", "Should send add=16");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== getChannelRolePermissions ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_rp/permissions/r_5", (call) => {
      if (call.method === "GET") {
        return { status: 200, body: { permissions: "16" } };
      }
      return { status: 200, body: {} };
    });

    const perms = await adapter.getChannelRolePermissions("ch_rp", "r_5");
    assert(perms.permissions === "16", "Should return role permissions='16'");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== updateChannelRolePermissions ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_urp/permissions/r_5", (call) => {
      if (call.method === "PUT" || call.method === "PATCH") return { status: 204, body: null };
      return { status: 200, body: {} };
    });

    await adapter.updateChannelRolePermissions("ch_urp", "r_5", { permissions: "64" });
    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "PUT", "Default should use PUT");
    assert(lastCall?.body?.add === "64", "Should send add=64");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  // ══════════════════════════════════════════════════════
  // Announces API
  // ══════════════════════════════════════════════════════

  console.log("\n=== getAnnounces ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_a/announces", (call) => {
      if (call.method === "GET") {
        return {
          status: 200,
          body: [
            { guild_id: "g_a", channel_id: "ch_a", message_id: "msg_a" },
            { guild_id: "g_a", channel_id: "ch_b", message_id: "msg_b" },
          ],
        };
      }
      return { status: 200, body: {} };
    });

    const announces = await adapter.getAnnounces("g_a");
    assert(announces.length === 2, "Should return 2 announces");
    assert(announces[0].message_id === "msg_a", "First announce message_id should be msg_a");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== createAnnounce ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_ca/announces", (call) => {
      if (call.method === "POST") {
        return {
          status: 200,
          body: { guild_id: "g_ca", channel_id: call.body?.channel_id, message_id: call.body?.message_id },
        };
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  // ══════════════════════════════════════════════════════
  // Schedule API
  // ══════════════════════════════════════════════════════

  console.log("\n=== getSchedules ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_s/schedules", (call) => {
      if (call.method === "GET") {
        return {
          status: 200,
          body: [
            {
              id: "sch_1",
              name: "会议1",
              description: "周会",
              start_timestamp: "1700000000000",
              end_timestamp: "1700003600000",
              creator: { id: "u_1", username: "Organizer" },
              jump_channel_id: "ch_meeting",
              remind_type: "1",
            },
          ],
        };
      }
      return { status: 200, body: {} };
    });

    const schedules = await adapter.getSchedules("ch_s", "1700000000000");
    assert(schedules.length === 1, "Should return 1 schedule");
    assert(schedules[0].id === "sch_1", "Schedule id should be sch_1");
    assert(schedules[0].name === "会议1", "Schedule name should be '会议1'");
    assert(schedules[0].remind_type === "1", "Schedule remind_type should be 1");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.url.includes("since=1700000000000"), "Should include since param");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== createSchedule ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_cs/schedules", (call) => {
      if (call.method === "POST") {
        const sched = (call.body as { schedule: { name: string } }).schedule;
        return {
          status: 200,
          body: {
            id: "new_sch",
            name: sched.name,
            description: "",
            start_timestamp: "0",
            end_timestamp: "0",
            creator: { id: "bot" },
            jump_channel_id: "",
            remind_type: "0",
          },
        };
      }
      return { status: 200, body: {} };
    });

    const schedule = await adapter.createSchedule("ch_cs", {
      name: "新日程",
      description: "描述",
      start_timestamp: "1700000000000",
      end_timestamp: "1700003600000",
      jump_channel_id: "ch_j",
      remind_type: "2",
    });
    assert(schedule.id === "new_sch", "Should return new schedule id");
    assert(schedule.name === "新日程", "Should return schedule name");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "POST", "Should use POST");
    assert((lastCall?.body as { schedule: { name: string } }).schedule.name === "新日程", "Should wrap in schedule object");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== updateSchedule ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_us/schedules/sch_us", (call) => {
      if (call.method === "PATCH") {
        return {
          status: 200,
          body: {
            id: "sch_us",
            name: (call.body as { schedule: { name: string } }).schedule.name,
            description: "",
            start_timestamp: "0",
            end_timestamp: "0",
            creator: { id: "bot" },
            jump_channel_id: "",
            remind_type: "0",
          },
        };
      }
      return { status: 200, body: {} };
    });

    const schedule = await adapter.updateSchedule("ch_us", "sch_us", {
      name: "改名日程",
      description: "",
      start_timestamp: "1700000000000",
      end_timestamp: "1700003600000",
      jump_channel_id: "ch_j",
      remind_type: "0",
    });
    assert(schedule.name === "改名日程", "Should return updated schedule name");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "PATCH", "Should use PATCH");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== deleteSchedule ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/ch_ds/schedules/sch_ds", (call) => {
      if (call.method === "DELETE") return { status: 200, body: {} };
      return { status: 200, body: {} };
    });

    await adapter.deleteSchedule("ch_ds", "sch_ds");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "DELETE", "Should use DELETE");
    assert(lastCall?.url.includes("/schedules/sch_ds"), "Should target schedule endpoint");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  // ══════════════════════════════════════════════════════
  // API Permissions
  // ══════════════════════════════════════════════════════

  console.log("\n=== getApiPermissions ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_ap/api_permission", (call) => {
      if (call.method === "GET") {
        return {
          status: 200,
          body: {
            apis: [
              { path: "/guilds/{guild_id}", method: "GET", desc: "获取频道信息" },
              { path: "/channels/{channel_id}", method: "GET", desc: "获取子频道信息" },
            ],
          },
        };
      }
      return { status: 200, body: {} };
    });

    const apis = await adapter.getApiPermissions("g_ap");
    assert(apis.length === 2, "Should return 2 apis");
    assert(apis[0].path === "/guilds/{guild_id}", "First api path should be /guilds/{guild_id}");
    assert(apis[0].method === "GET", "First api method should be GET");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== createApiPermissionDemand ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/guilds/g_apd/api_permission/demand", (call) => {
      if (call.method === "POST") {
        return {
          status: 200,
          body: {
            guild_id: "g_apd",
            channel_id: call.body?.channel_id,
            api_identify: call.body?.api_identify,
            title: "申请权限",
            desc: call.body?.desc,
          },
        };
      }
      return { status: 200, body: {} };
    });

    const demand = await adapter.createApiPermissionDemand("g_apd", {
      channel_id: "ch_apd",
      api_identify: { path: "/guilds/{guild_id}", method: "GET" },
      desc: "显示频道信息",
    });
    assert(demand.guild_id === "g_apd", "Should return guild_id");
    assert(demand.channel_id === "ch_apd", "Should return channel_id");
    assert(demand.api_identify.path === "/guilds/{guild_id}", "Should return api_identify.path");
    assert(demand.desc === "显示频道信息", "Should return desc");

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.method === "POST", "Should use POST");
    assert(lastCall?.body?.api_identify?.method === "GET", "Should send api_identify.method");

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
