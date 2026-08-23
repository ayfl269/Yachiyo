/**
 * QQ (OneBot11) platform interaction tools.
 *
 * Exposes the OneBot11 adapter's rich API surface to the agent so the bot
 * can interact beyond plain text replies: poke, emoji reactions, profile
 * likes, message recall, forward-message reading/sending, group history,
 * group/friend info queries, and (behind a config switch) group admin
 * write operations.
 *
 * The agent package must NOT depend on @yachiyo/platform (circular dep:
 * platform depends on agent/types). Instead we declare minimal interfaces
 * that OneBot11Adapter satisfies structurally; bootstrap wires the real
 * AdapterRegistry in with an instanceof guard.
 *
 * Tools (grouped to avoid tool-list bloat):
 *   qq_interact     poke / emoji_like / like / mark_read
 *   qq_message      recall / get_msg / get_forward_msg / get_group_history / send_forward
 *   qq_group_query  group_info / group_list / member_info / member_list /
 *                   friend_list / honor_info / group_notice   (read-only)
 *   qq_group_admin  ban / whole_ban / kick / set_card / set_name / set_admin /
 *                   set_special_title / notice / essence / cancel_essence / leave
 *                   (sensitive; only registered when enabled)
 */

import { createFunctionTool, type FunctionTool } from "./tool.js";
import type { ContextWrapper, CallToolResult } from "./types.js";

// ── Minimal adapter API interface (structurally satisfied by OneBot11Adapter) ──

export interface QQAdapterApi {
  meta(): { id: string };
  isRunning: boolean;

  // Interact
  groupPoke(groupId: number, userId: number): Promise<void>;
  friendPoke(userId: number): Promise<void>;
  setMsgEmojiLike(messageId: number | string, emojiId: number | string): Promise<void>;
  sendLike(userId: number, times?: number): Promise<void>;
  markPrivateMsgAsRead(userId: number): Promise<void>;
  markGroupMsgAsRead(groupId: number): Promise<void>;

  // Message
  deleteMsg(messageId: number | string): Promise<void>;
  getMsg(messageId: number | string): Promise<unknown>;
  getForwardMsg(resId: string): Promise<unknown>;
  getGroupMsgHistory(
    groupId: number,
    options?: { messageSeq?: number; count?: number; reverseOrder?: boolean },
  ): Promise<unknown>;
  sendGroupForwardMsg(
    groupId: number,
    nodes: Array<{ nickname?: string; content?: Array<{ type: string; data: { text?: string } }> }>,
  ): Promise<unknown>;
  sendPrivateForwardMsg(
    userId: number,
    nodes: Array<{ nickname?: string; content?: Array<{ type: string; data: { text?: string } }> }>,
  ): Promise<unknown>;

  // Query
  getFriendList(): Promise<unknown>;
  getGroupList(): Promise<unknown>;
  getGroupInfo(groupId: number): Promise<unknown>;
  getGroupMemberInfo(groupId: number, userId: number): Promise<unknown>;
  getGroupMemberList(groupId: number): Promise<unknown>;
  getGroupHonorInfo(groupId: number, honorType?: string): Promise<unknown>;
  getGroupNotice(groupId: number): Promise<unknown>;

  // Admin (write)
  setGroupBan(groupId: number, userId: number, duration?: number): Promise<void>;
  setGroupWholeBan(groupId: number, enable?: boolean): Promise<void>;
  setGroupKick(groupId: number, userId: number, rejectAddRequest?: boolean): Promise<void>;
  setGroupCard(groupId: number, userId: number, card: string): Promise<void>;
  setGroupName(groupId: number, name: string): Promise<void>;
  setGroupAdmin(groupId: number, userId: number, enable?: boolean): Promise<void>;
  setGroupSpecialTitle(groupId: number, userId: number, specialTitle: string): Promise<void>;
  setGroupLeave(groupId: number, isDismiss?: boolean): Promise<void>;
  sendGroupNotice(groupId: number, content: string, image?: string): Promise<void>;
  setEssenceMsg(messageId: number | string): Promise<void>;
  deleteEssenceMsg(messageId: number | string): Promise<void>;

