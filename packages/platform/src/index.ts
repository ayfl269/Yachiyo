export { PlatformAdapter, type AdapterStatus } from "./adapter.js";
export type { PlatformMetadata } from "./metadata.js";
export { MessageConverter } from "./conversion.js";
export { AdapterRegistry, registerBuiltinAdapterFactories, type AdapterFactory } from "./registry.js";
export {
  validateAdapterConfig,
  type AdapterConfigBase,
  type OneBot11AdapterConfig,
} from "./config.js";
