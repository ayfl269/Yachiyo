export { PlatformAdapter, type AdapterStatus } from "./adapter.js";
export type { PlatformMetadata } from "./metadata.js";
export { MessageConverter } from "./conversion.js";
export { AdapterRegistry, registerBuiltinAdapterFactories, type AdapterFactory } from "./registry.js";
export {
  validateAdapterConfig,
  type AdapterConfigBase,
  type OneBot11AdapterConfig,
} from "./config.js";
export {
  OneBot11Adapter,
  type Ob11FileResult,
  type Ob11GetMsgResult,
  type Ob11GetForwardMsgResult,
  type Ob11SendMsgResult,
  type Ob11LoginInfo,
  type Ob11FriendRequestEvent,
  type Ob11GroupRequestEvent,
  type Ob11NoticeEvent,
  type Ob11GroupInfo,
  type Ob11GroupMemberInfo,
} from "./implementations/onebot11-adapter.js";