  /**
   * Record a completed bot-initiated action as an assistant note in the
   * target conversation's history (used by mutating tool actions so the
   * bot's own actions remain traceable in conversation data).
   */
  recordBotActionNote(umo: string, text: string): void;
}

export interface QQAdapterLookup {
  /** Returns the OneBot11 adapter instance by adapter id, or undefined. */
  getAdapter(id: string): QQAdapterApi | undefined;
}

// ── Session context (extracted from the current MessageEvent) ──

export interface QQToolContext {
  platformId?: string;
  umo?: string;
  /** Peer user id (private) or message sender id (group). */
  userId?: number;
  /** Present when the current session is a group chat. */
  groupId?: number;
  /** Message id of the message currently being processed. */
  messageId?: number | string;
  /** Message id of the bot's own last reply in this session. */
  sentMessageId?: number | string;
}

function toNum(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function getQQToolContext(_ctx: unknown): QQToolContext {
  const wrapper = _ctx as ContextWrapper<QQToolContext> | undefined;
  const ctx = wrapper?.context;
  if (!ctx) return {};

  // When called from the pipeline, `ctx` is a MessageEvent instance
  // (OneBot11Event) with unifiedMsgOrigin / platformMeta / getExtra.
  const maybeEvent = ctx as {
    unifiedMsgOrigin?: string;
    sessionId?: string;
    platformMeta?: { id?: string };
    getExtra?: <T = unknown>(key: string) => T | undefined;
  };
  if (typeof maybeEvent.getExtra === "function" && typeof maybeEvent.unifiedMsgOrigin === "string") {
    return {
      platformId: maybeEvent.platformMeta?.id,
      umo: maybeEvent.unifiedMsgOrigin,
      userId: toNum(maybeEvent.getExtra("user_id")),
      groupId: toNum(maybeEvent.getExtra("group_id")),
      messageId: maybeEvent.getExtra<number | string>("message_id"),
      sentMessageId: maybeEvent.getExtra<number | string>("sent_message_id"),
    };
  }
  return ctx as QQToolContext;
}

// ── Shared helpers ──

const MAX_RESULT_LENGTH = 4000;

function formatText(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function formatError(text: string): CallToolResult {
  return { content: [{ type: "text", text: `error: ${text}` }], isError: true };
}

function truncate(text: string, maxLen: number = MAX_RESULT_LENGTH): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n... (truncated, ${text.length} chars total)`;
}

function jsonResult(data: unknown): CallToolResult {
  return formatText(truncate(JSON.stringify(data)));
}

/** Resolve the OneBot11 adapter for the current session. */
function resolveAdapter(
  lookup: QQAdapterLookup,
  ctx: QQToolContext,
): { adapter: QQAdapterApi } | { error: CallToolResult } {
  if (!ctx.platformId) {
    return {
      error: formatError(
        "No platform session context. This tool only works while handling a message from a QQ (OneBot11) session.",
      ),
    };
  }
  const adapter = lookup.getAdapter(ctx.platformId);
  if (!adapter) {
    return {
      error: formatError(
        `Current platform "${ctx.platformId}" is not a OneBot11 (QQ) adapter. This tool only supports QQ sessions.`,
      ),
    };
  }
  if (!adapter.isRunning) {
    return { error: formatError(`QQ adapter "${adapter.meta().id}" is not running.`) };
  }
  return { adapter };
}

function apiError(action: string, e: unknown): CallToolResult {
  const detail = e instanceof Error ? e.message : String(e);
  return formatError(`QQ API call failed (action: ${action}): ${detail}`);
}

/**
 * Record a completed bot action into the current session's conversation
 * history (no-op when there is no session context, e.g. subagent calls).
 * The note waits on the session lock and is appended after the triggering
 * agent run finishes — see OneBot11Adapter.recordBotActionNote.
 */
function recordAction(adapter: QQAdapterApi, ctx: QQToolContext, text: string): void {
  if (ctx.umo) adapter.recordBotActionNote(ctx.umo, text);
}

/** Format a forward-message / arbitrary segment list into readable lines. */
function formatSegments(messages: unknown): string {
  if (!Array.isArray(messages)) return JSON.stringify(messages);
  const lines = messages.map((seg) => {
    if (seg && typeof seg === "object" && "type" in seg) {
      const s = seg as { type: string; data?: { text?: string } };
      if (s.type === "text" && typeof s.data?.text === "string") return s.data.text;
    }
    return JSON.stringify(seg);
  });
  return lines.join("\n");
}

// ══════════════════════════════════════════════════════════════════
// qq_interact
// ══════════════════════════════════════════════════════════════════

export interface CreateQQPlatformToolsOptions {
  adapterLookup: QQAdapterLookup;
  /** Whether to include the sensitive qq_group_admin tool. Default: false. */
  adminEnabled?: boolean;
}

export function createQQInteractTool(
  options: CreateQQPlatformToolsOptions,
): FunctionTool<QQToolContext> {
  const lookup = options.adapterLookup;

  return createFunctionTool<QQToolContext>({
    name: "qq_interact",
    description:
      "Interactive actions in the current QQ (OneBot11) session: poke someone, react to a " +
      "message with an emoji, like the sender's QQ profile, or mark the session as read. " +
      "All target parameters default to the current message/sender when omitted. " +
      "Actions: poke, emoji_like, like, mark_read.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action to perform.",
          enum: ["poke", "emoji_like", "like", "mark_read"],
        },
        user_id: {
          type: "integer",
          description: "Target QQ user. Defaults to the current message sender.",
        },
        message_id: {
          type: "integer",
          description: "Target message id (for emoji_like). Defaults to the current message.",
        },
        emoji_id: {
          type: "string",
          description: "Emoji reaction id (for emoji_like), e.g. \"76\" (thumbs up), \"5\" (celebrate).",
        },
        times: {
          type: "integer",
          description: "Like count (for like), 1-20. Default: 1.",
          minimum: 1,
          maximum: 20,
        },
      },
      required: ["action"],
    },
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const ctx = getQQToolContext(_ctx);
      const action = String(args[0] ?? "");
      const userId = toNum(args[1]);
      const messageId = toNum(args[2]) ?? (typeof args[2] === "string" ? String(args[2]) : undefined);
      const emojiId = args[3] != null ? String(args[3]) : undefined;
      const times = toNum(args[4]);

      const resolved = resolveAdapter(lookup, ctx);
      if ("error" in resolved) return resolved.error;
      const adapter = resolved.adapter;

      try {
        switch (action) {
          case "poke": {
            // 动作记录由 poke notice 回声驱动（onebot11-adapter 的
            // processNoticeEvent），此处不再记录，避免双重记录。
            const target = userId ?? ctx.userId;
            if (target == null) {
              return formatError("poke: no target user_id (no current sender context and none provided).");
            }
            if (ctx.groupId != null) {
              await adapter.groupPoke(ctx.groupId, target);
            } else {
              await adapter.friendPoke(target);
            }
            return formatText(`Poked user ${target}${ctx.groupId != null ? ` in group ${ctx.groupId}` : ""}.`);
          }

          case "emoji_like": {
            const msgId = messageId ?? ctx.messageId;
            if (msgId == null) {
              return formatError("emoji_like: no target message_id (no current message context and none provided).");
            }
            if (!emojiId) {
              return formatError("emoji_like: emoji_id is required (e.g. \"76\" for thumbs up).");
            }
            await adapter.setMsgEmojiLike(msgId, emojiId);
            recordAction(adapter, ctx, `[表情回应] 我给消息 ${msgId} 贴了表情 ${emojiId}`);
            return formatText(`Reacted to message ${msgId} with emoji ${emojiId}.`);
          }

          case "like": {
            const target = userId ?? ctx.userId;
            if (target == null) {
              return formatError("like: no target user_id (no current sender context and none provided).");
            }
            const n = Math.min(20, Math.max(1, times ?? 1));
            await adapter.sendLike(target, n);
            recordAction(adapter, ctx, `[点赞] 我赞了 用户${target} 的资料 ${n} 次`);
            return formatText(`Liked user ${target}'s QQ profile ${n} time(s).`);
          }

          case "mark_read": {
            if (ctx.groupId != null) {
              await adapter.markGroupMsgAsRead(ctx.groupId);
              return formatText(`Marked group ${ctx.groupId} messages as read.`);
            }
            if (ctx.userId != null) {
              await adapter.markPrivateMsgAsRead(ctx.userId);
              return formatText(`Marked private messages with user ${ctx.userId} as read.`);
            }
            return formatError("mark_read: no current session user/group context.");
          }

          default:
            return formatError(`Unknown action: ${action}. Valid actions: poke, emoji_like, like, mark_read`);
        }
      } catch (e) {
        return apiError(action, e);
      }
    },
  });
}

