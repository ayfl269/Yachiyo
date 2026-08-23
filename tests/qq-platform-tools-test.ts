/**
 * QQ (OneBot11) 平台互动工具回归测试
 * 覆盖：上下文提取、平台降级、每个 action 的参数转换与默认值解析、
 * 数值钳制、结果截断/格式化、API 错误转译、admin 开关行为。
 *
 * 工具层 mock QQAdapterApi 记录调用；adapter → OneBot action 的映射
 * 已由 onebot11 三套测试（200 用例）覆盖，不在此重复。
 */
import {
  createQQPlatformTools,
  createQQGroupAdminTool,
  QQ_GROUP_ADMIN_TOOL_NAME,
  type QQAdapterApi,
  type QQAdapterLookup,
  type QQToolContext,
} from "@yachiyo/agent/qq-platform-tools.js";
import type { CallToolResult } from "@yachiyo/agent/types.js";

// ── Helpers ──

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

function resultText(r: CallToolResult): string {
  const first = r.content[0];
  return first && first.type === "text" ? first.text : "";
}

/** 记录调用的 mock adapter */
interface CallRecord {
  method: string;
  args: unknown[];
}

function createMockAdapter(overrides: Partial<Record<string, () => unknown>> = {}) {
  const calls: CallRecord[] = [];
  const adapter = {
    meta: () => ({ id: "onebot11" }),
    isRunning: true,
    groupPoke: async (groupId: number, userId: number) => { calls.push({ method: "groupPoke", args: [groupId, userId] }); },
    friendPoke: async (userId: number) => { calls.push({ method: "friendPoke", args: [userId] }); },
    setMsgEmojiLike: async (messageId: number | string, emojiId: number | string) => { calls.push({ method: "setMsgEmojiLike", args: [messageId, emojiId] }); },
    sendLike: async (userId: number, times?: number) => { calls.push({ method: "sendLike", args: [userId, times] }); },
    markPrivateMsgAsRead: async (userId: number) => { calls.push({ method: "markPrivateMsgAsRead", args: [userId] }); },
    markGroupMsgAsRead: async (groupId: number) => { calls.push({ method: "markGroupMsgAsRead", args: [groupId] }); },
    deleteMsg: async (messageId: number | string) => { calls.push({ method: "deleteMsg", args: [messageId] }); },
    getMsg: async (messageId: number | string) => { calls.push({ method: "getMsg", args: [messageId] }); return { message_id: messageId, raw_message: "hello" }; },
    getForwardMsg: async (resId: string) => { calls.push({ method: "getForwardMsg", args: [resId] }); return { messages: [{ type: "text", data: { text: "转发内容A" } }, { type: "text", data: { text: "转发内容B" } }] }; },
    getGroupMsgHistory: async (groupId: number, options?: { count?: number; messageSeq?: number }) => {
      calls.push({ method: "getGroupMsgHistory", args: [groupId, options] });
      return {
        messages: [
          { time: 1700000000, sender: { nickname: "Alice", card: "卡片A" }, user_id: 111, raw_message: "消息1" },
          { time: 1700000060, sender: { nickname: "Bob" }, user_id: 222, raw_message: "消息2" },
        ],
      };
    },
    sendGroupForwardMsg: async (groupId: number, nodes: unknown[]) => { calls.push({ method: "sendGroupForwardMsg", args: [groupId, nodes] }); return { message_id: 99 }; },
    sendPrivateForwardMsg: async (userId: number, nodes: unknown[]) => { calls.push({ method: "sendPrivateForwardMsg", args: [userId, nodes] }); return { message_id: 98 }; },
    getFriendList: async () => { calls.push({ method: "getFriendList", args: [] }); return [{ user_id: 1, nickname: "张三", remark: "备注" }, { user_id: 2, nickname: "李四" }]; },
    getGroupList: async () => { calls.push({ method: "getGroupList", args: [] }); return [{ group_id: 100, group_name: "测试群", member_count: 10, max_member_count: 200 }]; },
    getGroupInfo: async (groupId: number) => { calls.push({ method: "getGroupInfo", args: [groupId] }); return { group_id: groupId, group_name: "测试群" }; },
    getGroupMemberInfo: async (groupId: number, userId: number) => { calls.push({ method: "getGroupMemberInfo", args: [groupId, userId] }); return { user_id: userId, nickname: "成员" }; },
    getGroupMemberList: async (groupId: number) => {
      calls.push({ method: "getGroupMemberList", args: [groupId] });
      return Array.from({ length: 60 }, (_, i) => ({ user_id: 1000 + i, nickname: `成员${i}`, role: i === 0 ? "owner" : i < 3 ? "admin" : "member" }));
    },
    getGroupHonorInfo: async (groupId: number, honorType?: string) => { calls.push({ method: "getGroupHonorInfo", args: [groupId, honorType] }); return { group_id: groupId }; },
    getGroupNotice: async (groupId: number) => { calls.push({ method: "getGroupNotice", args: [groupId] }); return { notices: [] }; },
    setGroupBan: async (groupId: number, userId: number, duration?: number) => { calls.push({ method: "setGroupBan", args: [groupId, userId, duration] }); },
    setGroupWholeBan: async (groupId: number, enable?: boolean) => { calls.push({ method: "setGroupWholeBan", args: [groupId, enable] }); },
    setGroupKick: async (groupId: number, userId: number, rejectAddRequest?: boolean) => { calls.push({ method: "setGroupKick", args: [groupId, userId, rejectAddRequest] }); },
    setGroupCard: async (groupId: number, userId: number, card: string) => { calls.push({ method: "setGroupCard", args: [groupId, userId, card] }); },
    setGroupName: async (groupId: number, name: string) => { calls.push({ method: "setGroupName", args: [groupId, name] }); },
    setGroupAdmin: async (groupId: number, userId: number, enable?: boolean) => { calls.push({ method: "setGroupAdmin", args: [groupId, userId, enable] }); },
    setGroupSpecialTitle: async (groupId: number, userId: number, specialTitle: string) => { calls.push({ method: "setGroupSpecialTitle", args: [groupId, userId, specialTitle] }); },
    setGroupLeave: async (groupId: number, isDismiss?: boolean) => { calls.push({ method: "setGroupLeave", args: [groupId, isDismiss] }); },
    sendGroupNotice: async (groupId: number, content: string, image?: string) => { calls.push({ method: "sendGroupNotice", args: [groupId, content, image] }); },
    setEssenceMsg: async (messageId: number | string) => { calls.push({ method: "setEssenceMsg", args: [messageId] }); },
    deleteEssenceMsg: async (messageId: number | string) => { calls.push({ method: "deleteEssenceMsg", args: [messageId] }); },
    recordBotActionNote: (umo: string, text: string) => { calls.push({ method: "recordBotActionNote", args: [umo, text] }); },
    ...overrides,
  };
  return { adapter: adapter as unknown as QQAdapterApi, calls };
}

