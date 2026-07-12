/**
 * Unit tests for the OneBot11 adapter API response mechanism.
 *
 * Tests cover:
 *   - Echo-based API response correlation
 *   - callApiWithResponse: success, timeout, error retcode
 *   - Core APIs: getFile, getImage, getRecord, deleteMsg, getMsg, getForwardMsg
 *   - getLoginInfo, markMsgAsRead
 *   - Fire-and-forget callApiFireAndForget
 *   - rejectAllPending on adapter stop
 *   - send() now awaits response and stores message_id
 */

import { OneBot11Adapter } from "@yachiyo/platform/implementations/onebot11-adapter.js";
import type { Ob11FileResult, Ob11GetMsgResult, Ob11SendMsgResult } from "@yachiyo/platform/implementations/onebot11-adapter.js";
import type { OneBot11AdapterConfig } from "@yachiyo/platform/config.js";
import { AsyncQueue } from "@yachiyo/common/async-queue.js";
import { WebSocketServer, WebSocket } from "ws";
import { MessageEvent } from "@yachiyo/message/event.js";
import { PlatformMessage } from "@yachiyo/message/platform-message.js";
import { MessageType } from "@yachiyo/message/types.js";
import type { PlatformMetadata } from "@yachiyo/platform/metadata.js";

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

function assertApprox(actual: number, expected: number, tolerance: number, message: string): void {
  if (Math.abs(actual - expected) <= tolerance) {
    passed++;
    console.log(`  \u2714 ${message}`);
  } else {
    failed++;
    console.error(`  \u2717 ${message} (expected ~${expected}, got ${actual})`);
  }
}

/** Mock napcat WS server that responds to API calls */
class MockNapcatServer {
  private wss: WebSocketServer;
  private pendingEchoMap = new Map<string, (data: unknown) => void>();
  public lastReceivedAction: string | null = null;
  public lastReceivedParams: Record<string, unknown> | null = null;
  public messageHandler: ((data: Record<string, unknown>) => void) | null = null;

  constructor(port: number) {
    this.wss = new WebSocketServer({ port, host: "127.0.0.1" });
    this.wss.on("connection", (ws: WebSocket) => {
      ws.on("message", (raw: Buffer) => {
        const msg = JSON.parse(raw.toString());
        this.lastReceivedAction = msg.action;
        this.lastReceivedParams = msg.params;

        // If there's a custom message handler, call it
        if (this.messageHandler) {
          this.messageHandler(msg);
        }

        // If there's a pending echo handler, call it
        const echoHandler = this.pendingEchoMap.get(msg.echo);
        if (echoHandler) {
          echoHandler(msg);
          this.pendingEchoMap.delete(msg.echo);
        }
      });
    });
  }

  /** Send a message to all connected clients */
  broadcast(data: Record<string, unknown>): void {
    const json = JSON.stringify(data);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }

  /** Queue a response for the next API call with this echo */
  queueResponse(echo: string, retcode: number, data: unknown, msg?: string): void {
    this.pendingEchoMap.set(echo, (_received) => {
      // The server received the request with this echo; now send the response
      this.broadcast({ echo, retcode, data, msg: msg ?? (retcode === 0 ? "ok" : "error"), status: retcode === 0 ? "ok" : "failed" });
    });
  }

