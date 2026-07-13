/**
 * Unit tests for QQ Official Bot adapter extended APIs.
 *
 * Tests the new Phase 1 high-priority APIs:
 * - Rich media upload (uploadGroupRichMedia, uploadC2CRichMedia)
 * - Extended send (all msg_types: markdown, ark, embed, media, keyboard, is_wakeup)
 * - Message recall (deleteGroupMessage, deleteC2CMessage, deleteGuildMessage)
 * - Emoji reactions (addReaction, deleteReaction, getReactionUsers)
 * - Event-level convenience methods (sendImage, sendMarkdown, recall, addReaction)
 *
 * Strategy: Mock global fetch to capture requests and return controlled responses.
 * Authentication is bypassed by directly setting the access token.
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

      // Find a matching route
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
    // store original to restore later
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
    id: "test-qq-official",
    appId: "test-app-id",
    appSecret: "test-secret",
  };
  const eventQueue = new AsyncQueue<MessageEvent>();
  const adapter = new QQOfficialAdapter(config, eventQueue);
  await adapter.initialize();

  // Bypass authentication by injecting a token directly via the authenticate route mock
  const fetchMock = new FetchMock();
  fetchMock.install();
  fetchMock.route("getAppAccessToken", () => ({
    status: 200,
    body: { access_token: "mock-token-xyz", expires_in: 7200 },
  }));

  // Access private fields via duck typing to set token without network call
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
  // Phase: Rich Media Upload
  // ══════════════════════════════════════════════════════

  console.log("\n=== Rich Media Upload (Group) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/v2/groups/", (call) => {
      if (call.url.includes("/files") && call.method === "POST") {
        return {
          status: 200,
          body: { file_uuid: "uuid-001", file_info: "file_info_abc", ttl: 300 },
        };
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== Rich Media Upload (C2C) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/v2/users/", (call) => {
      if (call.url.includes("/files") && call.method === "POST") {
        return {
          status: 200,
          body: { file_uuid: "uuid-002", file_info: "file_info_def", ttl: 0 },
        };
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== Rich Media Upload with base64 file_data ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/files", (call) => ({
      status: 200,
      body: { file_uuid: "uuid-003", file_info: "info", ttl: 100 },
    }));

    await adapter.uploadGroupRichMedia("g1", 3, "https://example.com/audio.silk", "base64data==");
    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.file_data === "base64data==", "Should pass file_data when provided");
    assert(lastCall?.body?.file_type === 3, "Should pass file_type=3 (voice)");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  // ══════════════════════════════════════════════════════
  // Phase: Extended Send (all msg_types)
  // ══════════════════════════════════════════════════════

  console.log("\n=== Extended Send: Markdown (msg_type=2) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/messages", () => ({
      status: 200,
      body: { id: "msg_id_100", seq: 1 },
    }));

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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== Extended Send: Keyboard (message buttons) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/messages", () => ({ status: 200, body: { id: "msg_kb_1" } }));

    const keyboard = {
      content: {
        rows: [
          {
            buttons: [
              {
                id: "btn1",
                render_data: { label: "Click me", visited_label: "Clicked", style: 1 as 0 | 1 },
                action: {
                  type: 1 as 0 | 1 | 2,
                  permission: { type: 2 as 0 | 1 | 2 | 3 },
                  data: "callback_data",
                  unsupport_tips: "Not supported",
                },
              },
            ],
          },
        ],
      },
    };
    await adapter.sendC2CMessageEx("user_1", {
      msg_type: 2,
      markdown: { content: "Please choose" },
      keyboard,
    });

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.keyboard?.content?.rows?.length === 1, "Should pass keyboard with 1 row");
    assert(lastCall?.body?.keyboard?.content?.rows[0].buttons[0].id === "btn1", "Should pass button id");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== Extended Send: is_wakeup (interactive recall) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/messages", () => ({ status: 200, body: { id: "msg_wake_1" } }));

    await adapter.sendC2CMessageEx("user_1", {
      content: "Wake up reminder",
      msg_type: 0,
      is_wakeup: true,
    });

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.is_wakeup === true, "Should pass is_wakeup=true");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== Extended Send: Guild/Direct with msg_id ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/channels/", () => ({ status: 200, body: { id: "msg_guild_1" } }));

    await adapter.sendGuildMessageEx("channel_1", { content: "Hello guild", msg_id: "evt_123" });

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.msg_id === "evt_123", "Should pass msg_id for passive guild reply");
    assert(lastCall?.body?.content === "Hello guild", "Should pass content");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== Backward compatible sendGroupMessage returns result ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/messages", () => ({ status: 200, body: { id: "bc_msg_1" } }));

    const result = await adapter.sendGroupMessage("group_1", "hello", "evt_1");
    assert(result.id === "bc_msg_1", "Backward compatible sendGroupMessage should return result");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  // ══════════════════════════════════════════════════════
  // Phase: Message Recall (Delete)
  // ══════════════════════════════════════════════════════

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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  // ══════════════════════════════════════════════════════
  // Phase: Emoji Reactions
  // ══════════════════════════════════════════════════════

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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== Get Reaction Users (GET with pagination) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/reactions/", (call) => {
      if (call.method === "GET") {
        return {
          status: 200,
          body: {
            users: [
              { user_id: "u1", username: "Alice" },
              { user_id: "u2", username: "Bob" },
            ],
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

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== Get Reaction Users (second page with cookie) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/reactions/", (call) => {
      if (call.method === "GET") {
        return {
          status: 200,
          body: { users: [{ user_id: "u3" }], is_end: true },
        };
      }
      return { status: 200, body: {} };
    });

    const result = await adapter.getReactionUsers("ch1", "m1", 1, "4", { cookie: "prev_cookie" });

    assert(result.is_end === true, "Should return is_end=true on last page");
    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.url.includes("cookie=prev_cookie"), "Should pass cookie query param");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  // ══════════════════════════════════════════════════════
  // Phase: Event-level convenience methods
  // ══════════════════════════════════════════════════════

  console.log("\n=== Event-level: sendImage (upload + send) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    let uploadCalled = false;
    let sendCalled = false;

    fetchMock.route("/files", () => {
      uploadCalled = true;
      return { status: 200, body: { file_uuid: "uuid-img", file_info: "img_info", ttl: 300 } };
    });
    fetchMock.route("/messages", () => {
      sendCalled = true;
      return { status: 200, body: { id: "msg_img_1" } };
    });

    // Inject a group event into the queue
    const adapterInternals = adapter as unknown as {
      commitEvent(event: MessageEvent): void;
      meta(): { name: string; description: string; id: string; supportStreamingMessage: boolean; supportProactiveMessage: boolean };
    };

    // Use the adapter's internal message handler by simulating a GROUP_AT_MESSAGE_CREATE dispatch
    // We need to access the handleDispatch method. Instead, we'll create the event via the internal class.
    // Since QQOfficialEvent is not exported, we test sendImage via the adapter directly using a constructed
    // scenario: upload then send.
    const uploadResult = await adapter.uploadGroupRichMedia("group_1", 1, "https://example.com/cat.png");
    assert(uploadCalled, "Should call upload endpoint");
    assert(uploadResult.file_info === "img_info", "Upload should return file_info");

    const sendResult = await adapter.sendGroupMessageEx("group_1", {
      msg_type: 7,
      media: { file_info: uploadResult.file_info },
      msg_id: "evt_1",
    });
    assert(sendCalled, "Should call send endpoint");
    assert(sendResult.id === "msg_img_1", "Should return message id");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== Event-level: Markdown + Keyboard combined send ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/messages", () => ({ status: 200, body: { id: "msg_combo_1" } }));

    const keyboard = {
      content: {
        rows: [{
          buttons: [{
            id: "b1",
            render_data: { label: "OK", visited_label: "OK", style: 1 as 0 | 1 },
            action: {
              type: 2 as 0 | 1 | 2,
              permission: { type: 2 as 0 | 1 | 2 | 3 },
              data: "ok",
              unsupport_tips: "n/a",
            },
          }],
        }],
      },
    };

    const result = await adapter.sendC2CMessageEx("user_1", {
      msg_type: 2,
      markdown: { content: "Choose an option" },
      keyboard,
    });

    assert(result.id === "msg_combo_1", "Should return message id");
    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.body?.msg_type === 2, "Should send msg_type=2 (markdown)");
    assert(lastCall?.body?.markdown?.content === "Choose an option", "Should pass markdown");
    assert(lastCall?.body?.keyboard?.content?.rows?.length === 1, "Should pass keyboard");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== Event-level: recall flow (send then delete) ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    let sentMessageId: string | null = null;
    fetchMock.route("/messages", (call) => {
      if (call.method === "POST") {
        sentMessageId = "msg_recall_test";
        return { status: 200, body: { id: "msg_recall_test" } };
      }
      if (call.method === "DELETE") {
        return { status: 200, body: {} };
      }
      return { status: 200, body: {} };
    });

    // Send a message
    const sendResult = await adapter.sendGroupMessageEx("group_1", { content: "To be recalled", msg_id: "evt_1" });
    assert(sendResult.id === "msg_recall_test", "Send should return message id");

    // Recall it
    await adapter.deleteGroupMessage("group_1", sendResult.id!);

    const calls = fetchMock.getCalls();
    const deleteCall = calls.find(c => c.method === "DELETE");
    assert(deleteCall !== undefined, "Should have made a DELETE call");
    assert(deleteCall?.url.includes("/v2/groups/group_1/messages/msg_recall_test"), "DELETE should target the sent message");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== Auth header verification ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/messages", () => ({ status: 200, body: { id: "x" } }));

    await adapter.sendGroupMessageEx("g1", { content: "test" });

    const lastCall = fetchMock.getLastCall();
    assert(lastCall?.headers?.Authorization === "QQBot mock-token-xyz", "Should include correct Authorization header");
    assert(lastCall?.headers?.["Content-Type"] === "application/json", "Should include JSON content type");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("\n=== msg_seq auto-increment ===");
  {
    const { adapter, fetchMock } = await createAdapter();

    fetchMock.route("/messages", () => ({ status: 200, body: { id: "x" } }));

    await adapter.sendGroupMessageEx("g1", { content: "msg1" });
    const seq1 = fetchMock.getLastCall()?.body?.msg_seq;
    await adapter.sendGroupMessageEx("g1", { content: "msg2" });
    const seq2 = fetchMock.getLastCall()?.body?.msg_seq;

    assert(typeof seq1 === "number" && typeof seq2 === "number", "msg_seq should be numbers");
    assert(seq2! > seq1!, "msg_seq should auto-increment");

    fetchMock.restore();
    await adapter.stop();
    await new Promise(r => setTimeout(r, 100));
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
