export interface AdapterConfigBase {
  /** 适配器类型标识，用于匹配工厂 */
  type: string;
  /** 适配器实例 ID，必须全局唯一 */
  id: string;
  /** 是否启用此适配器，默认 true */
  enabled?: boolean;
  /** 适配器专属配置 */
  [key: string]: unknown;
}

export interface OneBot11AdapterConfig extends AdapterConfigBase {
  type: "onebot11";
  /** WS 连接方向: forward=反向WS(本地监听), reverse=正向WS(主动连接) */
  direction: "forward" | "reverse";
  /** 反向WS: 监听端口 */
  port?: number;
  /** 反向WS: 监听主机 */
  host?: string;
  /** 反向WS: WS 路径 */
  path?: string;
  /** 正向WS: 目标 WS URL (例如 ws://127.0.0.1:6700) */
  reverseUrl?: string;
  /** 正向WS: 重连间隔 (毫秒) */
  reconnectInterval?: number;
  /** 鉴权 Token (可选) */
  accessToken?: string;
  /** 自动通过好友请求 (默认 false) */
  autoApproveFriend?: boolean;
  /** 自动通过加群请求/邀请 (默认 false) */
  autoApproveGroup?: boolean;
  /** 自动拒绝时的理由 (可选) */
  autoRejectReason?: string;
  /** 将戳一戳(poke)事件转为消息送入 pipeline (默认 true) */
  pokeToMessage?: boolean;
  /** 将群文件上传通知转为文件消息送入 pipeline (默认 true) */
  groupUploadToMessage?: boolean;
  /** 将成员入群通知转为消息送入 pipeline (默认 false) */
  memberJoinToMessage?: boolean;
}

export interface QQOfficialAdapterConfig extends AdapterConfigBase {
  type: "qqofficial";
  /** QQ 机器人 AppID */
  appId?: string;
  /** QQ 机器人 AppSecret */
  appSecret?: string;
  /** 订阅事件意图位掩码 (可选, 不填则自动根据配置计算) */
  intents?: number;
  /** 扫码登录配置：绑定域名/HOST (例如 q.qq.com) */
  qqofficialBindHost?: string;
  /** 二维码轮询间隔 (毫秒) */
  qqofficialQrPollInterval?: number;
  /** API 请求超时 (毫秒) */
  qqofficialApiTimeoutMs?: number;
}

export interface WeixinOCAdapterConfig extends AdapterConfigBase {
  type: "weixin_oc";
  /** iLink API 基础 URL (默认 https://ilinkai.weixin.qq.com) */
  baseUrl?: string;
  /** CDN 基础 URL (默认 https://novac2c.cdn.weixin.qq.com/c2c) */
  cdnBaseUrl?: string;
  /** 已有的 bot_token (可选, 不填则走扫码登录) */
  token?: string;
  /** 已有的 account_id (可选) */
  accountId?: string;
  /** 已有的 sync_buf (可选) */
  syncBuf?: string;
  /** 二维码轮询间隔 (毫秒, 默认 1000) */
  qrPollInterval?: number;
  /** 长轮询超时 (毫秒, 默认 35000) */
  longPollTimeout?: number;
  /** API 请求超时 (毫秒, 默认 120000) */
  apiTimeout?: number;
  /** bot_type 参数 (默认 "3") */
  botType?: string;
}

export function validateAdapterConfig(config: unknown): AdapterConfigBase {
  if (!config || typeof config !== "object") {
    throw new Error("Adapter config must be an object");
  }
  const cfg = config as Record<string, unknown>;
  if (!cfg.type || typeof cfg.type !== "string") {
    throw new Error("Adapter config must have a 'type' field");
  }
  if (!cfg.id || typeof cfg.id !== "string") {
    throw new Error("Adapter config must have an 'id' field");
  }
  return cfg as AdapterConfigBase;
}