// ══════════════════════════════════════════════════════════════════
// qq_message
// ══════════════════════════════════════════════════════════════════

interface ForwardNodeInput {
  nickname?: string;
  content: string;
}

export function createQQMessageTool(
  options: CreateQQPlatformToolsOptions,
): FunctionTool<QQToolContext> {
  const lookup = options.adapterLookup;

  return createFunctionTool<QQToolContext>({
    name: "qq_message",
    description:
      "Message operations in the current QQ (OneBot11) session: recall a message (defaults to " +
      "the bot's own last reply), inspect a message, expand a forward (合并转发) message, fetch " +
      "recent group chat history, or send a merged-forward message to the current session. " +
      "Actions: recall, get_msg, get_forward_msg, get_group_history, send_forward.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action to perform.",
          enum: ["recall", "get_msg", "get_forward_msg", "get_group_history", "send_forward"],
        },
        message_id: {
          type: "integer",
          description: "Message id (for recall / get_msg). recall defaults to the bot's own last reply in this session.",
        },
        res_id: {
          type: "string",
          description: "Forward message res id (for get_forward_msg), from a received forward message.",
        },
        count: {
          type: "integer",
          description: "Number of history messages to fetch (for get_group_history), 1-50. Default: 10.",
          minimum: 1,
          maximum: 50,
        },
        message_seq: {
          type: "integer",
          description: "Starting message seq for get_group_history. Defaults to the latest messages.",
        },
        nodes: {
          type: "array",
          description:
            "Forward nodes (for send_forward): each {\"nickname\": string, \"content\": string}. " +
            "At least 1 node, at most 100.",
          items: {
            type: "object",
            properties: {
              nickname: { type: "string", description: "Displayed sender nickname for the node." },
              content: { type: "string", description: "Text content of the node." },
            },
            required: ["content"],
          },
        },
      },
      required: ["action"],
    },
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const ctx = getQQToolContext(_ctx);
      const action = String(args[0] ?? "");
      const messageId = toNum(args[1]) ?? (typeof args[1] === "string" ? String(args[1]) : undefined);
      const resId = args[2] != null ? String(args[2]) : undefined;
      const count = toNum(args[3]);
      const messageSeq = toNum(args[4]);
      const rawNodes = Array.isArray(args[5]) ? (args[5] as ForwardNodeInput[]) : undefined;

      const resolved = resolveAdapter(lookup, ctx);
      if ("error" in resolved) return resolved.error;
      const adapter = resolved.adapter;

      try {
        switch (action) {
          case "recall": {
            const msgId = messageId ?? ctx.sentMessageId;
            if (msgId == null) {
              return formatError(
                "recall: no message_id provided and the bot has no recent reply in this session to recall.",
              );
            }
            await adapter.deleteMsg(msgId);
            recordAction(adapter, ctx, `[撤回] 我撤回了消息 ${msgId}`);
            return formatText(`Recalled message ${msgId}.`);
          }

          case "get_msg": {
            if (messageId == null) {
              return formatError("get_msg: message_id is required.");
            }
            const detail = await adapter.getMsg(messageId);
            return jsonResult(detail);
          }

          case "get_forward_msg": {
            if (!resId) {
              return formatError("get_forward_msg: res_id is required (the resId of the received forward message).");
            }
            const result = await adapter.getForwardMsg(resId);
            const messages = (result as { messages?: unknown }).messages;
            return formatText(truncate(formatSegments(messages ?? result)));
          }

          case "get_group_history": {
            if (ctx.groupId == null) {
              return formatError("get_group_history: current session is not a group chat.");
            }
            const n = Math.min(50, Math.max(1, count ?? 10));
            const result = await adapter.getGroupMsgHistory(ctx.groupId, {
              count: n,
              ...(messageSeq != null ? { messageSeq } : {}),
            });
            const messages = (result as { messages?: Array<{
              time: number;
              sender?: { nickname?: string; card?: string };
              user_id: number;
              raw_message: string;
            }> }).messages ?? [];
            if (messages.length === 0) {
              return formatText(`No group history messages returned for group ${ctx.groupId}.`);
            }
            const lines = messages.map((m) => {
              const name = m.sender?.card || m.sender?.nickname || m.user_id;
              const time = new Date(m.time * 1000).toISOString().replace("T", " ").slice(0, 19);
              return `[${time}] ${name}: ${m.raw_message}`;
            });
            return formatText(truncate(`Group ${ctx.groupId} history (${messages.length} messages):\n${lines.join("\n")}`));
          }

          case "send_forward": {
            if (!rawNodes || rawNodes.length === 0) {
              return formatError("send_forward: nodes is required (array of {nickname, content}).");
            }
            if (rawNodes.length > 100) {
              return formatError("send_forward: too many nodes (max 100).");
            }
            const nodes = rawNodes.map((n) => ({
              ...(n.nickname != null ? { nickname: String(n.nickname) } : {}),
              content: [{ type: "text", data: { text: String(n.content ?? "") } }],
            }));
            const preview = rawNodes.map((n) => String(n.content ?? "")).filter(Boolean).join(" / ").slice(0, 120);
            const note = `[合并转发] 我发送了 ${nodes.length} 条合并转发消息${preview ? `: ${preview}` : ""}`;
            if (ctx.groupId != null) {
              const result = await adapter.sendGroupForwardMsg(ctx.groupId, nodes);
              recordAction(adapter, ctx, note);
              return formatText(`Sent merged-forward message (${nodes.length} nodes) to group ${ctx.groupId}. ${JSON.stringify(result ?? {})}`);
            }
            if (ctx.userId != null) {
              const result = await adapter.sendPrivateForwardMsg(ctx.userId, nodes);
              recordAction(adapter, ctx, note);
              return formatText(`Sent merged-forward message (${nodes.length} nodes) to user ${ctx.userId}. ${JSON.stringify(result ?? {})}`);
            }
            return formatError("send_forward: no current group/user session context.");
          }

          default:
            return formatError(
              `Unknown action: ${action}. Valid actions: recall, get_msg, get_forward_msg, get_group_history, send_forward`,
            );
        }
      } catch (e) {
        return apiError(action, e);
      }
    },
  });
}