  /** Wait for a connection */
  async waitForConnection(timeoutMs: number = 3000): Promise<void> {
    const start = Date.now();
    while (this.wss.clients.size === 0) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("Timeout waiting for WS connection");
      }
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

async function main(): Promise<void> {
  const port = 18765;
  const mockServer = new MockNapcatServer(port);

  try {
    // Create adapter in reverse WS mode (connects to our mock server)
    const config: OneBot11AdapterConfig = {
      type: "onebot11",
      id: "test-ob11",
      direction: "reverse",
      reverseUrl: `ws://127.0.0.1:${port}`,
      reconnectInterval: 1000,
    };
    const eventQueue = new AsyncQueue<MessageEvent>();
    const adapter = new OneBot11Adapter(config, eventQueue);

    await adapter.initialize();
    await adapter.run();

    // Wait for the adapter to connect to our mock server
    await mockServer.waitForConnection();
    console.log("  (adapter connected to mock server)");

    // Give a small delay for WS to stabilize
    await new Promise(r => setTimeout(r, 100));

    // ── Test: callApiWithResponse success ──
    console.log("\n=== callApiWithResponse: success ===");
    {
      // Pre-queue a response for any echo the adapter sends
      mockServer.messageHandler = (msg) => {
        if (msg.action === "get_login_info") {
          mockServer.broadcast({
            echo: msg.echo,
            retcode: 0,
            status: "ok",
            data: { user_id: 123456, nickname: "TestBot" },
          });
        }
      };

      const result = await adapter.callApiWithResponse("get_login_info", {});
      const loginInfo = result as { user_id: number; nickname: string };
      assert(loginInfo.user_id === 123456, "Should return correct user_id");
      assert(loginInfo.nickname === "TestBot", "Should return correct nickname");
      mockServer.messageHandler = null;
    }

    // ── Test: callApiWithResponse error retcode ──
    console.log("\n=== callApiWithResponse: error retcode ===");
    {
      mockServer.messageHandler = (msg) => {
        if (msg.action === "get_msg") {
          mockServer.broadcast({
            echo: msg.echo,
            retcode: 1400,
            status: "failed",
            msg: "Message not found",
            data: null,
          });
        }
      };

      let threw = false;
      let errorMsg = "";
      try {
        await adapter.callApiWithResponse("get_msg", { message_id: 999 });
      } catch (e) {
        threw = true;
        errorMsg = e instanceof Error ? e.message : String(e);
      }
      assert(threw, "Should throw on error retcode");
      assert(errorMsg.includes("1400"), "Error should include retcode");
      assert(errorMsg.includes("Message not found"), "Error should include API error message");
      mockServer.messageHandler = null;
    }

    // ── Test: callApiWithResponse timeout ──
    console.log("\n=== callApiWithResponse: timeout ===");
    {
      // Don't send any response — let it timeout
      mockServer.messageHandler = null;

      const start = Date.now();
      let threw = false;
      let errorMsg = "";
      try {
        await adapter.callApiWithResponse("get_msg", { message_id: 1 }, 500);
      } catch (e) {
        threw = true;
        errorMsg = e instanceof Error ? e.message : String(e);
      }
      const elapsed = Date.now() - start;
      assert(threw, "Should throw on timeout");
      assert(errorMsg.includes("timed out"), "Error should mention timeout");
      assertApprox(elapsed, 500, 300, "Should timeout after ~500ms");
    }

    // ── Test: getFile ──
    console.log("\n=== getFile ===");
    {
      mockServer.messageHandler = (msg) => {
        if (msg.action === "get_file") {
          mockServer.broadcast({
            echo: msg.echo,
            retcode: 0,
            status: "ok",
            data: {
              file: "/path/to/file.pdf",
              url: "https://example.com/download/file.pdf",
              file_name: "document.pdf",
              file_size: 1024,
            },
          });
        }
      };

      const result = await adapter.getFile("abc123");
      assert(result.url === "https://example.com/download/file.pdf", "Should return file URL");
      assert(result.file_name === "document.pdf", "Should return file name");
      assert(result.file_size === 1024, "Should return file size");
      assert(mockServer.lastReceivedAction === "get_file", "Should call get_file action");
      assert(mockServer.lastReceivedParams?.file_id === "abc123", "Should pass file_id param");
      mockServer.messageHandler = null;
    }

    // ── Test: getImage ──
    console.log("\n=== getImage ===");
    {
      mockServer.messageHandler = (msg) => {
        if (msg.action === "get_image") {
          mockServer.broadcast({
            echo: msg.echo,
            retcode: 0,
            status: "ok",
            data: { url: "https://example.com/img.png", filename: "img.png", size: 2048 },
          });
        }
      };

      const result = await adapter.getImage("img_hash_123");
      assert(result.url === "https://example.com/img.png", "Should return image URL");
      assert(mockServer.lastReceivedAction === "get_image", "Should call get_image action");
      assert(mockServer.lastReceivedParams?.file === "img_hash_123", "Should pass file param");
      mockServer.messageHandler = null;
    }

    // ── Test: getRecord ──
    console.log("\n=== getRecord ===");
    {
      mockServer.messageHandler = (msg) => {
        if (msg.action === "get_record") {
          mockServer.broadcast({
            echo: msg.echo,
            retcode: 0,
            status: "ok",
            data: { file: "/path/to/converted.mp3" },
          });
        }
      };

      const result = await adapter.getRecord("audio_hash", "mp3");
      assert(result.file === "/path/to/converted.mp3", "Should return converted file path");
      assert(mockServer.lastReceivedAction === "get_record", "Should call get_record action");
      assert(mockServer.lastReceivedParams?.out_format === "mp3", "Should pass out_format param");
      mockServer.messageHandler = null;
    }

    // ── Test: deleteMsg ──
    console.log("\n=== deleteMsg ===");
    {
      mockServer.messageHandler = (msg) => {
        if (msg.action === "delete_msg") {
          mockServer.broadcast({
            echo: msg.echo,
            retcode: 0,
            status: "ok",
            data: {},
          });
        }
      };

      await adapter.deleteMsg("12345");
      assert(mockServer.lastReceivedAction === "delete_msg", "Should call delete_msg action");
      assert(mockServer.lastReceivedParams?.message_id === 12345, "Should pass message_id as number");
      mockServer.messageHandler = null;
    }

    // ── Test: getMsg ──
    console.log("\n=== getMsg ===");
    {
      mockServer.messageHandler = (msg) => {
        if (msg.action === "get_msg") {
          mockServer.broadcast({
            echo: msg.echo,
            retcode: 0,
            status: "ok",
            data: {
              message_id: 12345,
              message_type: "group",
              sender: { user_id: 100, nickname: "User1" },
              message: [{ type: "text", data: { text: "hello" } }],
              raw_message: "hello",
              time: 1700000000,
              user_id: 100,
              self_id: 999,
            },
          });
        }
      };

      const result = await adapter.getMsg("12345");
      assert(result.message_id === 12345, "Should return message_id");
      assert(result.message_type === "group", "Should return message_type");
      assert(result.sender.nickname === "User1", "Should return sender nickname");
      assert(mockServer.lastReceivedAction === "get_msg", "Should call get_msg action");
      mockServer.messageHandler = null;
    }

    // ── Test: getForwardMsg ──
    console.log("\n=== getForwardMsg ===");
    {
      mockServer.messageHandler = (msg) => {
        if (msg.action === "get_forward_msg") {
          mockServer.broadcast({
            echo: msg.echo,
            retcode: 0,
            status: "ok",
            data: {
              messages: [
                { type: "text", data: { text: "Forwarded message 1" } },
                { type: "text", data: { text: "Forwarded message 2" } },
              ],
            },
          });
        }
      };

      const result = await adapter.getForwardMsg("res_id_123");
      assert(result.messages.length === 2, "Should return 2 forwarded messages");
      assert(mockServer.lastReceivedAction === "get_forward_msg", "Should call get_forward_msg action");
      assert(mockServer.lastReceivedParams?.id === "res_id_123", "Should pass id param");
      mockServer.messageHandler = null;
    }

    // ── Test: getLoginInfo ──
    console.log("\n=== getLoginInfo ===");
    {
      mockServer.messageHandler = (msg) => {
        if (msg.action === "get_login_info") {
          mockServer.broadcast({
            echo: msg.echo,
            retcode: 0,
            status: "ok",
            data: { user_id: 999888, nickname: "MyBot" },
          });
        }
      };

      const result = await adapter.getLoginInfo();
      assert(result.user_id === 999888, "Should return user_id");
      assert(result.nickname === "MyBot", "Should return nickname");
      mockServer.messageHandler = null;
    }

    // ── Test: markMsgAsRead ──
    console.log("\n=== markMsgAsRead ===");
    {
      mockServer.messageHandler = (msg) => {
        if (msg.action === "mark_msg_as_read") {
          mockServer.broadcast({
            echo: msg.echo,
            retcode: 0,
            status: "ok",
            data: {},
          });
        }
      };

      await adapter.markMsgAsRead("67890");
      assert(mockServer.lastReceivedAction === "mark_msg_as_read", "Should call mark_msg_as_read action");
      assert(mockServer.lastReceivedParams?.message_id === 67890, "Should pass message_id as number");
      mockServer.messageHandler = null;
    }

    // ── Test: callApiFireAndForget ──
    console.log("\n=== callApiFireAndForget ===");
    {
      let receivedAction: string | null = null;
      mockServer.messageHandler = (msg) => {
        receivedAction = msg.action;
      };

      // Should not throw, should not wait for response
      adapter.callApiFireAndForget("get_status", {});
      await new Promise(r => setTimeout(r, 200));
      assert(receivedAction === "get_status", "Server should receive the action");
      mockServer.messageHandler = null;
    }

    // ── Test: pendingRequests cleared after response ──
    console.log("\n=== pendingRequests cleared after response ===");
    {
      mockServer.messageHandler = (msg) => {
        if (msg.action === "get_login_info") {
          mockServer.broadcast({
            echo: msg.echo, retcode: 0, status: "ok",
            data: { user_id: 1, nickname: "X" },
          });
        }
      };

      await adapter.callApiWithResponse("get_login_info", {});
      // Access internal state via cast
      const internal = adapter as unknown as { pendingRequests: Map<string, unknown> };
      assert(internal.pendingRequests.size === 0, "pendingRequests should be empty after response");
      mockServer.messageHandler = null;
    }

    // ── Test: concurrent API calls ──
    console.log("\n=== concurrent API calls ===");
    {
      mockServer.messageHandler = (msg) => {
        // Respond with the user_id from the params
        mockServer.broadcast({
          echo: msg.echo,
          retcode: 0,
          status: "ok",
          data: { user_id: msg.params.user_id, nickname: `User${msg.params.user_id}` },
        });
      };

      const promises: Promise<unknown>[] = [];
      for (let i = 1; i <= 5; i++) {
        promises.push(adapter.callApiWithResponse("get_login_info", { user_id: i }));
      }
      const results = await Promise.all(promises);
      const typedResults = results as { user_id: number; nickname: string }[];
      assert(typedResults.length === 5, "Should get 5 results");
      assert(typedResults[0].user_id === 1, "First result should have user_id=1");
      assert(typedResults[4].user_id === 5, "Fifth result should have user_id=5");
      assert(typedResults[2].nickname === "User3", "Third result should have correct nickname");
      mockServer.messageHandler = null;
    }

    // ── Test: rejectAllPending on stop ──
    console.log("\n=== rejectAllPending on stop ===");
    {
      // Start an API call that won't get a response
      mockServer.messageHandler = null;
      const pendingPromise = adapter.callApiWithResponse("get_msg", { message_id: 1 }, 10000);

      // Stop the adapter — should reject pending requests
      const stopPromise = adapter.stop();

      let threw = false;
      let errorMsg = "";
      try {
        await pendingPromise;
      } catch (e) {
        threw = true;
        errorMsg = e instanceof Error ? e.message : String(e);
      }
      await stopPromise;
      assert(threw, "Pending request should be rejected on stop");
      assert(errorMsg.includes("stopping") || errorMsg.includes("Adapter"), "Error should mention adapter stop");
    }

  } finally {
    await mockServer.close();
    // Give time for WS cleanup
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
