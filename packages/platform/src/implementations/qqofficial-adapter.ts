/**
 * QQ Official Bot Adapter — QQ 官方机器人 API 适配器
 *
 * 通过 WebSocket 接收事件，通过 REST API 发送消息。
 * 支持: 群@消息、C2C私聊消息、频道@消息、私信消息
 *
 * 协议参考: https://bot.q.qq.com/wiki/
 */

import { PlatformAdapter } from "../adapter.js";
import type { PlatformMetadata } from "../metadata.js";
import type { AsyncQueue } from "@yachiyo/common/async-queue.js";
import { MessageEvent } from "@yachiyo/message/event.js";
import type { MessageComponent, PlainComponent, ImageComponent } from "@yachiyo/message/components.js";
import { ComponentType } from "@yachiyo/message/components.js";
import { PlatformMessage } from "@yachiyo/message/platform-message.js";
import { MessageType } from "@yachiyo/message/types.js";
import type { MessageChain } from "@yachiyo/agent/types.js";

import { WebSocket } from "ws";
import { EventEmitter } from "events";
import { randomBytes, createDecipheriv } from "crypto";

// ── Config ──

interface AdapterConfigBase {
  type: string;
  id: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface QQOfficialAdapterConfig extends AdapterConfigBase {
  type: "qqofficial";
  appId?: string;
  appSecret?: string;
  /** 事件订阅 intents 位掩码; 不填使用默认值 */
  intents?: number;
  /** 事件订阅名称列表 (与 intents 二选一, 名称会被转换为位掩码) */
  intentNames?: QQOfficialIntentName[];
  /** 沙箱环境 (true 时切换到 sandbox.api.sgroup.qq.com) */
  sandbox?: boolean;
  /** 分片配置: [当前分片ID, 总分片数]; 不填为单分片 */
  shard?: [number, number];
  /** 私信回调专用 token (可选, 用于回调模式下的私信场景) */
  privateToken?: string;
  /** 扫码登录配置：绑定域名/HOST (例如 q.qq.com) */
  qqofficialBindHost?: string;
  /** 二维码轮询间隔 (毫秒) */
  qqofficialQrPollInterval?: number;
  /** API 请求超时 (毫秒) */
  qqofficialApiTimeoutMs?: number;
}

// ── QQ Official API Types ──

/** WebSocket gateway opcodes */
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** Dispatch event types */
const DISPATCH_TYPE = {
  READY: "READY",
  RESUMED: "RESUMED",
  // 消息事件
  GROUP_AT_MESSAGE_CREATE: "GROUP_AT_MESSAGE_CREATE",
  C2C_MESSAGE_CREATE: "C2C_MESSAGE_CREATE",
  AT_MESSAGE_CREATE: "AT_MESSAGE_CREATE",
  DIRECT_MESSAGE_CREATE: "DIRECT_MESSAGE_CREATE",
  MESSAGE_CREATE: "MESSAGE_CREATE", // 私域机器人可接收
  MESSAGE_AUDIT_PASS: "MESSAGE_AUDIT_PASS",
  MESSAGE_AUDIT_REJECT: "MESSAGE_AUDIT_REJECT",
  // 频道事件 (GUILDS intent)
  GUILD_CREATE: "GUILD_CREATE",
  GUILD_UPDATE: "GUILD_UPDATE",
  GUILD_DELETE: "GUILD_DELETE",
  CHANNEL_CREATE: "CHANNEL_CREATE",
  CHANNEL_UPDATE: "CHANNEL_UPDATE",
  CHANNEL_DELETE: "CHANNEL_DELETE",
  // 频道成员事件 (GUILD_MEMBERS intent)
  GUILD_MEMBER_ADD: "GUILD_MEMBER_ADD",
  GUILD_MEMBER_UPDATE: "GUILD_MEMBER_UPDATE",
  GUILD_MEMBER_REMOVE: "GUILD_MEMBER_REMOVE",
  // 表情表态事件 (GUILD_MESSAGE_REACTIONS intent)
  MESSAGE_REACTION_ADD: "MESSAGE_REACTION_ADD",
  MESSAGE_REACTION_REMOVE: "MESSAGE_REACTION_REMOVE",
  // 互动事件 (INTERACTION intent)
  INTERACTION_CREATE: "INTERACTION_CREATE",
  // 论坛事件 (FORUMS_EVENT intent, 仅私域)
  FORUM_THREAD_CREATE: "FORUM_THREAD_CREATE",
  FORUM_THREAD_UPDATE: "FORUM_THREAD_UPDATE",
  FORUM_THREAD_DELETE: "FORUM_THREAD_DELETE",
  FORUM_POST_CREATE: "FORUM_POST_CREATE",
  FORUM_POST_DELETE: "FORUM_POST_DELETE",
  FORUM_REPLY_CREATE: "FORUM_REPLY_CREATE",
  FORUM_REPLY_DELETE: "FORUM_REPLY_DELETE",
  FORUM_PUBLISH_AUDIT_RESULT: "FORUM_PUBLISH_AUDIT_RESULT",
  // 音频事件 (AUDIO_ACTION intent)
  AUDIO_START: "AUDIO_START",
  AUDIO_FINISH: "AUDIO_FINISH",
  AUDIO_ON_MIC: "AUDIO_ON_MIC",
  AUDIO_OFF_MIC: "AUDIO_OFF_MIC",
} as const;

/** Intents bitfield */
const INTENTS = {
  // 基础事件 (默认有权限)
  GUILDS: 1 << 0,                          // 频道变更事件
  GUILD_MEMBERS: 1 << 1,                   // 频道成员变更 (需申请)
  GUILD_MESSAGES: 1 << 9,                  // 私域消息事件 (需申请)
  GUILD_MESSAGE_REACTIONS: 1 << 10,        // 表情表态事件 (需申请)
  DIRECT_MESSAGE: 1 << 12,                 // 私信事件 (默认有权限)
  GROUP_AND_C2C_EVENT: 1 << 25,            // 群@消息和C2C私聊消息事件
  INTERACTION: 1 << 26,                    // 互动事件 (按钮回调)
  MESSAGE_AUDIT: 1 << 27,                  // 消息审核事件
  FORUMS_EVENT: 1 << 28,                   // 论坛事件 (仅私域)
  AUDIO_ACTION: 1 << 29,                   // 音频事件
  PUBLIC_GUILD_MESSAGES: 1 << 30,          // 公域消息事件 (默认有权限)
} as const;

/** 事件订阅类型 (用于配置) */
export type QQOfficialIntentName =
  | "GUILDS"
  | "GUILD_MEMBERS"
  | "GUILD_MESSAGES"
  | "GUILD_MESSAGE_REACTIONS"
  | "DIRECT_MESSAGE"
  | "GROUP_AND_C2C_EVENT"
  | "INTERACTION"
  | "MESSAGE_AUDIT"
  | "FORUMS_EVENT"
  | "AUDIO_ACTION"
  | "PUBLIC_GUILD_MESSAGES";

interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
}

interface QQOfficialAuthor {
  user_openid?: string;
  member_openid?: string;
  id?: string;
  username?: string;
}

interface QQOfficialAttachment {
  content_type?: string;
  url?: string;
  filename?: string;
  height?: number;
  width?: number;
  size?: number;
}

interface QQOfficialDispatchPayload {
  op?: number;
  t?: string;
  s?: number;
  d?: unknown;
}

interface GroupAtMessageData {
  id: string;
  group_openid: string;
  content: string;
  author: QQOfficialAuthor;
  attachments?: QQOfficialAttachment[];
  timestamp?: string;
}

interface C2CMessageData {
  id: string;
  content: string;
  author: QQOfficialAuthor;
  attachments?: QQOfficialAttachment[];
  timestamp?: string;
}

interface AtMessageData {
  id: string;
  channel_id: string;
  guild_id: string;
  content: string;
  author: QQOfficialAuthor;
  mentions?: Array<{ id: string }>;
  attachments?: QQOfficialAttachment[];
  timestamp?: string;
}

interface DirectMessageData {
  id: string;
  channel_id: string;
  content: string;
  author: QQOfficialAuthor;
  attachments?: QQOfficialAttachment[];
  timestamp?: string;
}

interface HelloData {
  heartbeat_interval: number;
}

interface ReadyData {
  user: { id: string; username: string };
  session_id: string;
  shard?: [number, number];
}

// ── Rich Media / Markdown / Ark / Embed / Keyboard / Reaction Types ──

/** 媒体类型: 1 图片、2 视频、3 语音、4 文件 */
export type QQOfficialMediaType = 1 | 2 | 3 | 4;

/** 富媒体上传返回结果 */
export interface QQOfficialRichMediaUploadResult {
  file_uuid: string;
  file_info: string;
  /** 有效期剩余秒数，0 表示可长期使用 */
  ttl: number;
}

/** Markdown 模板消息 */
export interface QQOfficialMarkdownTemplate {
  /** 模板 ID */
  custom_template_id: string;
  /** 模板参数键值对 */
  params: Array<{ key: string; values: Array<{ key: string; values: string[] }> }>;
}

/** Markdown 自定义消息 */
export interface QQOfficialMarkdownCustom {
  /** Markdown 内容 */
  content: string;
}

/** Ark 消息 */
export interface QQOfficialArkMessage {
  template_id: number;
  kv: Array<{ key: string; value: string } | { key: string; obj: Array<{ obj_kv: Array<{ key: string; value: string }> }> }>;
}

/** Embed 消息 */
export interface QQOfficialEmbed {
  title?: string;
  description?: string;
  prompt?: string;
  thumbnail?: { url: string };
  fields?: Array<{ name: string; value: string }>;
}

/** 发送消息时附带的 media 字段 */
export interface QQOfficialMediaField {
  file_info: string;
}

/** 按钮权限 */
export interface QQOfficialButtonPermission {
  /** 0 指定用户、1 仅管理者、2 所有人、3 指定身份组(频道) */
  type: 0 | 1 | 2 | 3;
  specify_user_ids?: string[];
  specify_role_ids?: string[];
}

/** 按钮操作 */
export interface QQOfficialButtonAction {
  /** 0 跳转按钮、1 回调按钮、2 指令按钮 */
  type: 0 | 1 | 2;
  permission: QQOfficialButtonPermission;
  /** 操作相关数据 */
  data: string;
  /** 指令按钮: 是否带引用回复 */
  reply?: boolean;
  /** 指令按钮: 点击后自动发送 (仅单聊) */
  enter?: boolean;
  /** 指令按钮: 1=唤起手Q选图器 */
  anchor?: number;
  /** 客户端不支持时的 toast 文案 */
  unsupport_tips: string;
}

/** 按钮渲染数据 */
export interface QQOfficialButtonRender {
  label: string;
  visited_label: string;
  /** 0 灰色线框、1 蓝色线框 */
  style: 0 | 1;
}

/** 单个按钮 */
export interface QQOfficialButton {
  id?: string;
  render_data: QQOfficialButtonRender;
  action: QQOfficialButtonAction;
}

/** 按钮行 */
export interface QQOfficialButtonRow {
  buttons: QQOfficialButton[];
}

/** Inline 键盘 (消息按钮) */
export interface QQOfficialKeyboard {
  content?: { rows: QQOfficialButtonRow[] };
  /** 模板 ID */
  id?: string;
}

/** 表情表态用户 */
export interface QQOfficialReactionUser {
  user_id: string;
  username?: string;
  avatar?: string;
}

/** 表情表态用户列表返回 */
export interface QQOfficialReactionUsersResult {
  users: QQOfficialReactionUser[];
  is_end: boolean;
  cookie?: string;
}

/** 扩展发送消息参数 */
export interface QQOfficialSendOptions {
  /** 文本内容 (msg_type=0 时必填) */
  content?: string;
  /** 消息类型: 0 文本、2 markdown、3 ark、4 embed、7 media */
  msg_type?: 0 | 2 | 3 | 4 | 7;
  /** Markdown 对象 (msg_type=2) */
  markdown?: QQOfficialMarkdownTemplate | QQOfficialMarkdownCustom;
  /** Ark 对象 (msg_type=3) */
  ark?: QQOfficialArkMessage;
  /** Embed 对象 (msg_type=4) */
  embed?: QQOfficialEmbed;
  /** 富媒体 (msg_type=7) */
  media?: QQOfficialMediaField;
  /** 消息按钮 */
  keyboard?: QQOfficialKeyboard;
  /** 被动消息回复的 msg_id */
  msg_id?: string;
  /** 互动召回消息 (仅 C2C, 2026/01/10 新增) */
  is_wakeup?: boolean;
}