// ══════════════════════════════════════════════════════════════════
// qq_group_query
// ══════════════════════════════════════════════════════════════════

export function createQQGroupQueryTool(
  options: CreateQQPlatformToolsOptions,
): FunctionTool<QQToolContext> {
  const lookup = options.adapterLookup;

  return createFunctionTool<QQToolContext>({
    name: "qq_group_query",
    description:
      "Read-only QQ group / friend info queries via OneBot11: group info, group list, member " +
      "info, member list, friend list, group honor (龙王 etc.), group notices. group_id defaults " +
      "to the current group when omitted. Actions: group_info, group_list, member_info, " +
      "member_list, friend_list, honor_info, group_notice.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action to perform.",
          enum: ["group_info", "group_list", "member_info", "member_list", "friend_list", "honor_info", "group_notice"],
        },
        group_id: {
          type: "integer",
          description: "Target group id. Defaults to the current group session.",
        },
        user_id: {
          type: "integer",
          description: "Target user id (required for member_info).",
        },
        honor_type: {
          type: "string",
          description: "Honor type for honor_info: talkative, performer, legend, strong_newbie, emotion, all. Default: all.",
          enum: ["talkative", "performer", "legend", "strong_newbie", "emotion", "all"],
        },
      },
      required: ["action"],
    },
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const ctx = getQQToolContext(_ctx);
      const action = String(args[0] ?? "");
      const groupId = toNum(args[1]);
      const userId = toNum(args[2]);
      const honorType = args[3] != null ? String(args[3]) : undefined;

      const resolved = resolveAdapter(lookup, ctx);
      if ("error" in resolved) return resolved.error;
      const adapter = resolved.adapter;

      try {
        switch (action) {
          case "group_info": {
            const gid = groupId ?? ctx.groupId;
            if (gid == null) return formatError("group_info: group_id is required (current session is not a group).");
            return jsonResult(await adapter.getGroupInfo(gid));
          }

          case "group_list": {
            const groups = (await adapter.getGroupList()) as Array<{
              group_id: number; group_name: string; member_count?: number; max_member_count?: number;
            }>;
            if (!Array.isArray(groups)) return jsonResult(groups);
            const lines = groups.map(
              (g) => `${g.group_id} ${g.group_name} (${g.member_count ?? "?"}/${g.max_member_count ?? "?"})`,
            );
            return formatText(
              truncate(`Groups (${groups.length} total):\n${lines.slice(0, 50).join("\n")}`) +
                (groups.length > 50 ? `\n... (${groups.length - 50} more not shown)` : ""),
            );
          }

          case "member_info": {
            const gid = groupId ?? ctx.groupId;
            if (gid == null) return formatError("member_info: group_id is required (current session is not a group).");
            if (userId == null) return formatError("member_info: user_id is required.");
            return jsonResult(await adapter.getGroupMemberInfo(gid, userId));
          }

          case "member_list": {
            const gid = groupId ?? ctx.groupId;
            if (gid == null) return formatError("member_list: group_id is required (current session is not a group).");
            const members = (await adapter.getGroupMemberList(gid)) as Array<{
              user_id: number; nickname?: string; card?: string; role?: string;
            }>;
            if (!Array.isArray(members)) return jsonResult(members);
            const lines = members.slice(0, 50).map((m) => {
              const role = m.role && m.role !== "member" ? ` [${m.role}]` : "";
              return `${m.user_id} ${m.card || m.nickname || ""}${role}`;
            });
            return formatText(
              `Group ${gid} members (${members.length} total, showing first 50):\n${lines.join("\n")}`,
            );
          }

          case "friend_list": {
            const friends = (await adapter.getFriendList()) as Array<{
              user_id: number; nickname?: string; remark?: string;
            }>;
            if (!Array.isArray(friends)) return jsonResult(friends);
            const lines = friends.slice(0, 100).map(
              (f) => `${f.user_id} ${f.nickname || ""}${f.remark ? ` (${f.remark})` : ""}`,
            );
            return formatText(
              `Friends (${friends.length} total${friends.length > 100 ? ", showing first 100" : ""}):\n${lines.join("\n")}`,
            );
          }

          case "honor_info": {
            const gid = groupId ?? ctx.groupId;
            if (gid == null) return formatError("honor_info: group_id is required (current session is not a group).");
            return jsonResult(await adapter.getGroupHonorInfo(gid, honorType ?? "all"));
          }

          case "group_notice": {
            const gid = groupId ?? ctx.groupId;
            if (gid == null) return formatError("group_notice: group_id is required (current session is not a group).");
            return jsonResult(await adapter.getGroupNotice(gid));
          }

          default:
            return formatError(
              `Unknown action: ${action}. Valid actions: group_info, group_list, member_info, member_list, friend_list, honor_info, group_notice`,
            );
        }
      } catch (e) {
        return apiError(action, e);
      }
    },
  });
}

