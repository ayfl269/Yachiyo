/**
 * Unit tests for OneBot11 adapter event handling and extended APIs.
 *
 * Phase 3: Request events (friend/group join) + auto-approve
 * Phase 4: Notice events (poke, recall, member changes, file upload)
 * Phase 5: Group management APIs (kick, ban, card, name, leave, admin, title)
 * Phase 6: Info query APIs (friend list, group list, member info, etc.)
 */

import { OneBot11Adapter } from "@yachiyo/platform/implementations/onebot11-adapter.js";
import type { OneBot11AdapterConfig } from "@yachiyo/platform/config.js";
import { AsyncQueue } from "@yachiyo/common/async-queue.js";
import { WebSocketServer, WebSocket } from "ws";
import { MessageEvent } from "@yachiyo/message/event.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  \u2714 ${message}`);
  } else {
    failed++;
    console.error(`  \u2717 ${message}`);
  }
}

class MockNapcatServer {
  private wss: WebSocketServer;
  public lastReceivedAction: string | null = null;
  public lastReceivedParams: Record<string, unknown> | null = null;
  public messageHandler: ((msg: Record<string, unknown>) => void) | null = null;

  constructor(port: number) {
    this.wss = new WebSocketServer({ port, host: "127.0.0.1" });
    this.wss.on("connection", (ws: WebSocket) => {
      ws.on("message", (raw: Buffer) => {
        const msg = JSON.parse(raw.toString());
        this.lastReceivedAction = msg.action;
        this.lastReceivedParams = msg.params;
        if (this.messageHandler) {
          this.messageHandler(msg);
        }
      });
    });
  }

  broadcast(data: Record<string, unknown>): void {
    const json = JSON.stringify(data);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }

  async waitForConnection(timeoutMs: number = 3000): Promise<void> {
    const start = Date.now();
    while (this.wss.clients.size === 0) {
      if (Date.now() - start > timeoutMs) throw new Error("Timeout waiting for WS connection");
      await new Promise(r => setTimeout(r, 50));
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.wss.clients) {
        try { client.close(); } catch { /* ignore */ }
      }
      this.wss.close(() => resolve());
    });
  }
}

async function createAdapterAndServer(
  port: number,
  configOverrides?: Partial<OneBot11AdapterConfig>,
): Promise<{ adapter: OneBot11Adapter; server: MockNapcatServer; eventQueue: AsyncQueue<MessageEvent> }> {
  const server = new MockNapcatServer(port);
  const config: OneBot11AdapterConfig = {
    type: "onebot11",
    id: "test-ob11",
    direction: "reverse",
    reverseUrl: `ws://127.0.0.1:${port}`,
    reconnectInterval: 1000,
    ...configOverrides,
  };
  const eventQueue = new AsyncQueue<MessageEvent>();
  const adapter = new OneBot11Adapter(config, eventQueue);
  await adapter.initialize();
  await adapter.run();
  await server.waitForConnection();
  await new Promise(r => setTimeout(r, 100));

  // Default response handler: respond to any API call with empty success
  server.messageHandler = (msg) => {
    server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
  };

  return { adapter, server, eventQueue };
}

async function drainEvents(queue: AsyncQueue<MessageEvent>, timeoutMs: number = 500): Promise<MessageEvent[]> {
  // NOTE: We must use AbortSignal (not Promise.race) to cancel the queue.get() waiter.
  // Otherwise the abandoned waiter stays in AsyncQueue.waiters and silently consumes
  // the next put() event — causing the event to be lost (the "lost item" problem).
  const events: MessageEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(remaining, 200));
    try {
      const event = await queue.get(controller.signal);
      events.push(event);
    } catch {
      // Aborted — no event within this window
      clearTimeout(timeout);
      break;
    }
    clearTimeout(timeout);
  }
  return events;
}

