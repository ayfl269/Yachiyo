import { StarHandlerRegistry } from "./registry.js";
import type { StarHandlerMetadata } from "./handler.js";
import type { SqlitePluginStore } from "@yachiyo/config/sqlite-config-extras-store.js";
import type { StarMetadata } from "@yachiyo/common/plugin-types.js";

export type { StarMetadata };


export class PluginManager {
  private starRegistry: StarMetadata[] = [];
  private starMap: Map<string, StarMetadata> = new Map();
  private handlerRegistry: StarHandlerRegistry = new StarHandlerRegistry();
  private sqliteStore?: SqlitePluginStore;

  setSqliteStore(store: SqlitePluginStore): void {
    this.sqliteStore = store;
  }

  async restoreFromStore(): Promise<void> {
    if (!this.sqliteStore) return;
    const saved = this.sqliteStore.getAllStars();
    for (const star of saved) {
      // 数据形状校验：store 数据可能来自旧版本或外部篡改，缺关键字段的
      // 记录跳过而非污染注册表。
      if (
        !star ||
        typeof star !== "object" ||
        typeof star.modulePath !== "string" ||
        star.modulePath.length === 0 ||
        typeof star.name !== "string" ||
        !Array.isArray(star.handlerFullNames)
      ) {
        console.warn("[PluginManager] Skipping malformed star record from store:", star);
        continue;
      }
      // 去重：store 层不保证唯一（saveStar 可能被重复调用），按 modulePath
      // 覆盖旧记录，保持 registerStar 的语义一致。
      if (this.starMap.has(star.modulePath)) {
        const idx = this.starRegistry.findIndex(s => s.modulePath === star.modulePath);
        if (idx >= 0) this.starRegistry.splice(idx, 1);
        console.warn(`[PluginManager] Duplicate star record in store, replacing: ${star.modulePath}`);
      }
      this.starRegistry.push(star);
      this.starMap.set(star.modulePath, star);
    }
  }

  getHandlerRegistry(): StarHandlerRegistry {
    return this.handlerRegistry;
  }

  getStarByModulePath(modulePath: string): StarMetadata | null {
    return this.starMap.get(modulePath) ?? null;
  }

  getAllStars(): StarMetadata[] {
    return [...this.starRegistry];
  }

  registerStar(metadata: StarMetadata): void {
    // Dedupe by modulePath, mirroring restoreFromStore(). Blindly pushing
    // produced duplicate entries in getAllStars() (and repeated activation
    // toggles) when a plugin was registered more than once, e.g. on hot reload.
    if (this.starMap.has(metadata.modulePath)) {
      const idx = this.starRegistry.findIndex(s => s.modulePath === metadata.modulePath);
      if (idx >= 0) this.starRegistry.splice(idx, 1);
    }
    this.starRegistry.push(metadata);
    this.starMap.set(metadata.modulePath, metadata);
    this.sqliteStore?.saveStar(metadata);
  }

  registerHandler(handler: StarHandlerMetadata): void {
    this.handlerRegistry.append(handler);
  }

  activateStar(modulePath: string): void {
    const star = this.starMap.get(modulePath);
    if (star) {
      star.activated = true;
      this.sqliteStore?.setStarActivated(modulePath, true);
    }
  }

  deactivateStar(modulePath: string): void {
    const star = this.starMap.get(modulePath);
    if (star) {
      star.activated = false;
      this.sqliteStore?.setStarActivated(modulePath, false);
    }
  }

  reloadStar(modulePath: string): void {
    this.deactivateStar(modulePath);
    this.activateStar(modulePath);
  }
}