/** 发送消息返回结果 */
export interface QQOfficialSendMessageResult {
  id?: string;
  /** 频道场景返回的消息 ID */
  message_id?: string;
  /** msg_seq */
  seq?: number;
  /** 审核中的消息会返回 audit_id */
  audit_id?: string;
}

// ── Phase 2: Guild / Channel / Member / Role / Announces / Schedule Types ──

/** 频道用户对象 */
export interface QQOfficialUser {
  id: string;
  username?: string;
  avatar?: string;
  bot?: boolean;
  public_flags?: number;
  system?: boolean;
  union_openid?: string;
  union_user_account?: string;
}

/** 频道对象 */
export interface QQOfficialGuild {
  id: string;
  name: string;
  icon: string;
  owner_id?: string;
  owner?: boolean;
  member_count?: number;
  max_members?: number;
  description?: string;
  joined_at?: string;
}

/** 频道成员对象 */
export interface QQOfficialMember {
  user: QQOfficialUser;
  nick: string;
  roles: string[];
  joined_at: string;
  deaf?: boolean;
  mute?: boolean;
  pending?: boolean;
}

/** 身份组对象 */
export interface QQOfficialRole {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  number: number;
  member_limit: number;
  permissions: string;
}

/** 子频道对象 */
export interface QQOfficialChannel {
  id: string;
  guild_id: string;
  name: string;
  type: number;
  position?: number;
  parent_id?: string;
  owner_id?: string;
  sub_type?: number;
  private_type?: number;
  speak_permission?: number;
  application_id?: string;
  permissions?: string;
}

/** 子频道创建参数 */
export interface QQOfficialChannelCreateOptions {
  name: string;
  type: number;
  position?: number;
  parent_id?: string;
  sub_type?: number;
  private_type?: number;
  speak_permission?: number;
}

/** 子频道修改参数 */
export interface QQOfficialChannelUpdateOptions {
  name?: string;
  type?: number;
  position?: number;
  parent_id?: string;
  sub_type?: number;
  private_type?: number;
  speak_permission?: number;
}

/** 子频道权限 (用户/身份组通用) */
export interface QQOfficialChannelPermissions {
  /** 权限位字符串 (例如 "5"=可读+可写) */
  permissions?: string;
}

/** 频道公告对象 */
export interface QQOfficialAnnounce {
  guild_id: string;
  channel_id: string;
  message_id: string;
}

/** 频道公告创建参数 */
export interface QQOfficialAnnounceCreateOptions {
  channel_id: string;
  message_id: string;
}

/** 日程对象 */
export interface QQOfficialSchedule {
  id: string;
  name: string;
  description: string;
  start_timestamp: string;
  end_timestamp: string;
  creator: QQOfficialUser;
  jump_channel_id: string;
  remind_type: string;
}

/** 日程创建/修改参数 */
export interface QQOfficialScheduleOptions {
  name: string;
  description: string;
  start_timestamp: string;
  end_timestamp: string;
  jump_channel_id: string;
  /** 提醒类型: "0"=不提醒, "1"=开始时, "2"=5分钟前, "3"=15分钟前, "4"=30分钟前, "5"=60分钟前 */
  remind_type: string;
}

/** 频道成员修改参数 (修改昵称/禁言) */
export interface QQOfficialModifyMemberOptions {
  /** 昵称 */
  nick?: string;
  /** 禁言时长 (秒)，传 "0" 解除禁言 */
  mute_seconds?: string;
  /** 头像 */
  avatar?: string;
}

/** API 权限标识 */
export interface QQOfficialApiPermissionIdentify {
  path: string;
  method: string;
}

/** API 权限需求 (申请授权链接) */
export interface QQOfficialApiPermissionDemand {
  guild_id: string;
  channel_id: string;
  api_identify: QQOfficialApiPermissionIdentify;
  title: string;
  desc: string;
}

/** API 权限申请参数 */
export interface QQOfficialApiPermissionDemandOptions {
  channel_id: string;
  api_identify: QQOfficialApiPermissionIdentify;
  desc: string;
}

/** 在线成员数返回 */
export interface QQOfficialOnlineNums {
  online_count: number;
  online_member_count: number;
  online_robot_count: number;
}

// ── Phase 4: Gateway / Message / Role CRUD / Pins / Speak / Forum / Audio Types ──

/** Gateway 接入点返回 */
export interface QQOfficialGateway {
  url: string;
}

/** Gateway Bot 接入点返回 (含分片信息) */
export interface QQOfficialGatewayBot {
  url: string;
  shards: number;
  session_start_limit: {
    total: number;
    remaining: number;
    reset_after: number;
    max_concurrency: number;
  };
}

/** 频道消息对象 (与子频道消息 API 配合使用) */
export interface QQOfficialChannelMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  timestamp: string;
  author: QQOfficialUser;
  member?: { roles: string[]; joined_at: string };
  mentions?: QQOfficialUser[];
  attachments?: QQOfficialAttachment[];
  pinned?: boolean;
  type?: number;
  seq?: number;
}

/** 频道消息列表查询参数 */
export interface QQOfficialListMessagesOptions {
  /** 查询此 ID 之前的消息 (不含), 与 after 二选一 */
  before?: string;
  /** 查询此 ID 之后的消息 (不含), 与 before 二选一 */
  after?: string;
  /** 查询条数 (1-20) */
  limit?: number;
  /** 分页类型: 0=前后, 1=向前, 2=向后 */
  type?: 0 | 1 | 2;
}

/** 修改消息参数 (仅 markdown + keyboard 可修改) */
export interface QQOfficialPatchMessageOptions {
  content?: string;
  markdown?: QQOfficialMarkdownTemplate | QQOfficialMarkdownCustom;
  keyboard?: QQOfficialKeyboard;
}

/** 身份组创建/修改参数 */
export interface QQOfficialRoleOptions {
  name: string;
  color: number;
  hoist: boolean;
}

/** 身份组创建/修改返回 */
export interface QQOfficialRoleCreateResult {
  role: QQOfficialRole;
  role_id: string;
}

/** 精华消息列表返回 */
export interface QQOfficialPinsListResult {
  guild_id?: string;
  channel_id: string;
  message_ids: string[];
}

/** 精华消息操作返回 */
export interface QQOfficialPinsResult {
  message_ids: string[];
  guild_id?: string;
  channel_id: string;
}

/** 子频道发言权限设置 */
export interface QQOfficialSpeakPrivilegeSettings {
  /** 子频道 ID 与权限的映射, 值为权限位字符串 */
  [channelId: string]: string;
}

/** 频道消息频率设置返回 */
export interface QQOfficialMessageSetting {
  guild_id: string;
  channel_id: string;
  /** 5 秒内可发送消息数 */
  max_count: number;
  /** 统计窗口 (秒) */
  window_seconds: number;
}

/** 论坛帖子对象 */
export interface QQOfficialThread {
  channel_id: string;
  guild_id?: string;
  author: QQOfficialUser;
  thread_info: {
    thread_id: string;
    title: string;
    content: string;
    date_time: string;
  };
}

/** 论坛帖子详情 */
export interface QQOfficialThreadDetail extends QQOfficialThread {
  member?: { roles: string[]; joined_at: string };
}

/** 论坛帖子列表返回 */
export interface QQOfficialThreadListResult {
  threads: QQOfficialThread[];
}

/** 论坛评论对象 */
export interface QQOfficialComment {
  comment_id: string;
  content: string;
  author: QQOfficialUser;
  date_time: string;
}

/** 论坛评论列表返回 */
export interface QQOfficialCommentListResult {
  comments: QQOfficialComment[];
}

/** 音频控制参数 */
export interface QQOfficialAudioControl {
  /** 音频 URL */
  audio_url: string;
  /** 显示文字 */
  text?: string;
  /** 状态: 0=开始, 1=暂停, 2=继续, 3=停止 */
  status: 0 | 1 | 2 | 3;
}

// ── QQOfficialEvent ──

type QQOfficialEventType = "group" | "c2c" | "guild" | "direct";

class QQOfficialEvent extends MessageEvent {
  private adapter: QQOfficialAdapter;
  private eventType: QQOfficialEventType;
  private _umo: string;

  /** Target identifiers for replying */
  private targetId: string;
  private eventId: string;
  /** 机器人最近发送消息的 ID (用于撤回) */
  private sentMessageId: string | null = null;

  constructor(
    messageStr: string,
    messageObj: PlatformMessage,
    platformMeta: PlatformMetadata,
    sessionId: string,
    adapter: QQOfficialAdapter,
    eventType: QQOfficialEventType,
    targetId: string,
    eventId: string,
  ) {
    super(messageStr, messageObj, platformMeta, sessionId);
    this.adapter = adapter;
    this.eventType = eventType;
    this.targetId = targetId;
    this.eventId = eventId;

    // Build unified message origin
    switch (eventType) {
      case "group":
        this._umo = `qqofficial:group:${targetId}`;
        break;
      case "c2c":
        this._umo = `qqofficial:private:${targetId}`;
        break;
      case "guild":
        this._umo = `qqofficial:guild:${targetId}`;
        break;
      case "direct":
        this._umo = `qqofficial:private:${targetId}`;
        break;
    }
  }

  get unifiedMsgOrigin(): string {
    return this._umo;
  }

  async send(components: MessageComponent[]): Promise<void> {
    const plainText = this.extractPlainText(components);
    if (!plainText) return;

    try {
      const result = await this.sendTextEx(plainText);
      this.storeSentMessageId(result);
    } catch (e: unknown) {
      console.error("[QQOfficial] Failed to send message:", e);
    }
  }

  /**
   * 扩展发送消息 (支持所有 msg_type, 由调用方构造完整 options)
   * 返回结果对象, 调用方可自行获取 message_id 用于撤回。
   */
  async sendEx(options: QQOfficialSendOptions): Promise<QQOfficialSendMessageResult> {
    // 默认带上被动回复的 msg_id (群/C2C 场景)
    if (!options.msg_id && (this.eventType === "group" || this.eventType === "c2c")) {
      options.msg_id = this.eventId;
    }
    const result = await this.dispatchSend(options);
    this.storeSentMessageId(result);
    return result;
  }

  /** 发送纯文本 (扩展版, 返回结果) */
  async sendTextEx(content: string): Promise<QQOfficialSendMessageResult> {
    return this.sendEx({ content, msg_type: 0 });
  }

  /**
   * 发送图片消息 (自动上传富媒体 + 发送)
   * @param imageUrl 图片 URL
   */
  async sendImage(imageUrl: string): Promise<QQOfficialSendMessageResult> {
    return this.sendMedia(1, imageUrl);
  }

  /**
   * 发送视频消息
   */
  async sendVideo(videoUrl: string): Promise<QQOfficialSendMessageResult> {
    return this.sendMedia(2, videoUrl);
  }

  /**
   * 发送语音消息
   */
  async sendVoice(voiceUrl: string): Promise<QQOfficialSendMessageResult> {
    return this.sendMedia(3, voiceUrl);
  }

  /**
   * 发送文件消息
   */
  async sendFile(fileUrl: string): Promise<QQOfficialSendMessageResult> {
    return this.sendMedia(4, fileUrl);
  }

