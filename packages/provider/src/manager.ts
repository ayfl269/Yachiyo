import type { Provider } from "./provider.js";
import type { ProviderType } from "./types.js";
import type { SqliteProviderStore } from "./sqlite-provider-store.js";

export type AnyProvider = Provider | STTProvider | TTSProvider | EmbeddingProvider | RerankProvider;

export abstract class STTProvider {
  providerConfig: Record<string, unknown> = {};
  abstract getText(audioUrl: string): Promise<string>;
}

export abstract class TTSProvider {
  providerConfig: Record<string, unknown> = {};
  supportStream(): boolean { return false; }
  abstract getAudio(text: string): Promise<string>;
}

export abstract class EmbeddingProvider {
  providerConfig: Record<string, unknown> = {};
  abstract getEmbedding(text: string): Promise<number[]>;
  abstract getEmbeddings(texts: string[]): Promise<number[][]>;
  abstract getDim(): number;
}

export interface RerankResult {
  index: number;
  relevanceScore: number;
  document: { text: string };
}

export abstract class RerankProvider {
  providerConfig: Record<string, unknown> = {};
  abstract rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]>;
}

// ── Provider Change Callback Types ──

export type ProviderChangeCallback = (
  providerId: string,
  providerType: ProviderType,
  changeType: "load" | "reload" | "terminate" | "update" | "delete"
) => void;

// ── Provider Configuration ──

/**
 * Configuration shape used by loadProvider / createProvider.
 * Must include `type` to determine which factory to use, and `id` for lookup.
 */
export interface ProviderLoadConfig {
  /** Provider type key (e.g. "openai", "gemini", "anthropic"). */
  type: string;
  /** Unique identifier for this provider instance. */
  id: string;
  /** Provider-specific configuration. */
  [key: string]: unknown;
}

// ── MCP Server Configuration ──

export interface MCPServerConfigMap {
  [serverName: string]: Record<string, unknown>;
}

// ── ProviderManager ──

export class ProviderManager {
  providerInsts: Provider[] = [];
  sttInsts: STTProvider[] = [];
  ttsInsts: TTSProvider[] = [];
  embeddingInsts: EmbeddingProvider[] = [];
  rerankInsts: RerankProvider[] = [];

  /** ID-based instance lookup map. Replaces unsafe cast-based lookups. */
  instMap: Map<string, AnyProvider> = new Map();

  /** Provider configurations, keyed by provider ID. */
  providerConfigs: Map<string, Record<string, unknown>> = new Map();

  private defaultProviderId: string | null = null;
  private fallbackProviderIds: string[] = [];

  /** 被禁用的提供商 ID 集合 */
  private disabledIds: Set<string> = new Set();

  /** MCP server config passed at initialization. */
  private mcpServerConfig: MCPServerConfigMap | null = null;

  /** Whether initialize() has been called. */
  private initialized = false;

  /** Change callbacks. */
  private changeCallbacks: ProviderChangeCallback[] = [];

  /** Optional SQLite store for persisting provider configs across restarts. */
  private sqliteStore?: SqliteProviderStore;

  // ── Registration ──

  setSqliteStore(store: SqliteProviderStore): void {
    this.sqliteStore = store;
  }

  registerProvider(provider: Provider): void {
    this.providerInsts.push(provider);
    const id = this.extractId(provider.providerConfig);
    if (id) {
      this.instMap.set(id, provider);
    }
  }

  registerEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingInsts.push(provider);
    const id = this.extractId(provider.providerConfig);
    if (id) {
      this.instMap.set(id, provider);
    }
  }

  registerRerankProvider(provider: RerankProvider): void {
    this.rerankInsts.push(provider);
    const id = this.extractId(provider.providerConfig);
    if (id) {
      this.instMap.set(id, provider);
    }
  }

  registerSttProvider(provider: STTProvider): void {
    this.sttInsts.push(provider);
    const id = this.extractId(provider.providerConfig);
    if (id) {
      this.instMap.set(id, provider);
    }
  }

  registerTtsProvider(provider: TTSProvider): void {
    this.ttsInsts.push(provider);
    const id = this.extractId(provider.providerConfig);
    if (id) {
      this.instMap.set(id, provider);
    }
  }

  // ── ID-based Lookup ──

  /**
   * Get any provider by ID from the unified instance map.
   */
  getProviderById(id: string): AnyProvider | null {
    return this.instMap.get(id) ?? null;
  }

  getEmbeddingProviderById(id: string): EmbeddingProvider | null {
    const p = this.instMap.get(id);
    if (p && p instanceof EmbeddingProvider) return p;
    // Fallback: search the array
    return this.embeddingInsts.find((ep) => this.extractId(ep.providerConfig) === id) ?? null;
  }

  getRerankProviderById(id: string): RerankProvider | null {
    const p = this.instMap.get(id);
    if (p && p instanceof RerankProvider) return p;
    return this.rerankInsts.find((rp) => this.extractId(rp.providerConfig) === id) ?? null;
  }

  // ── Provider Selection ──

  /**
   * Get the currently active provider.
   * Priority: defaultProviderId > first registered non-disabled provider.
   * @param providerType 请求的 provider 类型（当前仅支持 chat_completion）
   */
  getUsingProvider(_providerType: ProviderType, _umo?: string): Provider | null {
    // 当前所有 chat provider 都通过 textChat 接口访问，providerType 参数保留用于未来扩展
    // 如需按子类型（如 streaming 能力）区分，可在此处添加过滤逻辑
    if (this.defaultProviderId && !this.disabledIds.has(this.defaultProviderId)) {
      const found = this.instMap.get(this.defaultProviderId);
      if (found && "textChat" in found) return found as Provider;
    }
    // Fallback to first non-disabled provider
    for (const p of this.providerInsts) {
      const id = p.providerConfig?.id as string | undefined;
      if (id && !this.disabledIds.has(id)) return p;
    }
    return null;
  }

  getUsingTtsProvider(_umo?: string): TTSProvider | null {
    return this.ttsInsts[0] ?? null;
  }

  getUsingSttProvider(_umo?: string): STTProvider | null {
    return this.sttInsts[0] ?? null;
  }

  getUsingEmbeddingProvider(_umo?: string): EmbeddingProvider | null {
    return this.embeddingInsts[0] ?? null;
  }

  getUsingRerankProvider(_umo?: string): RerankProvider | null {
    return this.rerankInsts[0] ?? null;
  }

  // ── Enable / Disable ──

  /** 检查提供商是否被禁用 */
  isDisabled(id: string): boolean {
    return this.disabledIds.has(id);
  }

  /** 禁用提供商 */
  setDisabled(id: string): void {
    this.disabledIds.add(id);
  }

  /** 启用提供商 */
  setEnabled(id: string): void {
    this.disabledIds.delete(id);
  }

  /** 获取所有被禁用的 ID */
  getDisabledIds(): string[] {
    return [...this.disabledIds];
  }

  // ── Default / Fallback ──

  /** 设置默认 provider，验证 ID 指向有效的 chat provider */
  setDefaultProvider(providerId: string | null): void {
    if (!providerId) {
      this.defaultProviderId = null;
      this.sqliteStore?.setDefaultProvider("");
      return;
    }
    const inst = this.instMap.get(providerId);
    if (!inst) {
      console.warn(`[ProviderManager] setDefaultProvider: ID "${providerId}" 不存在，忽略`);
      return;
    }
    if (!("textChat" in inst)) {
      console.warn(`[ProviderManager] setDefaultProvider: ID "${providerId}" 不是 chat provider，忽略`);
      return;
    }
    this.defaultProviderId = providerId;
    this.sqliteStore?.setDefaultProvider(providerId);
  }

  setFallbackProviders(providerIds: string[]): void {
    this.fallbackProviderIds = providerIds;
    this.sqliteStore?.setFallbackProviders(providerIds);
  }

  getFallbackProviders(): Provider[] {
    return this.fallbackProviderIds
      .map((id) => this.instMap.get(id))
      .filter((p): p is Provider => p !== undefined && "textChat" in p);
  }

  getDefaultProviderId(): string | null {
    return this.defaultProviderId;
  }

  getFallbackProviderIds(): string[] {
    return this.fallbackProviderIds;
  }

  // ── Change Callbacks ──

  /**
   * Register a callback that fires when a provider is loaded, reloaded, or terminated.
   */
  setProviderChangeCallback(cb: ProviderChangeCallback): void {
    this.changeCallbacks.push(cb);
  }

  /** Alias for setProviderChangeCallback. */
  registerProviderChangeHook(hook: ProviderChangeCallback): void {
    this.changeCallbacks.push(hook);
  }

  private notifyChange(
    providerId: string,
    providerType: ProviderType,
    changeType: "load" | "reload" | "terminate" | "update" | "delete"
  ): void {
    for (const cb of this.changeCallbacks) {
      try {
        cb(providerId, providerType, changeType);
      } catch (e) {
        console.error(`[ProviderManager] Change callback error: ${e}`);
      }
    }
  }

  // ── Configuration ──

  /**
   * Get a merged provider config (base config + overrides).
   */
  getMergedProviderConfig(providerConfig: Record<string, unknown>): Record<string, unknown> {
    const id = String(providerConfig.id ?? "");
    const stored = this.providerConfigs.get(id);
    if (stored) {
      return { ...stored, ...providerConfig };
    }
    return { ...providerConfig };
  }

  /**
   * Get a provider's configuration by ID.
   */
  getProviderConfigById(providerId: string, merged?: boolean): Record<string, unknown> | null {
    const config = this.providerConfigs.get(providerId);
    if (!config) return null;
    if (merged) {
      return this.getMergedProviderConfig(config);
    }
    return { ...config };
  }

  // ── Lifecycle: Initialize / Terminate ──

  /**
   * Initialize all registered providers and optionally start MCP server connections.
   *
   * @param mcpServerConfig - Optional MCP server configuration map.
   *   When provided, MCP clients are created and connected for each server.
   *   MCP tool registration is delegated to FunctionToolManager at the Agent layer.
   */
  async initialize(mcpServerConfig?: MCPServerConfigMap): Promise<void> {
    if (this.initialized) {
      console.warn("[ProviderManager] Already initialized.");
      return;
    }

    this.mcpServerConfig = mcpServerConfig ?? null;

    if (this.sqliteStore) {
      const savedConfigs = this.sqliteStore.getAllProviderConfigs();
      for (const saved of savedConfigs) {
        this.providerConfigs.set(saved.id, saved.config);
        try {
          await this.createAndRegisterProvider(saved.type, saved.id, saved.config);
        } catch (e) {
          console.error(`[ProviderManager] Failed to restore provider ${saved.id}: ${e}`);
        }
      }

      this.defaultProviderId = this.sqliteStore.getDefaultProviderId();
      this.fallbackProviderIds = this.sqliteStore.getFallbackProviderIds();

      const savedMcpConfigs = this.sqliteStore.getMcpServerConfigMap();
      if (!this.mcpServerConfig && Object.keys(savedMcpConfigs).length > 0) {
        this.mcpServerConfig = savedMcpConfigs;
      }
    }

    if (this.mcpServerConfig && Object.keys(this.mcpServerConfig).length > 0) {
      console.info(
        `[ProviderManager] MCP server config registered for ${Object.keys(this.mcpServerConfig).length} server(s). ` +
        `MCP client lifecycle will be managed by FunctionToolManager.`
      );
    }

    this.initialized = true;
    console.info(
      `[ProviderManager] Initialized with ${this.providerInsts.length} chat, ` +
      `${this.embeddingInsts.length} embedding, ${this.rerankInsts.length} rerank, ` +
      `${this.ttsInsts.length} TTS, ${this.sttInsts.length} STT providers.`
    );
  }

  /**
   * Get the stored MCP server configuration (for passing to FunctionToolManager).
   */
  getMcpServerConfig(): MCPServerConfigMap | null {
    return this.mcpServerConfig;
  }

  /**
   * Terminate all providers and clean up resources.
   */
  async terminate(): Promise<void> {
    // Clear all provider instances
    this.providerInsts = [];
    this.ttsInsts = [];
    this.sttInsts = [];
    this.embeddingInsts = [];
    this.rerankInsts = [];
    this.instMap.clear();
    this.providerConfigs.clear();
    this.mcpServerConfig = null;
    this.initialized = false;

    console.info("[ProviderManager] Terminated. All providers and MCP config cleared.");
  }

  // ── Dynamic Provider Lifecycle ──

  /**
   * Dynamically import a provider class by type string.
   * Returns the constructor, or null if the type is unknown.
   */
  async dynamicImportProvider(type: string): Promise<(new (config: any) => any) | null> {
    const { dynamicImportProviderModule } = await import("./factory.js");
    return dynamicImportProviderModule(type);
  }

  /**
   * Load a provider from a configuration object.
   * Creates the provider instance via dynamic import and registers it.
   */
  async loadProvider(providerConfig: ProviderLoadConfig): Promise<void> {
    const { type, id } = providerConfig;
    if (!type || !id) {
      throw new Error("[ProviderManager] loadProvider requires 'type' and 'id' in config.");
    }

    // Check if already loaded
    if (this.instMap.has(id)) {
      console.warn(`[ProviderManager] Provider ${id} is already loaded. Use reloadProvider() to replace.`);
      return;
    }

    // Store configuration
    this.providerConfigs.set(id, { ...providerConfig });

    if (this.sqliteStore) {
      this.sqliteStore.saveProviderConfig({
        id,
        type,
        config: { ...providerConfig },
        isDefault: this.defaultProviderId === id,
        isFallback: this.fallbackProviderIds.includes(id),
        sortOrder: this.providerConfigs.size - 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    // Determine provider category and create instance
    await this.createAndRegisterProvider(type, id, providerConfig);

    console.info(`[ProviderManager] Loaded provider ${id} (type: ${type}).`);
  }

  /**
   * Reload (hot-swap) a provider by terminating the old one and loading the new config.
   */
  async reloadProvider(providerConfig: ProviderLoadConfig): Promise<void> {
    const { type, id } = providerConfig;
    if (!type || !id) {
      throw new Error("[ProviderManager] reloadProvider requires 'type' and 'id' in config.");
    }

    // Terminate existing if present
    if (this.instMap.has(id)) {
      this.removeProviderInstance(id);
    }

    // Store new configuration
    this.providerConfigs.set(id, { ...providerConfig });

    // Create and register new instance
    await this.createAndRegisterProvider(type, id, providerConfig);

    this.notifyChange(id, this.guessProviderType(type), "reload");
    console.info(`[ProviderManager] Reloaded provider ${id} (type: ${type}).`);
  }

  /**
   * Terminate a specific provider by ID.
   */
  async terminateProvider(providerId: string): Promise<void> {
    if (!this.instMap.has(providerId)) {
      console.warn(`[ProviderManager] Provider ${providerId} not found for termination.`);
      return;
    }

    const config = this.providerConfigs.get(providerId);
    const type = config?.type as string ?? "unknown";

    this.removeProviderInstance(providerId);

    this.notifyChange(providerId, this.guessProviderType(type), "terminate");
    console.info(`[ProviderManager] Terminated provider ${providerId}.`);
  }

  /**
   * Delete a provider: terminate it and remove its configuration.
   */
  async deleteProvider(providerId: string, _providerSourceId?: string): Promise<void> {
    await this.terminateProvider(providerId);
    this.providerConfigs.delete(providerId);
    this.sqliteStore?.deleteProviderConfig(providerId);

    console.info(`[ProviderManager] Deleted provider ${providerId} and its configuration.`);
  }

  /**
   * Update an existing provider's config and recreate it.
   */
  async updateProvider(originProviderId: string, newConfig: ProviderLoadConfig): Promise<void> {
    const newId = newConfig.id ?? originProviderId;

    // Remove old provider
    if (this.instMap.has(originProviderId)) {
      this.removeProviderInstance(originProviderId);
      this.providerConfigs.delete(originProviderId);
    }

    // Load with new config
    const config = { ...newConfig, id: newId };
    await this.loadProvider(config);

    this.notifyChange(newId, this.guessProviderType(config.type), "update");
  }

  /**
   * Create a new provider at runtime (alias for loadProvider with "create" semantics).
   */
  async createProvider(providerConfig: ProviderLoadConfig): Promise<void> {
    await this.loadProvider(providerConfig);
  }

  // ── Internal Helpers ──

  /**
   * Extract provider ID from config object.
   */
  private extractId(config: Record<string, unknown> | undefined): string | null {
    if (!config) return null;
    const id = config.id;
    if (id === undefined || id === null) return null;
    return String(id);
  }

  /**
   * Remove a provider instance from all arrays and the instMap.
   */
  private removeProviderInstance(id: string): void {
    this.instMap.delete(id);

    this.providerInsts = this.providerInsts.filter(
      (p) => this.extractId(p.providerConfig) !== id
    );
    this.embeddingInsts = this.embeddingInsts.filter(
      (p) => this.extractId(p.providerConfig) !== id
    );
    this.rerankInsts = this.rerankInsts.filter(
      (p) => this.extractId(p.providerConfig) !== id
    );
    this.ttsInsts = this.ttsInsts.filter(
      (p) => this.extractId(p.providerConfig) !== id
    );
    this.sttInsts = this.sttInsts.filter(
      (p) => this.extractId(p.providerConfig) !== id
    );
  }

  /**
   * Create a provider instance using dynamic factory functions and register it.
   */
  private async createAndRegisterProvider(
    type: string,
    id: string,
    config: Record<string, unknown>
  ): Promise<void> {
    // Lazy import to avoid circular dependency
    const {
      dynamicCreateChatProvider,
      dynamicCreateEmbeddingProvider,
      dynamicCreateRerankProvider,
      dynamicCreateTtsProvider,
      dynamicCreateSttProvider,
      dynamicImportProviderModule,
    } = await import("./factory.js");

    // Determine category based on type string
    const chatTypes = new Set(["openai", "openai_responses", "gemini", "anthropic"]);
    const embeddingTypes = new Set(["openai_embedding", "gemini_embedding"]);
    const rerankTypes = new Set(["cohere", "jina", "voyage", "generic"]);
    const ttsTypes = new Set(["openai_tts"]);
    const sttTypes = new Set(["openai_stt"]);

    if (chatTypes.has(type)) {
      const provider = await dynamicCreateChatProvider(type, config as any);
      if (provider) {
        this.providerInsts.push(provider);
        this.instMap.set(id, provider);
        this.notifyChange(id, "chat_completion" as ProviderType, "load");
      } else {
        throw new Error(`[ProviderManager] Failed to create chat provider of type: ${type}`);
      }
    } else if (embeddingTypes.has(type)) {
      const provider = await dynamicCreateEmbeddingProvider(type, config as any);
      if (provider) {
        this.embeddingInsts.push(provider);
        this.instMap.set(id, provider);
        this.notifyChange(id, "embedding" as ProviderType, "load");
      } else {
        throw new Error(`[ProviderManager] Failed to create embedding provider of type: ${type}`);
      }
    } else if (rerankTypes.has(type)) {
      const provider = await dynamicCreateRerankProvider(type, config as any);
      if (provider) {
        this.rerankInsts.push(provider);
        this.instMap.set(id, provider);
        this.notifyChange(id, "rerank" as ProviderType, "load");
      } else {
        throw new Error(`[ProviderManager] Failed to create rerank provider of type: ${type}`);
      }
    } else if (ttsTypes.has(type)) {
      const provider = await dynamicCreateTtsProvider(type, config as any);
      if (provider) {
        this.ttsInsts.push(provider);
        this.instMap.set(id, provider);
        this.notifyChange(id, "text_to_speech" as ProviderType, "load");
      } else {
        throw new Error(`[ProviderManager] Failed to create TTS provider of type: ${type}`);
      }
    } else if (sttTypes.has(type)) {
      const provider = await dynamicCreateSttProvider(type, config as any);
      if (provider) {
        this.sttInsts.push(provider);
        this.instMap.set(id, provider);
        this.notifyChange(id, "speech_to_text" as ProviderType, "load");
      } else {
        throw new Error(`[ProviderManager] Failed to create STT provider of type: ${type}`);
      }
    } else {
      // Try dynamic import as fallback for unknown types
      const cls = await dynamicImportProviderModule(type);
      if (cls) {
        const instance = new cls(config);
        // Default to chat provider registration
        if ("textChat" in instance) {
          this.providerInsts.push(instance);
        }
        this.instMap.set(id, instance);
        console.info(`[ProviderManager] Dynamically loaded unknown provider type: ${type}`);
      } else {
        throw new Error(`[ProviderManager] Unknown provider type: ${type}`);
      }
    }
  }

  /**
   * Guess ProviderType from type string.
   */
  private guessProviderType(type: string): ProviderType {
    if (["openai", "openai_responses", "gemini", "anthropic"].includes(type))
      return "chat_completion" as ProviderType;
    if (type.includes("embedding")) return "embedding" as ProviderType;
    if (type.includes("rerank") || ["cohere", "jina", "voyage", "generic"].includes(type))
      return "rerank" as ProviderType;
    if (type.includes("tts")) return "text_to_speech" as ProviderType;
    if (type.includes("stt")) return "speech_to_text" as ProviderType;
    return "chat_completion" as ProviderType;
  }
}