/** 构造模拟的 ContextWrapper（ctx 是 OneBot11Event 形态的 MessageEvent） */
function createEventContext(overrides: Partial<QQToolContext> & { extras?: Record<string, unknown> } = {}) {
  const extras: Record<string, unknown> = {
    user_id: 888,
    group_id: 12345,
    message_id: 777,
    sent_message_id: 555,
    ...overrides.extras,
  };
  return {
    context: {
      unifiedMsgOrigin: "onebot11:group:12345",
      sessionId: "group_12345",
      platformMeta: { id: "onebot11" },
      getExtra: <T = unknown>(key: string): T | undefined => extras[key] as T | undefined,
    },
  };
}

/** 私聊会话上下文 */
function createPrivateContext(extras: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = { user_id: 888, message_id: 777, sent_message_id: 555, ...extras };
  return {
    context: {
      unifiedMsgOrigin: "onebot11:private:888",
      sessionId: "private_888",
      platformMeta: { id: "onebot11" },
      getExtra: <T = unknown>(key: string): T | undefined => all[key] as T | undefined,
    },
  };
}

function createLookup(adapter: QQAdapterApi | undefined, ids: string[] = ["onebot11"]): QQAdapterLookup {
  return {
    getAdapter: (id: string) => (ids.includes(id) ? adapter : undefined),
  };
}

async function callTool(tool: { handler?: (ctx: unknown, ...args: unknown[]) => Promise<unknown> }, ctx: unknown, ...args: unknown[]): Promise<CallToolResult> {
  const result = await tool.handler!(ctx, ...args);
  if (typeof result === "string") return { content: [{ type: "text", text: result }] };
  return result as CallToolResult;
}