  /**
   * 上传富媒体并发送 (通用)
   * @param fileType 1 图片、2 视频、3 语音、4 文件
   */
  async sendMedia(fileType: QQOfficialMediaType, url: string): Promise<QQOfficialSendMessageResult> {
    let fileInfo: string;
    if (this.eventType === "group") {
      const upload = await this.adapter.uploadGroupRichMedia(this.targetId, fileType, url);
      fileInfo = upload.file_info;
    } else if (this.eventType === "c2c") {
      const upload = await this.adapter.uploadC2CRichMedia(this.targetId, fileType, url);
      fileInfo = upload.file_info;
    } else {
      // 频道场景: media 字段用 file_info, 需先上传
      // 频道富媒体上传使用群接口的变体; 若无 fileInfo, fallback 到 content 带 URL
      throw new Error("[QQOfficial] Guild/direct media upload not supported via this method; use sendGuildMessageEx with media field");
    }
    return this.sendEx({ msg_type: 7, media: { file_info: fileInfo } });
  }

  /** 发送 Markdown 消息 (自定义内容) */
  async sendMarkdown(content: string): Promise<QQOfficialSendMessageResult> {
    return this.sendEx({ msg_type: 2, markdown: { content } });
  }

  /** 发送 Markdown 模板消息 */
  async sendMarkdownTemplate(template: QQOfficialMarkdownTemplate): Promise<QQOfficialSendMessageResult> {
    return this.sendEx({ msg_type: 2, markdown: template });
  }

  /** 发送 Ark 消息 */
  async sendArk(ark: QQOfficialArkMessage): Promise<QQOfficialSendMessageResult> {
    return this.sendEx({ msg_type: 3, ark });
  }

  /** 发送 Embed 消息 */
  async sendEmbed(embed: QQOfficialEmbed): Promise<QQOfficialSendMessageResult> {
    return this.sendEx({ msg_type: 4, embed });
  }

  /**
   * 发送带按钮的消息 (Markdown + Keyboard)
   * 按钮需要 markdown 内容作为载体
   */
  async sendWithKeyboard(markdownContent: string, keyboard: QQOfficialKeyboard): Promise<QQOfficialSendMessageResult> {
    return this.sendEx({
      msg_type: 2,
      markdown: { content: markdownContent },
      keyboard,
    });
  }

  /**
   * 撤回机器人最近发送的消息
   * 仅在 2 分钟内有效 (单聊/群聊); 频道需管理员权限
   */
  async recall(): Promise<void> {
    if (!this.sentMessageId) {
      console.warn("[QQOfficial] recall(): no sent message_id available");
      return;
    }
    try {
      switch (this.eventType) {
        case "group":
          await this.adapter.deleteGroupMessage(this.targetId, this.sentMessageId);
          break;
        case "c2c":
          await this.adapter.deleteC2CMessage(this.targetId, this.sentMessageId);
          break;
        case "guild":
        case "direct":
          await this.adapter.deleteGuildMessage(this.targetId, this.sentMessageId);
          break;
      }
      this.sentMessageId = null;
    } catch (e: unknown) {
      console.error("[QQOfficial] recall() failed:", e);
    }
  }

  /**
   * 对当前消息发表表情表态 (仅频道场景)
   * @param type 表情类型, 参考 EmojiType
   * @param id 表情 ID
   */
  async addReaction(type: number, id: string): Promise<void> {
    if (this.eventType !== "guild" && this.eventType !== "direct") {
      console.warn("[QQOfficial] addReaction() only supported in guild/direct channel");
      return;
    }
    const messageId = this.messageObj.messageId;
    if (!messageId) {
      console.warn("[QQOfficial] addReaction(): no message_id available");
      return;
    }
    await this.adapter.addReaction(this.targetId, messageId, type, id);
  }

  /**
   * 删除机器人对当前消息的表情表态 (仅频道场景)
   */
  async deleteReaction(type: number, id: string): Promise<void> {
    if (this.eventType !== "guild" && this.eventType !== "direct") return;
    const messageId = this.messageObj.messageId;
    if (!messageId) return;
    await this.adapter.deleteReaction(this.targetId, messageId, type, id);
  }

  async sendStreaming(generator: AsyncGenerator<MessageChain, void>): Promise<void> {
    // Send chunks progressively instead of buffering the entire response.
    // QQ Official API does not support message editing, so we flush the
    // accumulated text periodically (every 500ms or 500 chars) to give the
    // user a streaming feel without flooding the chat with tiny messages.
    const FLUSH_INTERVAL_MS = 500;
    const FLUSH_CHAR_THRESHOLD = 500;

    let buffer = "";
    let lastFlush = Date.now();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = async (): Promise<void> => {
      if (buffer.length === 0) return;
      const text = buffer;
      buffer = "";
      lastFlush = Date.now();
      await this.send([{
        type: ComponentType.Plain,
        text,
        toDict() { return { type: "text", data: { text } }; },
      } as MessageComponent]);
    };

    // Periodic flush timer ensures partial output is sent even if the
    // generator stalls between chunks.
    flushTimer = setInterval(() => {
      if (buffer.length > 0 && Date.now() - lastFlush >= FLUSH_INTERVAL_MS) {
        flush().catch((e: unknown) => console.error("[QQOfficial] Streaming flush failed:", e));
      }
    }, FLUSH_INTERVAL_MS);

    try {
      for await (const chunk of generator) {
        if (chunk.message) {
          buffer += chunk.message;
          if (buffer.length >= FLUSH_CHAR_THRESHOLD) {
            await flush();
          }
        }
      }
      // Final flush for any remaining buffered text.
      await flush();
    } finally {
      if (flushTimer) clearInterval(flushTimer);
    }
  }

  // ── Private helpers ──

  /** Dispatch a send-message request to the correct REST endpoint based on event type. */
  private async dispatchSend(options: QQOfficialSendOptions): Promise<QQOfficialSendMessageResult> {
    switch (this.eventType) {
      case "group":
        return this.adapter.sendGroupMessageEx(this.targetId, options);
      case "c2c":
        return this.adapter.sendC2CMessageEx(this.targetId, options);
      case "guild":
        return this.adapter.sendGuildMessageEx(this.targetId, options);
      case "direct":
        return this.adapter.sendDirectMessageEx(this.targetId, options);
    }
  }

  /** Store the most recent sent message_id for recall support. */
  private storeSentMessageId(result: QQOfficialSendMessageResult): void {
    if (result.id || result.message_id) {
      this.sentMessageId = result.id ?? result.message_id ?? null;
    }
  }

  private extractPlainText(components: MessageComponent[]): string {
    return components
      .filter((c): c is PlainComponent => c.type === ComponentType.Plain)
      .map(c => c.text ?? "")
      .join("");
  }
}

// ── QQ Official Login Session ──

interface QQOfficialLoginSession {
  bindKey: string;
  taskId: string;
  qrcode: string;
  status: string; // "wait" | "confirmed" | "expired" | "error"
  error?: string;
  startedAt: number;
}

function decryptQQOfficialSecret(encryptedSecret: string, bindKey: string): string {
  try {
    const key = Buffer.from(bindKey, "base64");
    const raw = Buffer.from(encryptedSecret, "base64");

    if (key.length !== 32 || raw.length <= 28) {
      throw new Error("QQ 机器人凭证密文格式异常");
    }

    const nonce = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ciphertext = raw.subarray(12, raw.length - 16);

    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    return decrypted.toString("utf8");
  } catch (exc: any) {
    throw new Error(`QQ 机器人凭证解密失败: ${exc.message}`);
  }
}

// ── QQOfficialAdapter ──

export class QQOfficialAdapter extends PlatformAdapter {
  private config: QQOfficialAdapterConfig;

  // QR Login State
  private loginSession: QQOfficialLoginSession | null = null;
  private qrExpiredCount: number = 0;

  // Authentication
  private accessToken: string = "";
  private tokenExpiresAt: number = 0;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  // WebSocket
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private msgSeqCounter: number = 0;

  // 原生事件分发器 (用于非消息类事件, 如成员变动/消息审核/互动回调等)
  private rawEventEmitter = new EventEmitter();

  constructor(config: QQOfficialAdapterConfig, eventQueue: AsyncQueue<MessageEvent>) {
    super(config as unknown as Record<string, unknown>, eventQueue);
    this.config = config;
  }

  /**
   * 订阅原生 QQ 官方事件 (非消息类)
   * @param eventType 事件类型 (如 "GUILD_MEMBER_ADD", "INTERACTION_CREATE", "MESSAGE_AUDIT_PASS")
   * @param handler 事件处理器
   * @returns 取消订阅函数
   *
   * @example
   * ```typescript
   * adapter.onRawEvent("INTERACTION_CREATE", (data) => {
   *   console.log("按钮回调:", data.data);
   * });
   * ```
   */
  onRawEvent(eventType: string, handler: (data: unknown) => void): () => void {
    this.rawEventEmitter.on(eventType, handler);
    return () => this.rawEventEmitter.off(eventType, handler);
  }

  /** 触发原生事件 */
  private emitRawEvent(eventType: string, data: unknown): void {
    this.rawEventEmitter.emit(eventType, data);
    // 同时 emit 一个通用的 "raw" 事件, 让上层可以监听所有事件
    this.rawEventEmitter.emit("*", { type: eventType, data });
  }

  async initialize(): Promise<void> {
    await super.initialize();
  }

  async run(): Promise<void> {
    this._status = "running";
    this.reconnectAttempts = 0;

    if (this.config.appId && this.config.appSecret) {
      await this.authenticate();
      this.connectWebSocket();
      return;
    }

    // QR Login loop
    (async () => {
      while (this._status === "running") {
        try {
          if (!this.config.appId || !this.config.appSecret) {
            if (!this.isLoginSessionValid(this.loginSession)) {
              try {
                this.loginSession = await this.startLoginSession();
                this.qrExpiredCount = 0;
              } catch (e: unknown) {
                console.error(`[QQOfficial] Start QR login failed:`, e);
                await this.sleep(5000);
                continue;
              }
            }

            const currentLogin = this.loginSession;
            if (!currentLogin) continue;

            try {
              await this.pollQrStatus(currentLogin);
            } catch (e: unknown) {
              console.error(`[QQOfficial] Poll QR status failed:`, e);
              currentLogin.error = String(e);
              await this.sleep(2000);
            }

            if (this.config.appId && this.config.appSecret) {
              console.info(`[QQOfficial] QR binding completed. AppId: ${this.config.appId}`);
              continue;
            }

            if (currentLogin.error) {
              await this.sleep(2000);
            } else {
              const interval = this.config.qqofficialQrPollInterval ?? 2000;
              await this.sleep(interval);
            }
            continue;
          }

          // We have credentials, proceed to authenticate and connect WebSocket
          await this.authenticate();
          this.connectWebSocket();
          break;
        } catch (e: unknown) {
          console.error(`[QQOfficial] QR Login loop error:`, e);
          await this.sleep(5000);
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this._status = "stopping";
    this.loginSession = null;

    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      try { this.ws.close(); } catch (e) { console.warn(`[QQOfficial] ws.close() failed:`, e); }
      this.ws = null;
    }

    try {
      await super.stop();
    } catch (e) { console.warn(`[QQOfficial] super.stop() failed:`, e); }
  }

  meta(): PlatformMetadata {
    return {
      name: "qqofficial",
      description: "QQ Official Bot Adapter",
      id: this.config.id,
      supportStreamingMessage: false,
      supportProactiveMessage: true,
    };
  }

  async healthCheck(): Promise<string | null> {
    if (!this.isRunning) return "Adapter not running";
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return "WebSocket not connected";
    }
    return null;
  }

  // ── Authentication ──

  private async authenticate(): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error("[QQOfficial] appId and appSecret are required for authentication");
    }
    const body = JSON.stringify({
      appId: this.config.appId,
      clientSecret: this.config.appSecret,
    });

    const response = await fetch("https://bots.qq.com/app/getAppAccessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`[QQOfficial] Authentication failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as AccessTokenResponse;
    this.accessToken = data.access_token;
    // Refresh token 30 seconds before expiry
    const refreshDelay = Math.max((data.expires_in - 30) * 1000, 60000);
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;

    console.info(`[QQOfficial] Authenticated successfully, token expires in ${data.expires_in}s`);

    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
    }
    this.tokenRefreshTimer = setTimeout(() => {
      this.refreshToken().catch((e: unknown) => {
        console.error("[QQOfficial] Token refresh failed:", e);
      });
    }, refreshDelay);
  }

