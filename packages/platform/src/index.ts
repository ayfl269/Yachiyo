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
  // Phase 7 extended types
  type Ob11ForwardMsgNode,
  type Ob11ForwardMsgResult,
  type Ob11GroupMsgHistoryItem,
  type Ob11GroupMsgHistoryResult,
  type Ob11OcrTextDetection,
  type Ob11OcrResult,
  type Ob11GroupFileUrlResult,
  type Ob11DownloadFileResult,
  type Ob11CheckUrlSafelyResult,
  type Ob11GroupAtAllRemainResult,
  type Ob11GroupHonorInfo,
  type Ob11GroupFile,
  type Ob11GroupFileListResult,
  type Ob11GroupFileSystemInfo,
  type Ob11EssenceMsg,
  type Ob11EssenceMsgListResult,
  type Ob11GroupNotice,
  type Ob11GroupNoticeListResult,
} from "./implementations/onebot11-adapter.js";
