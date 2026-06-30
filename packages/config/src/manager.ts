import { readFile, writeFile } from "fs/promises";
import type { SqliteConfigStore } from "./sqlite-config-store.js";

export interface AgentConfig {
  id: string;
  name: string;
  wakePrefix: string;
  friendMessageNeedsWakePrefix: boolean;
  rateLimitEnabled: boolean;
  rateLimitMaxRequests: number;
  rateLimitWindowSeconds: number;
  rateLimitStrategy: "STALL" | "DISCARD";
  safetyKeywords: string[];
  safetyCheckResponse: boolean;
  emojiReact: boolean;
  pathMappings: [string, string][];
  sttEnabled: boolean;
  streamingResponse: boolean;
  modelStreaming: boolean;
  maxStep: number;
  maxContextLength: number;
  toolCallTimeout: number;
  toolSchemaMode: "full" | "skills_like";
  replyPrefix: string;
  replyWithMention: boolean;
  replyWithQuote: boolean;
  segmentedReply: boolean;
  onlyLlmResultSegmented: boolean;
  ttsEnabled: boolean;
  t2iEnabled: boolean;
  t2iWidth: number;
  t2iQuality: number;
  t2iFormat: "png" | "jpeg";
  t2iTemplate: string;
  displayReasoningText: boolean;
  defaultProviderId: string;
  fallbackProviderIds: string[];
  defaultPersonaId: string;
  knowledgeBaseNames: string[];
  llmCompressInstruction: string;
  llmCompressKeepRecent: number;
  enforceMaxTurns: number;
  truncateTurns: number;
  // Context injection
  injectDateTime: boolean;
  timezone: string;
  promptPrefix: string;
  extraContext: string;
  // Context compression
  contextLimitReachedStrategy: "truncate_by_turns" | "llm_compress";
  llmCompressKeepRecentRatio: number;
  llmCompressProviderId: string;
  fallbackMaxContextTokens: number;
  // Memory system
  memoryEnabled: boolean;
  memoryConsolidationInterval: string;
  memoryConsolidationEnabled: boolean;
  memoryMaxLength: number;
  memoryMaxRetries: number;
  memoryAgingAccessThreshold: number;
  memoryAgingMaxAgeDays: number;
  memoryShortTermMaxAgeHours: number;
  memoryPromoteOnSessionEnd: boolean;
  memoryInjectProfileCount: number;
  memoryInjectLongTermCount: number;
  memoryInjectPersonaCount: number;
  memoryBufferMinMessages: number;
  memoryConsolidationBufferCount: number;
  // History storage limit
  maxHistoryMessages: number;
  temperature?: number;
  // Session whitelist: when enabled, only whitelisted UMOs get responses
  sessionWhitelistEnabled: boolean;
}

export interface ConfigInfo {
  id: string;
  config: AgentConfig;
  [key: string]: unknown;
}

export class ConfigManager {
  private configs: Map<string, AgentConfig> = new Map();
  private filePath?: string;
  private sqliteStore?: SqliteConfigStore;
  private onChangeCallbacks: ((configId: string, changeType: string) => void)[] = [];

  constructor(filePath?: string, sqliteStore?: SqliteConfigStore) {
    this.filePath = filePath;
    this.sqliteStore = sqliteStore;

    if (this.sqliteStore) {
      this.configs = this.sqliteStore.getAllConfigs();
    } else if (filePath) {
      this.loadFromFile().catch(() => {});
    }
  }

  getConfInfo(_umo: string): ConfigInfo {
    const first = this.configs.entries().next();
    if (first.done) {
      return { id: "default", config: this.createDefaultConfig("default") };
    }
    return { id: first.value[0], config: first.value[1] };
  }

  /** Returns the active (first) config, or null if none exist */
  getActiveConfig(): AgentConfig | null {
    const first = this.configs.values().next();
    return first.done ? null : first.value;
  }

  getAllConfigs(): AgentConfig[] {
    return [...this.configs.values()];
  }

  getConfigById(id: string): AgentConfig | null {
    return this.configs.get(id) ?? null;
  }