  private async refreshToken(): Promise<void> {
    try {
      await this.authenticate();
      console.info("[QQOfficial] Token refreshed successfully");
    } catch (e: unknown) {
      console.error("[QQOfficial] Token refresh failed:", e);
      // Clear any existing timer before scheduling a retry to prevent
      // overlapping timer chains on repeated failures.
      if (this.tokenRefreshTimer) {
        clearTimeout(this.tokenRefreshTimer);
        this.tokenRefreshTimer = null;
      }
      // Retry after 30 seconds
      this.tokenRefreshTimer = setTimeout(() => {
        this.refreshToken().catch(() => { /* will retry again */ });
      }, 30000);
    }
  }

  // ── WebSocket Connection ──

  private getIntents(): number {
    if (this.config.intents !== undefined) {
      return this.config.intents;
    }
    if (this.config.intentNames && this.config.intentNames.length > 0) {
      let bits = 0;
      for (const name of this.config.intentNames) {
        const intent = INTENTS[name as keyof typeof INTENTS];
        if (intent) bits |= intent;
      }
      return bits;
    }
    // Default: guilds + public guild messages + group/C2C messages
    return INTENTS.GUILDS
      | INTENTS.PUBLIC_GUILD_MESSAGES
      | INTENTS.GROUP_AND_C2C_EVENT;
  }

  /** 获取 API 基础 URL (沙箱/生产) */
  private getApiBase(): string {
    return this.config.sandbox
      ? "https://sandbox.api.sgroup.qq.com"
      : "https://api.sgroup.qq.com";
  }

  /** 获取 WebSocket URL (沙箱/生产) */
  private getWsUrl(): string {
    return this.config.sandbox
      ? "wss://sandbox.api.sgroup.qq.com/websocket"
      : "wss://api.sgroup.qq.com/websocket";
  }

  /** 获取分片配置 (无配置返回 undefined) */
  private getShard(): [number, number] | undefined {
    if (Array.isArray(this.config.shard) && this.config.shard.length === 2) {
      return this.config.shard;
    }
    return undefined;
  }

