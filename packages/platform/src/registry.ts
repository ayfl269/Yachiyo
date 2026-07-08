import type { AsyncQueue } from "@yachiyo/common/async-queue.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import { PlatformAdapter } from "./adapter.js";
import type { OneBot11AdapterConfig, QQOfficialAdapterConfig, WeixinOCAdapterConfig } from "./config.js";
import type { SqliteAdapterStore } from "./sqlite-adapter-store.js";
import { OneBot11Adapter } from "./implementations/onebot11-adapter.js";
import { QQOfficialAdapter } from "./implementations/qqofficial-adapter.js";
import { WeixinOCAdapter } from "./implementations/weixin-oc-adapter.js";

export type AdapterFactory = (
  config: Record<string, unknown>,
  eventQueue: AsyncQueue<MessageEvent>,
) => PlatformAdapter;

export class AdapterRegistry {
  private factories: Map<string, AdapterFactory> = new Map();
  private adapters: Map<string, PlatformAdapter> = new Map();
  private adapterStore?: SqliteAdapterStore;

  /** Set the adapter store for persisting config updates */
  setAdapterStore(store: SqliteAdapterStore): void {
    this.adapterStore = store;
  }

  /** 注册适配器工厂 */
  registerFactory(type: string, factory: AdapterFactory): void {
    this.factories.set(type, factory);
  }

  /** 根据配置创建适配器实例 */
  createAdapter(
    type: string,
    config: Record<string, unknown>,
    eventQueue: AsyncQueue<MessageEvent>,
  ): PlatformAdapter {
    const factory = this.factories.get(type);
    if (!factory) throw new Error(`Unknown adapter type: ${type}`);
    const adapter = factory(config, eventQueue);
    // Register config persistence callback
    const store = this.adapterStore;
    if (store) {
      adapter.onConfigUpdate = (updatedConfig: Record<string, unknown>) => {
        try {
          store.save(updatedConfig as any);
        } catch (e) {
          console.warn(`[AdapterRegistry] Failed to persist config for ${adapter.meta().id}:`, e);
        }
      };
    }
    this.adapters.set(adapter.meta().id, adapter);
    return adapter;
  }

  /** 获取适配器实例 */
  getAdapter(id: string): PlatformAdapter | undefined {
    return this.adapters.get(id);
  }

  /** 获取所有适配器 */
  getAllAdapters(): PlatformAdapter[] {
    return [...this.adapters.values()];
  }

  /** 初始化所有适配器 */
  async initializeAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.initialize();
      } catch (e) {
        console.error(`Failed to initialize adapter ${adapter.meta().id}:`, e);
        adapter.setStatus("error");
      }
    }
  }

  /** 启动所有适配器 */
  async startAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        adapter.setStatus("running");
        await adapter.run();
      } catch (e) {
        console.error(`Failed to start adapter ${adapter.meta().id}:`, e);
        adapter.setStatus("error");
      }
    }
  }

  /** 停止所有适配器 */
  async stopAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        adapter.setStatus("stopping");
        await adapter.stop();
      } catch (e) {
        console.error(`Failed to stop adapter ${adapter.meta().id}:`, e);
        adapter.setStatus("error");
      }
    }
  }

  /** 健康检查所有适配器 */
  async healthCheckAll(): Promise<Record<string, string | null>> {
    const results: Record<string, string | null> = {};
    for (const [id, adapter] of this.adapters) {
      results[id] = await adapter.healthCheck();
    }
    return results;
  }

  /** 移除适配器 */
  async removeAdapter(id: string): Promise<boolean> {
    const adapter = this.adapters.get(id);
    if (!adapter) return false;
    if (adapter.isRunning) {
      try {
        await adapter.stop();
      } catch (e) {
        console.warn(`Failed to stop adapter ${id}:`, e);
      }
    }
    this.adapters.delete(id);
    return true;
  }

  /** 热添加适配器（运行时动态添加） */
  async addAndStart(
    type: string,
    config: Record<string, unknown>,
    eventQueue: AsyncQueue<MessageEvent>,
  ): Promise<PlatformAdapter> {
    const adapter = this.createAdapter(type, config, eventQueue);
    await adapter.initialize();
    adapter.setStatus("running");
    adapter.run().catch(e => {
      console.error(`Adapter ${adapter.meta().id} crashed:`, e);
      adapter.setStatus("error");
    });
    return adapter;
  }
}

/** 注册内置适配器工厂 */
export function registerBuiltinAdapterFactories(registry: AdapterRegistry): void {
  registry.registerFactory("onebot11", (config, eq) => {
    return new OneBot11Adapter(config as OneBot11AdapterConfig, eq);
  });
  registry.registerFactory("qqofficial", (config, eq) => {
    return new QQOfficialAdapter(config as QQOfficialAdapterConfig, eq);
  });
  registry.registerFactory("weixin_oc", (config, eq) => {
    return new WeixinOCAdapter(config as WeixinOCAdapterConfig, eq);
  });
}