/** 按命名参数构造 qq_group_admin 的位置参数（避免手工数位置出错） */
function adminArgs(p: {
  action: string;
  group_id?: number;
  user_id?: number;
  message_id?: number | string;
  duration?: number;
  enable?: boolean;
  content?: string;
  image?: string;
  card?: string;
  group_name?: string;
  special_title?: string;
  is_dismiss?: boolean;
  reject_add_request?: boolean;
}): unknown[] {
  return [
    p.action, p.group_id, p.user_id, p.message_id, p.duration, p.enable,
    p.content, p.image, p.card, p.group_name, p.special_title, p.is_dismiss, p.reject_add_request,
  ];
}

// ── Tests ──

async function main() {
  // ── 工具集合与 admin 开关 ──
  console.log("\n=== 工具集合与 admin 开关 ===");
  {
    const { adapter } = createMockAdapter();
    const lookup = createLookup(adapter);
    const tools = createQQPlatformTools({ adapterLookup: lookup, adminEnabled: true });
    assert(tools.length === 4, "adminEnabled=true 返回 4 个工具");
    assert(tools.map((t) => t.name).join(",") === "qq_interact,qq_message,qq_group_query,qq_group_admin", "工具名与顺序正确");

    const toolsNoAdmin = createQQPlatformTools({ adapterLookup: lookup, adminEnabled: false });
    assert(toolsNoAdmin.length === 3, "adminEnabled=false 返回 3 个工具");
    assert(!toolsNoAdmin.some((t) => t.name === QQ_GROUP_ADMIN_TOOL_NAME), "admin 关闭时无 qq_group_admin");
    assert(toolsNoAdmin.every((t) => t.active), "全部工具默认 active");
  }

  // ── 平台降级 ──
  console.log("\n=== 平台降级 ===");
  {
    const { adapter } = createMockAdapter();
    const tools = createQQPlatformTools({ adapterLookup: createLookup(adapter), adminEnabled: false });
    const interact = tools[0];

    // 无上下文
    let r = await callTool(interact, { context: null }, "poke");
    assert(r.isError === true && resultText(r).includes("OneBot11"), "无会话上下文时报平台错误");

    // 非 OneBot 平台（lookup 找不到该 id）
    const otherPlatformCtx = {
      context: {
        unifiedMsgOrigin: "qqofficial:private:888",
        platformMeta: { id: "qqofficial" },
        getExtra: () => undefined,
      },
    };
    r = await callTool(interact, otherPlatformCtx, "poke");
    assert(r.isError === true && resultText(r).includes("not a OneBot11"), "非 OneBot 平台明确报错");

    // adapter 停止
    const { adapter: stopped } = createMockAdapter();
    (stopped as unknown as { isRunning: boolean }).isRunning = false;
    const stoppedTools = createQQPlatformTools({ adapterLookup: createLookup(stopped) });
    r = await callTool(stoppedTools[0], createEventContext(), "poke");
    assert(r.isError === true && resultText(r).includes("not running"), "adapter 停止时报错");
  }

  // ── qq_interact ──
  console.log("\n=== qq_interact 互动操作 ===");
  {
    const { adapter, calls } = createMockAdapter();
    const [interact] = createQQPlatformTools({ adapterLookup: createLookup(adapter) });

    // poke 默认：群会话戳当前发送者
    let r = await callTool(interact, createEventContext(), "poke");
    assert(calls[0].method === "groupPoke" && calls[0].args[0] === 12345 && calls[0].args[1] === 888, "群会话 poke 默认戳当前发送者");
    assert(r.isError !== true, "poke 返回成功");

    // poke 指定 user_id（群会话）
    calls.length = 0;
    await callTool(interact, createEventContext(), "poke", 999);
    assert(calls[0].method === "groupPoke" && calls[0].args[1] === 999, "群会话 poke 指定 user_id");

    // poke 私聊 → friendPoke
    calls.length = 0;
    await callTool(interact, createPrivateContext(), "poke");
    assert(calls[0].method === "friendPoke" && calls[0].args[0] === 888, "私聊 poke → friendPoke");
    // poke 不走工具侧记录（由 poke notice 回声驱动，避免双重记录）
    assert(!calls.some(c => c.method === "recordBotActionNote"), "poke 不在工具侧记录动作");

    // emoji_like 默认当前消息
    calls.length = 0;
    await callTool(interact, createEventContext(), "emoji_like", undefined, undefined, "76");
    assert(calls[0].method === "setMsgEmojiLike" && calls[0].args[0] === 777 && calls[0].args[1] === "76", "emoji_like 默认当前消息 + emoji_id");
    assert(calls[1].method === "recordBotActionNote" && calls[1].args[0] === "onebot11:group:12345" && String(calls[1].args[1]).includes("表情回应"), "emoji_like 记录动作到群会话历史");

    // emoji_like 私聊 → 记录落到对应私聊会话
    calls.length = 0;
    await callTool(interact, createPrivateContext(), "emoji_like", undefined, undefined, "76");
    assert(calls[1].method === "recordBotActionNote" && calls[1].args[0] === "onebot11:private:888", "emoji_like 私聊记录落到私聊会话");

    // emoji_like 缺 emoji_id
    r = await callTool(interact, createEventContext(), "emoji_like");
    assert(r.isError === true && resultText(r).includes("emoji_id"), "emoji_like 缺 emoji_id 报错");

    // like 默认当前发送者 + times 钳制
    calls.length = 0;
    await callTool(interact, createEventContext(), "like", undefined, undefined, undefined, 99);
    assert(calls[0].method === "sendLike" && calls[0].args[0] === 888 && calls[0].args[1] === 20, "like 默认当前发送者，times 钳制到 20");
    assert(calls[1].method === "recordBotActionNote" && String(calls[1].args[1]).includes("点赞"), "like 记录动作到会话历史");

    // mark_read 群/私聊
    calls.length = 0;
    await callTool(interact, createEventContext(), "mark_read");
    assert(calls[0].method === "markGroupMsgAsRead" && calls[0].args[0] === 12345, "mark_read 群会话");
    assert(!calls.some(c => c.method === "recordBotActionNote"), "mark_read 不记录动作");
    calls.length = 0;
    await callTool(interact, createPrivateContext(), "mark_read");
    assert(calls[0].method === "markPrivateMsgAsRead" && calls[0].args[0] === 888, "mark_read 私聊会话");

    // 未知 action
    r = await callTool(interact, createEventContext(), "bad_action");
    assert(r.isError === true && resultText(r).includes("Unknown action"), "未知 action 报错");
  }

  // ── qq_message ──
  console.log("\n=== qq_message 消息操作 ===");
  {
    const { adapter, calls } = createMockAdapter();
    const [, message] = createQQPlatformTools({ adapterLookup: createLookup(adapter) });
    const groupCtx = createEventContext();

    // recall 默认撤回自己上一条
    let r = await callTool(message, groupCtx, "recall");
    assert(calls[0].method === "deleteMsg" && calls[0].args[0] === 555, "recall 默认撤回 bot 上一条回复");
    assert(calls[1].method === "recordBotActionNote" && String(calls[1].args[1]).includes("撤回"), "recall 记录动作到会话历史");

    // recall 指定 message_id
    calls.length = 0;
    await callTool(message, groupCtx, "recall", 123);
    assert(calls[0].args[0] === 123, "recall 指定 message_id");

    // recall 无可用 id
    r = await callTool(message, { context: { unifiedMsgOrigin: "onebot11:group:1", platformMeta: { id: "onebot11" }, getExtra: () => undefined } }, "recall");
    assert(r.isError === true && resultText(r).includes("recall"), "recall 无 message_id 且无上下文时报错");

    // get_msg
    r = await callTool(message, groupCtx, "get_msg", 42);
    assert(resultText(r).includes("hello"), "get_msg 返回消息详情");

    // get_forward_msg 展开
    calls.length = 0;
    r = await callTool(message, groupCtx, "get_forward_msg", undefined, "res123");
    assert(calls[0].method === "getForwardMsg" && calls[0].args[0] === "res123", "get_forward_msg 传递 res_id");
    assert(resultText(r).includes("转发内容A") && resultText(r).includes("转发内容B"), "get_forward_msg 展开文本内容");

    // get_group_history
    calls.length = 0;
    r = await callTool(message, groupCtx, "get_group_history", undefined, undefined, 5, 100);
    assert(calls[0].method === "getGroupMsgHistory" && calls[0].args[0] === 12345, "get_group_history 默认当前群");
    assert((calls[0].args[1] as { count: number }).count === 5 && (calls[0].args[1] as { messageSeq: number }).messageSeq === 100, "get_group_history 传递 count/message_seq");
    assert(resultText(r).includes("卡片A") && resultText(r).includes("消息2"), "get_group_history 格式化历史消息（card 优先）");

    // get_group_history 私聊 → 报错
    r = await callTool(message, createPrivateContext(), "get_group_history");
    assert(r.isError === true && resultText(r).includes("not a group"), "get_group_history 私聊报错");

    // send_forward 群聊节点转换
    calls.length = 0;
    r = await callTool(message, groupCtx, "send_forward", undefined, undefined, undefined, undefined, [
      { nickname: "小明", content: "第一条" },
      { content: "第二条" },
    ]);
    assert(calls[0].method === "sendGroupForwardMsg" && calls[0].args[0] === 12345, "send_forward 群聊发送");
    const nodes = calls[0].args[1] as Array<{ nickname?: string; content: Array<{ type: string; data: { text: string } }> }>;
    assert(nodes.length === 2 && nodes[0].nickname === "小明" && nodes[0].content[0].data.text === "第一条", "节点转换为 nickname + text segment");
    assert(nodes[1].nickname === undefined, "未提供 nickname 的节点不带 nickname 字段");
    assert(calls[1].method === "recordBotActionNote" && String(calls[1].args[1]).includes("合并转发") && String(calls[1].args[1]).includes("第一条"), "send_forward 记录动作与内容概要到会话历史");

    // send_forward 私聊
    calls.length = 0;
    await callTool(message, createPrivateContext(), "send_forward", undefined, undefined, undefined, undefined, [{ content: "hi" }]);
    assert(calls[0].method === "sendPrivateForwardMsg" && calls[0].args[0] === 888, "send_forward 私聊发送");

    // send_forward 缺 nodes
    r = await callTool(message, groupCtx, "send_forward");
    assert(r.isError === true && resultText(r).includes("nodes"), "send_forward 缺 nodes 报错");
  }

  // ── qq_group_query ──
  console.log("\n=== qq_group_query 查询操作 ===");
  {
    const { adapter, calls } = createMockAdapter();
    const [, , query] = createQQPlatformTools({ adapterLookup: createLookup(adapter) });
    const groupCtx = createEventContext();

    // group_info 默认当前群
    let r = await callTool(query, groupCtx, "group_info");
    assert(calls[0].method === "getGroupInfo" && calls[0].args[0] === 12345, "group_info 默认当前群");
    assert(resultText(r).includes("测试群"), "group_info 返回 JSON");

    // group_info 显式 group_id
    calls.length = 0;
    await callTool(query, groupCtx, "group_info", 999);
    assert(calls[0].args[0] === 999, "group_info 显式 group_id");

    // member_info 缺 user_id
    r = await callTool(query, groupCtx, "member_info");
    assert(r.isError === true && resultText(r).includes("user_id"), "member_info 缺 user_id 报错");

    // member_list 截断（60 成员只显示前 50）
    r = await callTool(query, groupCtx, "member_list");
    const text = resultText(r);
    assert(text.includes("60 total") && text.includes("showing first 50"), "member_list 显示总数与截断说明");
    assert(text.includes("[owner]") && text.includes("[admin]") && !text.includes("成员59"), "member_list 格式化角色标记并截断");

    // friend_list
    r = await callTool(query, groupCtx, "friend_list");
    assert(resultText(r).includes("张三") && resultText(r).includes("(备注)"), "friend_list 格式化昵称与备注");

    // group_list
    r = await callTool(query, groupCtx, "group_list");
    assert(resultText(r).includes("100 测试群 (10/200)"), "group_list 格式化");

    // honor_type 透传
    calls.length = 0;
    await callTool(query, groupCtx, "honor_info", undefined, undefined, "talkative");
    assert(calls[0].method === "getGroupHonorInfo" && calls[0].args[1] === "talkative", "honor_info 透传类型");

    // 私聊且无 group_id 的群操作 → 报错
    r = await callTool(query, createPrivateContext(), "group_info");
    assert(r.isError === true && resultText(r).includes("group_id"), "私聊会话 group_info 缺 group_id 报错");
  }

  // ── qq_group_admin ──
  console.log("\n=== qq_group_admin 管理操作 ===");
  {
    const { adapter, calls } = createMockAdapter();
    const admin = createQQGroupAdminTool({ adapterLookup: createLookup(adapter) });
    const groupCtx = createEventContext();

    // ban 默认 duration
    let r = await callTool(admin, groupCtx, ...adminArgs({ action: "ban", user_id: 666, duration: 600 }));
    assert(calls[0].method === "setGroupBan" && calls[0].args[0] === 12345 && calls[0].args[1] === 666 && calls[0].args[2] === 600, "ban 默认当前群 + duration 透传");
    assert(calls[1].method === "recordBotActionNote" && String(calls[1].args[1]).includes("禁言") && String(calls[1].args[1]).includes("600"), "ban 记录动作到会话历史");

    // ban duration=0 解禁
    calls.length = 0;
    await callTool(admin, groupCtx, ...adminArgs({ action: "ban", user_id: 666, duration: 0 }));
    assert(calls[0].args[2] === 0, "ban duration=0 透传（解除禁言）");

    // ban 缺 user_id
    r = await callTool(admin, groupCtx, ...adminArgs({ action: "ban" }));
    assert(r.isError === true && resultText(r).includes("user_id"), "ban 缺 user_id 报错");

    // whole_ban enable=false
    calls.length = 0;
    await callTool(admin, groupCtx, ...adminArgs({ action: "whole_ban", enable: false }));
    assert(calls[0].method === "setGroupWholeBan" && calls[0].args[1] === false, "whole_ban enable=false");

    // kick reject_add_request
    calls.length = 0;
    await callTool(admin, groupCtx, ...adminArgs({ action: "kick", user_id: 666, reject_add_request: true }));
    assert(calls[0].method === "setGroupKick" && calls[0].args[2] === true, "kick reject_add_request=true");

    // notice content + image
    calls.length = 0;
    await callTool(admin, groupCtx, ...adminArgs({ action: "notice", content: "公告内容", image: "http://img" }));
    assert(calls[0].method === "sendGroupNotice" && calls[0].args[1] === "公告内容" && calls[0].args[2] === "http://img", "notice content + image");

    // essence message_id
    calls.length = 0;
    await callTool(admin, groupCtx, ...adminArgs({ action: "essence", message_id: 8888 }));
    assert(calls[0].method === "setEssenceMsg" && calls[0].args[0] === 8888, "essence message_id");

    // set_card 空字符串合法（清除名片）
    calls.length = 0;
    await callTool(admin, groupCtx, ...adminArgs({ action: "set_card", user_id: 666, card: "" }));
    assert(calls[0].method === "setGroupCard" && calls[0].args[2] === "", "set_card 空字符串合法");

    // leave is_dismiss
    calls.length = 0;
    await callTool(admin, groupCtx, ...adminArgs({ action: "leave", is_dismiss: true }));
    assert(calls[0].method === "setGroupLeave" && calls[0].args[1] === true, "leave is_dismiss=true");

    // 私聊会话 + 无 group_id 的群操作 → 报错
    r = await callTool(admin, createPrivateContext(), ...adminArgs({ action: "ban", user_id: 666, duration: 600 }));
    assert(r.isError === true && resultText(r).includes("group_id"), "私聊会话 ban 报缺 group_id");
  }

  // ── API 错误转译 ──
  console.log("\n=== API 错误转译 ===");
  {
    const { adapter } = createMockAdapter({
      groupPoke: () => { throw new Error("retcode=1200: 对方屏蔽了戳一戳"); },
    });
    const [interact] = createQQPlatformTools({ adapterLookup: createLookup(adapter) });
    const r = await callTool(interact, createEventContext(), "poke");
    assert(r.isError === true && resultText(r).includes("poke") && resultText(r).includes("1200"), "API 抛错转译为含 action 名的错误");
  }

  // ── 大结果截断 ──
  console.log("\n=== 大结果截断 ===");
  {
    const { adapter } = createMockAdapter({
      getGroupMsgHistory: async () => ({
        messages: Array.from({ length: 200 }, (_, i) => ({
          time: 1700000000,
          sender: { nickname: `用户${i}` },
          user_id: i,
          raw_message: "这是一条很长的测试消息内容用于验证截断逻辑".repeat(10),
        })),
      }),
    });
    const [, message] = createQQPlatformTools({ adapterLookup: createLookup(adapter) });
    const r = await callTool(message, createEventContext(), "get_group_history");
    const text = resultText(r);
    assert(text.includes("truncated"), "超长历史结果被截断");
    assert(text.length < 5000, "截断后结果长度受控");
  }

  // ── 汇总 ──
  console.log(`\n总计: ${passed + failed} | 通过: ${passed} | 失败: ${failed}`);
  if (failures.length) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