  private connectWebSocket(): void {
    if (this._status !== "running") return;

    const url = this.getWsUrl();
    console.info(`[QQOfficial] Connecting to WebSocket: ${url}${this.config.sandbox ? " (sandbox)" : ""}`);

    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `QQBot ${this.accessToken}`,
      },
    });

    this.ws.on("open", () => {
      console.info("[QQOfficial] WebSocket connected");
    });

    this.ws.on("message", (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString()) as QQOfficialDispatchPayload;
        this.handleWsMessage(data);
      } catch (e: unknown) {
        console.error("[QQOfficial] Failed to parse WebSocket message:", e);
      }
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      console.warn(`[QQOfficial] WebSocket closed (code=${code}, reason=${reason})`);
      this.cleanupWs();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.error("[QQOfficial] WebSocket error:", err.message);
    });
  }

  private handleWsMessage(data: QQOfficialDispatchPayload): void {
    const op = data.op;

    switch (op) {
      case OP.HELLO: {
        const hello = data.d as HelloData;
        this.startHeartbeat(hello.heartbeat_interval);
        // After hello, send identify or resume
        if (this.sessionId && this.lastSeq !== null) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;
      }

      case OP.HEARTBEAT_ACK: {
        // Heartbeat acknowledged, connection is alive
        break;
      }

      case OP.RECONNECT: {
        console.info("[QQOfficial] Server requested reconnect");
        this.cleanupWs();
        this.scheduleReconnect();
        break;
      }

      case OP.INVALID_SESSION: {
        console.warn("[QQOfficial] Invalid session, clearing session state and re-identifying");
        this.sessionId = null;
        this.lastSeq = null;
        this.cleanupWs();
        this.scheduleReconnect();
        break;
      }

      case OP.DISPATCH: {
        this.handleDispatch(data.t, data.s, data.d);
        break;
      }

      default: {
        // Unknown opcode, ignore
        break;
      }
    }
  }

  private handleDispatch(eventType: string | undefined, seq: number | undefined, data: unknown): void {
    if (seq !== undefined) {
      this.lastSeq = seq;
    }

    if (!eventType) return;

    try {
      switch (eventType) {
        case DISPATCH_TYPE.READY: {
          const ready = data as ReadyData;
          this.sessionId = ready.session_id;
          console.info(`[QQOfficial] Session ready, session_id=${this.sessionId}`);
          this.reconnectAttempts = 0;
          this.emitRawEvent("READY", data);
          break;
        }

        case DISPATCH_TYPE.RESUMED: {
          console.info("[QQOfficial] Session resumed successfully");
          this.reconnectAttempts = 0;
          this.emitRawEvent("RESUMED", data);
          break;
        }

        // ── 消息事件 ──
        case DISPATCH_TYPE.GROUP_AT_MESSAGE_CREATE: {
          this.handleGroupAtMessage(data as GroupAtMessageData);
          break;
        }

        case DISPATCH_TYPE.C2C_MESSAGE_CREATE: {
          this.handleC2CMessage(data as C2CMessageData);
          break;
        }

        case DISPATCH_TYPE.AT_MESSAGE_CREATE: {
          this.handleAtMessage(data as AtMessageData);
          break;
        }

        case DISPATCH_TYPE.DIRECT_MESSAGE_CREATE: {
          this.handleDirectMessage(data as DirectMessageData);
          break;
        }

        case DISPATCH_TYPE.MESSAGE_CREATE: {
          // 私域机器人可接收所有消息 (无需@), 复用 handleAtMessage
          this.handleAtMessage(data as AtMessageData);
          break;
        }

        // ── 消息审核事件 ──
        case DISPATCH_TYPE.MESSAGE_AUDIT_PASS:
        case DISPATCH_TYPE.MESSAGE_AUDIT_REJECT: {
          console.info(`[QQOfficial] Message audit: ${eventType}`);
          this.emitRawEvent(eventType, data);
          break;
        }

        // ── 频道事件 (GUILDS intent) ──
        case DISPATCH_TYPE.GUILD_CREATE:
        case DISPATCH_TYPE.GUILD_UPDATE:
        case DISPATCH_TYPE.GUILD_DELETE:
        case DISPATCH_TYPE.CHANNEL_CREATE:
        case DISPATCH_TYPE.CHANNEL_UPDATE:
        case DISPATCH_TYPE.CHANNEL_DELETE: {
          this.emitRawEvent(eventType, data);
          break;
        }

        // ── 频道成员事件 (GUILD_MEMBERS intent) ──
        case DISPATCH_TYPE.GUILD_MEMBER_ADD:
        case DISPATCH_TYPE.GUILD_MEMBER_UPDATE:
        case DISPATCH_TYPE.GUILD_MEMBER_REMOVE: {
          this.emitRawEvent(eventType, data);
          break;
        }

        // ── 表情表态事件 (GUILD_MESSAGE_REACTIONS intent) ──
        case DISPATCH_TYPE.MESSAGE_REACTION_ADD:
        case DISPATCH_TYPE.MESSAGE_REACTION_REMOVE: {
          this.emitRawEvent(eventType, data);
          break;
        }

        // ── 互动事件 (INTERACTION intent) ──
        case DISPATCH_TYPE.INTERACTION_CREATE: {
          console.info("[QQOfficial] Interaction received (button callback)");
          this.emitRawEvent("INTERACTION_CREATE", data);
          break;
        }

        // ── 论坛事件 (FORUMS_EVENT intent, 仅私域) ──
        case DISPATCH_TYPE.FORUM_THREAD_CREATE:
        case DISPATCH_TYPE.FORUM_THREAD_UPDATE:
        case DISPATCH_TYPE.FORUM_THREAD_DELETE:
        case DISPATCH_TYPE.FORUM_POST_CREATE:
        case DISPATCH_TYPE.FORUM_POST_DELETE:
        case DISPATCH_TYPE.FORUM_REPLY_CREATE:
        case DISPATCH_TYPE.FORUM_REPLY_DELETE:
        case DISPATCH_TYPE.FORUM_PUBLISH_AUDIT_RESULT: {
          this.emitRawEvent(eventType, data);
          break;
        }

        // ── 音频事件 (AUDIO_ACTION intent) ──
        case DISPATCH_TYPE.AUDIO_START:
        case DISPATCH_TYPE.AUDIO_FINISH:
        case DISPATCH_TYPE.AUDIO_ON_MIC:
        case DISPATCH_TYPE.AUDIO_OFF_MIC: {
          this.emitRawEvent(eventType, data);
          break;
        }

        default: {
          // 未识别的 dispatch 事件, 通过 raw 事件分发
          if (eventType) {
            this.emitRawEvent(eventType, data);
          }
          break;
        }
      }
    } catch (e: unknown) {
      console.error(`[QQOfficial] Error handling dispatch event ${eventType}:`, e);
    }
  }

  // ── Message Handlers ──

  private handleGroupAtMessage(data: GroupAtMessageData): void {
    const content = this.stripMentionPrefix(data.content ?? "").trim();
    const senderId = data.author.member_openid ?? data.author.user_openid ?? "unknown";
    const groupOpenId = data.group_openid;

    const components = this.parseAttachments(data.attachments);
    components.unshift({
      type: ComponentType.Plain,
      text: content,
      toDict() { return { type: "text", data: { text: content } }; },
    } as PlainComponent);

    const platformMsg = new PlatformMessage();
    platformMsg.type = MessageType.GROUP_MESSAGE;
    platformMsg.selfId = this.config.appId!;
    platformMsg.sessionId = groupOpenId;
    platformMsg.messageId = data.id;
    platformMsg.sender = { userId: senderId, nickname: null };
    platformMsg.components = components;
    platformMsg.messageStr = content;
    platformMsg.timestamp = data.timestamp ? Date.parse(data.timestamp) : Date.now();

    const event = new QQOfficialEvent(
      platformMsg.messageStr,
      platformMsg,
      this.meta(),
      groupOpenId,
      this,
      "group",
      groupOpenId,
      data.id,
    );
    // GROUP_AT_MESSAGE_CREATE inherently means the bot was @'ed — bypass wake check
    event.isWake = true;
    event.isAtOrWakeCommand = true;

    this.commitEvent(event);
  }

  private handleC2CMessage(data: C2CMessageData): void {
    const content = (data.content ?? "").trim();
    const senderId = data.author.user_openid ?? "unknown";

    const components = this.parseAttachments(data.attachments);
    components.unshift({
      type: ComponentType.Plain,
      text: content,
      toDict() { return { type: "text", data: { text: content } }; },
    } as PlainComponent);

    const platformMsg = new PlatformMessage();
    platformMsg.type = MessageType.FRIEND_MESSAGE;
    platformMsg.selfId = this.config.appId!;
    platformMsg.sessionId = senderId;
    platformMsg.messageId = data.id;
    platformMsg.sender = { userId: senderId, nickname: null };
    platformMsg.components = components;
    platformMsg.messageStr = content;
    platformMsg.timestamp = data.timestamp ? Date.parse(data.timestamp) : Date.now();

    const event = new QQOfficialEvent(
      platformMsg.messageStr,
      platformMsg,
      this.meta(),
      senderId,
      this,
      "c2c",
      senderId,
      data.id,
    );

    this.commitEvent(event);
  }

  private handleAtMessage(data: AtMessageData): void {
    // Guild channel @bot message
    const content = this.stripMentionPrefix(data.content ?? "").trim();
    const senderId = data.author.id ?? "unknown";
    const channelId = data.channel_id;

    const components = this.parseAttachments(data.attachments);
    components.unshift({
      type: ComponentType.Plain,
      text: content,
      toDict() { return { type: "text", data: { text: content } }; },
    } as PlainComponent);

    const platformMsg = new PlatformMessage();
    platformMsg.type = MessageType.GROUP_MESSAGE;
    platformMsg.selfId = this.config.appId!;
    platformMsg.sessionId = channelId;
    platformMsg.messageId = data.id;
    platformMsg.sender = { userId: senderId, nickname: data.author.username ?? null };
    platformMsg.components = components;
    platformMsg.messageStr = content;
    platformMsg.timestamp = data.timestamp ? Date.parse(data.timestamp) : Date.now();

    const event = new QQOfficialEvent(
      platformMsg.messageStr,
      platformMsg,
      this.meta(),
      channelId,
      this,
      "guild",
      channelId,
      data.id,
    );
    // AT_MESSAGE_CREATE inherently means the bot was @'ed — bypass wake check
    event.isWake = true;
    event.isAtOrWakeCommand = true;

    this.commitEvent(event);
  }

  private handleDirectMessage(data: DirectMessageData): void {
    const content = (data.content ?? "").trim();
    const senderId = data.author.id ?? "unknown";
    const channelId = data.channel_id;

    const components = this.parseAttachments(data.attachments);
    components.unshift({
      type: ComponentType.Plain,
      text: content,
      toDict() { return { type: "text", data: { text: content } }; },
    } as PlainComponent);

    const platformMsg = new PlatformMessage();
    platformMsg.type = MessageType.FRIEND_MESSAGE;
    platformMsg.selfId = this.config.appId!;
    platformMsg.sessionId = channelId;
    platformMsg.messageId = data.id;
    platformMsg.sender = { userId: senderId, nickname: null };
    platformMsg.components = components;
    platformMsg.messageStr = content;
    platformMsg.timestamp = data.timestamp ? Date.parse(data.timestamp) : Date.now();

    const event = new QQOfficialEvent(
      platformMsg.messageStr,
      platformMsg,
      this.meta(),
      channelId,
      this,
      "direct",
      channelId,
      data.id,
    );

    this.commitEvent(event);
  }

  // ── Message Parsing Helpers ──

  /** Strip @bot mention prefix like `<@!123456>` from content */
  private stripMentionPrefix(content: string): string {
    return content.replace(/<@!\d+>/g, "").trim();
  }

  private parseAttachments(attachments?: QQOfficialAttachment[]): MessageComponent[] {
    const components: MessageComponent[] = [];
    if (!attachments) return components;

    for (const att of attachments) {
      const contentType = (att.content_type ?? "").toLowerCase();
      const url = att.url
        ? (att.url.startsWith("http://") || att.url.startsWith("https://"))
          ? att.url
          : `https://${att.url}`
        : "";

      if (contentType.startsWith("image") || !contentType) {
        if (url) {
          components.push({
            type: ComponentType.Image,
            url,
            toDict() { return { type: "image", data: { url } }; },
          } as ImageComponent);
        }
      }
      // Other attachment types can be extended here
    }

    return components;
  }

  // ── WebSocket Protocol ──

  private sendIdentify(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const d: Record<string, unknown> = {
      token: `QQBot ${this.accessToken}`,
      intents: this.getIntents(),
    };

    // 分片配置 (无配置默认 [0, 1])
    const shard = this.getShard();
    d.shard = shard ?? [0, 1];

    const payload: QQOfficialDispatchPayload = {
      op: OP.IDENTIFY,
      d,
    };

    this.ws.send(JSON.stringify(payload));
    const shardInfo = d.shard as [number, number];
    console.info(`[QQOfficial] Identify sent (shard: ${shardInfo.join("/")})`);
  }

  private sendResume(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.sessionId || this.lastSeq === null) {
      // Cannot resume, re-identify
      this.sendIdentify();
      return;
    }

    const payload: QQOfficialDispatchPayload = {
      op: OP.RESUME,
      d: {
        token: `QQBot ${this.accessToken}`,
        session_id: this.sessionId,
        seq: this.lastSeq,
      },
    };

    this.ws.send(JSON.stringify(payload));
    console.info("[QQOfficial] Resume sent");
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const payload: QQOfficialDispatchPayload = {
          op: OP.HEARTBEAT,
          d: this.lastSeq,
        };
        try {
          this.ws.send(JSON.stringify(payload));
        } catch (e: unknown) {
          console.error("[QQOfficial] Failed to send heartbeat:", e);
        }
      }
    }, intervalMs);

    console.info(`[QQOfficial] Heartbeat started, interval=${intervalMs}ms`);
  }

  private cleanupWs(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this._status !== "running") return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[QQOfficial] Max reconnect attempts (${this.maxReconnectAttempts}) reached, giving up`);
      this._status = "error";
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, ... up to 60s
    const baseDelay = 1000;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;

    console.info(`[QQOfficial] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(async () => {
      if (this._status !== "running") return;

      try {
        // Only re-authenticate when the access token is missing or about to
        // expire. The QQ server sends OP.RECONNECT (~every 30 min) for load
        // balancing; this does NOT require a fresh token. Re-authenticating on
        // every reconnect wastes an API call, needlessly resets the refresh
        // timer, and — if the API ever returns a different access token — risks
        // invalidating the old token mid-session and triggering an extra
        // server-side reconnect. Reuse the current token while it is still
        // valid; the refresh timer will renew it before expiry.
        const tokenRemainingMs = this.tokenExpiresAt - Date.now();
        if (!this.accessToken || tokenRemainingMs < 300000) {
          await this.authenticate();
        }
        this.connectWebSocket();
        // Try resume first, identify will be sent after HELLO
      } catch (e: unknown) {
        console.error("[QQOfficial] Reconnect authentication failed:", e);
        this.scheduleReconnect();
      }
    }, delay);
  }

  // ── REST API: Send Messages ──

  private getAuthHeaders(): Record<string, string> {
    return {
      "Authorization": `QQBot ${this.accessToken}`,
      "Content-Type": "application/json",
    };
  }

  /** Generate a monotonic msg_seq for idempotency tracking (QQ dedupes within 5s). */
  private nextMsgSeq(): number {
    this.msgSeqCounter = (this.msgSeqCounter + 1) % 1000000;
    return this.msgSeqCounter;
  }

  /**
   * Build the JSON body for an extended send-message request.
   *
   * NOTE on `msg_id`: per QQ Bot API spec
   * (https://bot.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html),
   * `msg_id` is OPTIONAL and is used only for passive replies (within the
   * 5-minute group / 60-minute C2C reply window). For proactive messages
   * the field MUST be omitted entirely — sending `msg_id: ""` causes the
   * API to reject the request with code 12002 (RequestInvalid) or similar,
   * which is the root cause of scheduled reminders never being delivered.
   * C2C proactive messages may instead set `is_wakeup: true` to use the
   * 互动召回 quota (4 periods within 30 days of last user interaction).
   */
  private buildSendBody(options: QQOfficialSendOptions, msgId?: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      msg_type: options.msg_type ?? 0,
      msg_seq: this.nextMsgSeq(),
    };
    // Only include msg_id when we actually have one (passive reply). For
    // proactive messages, omit the field so the API treats it as主动消息.
    const effectiveMsgId = options.msg_id ?? msgId;
    if (effectiveMsgId && typeof effectiveMsgId === "string" && effectiveMsgId.length > 0) {
      body.msg_id = effectiveMsgId;
    }
    if (options.content !== undefined) body.content = options.content;
    if (options.markdown) body.markdown = options.markdown;
    if (options.ark) body.ark = options.ark;
    if (options.embed) body.embed = options.embed;
    if (options.media) body.media = options.media;
    if (options.keyboard) body.keyboard = options.keyboard;
    if (options.is_wakeup !== undefined) body.is_wakeup = options.is_wakeup;
    return body;
  }

  /** Parse a send-message response into a result object. */
  private async parseSendResult(response: Response): Promise<QQOfficialSendMessageResult> {
    // 200/204 are success; body may be empty (204) or contain id/audit_id
    if (response.status === 204) return {};
    try {
      const data = await response.json() as Record<string, unknown>;
      return {
        id: data.id as string | undefined,
        message_id: (data.message_id ?? data.id) as string | undefined,
        seq: data.seq as number | undefined,
        audit_id: data.audit_id as string | undefined,
      };
    } catch {
      return {};
    }
  }

  /**
   * 发送群消息 (扩展版, 支持所有 msg_type)
   * POST /v2/groups/{group_openid}/messages
   */
  async sendGroupMessageEx(
    groupOpenId: string,
    options: QQOfficialSendOptions,
  ): Promise<QQOfficialSendMessageResult> {
    const url = `${this.getApiBase()}/v2/groups/${groupOpenId}/messages`;
    const body = JSON.stringify(this.buildSendBody(options));

    const response = await fetch(url, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] Send group message failed: ${response.status} ${text}`);
    }
    return this.parseSendResult(response);
  }

  /**
   * 发送 C2C 单聊消息 (扩展版, 支持所有 msg_type + is_wakeup)
   * POST /v2/users/{openid}/messages
   */
  async sendC2CMessageEx(
    openid: string,
    options: QQOfficialSendOptions,
  ): Promise<QQOfficialSendMessageResult> {
    const url = `${this.getApiBase()}/v2/users/${openid}/messages`;
    const body = JSON.stringify(this.buildSendBody(options));

    const response = await fetch(url, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] Send C2C message failed: ${response.status} ${text}`);
    }
    return this.parseSendResult(response);
  }

  /**
   * 发送频道子频道消息 (扩展版)
   * POST /channels/{channel_id}/messages
   */
  async sendGuildMessageEx(
    channelId: string,
    options: QQOfficialSendOptions,
  ): Promise<QQOfficialSendMessageResult> {
    const url = `${this.getApiBase()}/channels/${channelId}/messages`;
    // 频道消息体: msg_type 频道默认 0, content 必填; msg_id/msg_seq 仅被动回复需要
    const bodyObj: Record<string, unknown> = { content: options.content ?? "" };
    if (options.msg_type !== undefined) bodyObj.msg_type = options.msg_type;
    if (options.markdown) bodyObj.markdown = options.markdown;
    if (options.ark) bodyObj.ark = options.ark;
    if (options.embed) bodyObj.embed = options.embed;
    if (options.media) bodyObj.media = options.media;
    if (options.keyboard) bodyObj.keyboard = options.keyboard;
    if (options.msg_id) bodyObj.msg_id = options.msg_id;

    const response = await fetch(url, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] Send guild message failed: ${response.status} ${text}`);
    }
    return this.parseSendResult(response);
  }

  /**
   * 发送频道私信消息 (扩展版)
   * POST /channels/{channel_id}/messages (DM channel)
   */
  async sendDirectMessageEx(
    channelId: string,
    options: QQOfficialSendOptions,
  ): Promise<QQOfficialSendMessageResult> {
    const url = `${this.getApiBase()}/channels/${channelId}/messages`;
    const bodyObj: Record<string, unknown> = { content: options.content ?? "" };
    if (options.msg_type !== undefined) bodyObj.msg_type = options.msg_type;
    if (options.markdown) bodyObj.markdown = options.markdown;
    if (options.ark) bodyObj.ark = options.ark;
    if (options.embed) bodyObj.embed = options.embed;
    if (options.media) bodyObj.media = options.media;
    if (options.keyboard) bodyObj.keyboard = options.keyboard;

    const response = await fetch(url, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] Send direct message failed: ${response.status} ${text}`);
    }
    return this.parseSendResult(response);
  }

  // ── Backward-compatible simple send methods (return result for recall support) ──

  /** Send group text message via REST API (backward compatible) */
  async sendGroupMessage(groupOpenId: string, content: string, eventId: string): Promise<QQOfficialSendMessageResult> {
    return this.sendGroupMessageEx(groupOpenId, { content, msg_type: 0, msg_id: eventId });
  }

  /** Send C2C text message via REST API (backward compatible) */
  async sendC2CMessage(openid: string, content: string, eventId: string): Promise<QQOfficialSendMessageResult> {
    return this.sendC2CMessageEx(openid, { content, msg_type: 0, msg_id: eventId });
  }

  /** Send guild channel text message via REST API (backward compatible) */
  async sendGuildMessage(channelId: string, content: string): Promise<QQOfficialSendMessageResult> {
    return this.sendGuildMessageEx(channelId, { content });
  }

  /** Send direct message (guild DM) via REST API (backward compatible) */
  async sendDirectMessage(channelId: string, content: string): Promise<QQOfficialSendMessageResult> {
    return this.sendDirectMessageEx(channelId, { content });
  }

  // ── REST API: Rich Media Upload ──

  /**
   * 上传群聊富媒体文件
   * POST /v2/groups/{group_openid}/files
   */
  async uploadGroupRichMedia(
    groupOpenId: string,
    fileType: QQOfficialMediaType,
    url: string,
    fileData?: string,
  ): Promise<QQOfficialRichMediaUploadResult> {
    const apiUrl = `${this.getApiBase()}/v2/groups/${groupOpenId}/files`;
    return this.uploadRichMedia(apiUrl, fileType, url, fileData);
  }

  /**
   * 上传单聊富媒体文件
   * POST /v2/users/{openid}/files
   */
  async uploadC2CRichMedia(
    openid: string,
    fileType: QQOfficialMediaType,
    url: string,
    fileData?: string,
  ): Promise<QQOfficialRichMediaUploadResult> {
    const apiUrl = `${this.getApiBase()}/v2/users/${openid}/files`;
    return this.uploadRichMedia(apiUrl, fileType, url, fileData);
  }

  private async uploadRichMedia(
    apiUrl: string,
    fileType: QQOfficialMediaType,
    url: string,
    fileData?: string,
  ): Promise<QQOfficialRichMediaUploadResult> {
    const bodyObj: Record<string, unknown> = { file_type: fileType, url };
    if (fileData) bodyObj.file_data = fileData;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] Upload rich media failed: ${response.status} ${text}`);
    }

    return await response.json() as QQOfficialRichMediaUploadResult;
  }

  // ── REST API: Message Recall (Delete) ──

  /**
   * 撤回单聊消息
   * DELETE /v2/users/{openid}/messages/{message_id}
   */
  async deleteC2CMessage(openid: string, messageId: string): Promise<void> {
    const url = `${this.getApiBase()}/v2/users/${openid}/messages/${messageId}`;
    await this.deleteMessage(url);
  }

  /**
   * 撤回群聊消息 (机器人自己的, 或被设为管理员后撤回成员的)
   * DELETE /v2/groups/{group_openid}/messages/{message_id}
   */
  async deleteGroupMessage(groupOpenId: string, messageId: string): Promise<void> {
    const url = `${this.getApiBase()}/v2/groups/${groupOpenId}/messages/${messageId}`;
    await this.deleteMessage(url);
  }

  /**
   * 撤回频道子频道消息
   * DELETE /channels/{channel_id}/messages/{message_id}?hidetip=false
   * @param hideTip 是否隐藏提示小灰条, 默认 false
   */
  async deleteGuildMessage(channelId: string, messageId: string, hideTip: boolean = false): Promise<void> {
    const url = `${this.getApiBase()}/channels/${channelId}/messages/${messageId}?hidetip=${hideTip}`;
    await this.deleteMessage(url);
  }

  private async deleteMessage(url: string): Promise<void> {
    const response = await fetch(url, {
      method: "DELETE",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] Delete message failed: ${response.status} ${text}`);
    }
  }

  // ── REST API: Emoji Reactions (Channel only) ──

  /**
   * 发表表情表态 (频道场景)
   * PUT /channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}
   * @param type 表情类型, 参考 EmojiType
   * @param id 表情 ID, 参考 Emoji 列表
   */
  async addReaction(
    channelId: string,
    messageId: string,
    type: number,
    id: string,
  ): Promise<void> {
    const url = `${this.getApiBase()}/channels/${channelId}/messages/${messageId}/reactions/${type}/${id}`;
    const response = await fetch(url, {
      method: "PUT",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] Add reaction failed: ${response.status} ${text}`);
    }
  }

  /**
   * 删除机器人发表的表情表态 (频道场景)
   * DELETE /channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}
   */
  async deleteReaction(
    channelId: string,
    messageId: string,
    type: number,
    id: string,
  ): Promise<void> {
    const url = `${this.getApiBase()}/channels/${channelId}/messages/${messageId}/reactions/${type}/${id}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] Delete reaction failed: ${response.status} ${text}`);
    }
  }

  /**
   * 获取消息表情表态的用户列表 (频道场景)
   * GET /channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}?cookie=&limit=
   */
  async getReactionUsers(
    channelId: string,
    messageId: string,
    type: number,
    id: string,
    options: { cookie?: string; limit?: number } = {},
  ): Promise<QQOfficialReactionUsersResult> {
    const params = new URLSearchParams();
    if (options.cookie) params.set("cookie", options.cookie);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString();
    const url = `${this.getApiBase()}/channels/${channelId}/messages/${messageId}/reactions/${type}/${id}${query ? `?${query}` : ""}`;

    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] Get reaction users failed: ${response.status} ${text}`);
    }

    return await response.json() as QQOfficialReactionUsersResult;
  }

  /** Create a DM session for guild direct messages */
  async createDmSession(recipientId: string): Promise<string> {
    const url = `${this.getApiBase()}/users/@me/dms`;
    const body = JSON.stringify({ recipient_id: recipientId });

    const response = await fetch(url, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] Create DM session failed: ${response.status} ${text}`);
    }

    const data = await response.json() as { channel_id: string };
    return data.channel_id;
  }

  /**
   * 主动推送消息到指定会话。
   *
   * 通过解析 unifiedMsgOrigin 提取 eventType 和 targetId，然后调用对应的
   * REST API 发送消息。按 QQ 官方 API 规范
   * (https://bot.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html):
   *   - 群聊主动消息: 省略 msg_id，使用每月 4 条/群的主动消息配额
   *     (需群主在 QQ 客户端开启"机器人主动在群聊内发言"设置项)
   *   - C2C 主动消息: 设置 is_wakeup=true，使用 30 天内 4 个周期的互动召回配额
   *     (与 msg_id 互斥；用户最近一次与机器人对话后即可下发，更适合提醒场景)
   *   - 频道/私信: 直接发送（频道有独立的主动消息限额）
   *
   * 注意: buildSendBody 已确保不会发送空的 msg_id，避免触发 API 错误。
   */
  override async sendProactiveMessage(
    target: { umo: string; sessionId: string; platformId: string },
    components: MessageComponent[],
  ): Promise<boolean> {
    const text = extractText(components);
    if (!text) {
      console.warn("[QQOfficial] sendProactiveMessage: no text content extracted from components.");
      return false;
    }

    // QQOfficial 的 UMO 格式: qqofficial:<eventType>:<targetId>
    const parsed = parseQQOfficialUMO(target.umo);
    if (!parsed) {
      // fallback: 尝试用 sessionId 作为 targetId，默认 c2c
      console.warn(`[QQOfficial] Cannot parse UMO ${target.umo}, falling back to sessionId as c2c target.`);
      try {
        // Use Ex variant to leverage is_wakeup for C2C proactive delivery
        await this.sendC2CMessageEx(target.sessionId, {
          content: text,
          msg_type: 0,
          is_wakeup: true,
        });
        return true;
      } catch (e) {
        console.error(`[QQOfficial] Proactive message (fallback c2c, target=${target.sessionId}) failed:`, e);
        return false;
      }
    }

    try {
      switch (parsed.eventType) {
        case "group":
          // Proactive group message: omit msg_id entirely (buildSendBody
          // handles this). Consumes monthly 4-msg/group proactive quota.
          await this.sendGroupMessageEx(parsed.targetId, {
            content: text,
            msg_type: 0,
          });
          break;
        case "c2c":
          // C2C proactive: use is_wakeup=true to leverage互动召回 quota
          // (4 periods within 30 days of last user interaction) instead of
          // the stricter 4-msg/month proactive quota. is_wakeup is mutually
          // exclusive with msg_id, so we must NOT pass msg_id here.
          await this.sendC2CMessageEx(parsed.targetId, {
            content: text,
            msg_type: 0,
            is_wakeup: true,
          });
          break;
        case "guild":
          await this.sendGuildMessage(parsed.targetId, text);
          break;
        case "direct":
          await this.sendDirectMessage(parsed.targetId, text);
          break;
      }
      return true;
    } catch (e) {
      console.error(
        `[QQOfficial] Proactive message failed (umo=${target.umo}, eventType=${parsed?.eventType}, targetId=${parsed?.targetId}):`,
        e,
      );
      return false;
    }
  }

  // ── Phase 2: Guild API ──

  /**
   * 获取频道信息
   * GET /guilds/{guild_id}
   */
  async getGuild(guildId: string): Promise<QQOfficialGuild> {
    const url = `${this.getApiBase()}/guilds/${guildId}`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getGuild failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialGuild;
  }

  /**
   * 获取机器人加入的频道列表
   * GET /users/@me/guilds?before=&after=&limit=
   */
  async getGuilds(options?: { before?: string; after?: string; limit?: number }): Promise<QQOfficialGuild[]> {
    const params = new URLSearchParams();
    if (options?.before) params.set("before", options.before);
    if (options?.after) params.set("after", options.after);
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString() ? `?${params.toString()}` : "";
    const url = `${this.getApiBase()}/users/@me/guilds${query}`;

    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getGuilds failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialGuild[];
  }

  /**
   * 获取频道成员列表 (私域机器人可用, 支持分页)
   * GET /guilds/{guild_id}/members?after=&limit=
   */
  async getGuildMembers(
    guildId: string,
    options?: { after?: string; limit?: number },
  ): Promise<QQOfficialMember[]> {
    const params = new URLSearchParams();
    if (options?.after) params.set("after", options.after);
    params.set("limit", String(options?.limit ?? 1));
    const url = `${this.getApiBase()}/guilds/${guildId}/members?${params.toString()}`;

    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getGuildMembers failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialMember[];
  }

  /**
   * 获取频道成员详情
   * GET /guilds/{guild_id}/members/{user_id}
   */
  async getGuildMember(guildId: string, userId: string): Promise<QQOfficialMember> {
    const url = `${this.getApiBase()}/guilds/${guildId}/members/${userId}`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getGuildMember failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialMember;
  }

  /**
   * 删除频道成员 (踢出)
   * DELETE /guilds/{guild_id}/members/{user_id}?add_blacklist=&delete_message_days=
   */
  async deleteGuildMember(
    guildId: string,
    userId: string,
    options?: { addBlacklist?: boolean; deleteMessageDays?: number },
  ): Promise<void> {
    const params = new URLSearchParams();
    if (options?.addBlacklist !== undefined) params.set("add_blacklist", String(options.addBlacklist));
    if (options?.deleteMessageDays !== undefined) params.set("delete_message_days", String(options.deleteMessageDays));
    const query = params.toString() ? `?${params.toString()}` : "";
    const url = `${this.getApiBase()}/guilds/${guildId}/members/${userId}${query}`;

    const response = await fetch(url, {
      method: "DELETE",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] deleteGuildMember failed: ${response.status} ${text}`);
    }
  }

  /**
   * 修改频道成员 (修改昵称/禁言/头像)
   * PATCH /guilds/{guild_id}/members/{user_id}
   */
  async modifyGuildMember(
    guildId: string,
    userId: string,
    options: QQOfficialModifyMemberOptions,
  ): Promise<void> {
    const url = `${this.getApiBase()}/guilds/${guildId}/members/${userId}`;
    const body: Record<string, unknown> = {};
    if (options.nick !== undefined) body.nick = options.nick;
    if (options.mute_seconds !== undefined) body.mute_seconds = options.mute_seconds;
    if (options.avatar !== undefined) body.avatar = options.avatar;

    const response = await fetch(url, {
      method: "PATCH",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] modifyGuildMember failed: ${response.status} ${text}`);
    }
  }

  /**
   * 禁言频道成员 (便捷方法)
   * 等同于 modifyGuildMember({ mute_seconds: String(seconds) })
   */
  async muteGuildMember(guildId: string, userId: string, seconds: number): Promise<void> {
    await this.modifyGuildMember(guildId, userId, { mute_seconds: String(seconds) });
  }

  /**
   * 解除频道成员禁言 (便捷方法)
   */
  async unmuteGuildMember(guildId: string, userId: string): Promise<void> {
    await this.modifyGuildMember(guildId, userId, { mute_seconds: "0" });
  }

  /**
   * 获取频道身份组列表
   * GET /guilds/{guild_id}/roles
   */
  async getGuildRoles(guildId: string): Promise<QQOfficialRole[]> {
    const url = `${this.getApiBase()}/guilds/${guildId}/roles`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getGuildRoles failed: ${response.status} ${text}`);
    }
    const data = await response.json() as { roles: QQOfficialRole[] };
    return data.roles;
  }

  /**
   * 获取身份组成员列表 (分页)
   * GET /guilds/{guild_id}/roles/{role_id}/members?start_index=&limit=
   */
  async getRoleMembers(
    guildId: string,
    roleId: string,
    options?: { startIndex?: string; limit?: number },
  ): Promise<{ members: QQOfficialMember[]; next_start_index?: string }> {
    const params = new URLSearchParams();
    if (options?.startIndex) params.set("start_index", options.startIndex);
    params.set("limit", String(options?.limit ?? 1));
    const url = `${this.getApiBase()}/guilds/${guildId}/roles/${roleId}/members?${params.toString()}`;

    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getRoleMembers failed: ${response.status} ${text}`);
    }
    return await response.json() as { members: QQOfficialMember[]; next_start_index?: string };
  }

  /**
   * 为成员添加身份组
   * PUT /guilds/{guild_id}/members/{user_id}/roles/{role_id}
   */
  async addRoleToMember(guildId: string, userId: string, roleId: string): Promise<void> {
    const url = `${this.getApiBase()}/guilds/${guildId}/members/${userId}/roles/${roleId}`;
    const response = await fetch(url, {
      method: "PUT",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] addRoleToMember failed: ${response.status} ${text}`);
    }
  }

  /**
   * 移除成员的身份组
   * DELETE /guilds/{guild_id}/members/{user_id}/roles/{role_id}
   */
  async removeRoleFromMember(guildId: string, userId: string, roleId: string): Promise<void> {
    const url = `${this.getApiBase()}/guilds/${guildId}/members/${userId}/roles/${roleId}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] removeRoleFromMember failed: ${response.status} ${text}`);
    }
  }

  // ── Phase 2: Channel API ──

  /**
   * 获取频道下的子频道列表
   * GET /guilds/{guild_id}/channels
   */
  async getGuildChannels(guildId: string): Promise<QQOfficialChannel[]> {
    const url = `${this.getApiBase()}/guilds/${guildId}/channels`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getGuildChannels failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialChannel[];
  }

  /**
   * 获取子频道详情
   * GET /channels/{channel_id}
   */
  async getChannel(channelId: string): Promise<QQOfficialChannel> {
    const url = `${this.getApiBase()}/channels/${channelId}`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getChannel failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialChannel;
  }

  /**
   * 创建子频道
   * POST /guilds/{guild_id}/channels
   */
  async createChannel(guildId: string, options: QQOfficialChannelCreateOptions): Promise<QQOfficialChannel> {
    const url = `${this.getApiBase()}/guilds/${guildId}/channels`;
    const response = await fetch(url, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] createChannel failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialChannel;
  }

  /**
   * 修改子频道
   * PATCH /channels/{channel_id}
   */
  async updateChannel(channelId: string, options: QQOfficialChannelUpdateOptions): Promise<QQOfficialChannel> {
    const url = `${this.getApiBase()}/channels/${channelId}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] updateChannel failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialChannel;
  }

  /**
   * 删除子频道
   * DELETE /channels/{channel_id}
   */
  async deleteChannel(channelId: string): Promise<void> {
    const url = `${this.getApiBase()}/channels/${channelId}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] deleteChannel failed: ${response.status} ${text}`);
    }
  }

  /**
   * 获取子频道在线成员数
   * GET /channels/{channel_id}/online_nums
   */
  async getChannelOnlineNums(channelId: string): Promise<QQOfficialOnlineNums> {
    const url = `${this.getApiBase()}/channels/${channelId}/online_nums`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getChannelOnlineNums failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialOnlineNums;
  }

  /**
   * 获取子频道用户权限
   * GET /channels/{channel_id}/permissions/{user_id}
   */
  async getChannelUserPermissions(channelId: string, userId: string): Promise<QQOfficialChannelPermissions> {
    const url = `${this.getApiBase()}/channels/${channelId}/permissions/${userId}`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getChannelUserPermissions failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialChannelPermissions;
  }

  /**
   * 修改子频道用户权限 (PUT 为覆盖, PATCH 为增量)
   * PUT/PATCH /channels/{channel_id}/permissions/{user_id}
   * @param additive true=增量修改(PATCH), false=覆盖(PUT)
   */
  async updateChannelUserPermissions(
    channelId: string,
    userId: string,
    permissions: QQOfficialChannelPermissions,
    additive: boolean = false,
  ): Promise<void> {
    const url = `${this.getApiBase()}/channels/${channelId}/permissions/${userId}`;
    const response = await fetch(url, {
      method: additive ? "PATCH" : "PUT",
      headers: this.getAuthHeaders(),
      body: JSON.stringify({ add: permissions.permissions ?? "", remove: "" }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] updateChannelUserPermissions failed: ${response.status} ${text}`);
    }
  }

  /**
   * 获取子频道身份组权限
   * GET /channels/{channel_id}/permissions/{role_id}
   */
  async getChannelRolePermissions(channelId: string, roleId: string): Promise<QQOfficialChannelPermissions> {
    const url = `${this.getApiBase()}/channels/${channelId}/permissions/${roleId}`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getChannelRolePermissions failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialChannelPermissions;
  }

  /**
   * 修改子频道身份组权限
   * PUT/PATCH /channels/{channel_id}/permissions/{role_id}
   * @param additive true=增量(PATCH), false=覆盖(PUT)
   */
  async updateChannelRolePermissions(
    channelId: string,
    roleId: string,
    permissions: QQOfficialChannelPermissions,
    additive: boolean = false,
  ): Promise<void> {
    const url = `${this.getApiBase()}/channels/${channelId}/permissions/${roleId}`;
    const response = await fetch(url, {
      method: additive ? "PATCH" : "PUT",
      headers: this.getAuthHeaders(),
      body: JSON.stringify({ add: permissions.permissions ?? "", remove: "" }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] updateChannelRolePermissions failed: ${response.status} ${text}`);
    }
  }

  // ── Phase 2: Announces API ──

  /**
   * 获取频道公告列表
   * GET /guilds/{guild_id}/announces
   */
  async getAnnounces(guildId: string): Promise<QQOfficialAnnounce[]> {
    const url = `${this.getApiBase()}/guilds/${guildId}/announces`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getAnnounces failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialAnnounce[];
  }

  /**
   * 创建频道公告 (将消息设置为频道公告)
   * POST /guilds/{guild_id}/announces
   */
  async createAnnounce(guildId: string, options: QQOfficialAnnounceCreateOptions): Promise<QQOfficialAnnounce> {
    const url = `${this.getApiBase()}/guilds/${guildId}/announces`;
    const response = await fetch(url, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] createAnnounce failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialAnnounce;
  }

  /**
   * 删除频道公告
   * DELETE /guilds/{guild_id}/announces/{message_id}
   */
  async deleteAnnounce(guildId: string, messageId: string): Promise<void> {
    const url = `${this.getApiBase()}/guilds/${guildId}/announces/${messageId}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] deleteAnnounce failed: ${response.status} ${text}`);
    }
  }

  // ── Phase 2: Schedule API ──

  /**
   * 获取日程列表 (频道日程子频道)
   * GET /channels/{channel_id}/schedules?since=
   */
  async getSchedules(channelId: string, since?: string): Promise<QQOfficialSchedule[]> {
    const params = new URLSearchParams();
    if (since) params.set("since", since);
    const query = params.toString() ? `?${params.toString()}` : "";
    const url = `${this.getApiBase()}/channels/${channelId}/schedules${query}`;

    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getSchedules failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialSchedule[];
  }

  /**
   * 创建日程
   * POST /channels/{channel_id}/schedules
   */
  async createSchedule(channelId: string, options: QQOfficialScheduleOptions): Promise<QQOfficialSchedule> {
    const url = `${this.getApiBase()}/channels/${channelId}/schedules`;
    const response = await fetch(url, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body: JSON.stringify({ schedule: options }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] createSchedule failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialSchedule;
  }

  /**
   * 修改日程
   * PATCH /channels/{channel_id}/schedules/{schedule_id}
   */
  async updateSchedule(
    channelId: string,
    scheduleId: string,
    options: QQOfficialScheduleOptions,
  ): Promise<QQOfficialSchedule> {
    const url = `${this.getApiBase()}/channels/${channelId}/schedules/${scheduleId}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers: this.getAuthHeaders(),
      body: JSON.stringify({ schedule: options }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] updateSchedule failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialSchedule;
  }

  /**
   * 删除日程
   * DELETE /channels/{channel_id}/schedules/{schedule_id}
   */
  async deleteSchedule(channelId: string, scheduleId: string): Promise<void> {
    const url = `${this.getApiBase()}/channels/${channelId}/schedules/${scheduleId}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] deleteSchedule failed: ${response.status} ${text}`);
    }
  }

  // ── Phase 2: API Permissions ──

  /**
   * 获取机器人在频道可用权限列表
   * GET /guilds/{guild_id}/api_permission
   */
  async getApiPermissions(guildId: string): Promise<Array<{ path: string; method: string; desc: string }>> {
    const url = `${this.getApiBase()}/guilds/${guildId}/api_permission`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getApiPermissions failed: ${response.status} ${text}`);
    }
    const data = await response.json() as { apis: Array<{ path: string; method: string; desc: string }> };
    return data.apis;
  }

  /**
   * 发送机器人在频道接口权限的授权链接
   * POST /guilds/{guild_id}/api_permission/demand
   */
  async createApiPermissionDemand(
    guildId: string,
    options: QQOfficialApiPermissionDemandOptions,
  ): Promise<QQOfficialApiPermissionDemand> {
    const url = `${this.getApiBase()}/guilds/${guildId}/api_permission/demand`;
    const response = await fetch(url, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] createApiPermissionDemand failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialApiPermissionDemand;
  }

  // ── Phase 4: Gateway API ──

  /**
   * 获取 WSS 接入点
   * GET /gateway
   */
  async getGateway(): Promise<QQOfficialGateway> {
    const url = `${this.getApiBase()}/gateway`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getGateway failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialGateway;
  }

  /**
   * 获取带分片信息的 WSS 接入点
   * GET /gateway/bot
   */
  async getGatewayBot(): Promise<QQOfficialGatewayBot> {
    const url = `${this.getApiBase()}/gateway/bot`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getGatewayBot failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialGatewayBot;
  }

  // ── Phase 4: User API ──

  /**
   * 获取机器人自身信息
   * GET /users/@me
   */
  async getBotSelfInfo(): Promise<QQOfficialUser> {
    const url = `${this.getApiBase()}/users/@me`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getBotSelfInfo failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialUser;
  }

  // ── Phase 4: Channel Message Management API ──

  /**
   * 获取频道消息列表 (私域机器人可用)
   * GET /channels/{channel_id}/messages
   */
  async listChannelMessages(
    channelId: string,
    options?: QQOfficialListMessagesOptions,
  ): Promise<QQOfficialChannelMessage[]> {
    const params = new URLSearchParams();
    if (options?.before) params.set("before", options.before);
    if (options?.after) params.set("after", options.after);
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.type !== undefined) params.set("type", String(options.type));
    const query = params.toString() ? `?${params.toString()}` : "";
    const url = `${this.getApiBase()}/channels/${channelId}/messages${query}`;

    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] listChannelMessages failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialChannelMessage[];
  }

  /**
   * 获取频道消息详情
   * GET /channels/{channel_id}/messages/{message_id}
   */
  async getChannelMessage(channelId: string, messageId: string): Promise<QQOfficialChannelMessage> {
    const url = `${this.getApiBase()}/channels/${channelId}/messages/${messageId}`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getChannelMessage failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialChannelMessage;
  }

  /**
   * 修改频道消息 (仅 markdown + keyboard 可修改)
   * PATCH /channels/{channel_id}/messages/{message_id}
   */
  async patchChannelMessage(
    channelId: string,
    messageId: string,
    options: QQOfficialPatchMessageOptions,
  ): Promise<QQOfficialChannelMessage> {
    const url = `${this.getApiBase()}/channels/${channelId}/messages/${messageId}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] patchChannelMessage failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialChannelMessage;
  }

  // ── Phase 4: Role CRUD API ──

  /**
   * 创建身份组
   * POST /guilds/{guild_id}/roles
   */
  async createGuildRole(guildId: string, options: QQOfficialRoleOptions): Promise<QQOfficialRoleCreateResult> {
    const url = `${this.getApiBase()}/guilds/${guildId}/roles`;
    const response = await fetch(url, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] createGuildRole failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialRoleCreateResult;
  }

  /**
   * 修改身份组
   * PATCH /guilds/{guild_id}/roles/{role_id}
   */
  async updateGuildRole(
    guildId: string,
    roleId: string,
    options: QQOfficialRoleOptions,
  ): Promise<QQOfficialRoleCreateResult> {
    const url = `${this.getApiBase()}/guilds/${guildId}/roles/${roleId}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] updateGuildRole failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialRoleCreateResult;
  }

  /**
   * 删除身份组
   * DELETE /guilds/{guild_id}/roles/{role_id}
   */
  async deleteGuildRole(guildId: string, roleId: string): Promise<void> {
    const url = `${this.getApiBase()}/guilds/${guildId}/roles/${roleId}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] deleteGuildRole failed: ${response.status} ${text}`);
    }
  }

  // ── Phase 4: Pins API ──

  /**
   * 添加精华消息
   * PUT /channels/{channel_id}/pins/{message_id}
   */
  async addPinMessage(channelId: string, messageId: string): Promise<QQOfficialPinsResult> {
    const url = `${this.getApiBase()}/channels/${channelId}/pins/${messageId}`;
    const response = await fetch(url, {
      method: "PUT",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] addPinMessage failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialPinsResult;
  }

  /**
   * 删除精华消息
   * DELETE /channels/{channel_id}/pins/{message_id}
   */
  async deletePinMessage(channelId: string, messageId: string): Promise<void> {
    const url = `${this.getApiBase()}/channels/${channelId}/pins/${messageId}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] deletePinMessage failed: ${response.status} ${text}`);
    }
  }

  /**
   * 获取精华消息列表
   * GET /channels/{channel_id}/pins
   */
  async listPinMessages(channelId: string): Promise<QQOfficialPinsListResult> {
    const url = `${this.getApiBase()}/channels/${channelId}/pins`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] listPinMessages failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialPinsListResult;
  }

  // ── Phase 4: Speak Privilege Settings API ──

  /**
   * 获取子频道发言权限设置
   * GET /guilds/{guild_id}/speak_privilege_settings
   */
  async getSpeakPrivilegeSettings(guildId: string): Promise<QQOfficialSpeakPrivilegeSettings> {
    const url = `${this.getApiBase()}/guilds/${guildId}/speak_privilege_settings`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getSpeakPrivilegeSettings failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialSpeakPrivilegeSettings;
  }

  /**
   * 修改子频道发言权限设置
   * PUT /guilds/{guild_id}/speak_privilege_settings
   */
  async updateSpeakPrivilegeSettings(
    guildId: string,
    settings: QQOfficialSpeakPrivilegeSettings,
  ): Promise<QQOfficialSpeakPrivilegeSettings> {
    const url = `${this.getApiBase()}/guilds/${guildId}/speak_privilege_settings`;
    const response = await fetch(url, {
      method: "PUT",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(settings),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] updateSpeakPrivilegeSettings failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialSpeakPrivilegeSettings;
  }

  /**
   * 获取频道消息频率设置
   * GET /guilds/{guild_id}/message_setting
   */
  async getMessageSetting(guildId: string): Promise<QQOfficialMessageSetting> {
    const url = `${this.getApiBase()}/guilds/${guildId}/message_setting`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getMessageSetting failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialMessageSetting;
  }

  // ── Phase 4: Forum API (仅私域机器人) ──

  /**
   * 获取论坛帖子列表
   * GET /channels/{channel_id}/threads
   */
  async listThreads(channelId: string): Promise<QQOfficialThreadListResult> {
    const url = `${this.getApiBase()}/channels/${channelId}/threads`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] listThreads failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialThreadListResult;
  }

  /**
   * 获取论坛帖子详情
   * GET /channels/{channel_id}/threads/{thread_id}
   */
  async getThread(channelId: string, threadId: string): Promise<QQOfficialThreadDetail> {
    const url = `${this.getApiBase()}/channels/${channelId}/threads/${threadId}`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] getThread failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialThreadDetail;
  }

  /**
   * 发布论坛帖子
   * PUT /channels/{channel_id}/threads
   */
  async publishThread(
    channelId: string,
    title: string,
    content: string,
    format?: number,
  ): Promise<QQOfficialThread> {
    const url = `${this.getApiBase()}/channels/${channelId}/threads`;
    const body: Record<string, unknown> = { title, content };
    if (format !== undefined) body.format = format;
    const response = await fetch(url, {
      method: "PUT",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] publishThread failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialThread;
  }

  /**
   * 删除论坛帖子
   * DELETE /channels/{channel_id}/threads/{thread_id}
   */
  async deleteThread(channelId: string, threadId: string): Promise<void> {
    const url = `${this.getApiBase()}/channels/${channelId}/threads/${threadId}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] deleteThread failed: ${response.status} ${text}`);
    }
  }

  /**
   * 获取论坛评论列表
   * GET /channels/{channel_id}/threads/{thread_id}/comments
   */
  async listThreadComments(channelId: string, threadId: string): Promise<QQOfficialCommentListResult> {
    const url = `${this.getApiBase()}/channels/${channelId}/threads/${threadId}/comments`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] listThreadComments failed: ${response.status} ${text}`);
    }
    return await response.json() as QQOfficialCommentListResult;
  }

  // ── Phase 4: Audio API (仅音频机器人) ──

  /**
   * 音频控制 (播放/暂停/继续/停止)
   * POST /channels/{channel_id}/audio
   */
  async controlAudio(channelId: string, control: QQOfficialAudioControl): Promise<void> {
    const url = `${this.getApiBase()}/channels/${channelId}/audio`;
    const response = await fetch(url, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(control),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] controlAudio failed: ${response.status} ${text}`);
    }
  }

  /** 便捷: 播放音频 */
  async playAudio(channelId: string, audioUrl: string, text?: string): Promise<void> {
    await this.controlAudio(channelId, { audio_url: audioUrl, text, status: 0 });
  }

  /** 便捷: 暂停音频 */
  async pauseAudio(channelId: string): Promise<void> {
    await this.controlAudio(channelId, { audio_url: "", status: 1 });
  }

  /** 便捷: 继续播放 */
  async resumeAudio(channelId: string): Promise<void> {
    await this.controlAudio(channelId, { audio_url: "", status: 2 });
  }

  /** 便捷: 停止音频 */
  async stopAudio(channelId: string): Promise<void> {
    await this.controlAudio(channelId, { audio_url: "", status: 3 });
  }

  /**
   * 机器人上麦
   * PUT /channels/{channel_id}/mic
   */
  async onMic(channelId: string): Promise<void> {
    const url = `${this.getApiBase()}/channels/${channelId}/mic`;
    const response = await fetch(url, {
      method: "PUT",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] onMic failed: ${response.status} ${text}`);
    }
  }

  /**
   * 机器人下麦
   * DELETE /channels/{channel_id}/mic
   */
  async offMic(channelId: string): Promise<void> {
    const url = `${this.getApiBase()}/channels/${channelId}/mic`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[QQOfficial] offMic failed: ${response.status} ${text}`);
    }
  }

  // ── QR Login Helpers ──

  private isLoginSessionValid(session: QQOfficialLoginSession | null): boolean {
    if (!session) return false;
    return (Date.now() - session.startedAt) < 5 * 60 * 1000; // 5 minutes
  }

  private async startLoginSession(): Promise<QQOfficialLoginSession> {
    const host = (this.config.qqofficialBindHost || "q.qq.com")
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");

    const bindKey = randomBytes(32).toString("base64");
    const timeoutMs = this.config.qqofficialApiTimeoutMs ?? 10000;

    const response = await fetch(`https://${host}/lite/create_bind_task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ key: bindKey }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`[QQOfficial] create_bind_task failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as any;
    if (data.retcode !== undefined && Number(data.retcode) !== 0) {
      throw new Error(data.msg || data.message || "QQ 机器人绑定接口返回失败");
    }

    const taskId = data.data?.task_id;
    if (!taskId) {
      throw new Error("QQ 机器人绑定任务响应缺少 task_id");
    }

    const connectUrl = `https://${host}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&_wv=2`;

    return {
      bindKey,
      taskId,
      qrcode: connectUrl,
      status: "wait",
      startedAt: Date.now(),
    };
  }

  private async pollQrStatus(session: QQOfficialLoginSession): Promise<void> {
    const host = (this.config.qqofficialBindHost || "q.qq.com")
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");

    const timeoutMs = this.config.qqofficialApiTimeoutMs ?? 10000;

    const response = await fetch(`https://${host}/lite/poll_bind_result`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ task_id: session.taskId }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`[QQOfficial] poll_bind_result failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as any;
    if (data.retcode !== undefined && Number(data.retcode) !== 0) {
      throw new Error(data.msg || data.message || "QQ 机器人绑定结果查询失败");
    }

    const payload = data.data || {};
    const rawStatus = payload.status !== undefined ? Number(payload.status) : 0;

    if (rawStatus === 2) { // QQOFFICIAL_BIND_STATUS_COMPLETED
      const appid = String(payload.bot_appid || "").trim();
      const encryptedSecret = String(payload.bot_encrypt_secret || "").trim();

      if (!appid || !encryptedSecret) {
        throw new Error("扫码成功但未返回完整 QQ 机器人凭证");
      }

      const secret = decryptQQOfficialSecret(encryptedSecret, session.bindKey);

      this.config.appId = appid;
      this.config.appSecret = secret;

      session.status = "confirmed";
      this.loginSession = null;

      // Persist configuration update
      if (this.onConfigUpdate) {
        this.onConfigUpdate({
          ...this.config,
          appId: this.config.appId,
          appSecret: this.config.appSecret,
        });
      }
      return;
    }

    if (rawStatus === 3) { // QQOFFICIAL_BIND_STATUS_EXPIRED
      this.qrExpiredCount++;
      if (this.qrExpiredCount > 3) {
        session.status = "expired";
        session.error = "QR code expired, max retries exceeded";
        this.loginSession = null;
        return;
      }
      console.warn(`[QQOfficial] QR expired, refreshing (${this.qrExpiredCount}/3)`);
      this.loginSession = await this.startLoginSession();
      return;
    }

    session.status = "wait";
  }

  getLoginStatus(): {
    loggedIn: boolean;
    accountId: string | null;
    qrStatus: string | null;
    qrImgContent: string | null;
    qrError: string | null;
  } {
    return {
      loggedIn: !!(this.config.appId && this.config.appSecret),
      accountId: this.config.appId || null,
      qrStatus: this.loginSession?.status ?? null,
      qrImgContent: this.loginSession?.qrcode ?? null,
      qrError: this.loginSession?.error ?? null,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** 从消息组件中提取纯文本 */
function extractText(components: MessageComponent[]): string {
  return components
    .filter((c): c is PlainComponent => c.type === ComponentType.Plain)
    .map(c => c.text ?? "")
    .join("");
}

/** 解析 QQOfficial 的 UMO，提取 eventType 和 targetId */
function parseQQOfficialUMO(umo: string): { eventType: QQOfficialEventType; targetId: string } | null {
  // 格式: qqofficial:<eventType>:<targetId>
  const match = umo.match(/^qqofficial:(group|private|guild|direct):(.+)$/);
  if (!match) return null;
  const [, typeStr, targetId] = match;
  // UMO 中的 "private" 对应 eventType "c2c"
  const eventType = (typeStr === "private" ? "c2c" : typeStr) as QQOfficialEventType;
  return { eventType, targetId };
}