async function main(): Promise<void> {
  const port = 18766;

  // ══════════════════════════════════════════════════════
  // Phase 3: Request Event Handling
  // ══════════════════════════════════════════════════════

  // ── Test: friend request auto-reject (default) ──
  console.log("\n=== Phase 3: friend request auto-reject (default) ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    let receivedAction: string | null = null;
    let receivedParams: Record<string, unknown> | null = null;
    server.messageHandler = (msg) => {
      receivedAction = msg.action;
      receivedParams = msg.params;
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    // Send friend request event
    server.broadcast({
      post_type: "request",
      request_type: "friend",
      user_id: 111111,
      comment: "Hello, let's be friends!",
      flag: "flag_friend_001",
      time: Math.floor(Date.now() / 1000),
      self_id: 999,
    });

    await new Promise(r => setTimeout(r, 300));

    assert(receivedAction === "set_friend_add_request", "Should call set_friend_add_request");
    assert(receivedParams?.flag === "flag_friend_001", "Should pass correct flag");
    assert(receivedParams?.approve === false, "Should auto-reject by default");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Test: friend request auto-approve ──
  console.log("\n=== Phase 3: friend request auto-approve ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port, { autoApproveFriend: true });

    let receivedParams: Record<string, unknown> | null = null;
    server.messageHandler = (msg) => {
      receivedParams = msg.params;
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    server.broadcast({
      post_type: "request",
      request_type: "friend",
      user_id: 222222,
      comment: "Add me please",
      flag: "flag_friend_002",
      time: Math.floor(Date.now() / 1000),
      self_id: 999,
    });

    await new Promise(r => setTimeout(r, 300));
    assert(receivedParams?.approve === true, "Should auto-approve when configured");
    assert(receivedParams?.flag === "flag_friend_002", "Should pass correct flag");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Test: group request auto-reject ──
  console.log("\n=== Phase 3: group request auto-reject ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port, { autoRejectReason: "Not accepting" });

    let receivedAction: string | null = null;
    let receivedParams: Record<string, unknown> | null = null;
    server.messageHandler = (msg) => {
      receivedAction = msg.action;
      receivedParams = msg.params;
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    server.broadcast({
      post_type: "request",
      request_type: "group",
      sub_type: "add",
      group_id: 333333,
      user_id: 444444,
      comment: "Let me in",
      flag: "flag_group_001",
      time: Math.floor(Date.now() / 1000),
      self_id: 999,
    });

    await new Promise(r => setTimeout(r, 300));
    assert(receivedAction === "set_group_add_request", "Should call set_group_add_request");
    assert(receivedParams?.approve === false, "Should auto-reject group request by default");
    assert(receivedParams?.reason === "Not accepting", "Should pass reject reason");
    assert(receivedParams?.sub_type === "add", "Should pass sub_type");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Test: group invite auto-approve ──
  console.log("\n=== Phase 3: group invite auto-approve ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port, { autoApproveGroup: true });

    let receivedParams: Record<string, unknown> | null = null;
    server.messageHandler = (msg) => {
      receivedParams = msg.params;
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    server.broadcast({
      post_type: "request",
      request_type: "group",
      sub_type: "invite",
      group_id: 555555,
      user_id: 666666,
      comment: "Invited",
      flag: "flag_group_002",
      time: Math.floor(Date.now() / 1000),
      self_id: 999,
    });

    await new Promise(r => setTimeout(r, 300));
    assert(receivedParams?.approve === true, "Should auto-approve group invite when configured");
    assert(receivedParams?.sub_type === "invite", "Should pass sub_type=invite");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Test: setFriendAddRequest API ──
  console.log("\n=== Phase 3: setFriendAddRequest API ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    let receivedAction: string | null = null;
    let receivedParams: Record<string, unknown> | null = null;
    server.messageHandler = (msg) => {
      receivedAction = msg.action;
      receivedParams = msg.params;
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    await adapter.setFriendAddRequest("flag_123", true, "Friend");
    assert(receivedAction === "set_friend_add_request", "Should call set_friend_add_request");
    assert(receivedParams?.flag === "flag_123", "Should pass flag");
    assert(receivedParams?.approve === true, "Should pass approve=true");
    assert(receivedParams?.remark === "Friend", "Should pass remark");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Test: setGroupAddRequest API ──
  console.log("\n=== Phase 3: setGroupAddRequest API ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    let receivedAction: string | null = null;
    let receivedParams: Record<string, unknown> | null = null;
    server.messageHandler = (msg) => {
      receivedAction = msg.action;
      receivedParams = msg.params;
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    await adapter.setGroupAddRequest("flag_456", "add", false, "Full");
    assert(receivedAction === "set_group_add_request", "Should call set_group_add_request");
    assert(receivedParams?.flag === "flag_456", "Should pass flag");
    assert(receivedParams?.sub_type === "add", "Should pass sub_type");
    assert(receivedParams?.approve === false, "Should pass approve=false");
    assert(receivedParams?.reason === "Full", "Should pass reason");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ══════════════════════════════════════════════════════
  // Phase 4: Notice Event Handling
  // ══════════════════════════════════════════════════════

  // ── Test: poke → synthetic message ──
  console.log("\n=== Phase 4: poke → synthetic message ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    // Drain any existing events
    await drainEvents(eventQueue, 200);

    // Send poke notice (group)
    server.broadcast({
      post_type: "notice",
      notice_type: "poke",
      group_id: 777777,
      user_id: 100,
      target_id: 999,
      time: Math.floor(Date.now() / 1000),
      self_id: 999,
    });

    const events = await drainEvents(eventQueue, 500);
    assert(events.length > 0, "Should produce a synthetic message event for poke");
    if (events.length > 0) {
      const msg = events[0];
      assert(msg.messageStr.includes("戳一戳"), "Message should contain poke text");
      assert(msg.messageStr.includes("用户100"), "Message should contain poker name");
    }

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Test: poke (notify sub_type) → synthetic message ──
  console.log("\n=== Phase 4: poke via notify sub_type ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    await drainEvents(eventQueue, 200);

    // Some implementations send poke as notice_type=notify, sub_type=poke
    server.broadcast({
      post_type: "notice",
      notice_type: "notify",
      sub_type: "poke",
      group_id: 888888,
      user_id: 200,
      target_id: 999,
      time: Math.floor(Date.now() / 1000),
      self_id: 999,
    });

    const events = await drainEvents(eventQueue, 500);
    assert(events.length > 0, "Should produce synthetic message for notify/poke");
    if (events.length > 0) {
      assert(events[0].messageStr.includes("戳一戳"), "Message should contain poke text");
    }

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Test: poke disabled via config ──
  console.log("\n=== Phase 4: poke disabled via config ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port, { pokeToMessage: false });

    await drainEvents(eventQueue, 200);

    server.broadcast({
      post_type: "notice",
      notice_type: "poke",
      group_id: 111111,
      user_id: 300,
      target_id: 999,
      time: Math.floor(Date.now() / 1000),
      self_id: 999,
    });

    const events = await drainEvents(eventQueue, 500);
    assert(events.length === 0, "Should NOT produce synthetic message when pokeToMessage=false");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Test: group_upload → synthetic message with file ──
  console.log("\n=== Phase 4: group_upload → synthetic message ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    await drainEvents(eventQueue, 200);

    server.broadcast({
      post_type: "notice",
      notice_type: "group_upload",
      group_id: 123456,
      user_id: 400,
      file: { id: "file_id_abc", name: "report.pdf", size: 1048576 },
      time: Math.floor(Date.now() / 1000),
      self_id: 999,
    });

    const events = await drainEvents(eventQueue, 500);
    assert(events.length > 0, "Should produce synthetic message for group_upload");
    if (events.length > 0) {
      const msg = events[0];
      assert(msg.messageStr.includes("report.pdf"), "Message should contain file name");
      assert(msg.messageStr.includes("群文件上传"), "Message should contain upload label");
      assert(msg.messageStr.includes("1.0 MB"), "Message should contain file size");
    }

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Test: group_increase → no message by default ──
  console.log("\n=== Phase 4: group_increase (no message by default) ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    await drainEvents(eventQueue, 200);

    server.broadcast({
      post_type: "notice",
      notice_type: "group_increase",
      sub_type: "approve",
      group_id: 222222,
      user_id: 500,
      operator_id: 999,
      time: Math.floor(Date.now() / 1000),
      self_id: 999,
    });

    const events = await drainEvents(eventQueue, 500);
    assert(events.length === 0, "Should NOT produce message by default for group_increase");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Test: group_increase → message when enabled ──
  console.log("\n=== Phase 4: group_increase → message when enabled ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port, { memberJoinToMessage: true });

    await drainEvents(eventQueue, 200);

    server.broadcast({
      post_type: "notice",
      notice_type: "group_increase",
      sub_type: "approve",
      group_id: 333333,
      user_id: 600,
      operator_id: 999,
      time: Math.floor(Date.now() / 1000),
      self_id: 999,
    });

    const events = await drainEvents(eventQueue, 500);
    assert(events.length > 0, "Should produce message when memberJoinToMessage=true");
    if (events.length > 0) {
      assert(events[0].messageStr.includes("加入了群聊"), "Message should contain join text");
    }

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Test: group_recall (no crash, logged) ──
  console.log("\n=== Phase 4: group_recall (no crash) ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    await drainEvents(eventQueue, 200);

    server.broadcast({
      post_type: "notice",
      notice_type: "group_recall",
      group_id: 444444,
      user_id: 700,
      operator_id: 700,
      message_id: 12345,
      time: Math.floor(Date.now() / 1000),
      self_id: 999,
    });

    const events = await drainEvents(eventQueue, 500);
    assert(events.length === 0, "Should NOT produce message for group_recall");
    // No crash = pass

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ══════════════════════════════════════════════════════
  // Phase 5: Group Management APIs
  // ══════════════════════════════════════════════════════

  console.log("\n=== Phase 5: Group Management APIs ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    const apiCalls: Array<{ action: string; params: Record<string, unknown> }> = [];
    server.messageHandler = (msg) => {
      apiCalls.push({ action: msg.action, params: msg.params });
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    // setGroupKick
    await adapter.setGroupKick(100, 200, true);
    assert(apiCalls.at(-1)?.action === "set_group_kick", "Should call set_group_kick");
    assert(apiCalls.at(-1)?.params.group_id === 100, "Should pass group_id");
    assert(apiCalls.at(-1)?.params.user_id === 200, "Should pass user_id");
    assert(apiCalls.at(-1)?.params.reject_add_request === true, "Should pass reject_add_request");

    // setGroupBan
    await adapter.setGroupBan(100, 200, 3600);
    assert(apiCalls.at(-1)?.action === "set_group_ban", "Should call set_group_ban");
    assert(apiCalls.at(-1)?.params.duration === 3600, "Should pass duration");

    // setGroupWholeBan
    await adapter.setGroupWholeBan(100, true);
    assert(apiCalls.at(-1)?.action === "set_group_whole_ban", "Should call set_group_whole_ban");
    assert(apiCalls.at(-1)?.params.enable === true, "Should pass enable");

    // setGroupCard
    await adapter.setGroupCard(100, 200, "NewCard");
    assert(apiCalls.at(-1)?.action === "set_group_card", "Should call set_group_card");
    assert(apiCalls.at(-1)?.params.card === "NewCard", "Should pass card");

    // setGroupName
    await adapter.setGroupName(100, "NewGroupName");
    assert(apiCalls.at(-1)?.action === "set_group_name", "Should call set_group_name");
    assert(apiCalls.at(-1)?.params.group_name === "NewGroupName", "Should pass group_name");

    // setGroupLeave
    await adapter.setGroupLeave(100, false);
    assert(apiCalls.at(-1)?.action === "set_group_leave", "Should call set_group_leave");
    assert(apiCalls.at(-1)?.params.is_dismiss === false, "Should pass is_dismiss");

    // setGroupAdmin
    await adapter.setGroupAdmin(100, 200, true);
    assert(apiCalls.at(-1)?.action === "set_group_admin", "Should call set_group_admin");
    assert(apiCalls.at(-1)?.params.enable === true, "Should pass enable");

    // setGroupSpecialTitle
    await adapter.setGroupSpecialTitle(100, 200, "Champion");
    assert(apiCalls.at(-1)?.action === "set_group_special_title", "Should call set_group_special_title");
    assert(apiCalls.at(-1)?.params.special_title === "Champion", "Should pass special_title");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ══════════════════════════════════════════════════════
  // Phase 6: Info Query APIs
  // ══════════════════════════════════════════════════════

  console.log("\n=== Phase 6: Info Query APIs ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    // getFriendList
    server.messageHandler = (msg) => {
      if (msg.action === "get_friend_list") {
        server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: [
          { user_id: 1, nickname: "Alice", remark: "Alice" },
          { user_id: 2, nickname: "Bob", remark: "Bob" },
        ]});
      } else if (msg.action === "get_group_list") {
        server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: [
          { group_id: 100, group_name: "Group A", member_count: 50, max_member_count: 200 },
        ]});
      } else if (msg.action === "get_group_info") {
        server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {
          group_id: 100, group_name: "Group A", member_count: 50, max_member_count: 200,
        }});
      } else if (msg.action === "get_group_member_info") {
        server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {
          user_id: 200, nickname: "Member1", card: "Card1", role: "member",
        }});
      } else if (msg.action === "get_group_member_list") {
        server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: [
          { user_id: 200, nickname: "Member1", role: "member" },
          { user_id: 300, nickname: "Member2", role: "admin" },
        ]});
      } else if (msg.action === "get_stranger_info") {
        server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {
          user_id: 500, nickname: "Stranger", sex: "unknown", age: 0,
        }});
      } else {
        server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
      }
    };

    // getFriendList
    const friends = await adapter.getFriendList();
    assert(friends.length === 2, "Should return 2 friends");
    assert(friends[0].nickname === "Alice", "First friend should be Alice");

    // getGroupList
    const groups = await adapter.getGroupList();
    assert(groups.length === 1, "Should return 1 group");
    assert(groups[0].group_name === "Group A", "Group name should be 'Group A'");

    // getGroupInfo
    const groupInfo = await adapter.getGroupInfo(100);
    assert(groupInfo.group_id === 100, "Should return group_id");
    assert(groupInfo.member_count === 50, "Should return member_count");

    // getGroupMemberInfo
    const memberInfo = await adapter.getGroupMemberInfo(100, 200);
    assert(memberInfo.user_id === 200, "Should return user_id");
    assert(memberInfo.role === "member", "Should return role");

    // getGroupMemberList
    const members = await adapter.getGroupMemberList(100);
    assert(members.length === 2, "Should return 2 members");
    assert(members[1].role === "admin", "Second member should be admin");

    // getStrangerInfo
    const stranger = await adapter.getStrangerInfo(500);
    assert(stranger.nickname === "Stranger", "Should return nickname");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Summary ──
  console.log("\n==================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("==================================================");
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