// ══════════════════════════════════════════════════════════════════
// qq_group_admin (sensitive — registered only when enabled)
// ══════════════════════════════════════════════════════════════════

export function createQQGroupAdminTool(
  options: CreateQQPlatformToolsOptions,
): FunctionTool<QQToolContext> {
  const lookup = options.adapterLookup;

  return createFunctionTool<QQToolContext>({
    name: "qq_group_admin",
    description:
      "SENSITIVE group admin write operations via OneBot11 — only use when the user explicitly " +
      "asks for them. Actions: ban (duration seconds, 0 = unmute), whole_ban, kick, set_card, " +
      "set_name, set_admin, set_special_title, notice (group announcement), essence, " +
      "cancel_essence, leave (quit group, dangerous). group_id defaults to the current group.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action to perform.",
          enum: [
            "ban", "whole_ban", "kick", "set_card", "set_name", "set_admin",
            "set_special_title", "notice", "essence", "cancel_essence", "leave",
          ],
        },
        group_id: { type: "integer", description: "Target group id. Defaults to the current group session." },
        user_id: { type: "integer", description: "Target user id (ban / kick / set_card / set_admin / set_special_title)." },
        message_id: { type: "integer", description: "Target message id (essence / cancel_essence)." },
        duration: {
          type: "integer",
          description: "Mute duration in seconds (for ban), 0 = unmute. Default: 1800.",
          minimum: 0,
        },
        enable: { type: "boolean", description: "Enable flag (whole_ban / set_admin). Default: true." },
        content: { type: "string", description: "Announcement text (for notice)." },
        image: { type: "string", description: "Optional image URL for the announcement (for notice)." },
        card: { type: "string", description: "Group card text (for set_card, empty string clears it)." },
        group_name: { type: "string", description: "New group name (for set_name)." },
        special_title: { type: "string", description: "Special title text (for set_special_title)." },
        is_dismiss: { type: "boolean", description: "Also dismiss the group when leaving (for leave). Default: false." },
        reject_add_request: { type: "boolean", description: "Also reject future join requests (for kick). Default: false." },
      },
      required: ["action"],
    },
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const ctx = getQQToolContext(_ctx);
      const action = String(args[0] ?? "");
      const groupId = toNum(args[1]);
      const userId = toNum(args[2]);
      const messageId = toNum(args[3]) ?? (typeof args[3] === "string" ? String(args[3]) : undefined);
      const duration = toNum(args[4]);
      const enable = typeof args[5] === "boolean" ? args[5] : undefined;
      const content = args[6] != null ? String(args[6]) : undefined;
      const image = args[7] != null ? String(args[7]) : undefined;
      const card = args[8] != null ? String(args[8]) : undefined;
      const groupName = args[9] != null ? String(args[9]) : undefined;
      const specialTitle = args[10] != null ? String(args[10]) : undefined;
      const isDismiss = typeof args[11] === "boolean" ? args[11] : undefined;
      const rejectAdd = typeof args[12] === "boolean" ? args[12] : undefined;

      // Resolve adapter up-front for a consistent platform error
      const resolved = resolveAdapter(lookup, ctx);
      if ("error" in resolved) return resolved.error;
      const adapter = resolved.adapter;

      const gid = groupId ?? ctx.groupId;
      if (gid == null && action !== "essence" && action !== "cancel_essence") {
        return formatError(`${action}: group_id is required (current session is not a group).`);
      }

      try {
        switch (action) {
          case "ban": {
            if (userId == null) return formatError("ban: user_id is required.");
            const d = duration ?? 1800;
            await adapter.setGroupBan(gid!, userId, d);
            recordAction(adapter, ctx, d === 0
              ? `[禁言] 我解除了 用户${userId} 在群 ${gid} 的禁言`
              : `[禁言] 我禁言了 用户${userId} ${d} 秒（群 ${gid}）`);
            return formatText(d === 0 ? `Unmuted user ${userId} in group ${gid}.` : `Muted user ${userId} in group ${gid} for ${d} seconds.`);
          }

          case "whole_ban": {
            const en = enable ?? true;
            await adapter.setGroupWholeBan(gid!, en);
            recordAction(adapter, ctx, `[禁言] 我${en ? "开启" : "关闭"}了群 ${gid} 的全群禁言`);
            return formatText(`${en ? "Enabled" : "Disabled"} whole-group mute in group ${gid}.`);
          }

          case "kick": {
            if (userId == null) return formatError("kick: user_id is required.");
            await adapter.setGroupKick(gid!, userId, rejectAdd ?? false);
            recordAction(adapter, ctx, `[踢出] 我将 用户${userId} 移出了群 ${gid}`);
            return formatText(`Kicked user ${userId} from group ${gid}.`);
          }

          case "set_card": {
            if (userId == null) return formatError("set_card: user_id is required.");
            if (card == null) return formatError("set_card: card is required (empty string clears it).");
            await adapter.setGroupCard(gid!, userId, card);
            recordAction(adapter, ctx, `[群名片] 我将 用户${userId} 在群 ${gid} 的群名片设为 "${card}"`);
            return formatText(`Set group card of user ${userId} in group ${gid} to "${card}".`);
          }

          case "set_name": {
            if (!groupName) return formatError("set_name: group_name is required.");
            await adapter.setGroupName(gid!, groupName);
            recordAction(adapter, ctx, `[群改名] 我将群 ${gid} 改名为 "${groupName}"`);
            return formatText(`Renamed group ${gid} to "${groupName}".`);
          }

          case "set_admin": {
            if (userId == null) return formatError("set_admin: user_id is required.");
            const en = enable ?? true;
            await adapter.setGroupAdmin(gid!, userId, en);
            recordAction(adapter, ctx, `[管理员] 我${en ? "设置" : "取消了"} 用户${userId} 在群 ${gid} 的管理员权限`);
            return formatText(`${en ? "Promoted" : "Revoked admin of"} user ${userId} in group ${gid}.`);
          }

          case "set_special_title": {
            if (userId == null) return formatError("set_special_title: user_id is required.");
            if (specialTitle == null) return formatError("set_special_title: special_title is required.");
            await adapter.setGroupSpecialTitle(gid!, userId, specialTitle);
            recordAction(adapter, ctx, `[头衔] 我将 用户${userId} 在群 ${gid} 的头衔设为 "${specialTitle}"`);
            return formatText(`Set special title of user ${userId} in group ${gid} to "${specialTitle}".`);
          }

          case "notice": {
            if (content == null || content.trim() === "") return formatError("notice: content is required.");
            await adapter.sendGroupNotice(gid!, content, image);
            recordAction(adapter, ctx, `[群公告] 我在群 ${gid} 发布了公告: ${truncate(content, 100)}`);
            return formatText(`Published group announcement to group ${gid}.`);
          }

          case "essence": {
            if (messageId == null) return formatError("essence: message_id is required.");
            await adapter.setEssenceMsg(messageId);
            recordAction(adapter, ctx, `[精华] 我将消息 ${messageId} 设为精华`);
            return formatText(`Marked message ${messageId} as essence.`);
          }

          case "cancel_essence": {
            if (messageId == null) return formatError("cancel_essence: message_id is required.");
            await adapter.deleteEssenceMsg(messageId);
            recordAction(adapter, ctx, `[精华] 我将消息 ${messageId} 移出了精华`);
            return formatText(`Removed message ${messageId} from essence.`);
          }

          case "leave": {
            await adapter.setGroupLeave(gid!, isDismiss ?? false);
            recordAction(adapter, ctx, `[退群] 我退出了群 ${gid}${isDismiss ? "（并解散）" : ""}`);
            return formatText(`Left group ${gid}${isDismiss ? " (dismissed)" : ""}.`);
          }

          default:
            return formatError(
              `Unknown action: ${action}. Valid actions: ban, whole_ban, kick, set_card, set_name, set_admin, set_special_title, notice, essence, cancel_essence, leave`,
            );
        }
      } catch (e) {
        return apiError(action, e);
      }
    },
  });
}

// ══════════════════════════════════════════════════════════════════
// Aggregate factory
// ══════════════════════════════════════════════════════════════════

/**
 * Create the full set of QQ platform tools.
 * qq_group_admin is only included when `adminEnabled` is true.
 */
export function createQQPlatformTools(
  options: CreateQQPlatformToolsOptions,
): Array<FunctionTool<QQToolContext>> {
  const tools: Array<FunctionTool<QQToolContext>> = [
    createQQInteractTool(options),
    createQQMessageTool(options),
    createQQGroupQueryTool(options),
  ];
  if (options.adminEnabled) {
    tools.push(createQQGroupAdminTool(options));
  }
  return tools;
}

/** Name of the sensitive admin tool (for hot add/remove on config change). */
export const QQ_GROUP_ADMIN_TOOL_NAME = "qq_group_admin";
