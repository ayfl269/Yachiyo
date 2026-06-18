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