  addConfig(config: AgentConfig): void {
    this.configs.set(config.id, config);
    if (this.sqliteStore) {
      this.sqliteStore.saveConfig(config);
    }
    this.notifyChange(config.id, "add");
    this.autoSave();
  }

  updateConfig(config: AgentConfig): void {
    this.configs.set(config.id, config);
    if (this.sqliteStore) {
      this.sqliteStore.saveConfig(config);
    }
    this.notifyChange(config.id, "update");
    this.autoSave();
  }

  deleteConfig(id: string): void {
    this.configs.delete(id);
    if (this.sqliteStore) {
      this.sqliteStore.deleteConfig(id);
    }
    this.notifyChange(id, "delete");
    this.autoSave();
  }

  onChange(callback: (configId: string, changeType: string) => void): void {
    this.onChangeCallbacks.push(callback);
  }

  notifyChange(configId: string, changeType: string): void {
    for (const cb of this.onChangeCallbacks) {
      cb(configId, changeType);
    }
  }

  async saveToFile(): Promise<void> {
    if (!this.filePath) return;
    const data = {
      configs: [...this.configs.entries()],
    };
    await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async loadFromFile(): Promise<void> {
    if (!this.filePath) return;
    try {
      const content = await readFile(this.filePath, "utf-8");
      const data = JSON.parse(content);
      if (data.configs) {
        for (const [id, config] of data.configs) {
          this.configs.set(id, config);
        }
      }
    } catch {
    }
  }

  private autoSave(): void {
    if (!this.sqliteStore && this.filePath) {
      this.saveToFile().catch(() => {});
    }
  }

  createDefaultConfig(id: string): AgentConfig {
    return {
      id,
      name: "Default",
      wakePrefix: "",
      friendMessageNeedsWakePrefix: false,
      rateLimitEnabled: false,
      rateLimitMaxRequests: 10,
      rateLimitWindowSeconds: 60,
      rateLimitStrategy: "DISCARD",
      safetyKeywords: [],
      safetyCheckResponse: false,
      emojiReact: false,
      pathMappings: [],
      sttEnabled: false,
      streamingResponse: true,
      modelStreaming: true,
      maxStep: 30,
      maxContextLength: 8000,
      toolCallTimeout: 120000,
      toolSchemaMode: "full",
      replyPrefix: "",
      replyWithMention: false,
      replyWithQuote: false,
      segmentedReply: false,
      onlyLlmResultSegmented: false,
      ttsEnabled: false,
      t2iEnabled: false,
      t2iWidth: 800,
      t2iQuality: 85,
      t2iFormat: "png",
      t2iTemplate: "default",
      displayReasoningText: false,
      defaultProviderId: "",
      fallbackProviderIds: [],
      defaultPersonaId: "",
      knowledgeBaseNames: [],
      llmCompressInstruction: "",
      llmCompressKeepRecent: 10,
      enforceMaxTurns: 0,
      truncateTurns: 0,
      // Context injection
      injectDateTime: true,
      timezone: "",
      promptPrefix: "",
      extraContext: "",
      // Context compression
      contextLimitReachedStrategy: "truncate_by_turns",
      llmCompressKeepRecentRatio: 0.15,
      llmCompressProviderId: "",
      fallbackMaxContextTokens: 128000,
      // Memory system
      memoryEnabled: true,
      memoryConsolidationInterval: "12h",
      memoryConsolidationEnabled: true,
      memoryMaxLength: 400,
      memoryMaxRetries: 3,
      memoryAgingAccessThreshold: 1,
      memoryAgingMaxAgeDays: 90,
      memoryShortTermMaxAgeHours: 168,
      memoryPromoteOnSessionEnd: true,
      memoryInjectProfileCount: 5,
      memoryInjectLongTermCount: 10,
      memoryInjectPersonaCount: 5,
      memoryBufferMinMessages: 6,
      memoryConsolidationBufferCount: 30,
      // History storage limit
      maxHistoryMessages: 200,
      temperature: 0.7,
      // Session whitelist
      sessionWhitelistEnabled: false,
    };
  }
}
