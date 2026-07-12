/**
 * Unit tests for OneBot11 adapter Phase 7 extended APIs.
 *
 * Phase 7.2: Extended message APIs (send_like, set_msg_emoji_like, send_forward_msg, get_group_msg_history)
 * Phase 7.3: Extended file APIs (upload_group_file, upload_private_file, get_group_file_url, download_file, ...)
 * Phase 7.4: Utility APIs (ocr_image, check_url_safely, mark_all_as_read, get_group_at_all_remain, ...)
 * Phase 7.5: Group management extended APIs (essence, notice, poke, portrait, sign, AI, ...)
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

async function main(): Promise<void> {
  const port = 18767;

  // ══════════════════════════════════════════════════════
  // Phase 7.2: Extended Message APIs
  // ══════════════════════════════════════════════════════

  console.log("\n=== Phase 7.2: sendLike ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    let receivedAction: string | null = null;
    let receivedParams: Record<string, unknown> | null = null;
    server.messageHandler = (msg) => {
      receivedAction = msg.action;
      receivedParams = msg.params;
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    await adapter.sendLike(12345, 5);
    assert(receivedAction === "send_like", "Should call send_like");
    assert(receivedParams?.user_id === 12345, "Should pass user_id");
    assert(receivedParams?.times === 5, "Should pass times");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.2: setMsgEmojiLike ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    let receivedAction: string | null = null;
    let receivedParams: Record<string, unknown> | null = null;
    server.messageHandler = (msg) => {
      receivedAction = msg.action;
      receivedParams = msg.params;
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    await adapter.setMsgEmojiLike(9988, "107");
    assert(receivedAction === "set_msg_emoji_like", "Should call set_msg_emoji_like");
    assert(receivedParams?.message_id === 9988, "Should pass message_id as number");
    assert(receivedParams?.emoji_id === "107", "Should pass emoji_id as string");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.2: sendForwardMsg (napcat unified) ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    let receivedAction: string | null = null;
    let receivedParams: Record<string, unknown> | null = null;
    server.messageHandler = (msg) => {
      receivedAction = msg.action;
      receivedParams = msg.params;
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: { message_id: 55555 } });
    };

    const nodes = [
      { user_id: 100, nickname: "UserA", content: [{ type: "text", data: { text: "Hello" } }] },
      { user_id: 200, nickname: "UserB", content: [{ type: "text", data: { text: "World" } }] },
    ];
    const result = await adapter.sendForwardMsg("group", 99999, nodes);
    assert(receivedAction === "send_forward_msg", "Should call send_forward_msg");
    assert(receivedParams?.target_type === "group", "Should pass target_type");
    assert(receivedParams?.target_id === 99999, "Should pass target_id");
    assert(Array.isArray(receivedParams?.messages), "Should pass messages array");
    assert((receivedParams?.messages as unknown[]).length === 2, "Should pass 2 nodes");
    assert(result.message_id === 55555, "Should return message_id");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.2: sendGroupForwardMsg & sendPrivateForwardMsg (go-cqhttp) ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    const apiCalls: Array<{ action: string; params: Record<string, unknown> }> = [];
    server.messageHandler = (msg) => {
      apiCalls.push({ action: msg.action, params: msg.params });
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: { message_id: 111 } });
    };

    const nodes = [{ user_id: 100, content: [{ type: "text", data: { text: "Test" } }] }];

    await adapter.sendGroupForwardMsg(88888, nodes);
    assert(apiCalls.at(-1)?.action === "send_group_forward_msg", "Should call send_group_forward_msg");
    assert(apiCalls.at(-1)?.params.group_id === 88888, "Should pass group_id");

    await adapter.sendPrivateForwardMsg(77777, nodes);
    assert(apiCalls.at(-1)?.action === "send_private_forward_msg", "Should call send_private_forward_msg");
    assert(apiCalls.at(-1)?.params.user_id === 77777, "Should pass user_id");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.2: getGroupMsgHistory ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    server.messageHandler = (msg) => {
      if (msg.action === "get_group_msg_history") {
        server.broadcast({
          echo: msg.echo,
          retcode: 0,
          status: "ok",
          data: {
            messages: [
              {
                time: 1700000000,
                message_type: "group",
                message_id: 1001,
                sender: { user_id: 100, nickname: "Alice" },
                message: [{ type: "text", data: { text: "Hi" } }],
                raw_message: "Hi",
                group_id: 500,
                user_id: 100,
                self_id: 999,
              },
              {
                time: 1700000100,
                message_type: "group",
                message_id: 1002,
                sender: { user_id: 200, nickname: "Bob" },
                message: [{ type: "text", data: { text: "Hello" } }],
                raw_message: "Hello",
                group_id: 500,
                user_id: 200,
                self_id: 999,
              },
            ],
          },
        });
      } else {
        server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
      }
    };

    const result = await adapter.getGroupMsgHistory(500, { count: 2, reverseOrder: true });
    assert(result.messages.length === 2, "Should return 2 messages");
    assert(result.messages[0].message_id === 1001, "First message_id should be 1001");
    assert(result.messages[1].sender.nickname === "Bob", "Second sender should be Bob");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ══════════════════════════════════════════════════════
  // Phase 7.3: Extended File APIs
  // ══════════════════════════════════════════════════════

  console.log("\n=== Phase 7.3: uploadGroupFile ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    let receivedAction: string | null = null;
    let receivedParams: Record<string, unknown> | null = null;
    server.messageHandler = (msg) => {
      receivedAction = msg.action;
      receivedParams = msg.params;
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    await adapter.uploadGroupFile(12345, "/path/to/file.pdf", "report.pdf", "folder1");
    assert(receivedAction === "upload_group_file", "Should call upload_group_file");
    assert(receivedParams?.group_id === 12345, "Should pass group_id");
    assert(receivedParams?.file === "/path/to/file.pdf", "Should pass file path");
    assert(receivedParams?.name === "report.pdf", "Should pass name");
    assert(receivedParams?.folder === "folder1", "Should pass folder");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.3: uploadPrivateFile ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    let receivedAction: string | null = null;
    let receivedParams: Record<string, unknown> | null = null;
    server.messageHandler = (msg) => {
      receivedAction = msg.action;
      receivedParams = msg.params;
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    await adapter.uploadPrivateFile(67890, "/path/to/file.docx", "doc.docx");
    assert(receivedAction === "upload_private_file", "Should call upload_private_file");
    assert(receivedParams?.user_id === 67890, "Should pass user_id");
    assert(receivedParams?.name === "doc.docx", "Should pass name");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.3: getGroupFileUrl ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    server.messageHandler = (msg) => {
      if (msg.action === "get_group_file_url") {
        server.broadcast({
          echo: msg.echo,
          retcode: 0,
          status: "ok",
          data: { url: "https://example.com/file.dl" },
        });
      } else {
        server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
      }
    };

    const result = await adapter.getGroupFileUrl(12345, "file_abc", 1024);
    assert(result.url === "https://example.com/file.dl", "Should return file URL");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.3: downloadFile ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    let receivedAction: string | null = null;
    let receivedParams: Record<string, unknown> | null = null;
    server.messageHandler = (msg) => {
      receivedAction = msg.action;
      receivedParams = msg.params;
      server.broadcast({
        echo: msg.echo,
        retcode: 0,
        status: "ok",
        data: { file: "/tmp/cached.dl", file_size: 1024 },
      });
    };

    const result = await adapter.downloadFile("https://example.com/big.zip", { threadCnt: 8 });
    assert(receivedAction === "download_file", "Should call download_file");
    assert(receivedParams?.url === "https://example.com/big.zip", "Should pass url");
    assert(receivedParams?.thread_cnt === 8, "Should pass thread_cnt");
    assert(result.file === "/tmp/cached.dl", "Should return cached file path");
    assert(result.file_size === 1024, "Should return file_size");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.3: deleteGroupFile & folder operations ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    const apiCalls: Array<{ action: string; params: Record<string, unknown> }> = [];
    server.messageHandler = (msg) => {
      apiCalls.push({ action: msg.action, params: msg.params });
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    await adapter.deleteGroupFile(12345, "file_abc", 1024);
    assert(apiCalls.at(-1)?.action === "delete_group_file", "Should call delete_group_file");
    assert(apiCalls.at(-1)?.params.busid === 1024, "Should pass busid");

    await adapter.createGroupFileFolder(12345, "NewFolder", "/");
    assert(apiCalls.at(-1)?.action === "create_group_file_folder", "Should call create_group_file_folder");
    assert(apiCalls.at(-1)?.params.name === "NewFolder", "Should pass folder name");

    await adapter.deleteGroupFolder(12345, "folder_id_1");
    assert(apiCalls.at(-1)?.action === "delete_group_folder", "Should call delete_group_folder");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.3: getGroupFileSystemInfo / RootFiles / FilesByFolder ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    server.messageHandler = (msg) => {
      if (msg.action === "get_group_file_system_info") {
        server.broadcast({
          echo: msg.echo,
          retcode: 0,
          status: "ok",
          data: { file_count: 10, limit_count: 10000, used_space: 5242880, total_space: 1073741824 },
        });
      } else if (msg.action === "get_group_root_files") {
        server.broadcast({
          echo: msg.echo,
          retcode: 0,
          status: "ok",
          data: {
            files: [{ file_id: "f1", file_name: "a.txt", file_size: 100 }],
            folders: [{ file_id: "d1", file_name: "subfolder", is_folder: true }],
          },
        });
      } else if (msg.action === "get_group_files_by_folder") {
        server.broadcast({
          echo: msg.echo,
          retcode: 0,
          status: "ok",
          data: {
            files: [{ file_id: "f2", file_name: "b.txt" }],
            folders: [],
          },
        });
      } else {
        server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
      }
    };

    const fsInfo = await adapter.getGroupFileSystemInfo(12345);
    assert(fsInfo.file_count === 10, "Should return file_count");
    assert(fsInfo.total_space === 1073741824, "Should return total_space");

    const rootFiles = await adapter.getGroupRootFiles(12345);
    assert(rootFiles.files.length === 1, "Should return 1 root file");
    assert(rootFiles.folders[0].file_name === "subfolder", "Should return 1 folder");

    const subFiles = await adapter.getGroupFilesByFolder(12345, "d1");
    assert(subFiles.files[0].file_id === "f2", "Should return file in subfolder");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ══════════════════════════════════════════════════════
  // Phase 7.4: Utility APIs
  // ══════════════════════════════════════════════════════

  console.log("\n=== Phase 7.4: ocrImage ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    server.messageHandler = (msg) => {
      if (msg.action === "ocr_image") {
        server.broadcast({
          echo: msg.echo,
          retcode: 0,
          status: "ok",
          data: {
            texts: [
              {
                text: "Hello World",
                confidence: 0.98,
                coordinates: [[0, 0], [100, 0], [100, 30], [0, 30]],
              },
            ],
            language: "en",
          },
        });
      } else {
        server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
      }
    };

    const result = await adapter.ocrImage("file_id_img_001");
    const ocrResult = Array.isArray(result) ? result[0] : result;
    assert(ocrResult.texts[0].text === "Hello World", "Should return recognized text");
    assert(ocrResult.language === "en", "Should return language");
    assert(ocrResult.texts[0].confidence === 0.98, "Should return confidence");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.4: checkUrlSafely ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    server.messageHandler = (msg) => {
      if (msg.action === "check_url_safely") {
        server.broadcast({
          echo: msg.echo,
          retcode: 0,
          status: "ok",
          data: { level: 1, keyword: "safe" },
        });
      } else {
        server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
      }
    };

    const result = await adapter.checkUrlSafely("https://example.com");
    assert(result.level === 1, "Should return safety level");
    assert(result.keyword === "safe", "Should return keyword");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.4: markAllAsRead / markPrivateMsgAsRead / markGroupMsgAsRead ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    const apiCalls: Array<{ action: string; params: Record<string, unknown> }> = [];
    server.messageHandler = (msg) => {
      apiCalls.push({ action: msg.action, params: msg.params });
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    await adapter.markAllAsRead();
    assert(apiCalls.at(-1)?.action === "mark_all_as_read", "Should call mark_all_as_read");

    await adapter.markPrivateMsgAsRead(11111);
    assert(apiCalls.at(-1)?.action === "mark_private_msg_as_read", "Should call mark_private_msg_as_read");
    assert(apiCalls.at(-1)?.params.user_id === 11111, "Should pass user_id");

    await adapter.markGroupMsgAsRead(22222);
    assert(apiCalls.at(-1)?.action === "mark_group_msg_as_read", "Should call mark_group_msg_as_read");
    assert(apiCalls.at(-1)?.params.group_id === 22222, "Should pass group_id");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.4: getGroupAtAllRemain ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    server.messageHandler = (msg) => {
      if (msg.action === "get_group_at_all_remain") {
        server.broadcast({
          echo: msg.echo,
          retcode: 0,
          status: "ok",
          data: { can_at_all: true, remain_at_all_count: 3, remain_at_all_count_for_group: 10 },
        });
      } else {
        server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
      }
    };

    const result = await adapter.getGroupAtAllRemain(12345);
    assert(result.can_at_all === true, "Should return can_at_all");
    assert(result.remain_at_all_count === 3, "Should return remain_at_all_count");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.4: getGroupHonorInfo ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    server.messageHandler = (msg) => {
      if (msg.action === "get_group_honor_info") {
        server.broadcast({
          echo: msg.echo,
          retcode: 0,
          status: "ok",
          data: {
            group_id: 12345,
            talkative_list: [{ user_id: 100, nickname: "Talker", description: "龙王" }],
          },
        });
      } else {
        server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
      }
    };

    const result = await adapter.getGroupHonorInfo(12345, "talkative");
    assert(result.group_id === 12345, "Should return group_id");
    assert(result.talkative_list?.[0].nickname === "Talker", "Should return talkative_list");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ══════════════════════════════════════════════════════
  // Phase 7.5: Group Management Extended APIs
  // ══════════════════════════════════════════════════════

  console.log("\n=== Phase 7.5: Essence Msg APIs ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    const apiCalls: Array<{ action: string; params: Record<string, unknown> }> = [];
    server.messageHandler = (msg) => {
      apiCalls.push({ action: msg.action, params: msg.params });
      if (msg.action === "get_essence_msg_list") {
        server.broadcast({
          echo: msg.echo,
          retcode: 0,
          status: "ok",
          data: {
            data: [
              {
                sender_id: 100,
                sender_nick: "Alice",
                sender_time: 1700000000,
                operator_id: 999,
                operator_nick: "Admin",
                operator_time: 1700000500,
                message_id: 5000,
              },
            ],
          },
        });
      } else {
        server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
      }
    };

    await adapter.setEssenceMsg(5000);
    assert(apiCalls.at(-1)?.action === "set_essence_msg", "Should call set_essence_msg");
    assert(apiCalls.at(-1)?.params.message_id === 5000, "Should pass message_id");

    await adapter.deleteEssenceMsg(5000);
    assert(apiCalls.at(-1)?.action === "delete_essence_msg", "Should call delete_essence_msg");

    const essenceList = await adapter.getEssenceMsgList(12345, { page: 1, pageSize: 20 });
    assert(apiCalls.at(-1)?.action === "get_essence_msg_list", "Should call get_essence_msg_list");
    assert(apiCalls.at(-1)?.params.page_size === 20, "Should pass page_size");
    assert(essenceList.data.length === 1, "Should return 1 essence msg");
    assert(essenceList.data[0].sender_nick === "Alice", "Should return sender_nick");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.5: Group Notice APIs ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    const apiCalls: Array<{ action: string; params: Record<string, unknown> }> = [];
    server.messageHandler = (msg) => {
      apiCalls.push({ action: msg.action, params: msg.params });
      if (msg.action === "_get_group_notice") {
        server.broadcast({
          echo: msg.echo,
          retcode: 0,
          status: "ok",
          data: {
            notices: [
              {
                notice_id: "n1",
                sender_id: 999,
                publish_time: 1700000000,
                message: { text: "Welcome to the group!" },
              },
            ],
          },
        });
      } else {
        server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
      }
    };

    await adapter.sendGroupNotice(12345, "Test announcement", "https://img.example.com/a.png");
    assert(apiCalls.at(-1)?.action === "_send_group_notice", "Should call _send_group_notice");
    assert(apiCalls.at(-1)?.params.content === "Test announcement", "Should pass content");
    assert(apiCalls.at(-1)?.params.image === "https://img.example.com/a.png", "Should pass image");

    const notices = await adapter.getGroupNotice(12345);
    assert(apiCalls.at(-1)?.action === "_get_group_notice", "Should call _get_group_notice");
    assert(notices.notices[0].notice_id === "n1", "Should return notice_id");
    assert(notices.notices[0].message.text === "Welcome to the group!", "Should return text");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.5: Poke / Portrait / Sign ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    const apiCalls: Array<{ action: string; params: Record<string, unknown> }> = [];
    server.messageHandler = (msg) => {
      apiCalls.push({ action: msg.action, params: msg.params });
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    await adapter.groupPoke(12345, 67890);
    assert(apiCalls.at(-1)?.action === "group_poke", "Should call group_poke");
    assert(apiCalls.at(-1)?.params.group_id === 12345, "Should pass group_id");

    await adapter.friendPoke(67890);
    assert(apiCalls.at(-1)?.action === "friend_poke", "Should call friend_poke");

    await adapter.setGroupPortrait(12345, "/path/to/avatar.png");
    assert(apiCalls.at(-1)?.action === "set_group_portrait", "Should call set_group_portrait");

    await adapter.sendGroupSign(12345);
    assert(apiCalls.at(-1)?.action === "send_group_sign", "Should call send_group_sign");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.5: Forward Single Msg ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    const apiCalls: Array<{ action: string; params: Record<string, unknown> }> = [];
    server.messageHandler = (msg) => {
      apiCalls.push({ action: msg.action, params: msg.params });
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    await adapter.forwardGroupSingleMsg(8001, 12345);
    assert(apiCalls.at(-1)?.action === "forward_group_single_msg", "Should call forward_group_single_msg");
    assert(apiCalls.at(-1)?.params.message_id === 8001, "Should pass message_id");

    await adapter.forwardFriendSingleMsg(8002, 67890);
    assert(apiCalls.at(-1)?.action === "forward_friend_single_msg", "Should call forward_friend_single_msg");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.5: Account & Friend APIs ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    const apiCalls: Array<{ action: string; params: Record<string, unknown> }> = [];
    server.messageHandler = (msg) => {
      apiCalls.push({ action: msg.action, params: msg.params });
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    await adapter.setQqProfile({ nickname: "NewBot", personal_note: "Hello" });
    assert(apiCalls.at(-1)?.action === "set_qq_profile", "Should call set_qq_profile");
    assert(apiCalls.at(-1)?.params.nickname === "NewBot", "Should pass nickname");

    await adapter.deleteFriend(12345);
    assert(apiCalls.at(-1)?.action === "delete_friend", "Should call delete_friend");

    await adapter.setQqAvatar("/path/to/avatar.png");
    assert(apiCalls.at(-1)?.action === "set_qq_avatar", "Should call set_qq_avatar");

    await adapter.setOnlineStatus(1, 0, 80);
    assert(apiCalls.at(-1)?.action === "set_online_status", "Should call set_online_status");
    assert(apiCalls.at(-1)?.params.battery_status === 80, "Should pass battery_status");

    await adapter.cleanCache();
    assert(apiCalls.at(-1)?.action === "clean_cache", "Should call clean_cache");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.5: AI APIs (napcat) ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    const apiCalls: Array<{ action: string; params: Record<string, unknown> }> = [];
    server.messageHandler = (msg) => {
      apiCalls.push({ action: msg.action, params: msg.params });
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    await adapter.aiTextToImage(1, "a beautiful landscape");
    assert(apiCalls.at(-1)?.action === "ai_text_to_image", "Should call ai_text_to_image");
    assert(apiCalls.at(-1)?.params.prompt === "a beautiful landscape", "Should pass prompt");

    await adapter.aiSummarizeChat(12345);
    assert(apiCalls.at(-1)?.action === "ai_summarize_chat", "Should call ai_summarize_chat");

    await adapter.aiVoiceToText("file_voice_001");
    assert(apiCalls.at(-1)?.action === "ai_voice_to_text", "Should call ai_voice_to_text");
    assert(apiCalls.at(-1)?.params.file_id === "file_voice_001", "Should pass file_id");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== Phase 7.5: Status / Version / FriendsWithCategory ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    const apiCalls: Array<{ action: string }> = [];
    server.messageHandler = (msg) => {
      apiCalls.push({ action: msg.action });
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    await adapter.getStatus();
    assert(apiCalls.at(-1)?.action === "get_status", "Should call get_status");

    await adapter.getVersionInfo();
    assert(apiCalls.at(-1)?.action === "get_version_info", "Should call get_version_info");

    await adapter.getFriendsWithCategory();
    assert(apiCalls.at(-1)?.action === "get_friends_with_category", "Should call get_friends_with_category");

    await adapter.stop();
    await server.close();
    await new Promise(r => setTimeout(r, 200));
  }

  // ══════════════════════════════════════════════════════
  // Phase 7.6: Event-level convenience methods (via MessageEvent)
  // ══════════════════════════════════════════════════════

  console.log("\n=== Phase 7.6: Event-level setMsgEmojiLike ===");
  {
    const { adapter, server, eventQueue } = await createAdapterAndServer(port);

    let receivedAction: string | null = null;
    let receivedParams: Record<string, unknown> | null = null;
    server.messageHandler = (msg) => {
      receivedAction = msg.action;
      receivedParams = msg.params;
      server.broadcast({ echo: msg.echo, retcode: 0, status: "ok", data: {} });
    };

    // Send a group message event first to populate the event queue
    server.broadcast({
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: 4242,
      group_id: 55555,
      user_id: 33333,
      message: [{ type: "text", data: { text: "Hello bot" } }],
      raw_message: "Hello bot",
      time: Math.floor(Date.now() / 1000),
      self_id: 999,
      font: 0,
      sender: { user_id: 33333, nickname: "Tester" },
    });

    // Drain events with proper AbortSignal-based pattern
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    let event: MessageEvent | null = null;
    try {
      event = await eventQueue.get(controller.signal);
    } catch {
      event = null;
    }
    clearTimeout(timeout);

    assert(event !== null, "Should receive a message event");

    if (event) {
      // Call event-level setMsgEmojiLike
      const eventWithApi = event as unknown as {
        setMsgEmojiLike?: (emojiId: string | number) => Promise<void>;
      };
      if (typeof eventWithApi.setMsgEmojiLike === "function") {
        await eventWithApi.setMsgEmojiLike("76");
        assert(receivedAction === "set_msg_emoji_like", "Event setMsgEmojiLike should call API");
        assert(receivedParams?.message_id === 4242, "Should use message_id from event");
        assert(receivedParams?.emoji_id === "76", "Should pass emoji_id");
      } else {
        assert(false, "Event should have setMsgEmojiLike method");
      }
    }

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
