import { AsyncQueue } from "@yachiyo/common/async-queue.js";
import { join } from "path";
import type { MessageEvent } from "@yachiyo/message/event.js";
import { ProviderManager } from "@yachiyo/provider/manager.js";
import { ConversationManager } from "@yachiyo/conversation/manager.js";
import { PersonaManager } from "@yachiyo/persona/manager.js";
import { KnowledgeBaseManager } from "@yachiyo/knowledge-base/manager.js";
import { SessionLockManager } from "@yachiyo/pipeline/session-lock.js";
import { SessionServiceManager } from "@yachiyo/pipeline/stages/session-status-check.js";
import { PluginManager } from "@yachiyo/plugin/manager.js";
import { ConfigManager } from "@yachiyo/config/manager.js";
import { EventBus } from "@yachiyo/pipeline/event-bus.js";
import { PipelineScheduler } from "@yachiyo/pipeline/scheduler.js";
import { PipelineContext } from "@yachiyo/pipeline/context.js";
import { ensureBuiltinStagesRegistered } from "@yachiyo/pipeline/bootstrap.js";
import { AdapterRegistry, registerBuiltinAdapterFactories } from "@yachiyo/platform/registry.js";
import { validateAdapterConfig, type OneBot11AdapterConfig, type AdapterConfigBase } from "@yachiyo/platform/config.js";
import { SqliteAdapterStore, ADAPTER_MIGRATIONS } from "@yachiyo/platform/sqlite-adapter-store.js";
import { createChatProvider, createEmbeddingProvider, createRerankProvider, type ChatProviderConfig, type EmbeddingProviderConfig, type RerankProviderConfig } from "@yachiyo/provider/factory.js";
import { callHandler as callHandlerUtil, callEventHook as callEventHookUtil } from "@yachiyo/pipeline/handler-utils.js";
import { DatabaseManager } from "@yachiyo/common/database.js";
import { CHAT_MIGRATIONS, SqliteConversationStore } from "@yachiyo/conversation/sqlite-conversation-store.js";
import { MEMORY_MIGRATIONS, SqliteMemoryStore } from "@yachiyo/agent/sqlite-memory-store.js";
import { CONFIG_MIGRATIONS } from "@yachiyo/config/sqlite-config-store.js";
import { CONFIG_EXTRAS_MIGRATIONS, SqlitePluginStore, SqliteSkillStore, SqliteSessionDisabledStore, SqliteSessionWhitelistStore } from "@yachiyo/config/sqlite-config-extras-store.js";
import { PROVIDER_CONFIG_MIGRATIONS, SqliteProviderStore } from "@yachiyo/provider/sqlite-provider-store.js";
import { PERSONA_MIGRATIONS, SqlitePersonaStore } from "@yachiyo/persona/sqlite-persona-store.js";
import { KNOWLEDGE_MIGRATIONS, SqliteKBMetadataStore, SqliteVectorStore } from "@yachiyo/knowledge-base/stores/sqlite-kb-store.js";
import { loadEncryptionKey } from "@yachiyo/common/secret-crypto.js";

import { FunctionToolManager } from "@yachiyo/agent/func-tool-manager.js";
import { SkillManager } from "@yachiyo/skill/index.js";
import {
  getWebTools,
  closeSharedBrowser,
  closeWebSearchProviders,
  closeAllBrowserPages,
} from "@yachiyo/agent/web-tools.js";
import {
  getRuntimeComputerTools,
} from "@yachiyo/agent/computer-tools.js";
import { createMemoryTool } from "@yachiyo/agent/memory-tool.js";
import { MemoryConsolidator } from "@yachiyo/agent/memory-consolidator.js";
import { createCodeSearchTool } from "@yachiyo/agent/code-search-tool.js";
import { getSubAgentManagementTools } from "@yachiyo/agent/subagent-create-tool.js";
import { SCHEDULER_MIGRATIONS, SqliteSchedulerTaskStore } from "@yachiyo/agent/scheduler-task-store.js";
import { createSchedulerTool } from "@yachiyo/agent/scheduler-tool.js";
import { TaskScheduler } from "@yachiyo/pipeline/task-scheduler.js";

export interface BootstrapOptions {
  /** 数据目录路径，默认 ./data，支持 DATA_DIR 环境变量覆盖 */
  dataDir?: string;

  /** 适配器配置列表，支持同时配置多个适配器 */
  adapters?: AdapterConfigBase[];

  /** 快捷配置：OneBot11 适配器参数（当 adapters 未指定时使用） */
  onebot11?: Partial<OneBot11AdapterConfig>;

  provider?: {
    type: "openai" | "openai_responses" | "gemini" | "anthropic";
    config: ChatProviderConfig;
  };
  embedding?: {
    type: "openai_embedding" | "gemini_embedding";
    config: EmbeddingProviderConfig;
  };
  rerank?: {
    type: "cohere" | "jina" | "voyage" | "generic";
    config: RerankProviderConfig;
  };

  /** MCP 服务器配置映射（可选）。传入后由 ProviderManager 管理生命周期。 */
  mcpServers?: Record<string, Record<string, unknown>>;

  knowledgeBases?: Array<{
    name: string;
    description?: string;
    embeddingProviderId: string;
    rerankProviderId?: string;
  }>;

  /** Dashboard admin interface configurations */
  dashboard?: {
    enabled?: boolean;
    port?: number;
    host?: string;
    /**
     * Enable the `/api/debug/chat` endpoint, which runs the full agent
     * pipeline (tools, shell, file access) on each request. Disabled by
     * default because it is an RCE attack surface. Only enable in trusted
     * environments.
     */
    debugChatEnabled?: boolean;
    /** Allowed CORS origins for the Dashboard API. Leave unset for same-origin only. */
    allowedOrigins?: string[];
  };
}

export interface BootstrapContext {
  eventQueue: AsyncQueue<MessageEvent>;
  eventBus: EventBus;
  adapterRegistry: AdapterRegistry;
  adapterStore?: SqliteAdapterStore;
  providerManager: ProviderManager;
  configManager: ConfigManager;
  conversationManager: ConversationManager;
  knowledgeBaseManager: KnowledgeBaseManager;
  sessionLockManager: SessionLockManager;
  sessionServiceManager: SessionServiceManager;
  personaManager: PersonaManager;
  pluginManager: PluginManager;
  skillManager: SkillManager;
  scheduler: PipelineScheduler;
  dbManager: DatabaseManager;
  toolManager: FunctionToolManager;
  memoryConsolidator: MemoryConsolidator;
  taskScheduler: TaskScheduler;
  dashboardServer?: any;
  shutdown: () => Promise<void>;
}

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapContext> {
  // Setup proxy if environment variables are present (Node.js global fetch uses undici)
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.http_proxy || process.env.https_proxy;
  if (proxyUrl) {
    try {
      const { setGlobalDispatcher, ProxyAgent } = await import("undici");
      setGlobalDispatcher(new ProxyAgent(proxyUrl));
      console.log(`[Proxy] Global proxy dispatcher configured with: ${proxyUrl}`);
    } catch (e) {
      console.warn("[Proxy] Failed to configure global proxy dispatcher:", e);
    }
  }

  // 0. 初始化 DatabaseManager 和所有 SQLite 数据库
  const dataDir = options.dataDir ?? process.env.DATA_DIR ?? "./data";
  const dbManager = new DatabaseManager(dataDir);
  dbManager.initialize();

  dbManager.migrate("chat", CHAT_MIGRATIONS);
  dbManager.migrate("memory", MEMORY_MIGRATIONS);
  dbManager.migrate("config", [...PROVIDER_CONFIG_MIGRATIONS, ...CONFIG_MIGRATIONS, ...CONFIG_EXTRAS_MIGRATIONS, ...PERSONA_MIGRATIONS, ...ADAPTER_MIGRATIONS]);
  dbManager.migrate("knowledge", KNOWLEDGE_MIGRATIONS);
  dbManager.migrate("scheduler", SCHEDULER_MIGRATIONS);

  // 1. 创建核心组件（注入 SQLite Store）
  const eventQueue = new AsyncQueue<MessageEvent>();

  const sqliteConversationStore = new SqliteConversationStore(dbManager.getDb("chat"));
  await sqliteConversationStore.initialize();
  const conversationManager = new ConversationManager(sqliteConversationStore);
  const sqliteProviderStore = new SqliteProviderStore(
    dbManager.getDb("config"),
    loadEncryptionKey({ keyFilePath: join(dataDir, "secret.key") }),
  );
  const providerManager = new ProviderManager();
  providerManager.setSqliteStore(sqliteProviderStore);

  const sqliteConfigStore = new (await import("@yachiyo/config/sqlite-config-store.js")).SqliteConfigStore(dbManager.getDb("config"));
  const configManager = new ConfigManager(undefined, sqliteConfigStore);

  // Apply maxHistoryMessages from config to ConversationManager
  const initialConfig = configManager.getActiveConfig();
  if (initialConfig?.maxHistoryMessages) {
    conversationManager.setMaxHistoryMessages(initialConfig.maxHistoryMessages);
  }
  // Update when config changes
  configManager.onChange((_configId, _changeType) => {
    const cfg = configManager.getActiveConfig();
    if (cfg?.maxHistoryMessages) {
      conversationManager.setMaxHistoryMessages(cfg.maxHistoryMessages);
    }
  });

  const sqlitePersonaStore = new SqlitePersonaStore(dbManager.getDb("config"));
  const personaManager = new PersonaManager(sqlitePersonaStore);

  const sqliteVectorStore = new SqliteVectorStore(dbManager.getDb("knowledge"));
  const sqliteKBMetadataStore = new SqliteKBMetadataStore(dbManager.getDb("knowledge"));
  const knowledgeBaseManager = new KnowledgeBaseManager(providerManager, sqliteVectorStore);
  knowledgeBaseManager.setMetadataStore(sqliteKBMetadataStore);

  const sessionLockManager = new SessionLockManager();

  const sqliteSessionDisabledStore = new SqliteSessionDisabledStore(dbManager.getDb("config"));
  const sqliteSessionWhitelistStore = new SqliteSessionWhitelistStore(dbManager.getDb("config"));
  const sessionServiceManager = new SessionServiceManager(sqliteSessionDisabledStore, sqliteSessionWhitelistStore);

  const sqlitePluginStore = new SqlitePluginStore(dbManager.getDb("config"));
  const pluginManager = new PluginManager();
  pluginManager.setSqliteStore(sqlitePluginStore);

  const sqliteSkillStore = new SqliteSkillStore(dbManager.getDb("config"));
  const skillManager = new SkillManager(
    join(dataDir, "skills"),
    join(dataDir, "plugins")
  );
  skillManager.setSqliteStore(sqliteSkillStore);
  await skillManager.restoreFromStore();
  await skillManager.scanAndLoadSkills();
  console.log(`[Bootstrap] SkillManager initialized with ${skillManager.listSkills().length} skills from store`);

  const adapterRegistry = new AdapterRegistry();

  // 2. 注册 Provider
  if (options.provider) {
    const provider = createChatProvider(options.provider.type, options.provider.config);
    providerManager.registerProvider(provider);
  }
  if (options.embedding) {
    const emb = createEmbeddingProvider(options.embedding.type, options.embedding.config);
    providerManager.registerEmbeddingProvider(emb);
  }
  if (options.rerank) {
    const rerank = createRerankProvider(options.rerank.type, options.rerank.config);
    providerManager.registerRerankProvider(rerank);
  }

  // 2.5 初始化 ProviderManager（含 MCP 配置注入）
  await providerManager.initialize(options.mcpServers);

  // 3. 初始化知识库
  await knowledgeBaseManager.initialize();

  // 4. 创建默认配置（仅在数据库中无已保存配置时创建，避免覆盖 Dashboard 更新）
  const existingConfig = configManager.getActiveConfig();
  const defaultConfig = existingConfig ?? configManager.createDefaultConfig("default");
  if (!existingConfig) {
    if (options.provider) {
      defaultConfig.defaultProviderId = String(options.provider.config.id ?? "default");
    }
    configManager.addConfig(defaultConfig);
  }

  // 同步主模型提供商
  const activeConfig = configManager.getActiveConfig() ?? defaultConfig;
  if (activeConfig.defaultProviderId) {
    providerManager.setDefaultProvider(activeConfig.defaultProviderId);
  }
  if (activeConfig.fallbackProviderIds) {
    providerManager.setFallbackProviders(activeConfig.fallbackProviderIds);
  }

  // 5. 注册管线阶段
  ensureBuiltinStagesRegistered();

  // 5.1 创建 FunctionToolManager 并注册所有内置工具
  const toolManager = new FunctionToolManager();
  const workspaceRoot = dataDir;

  // 注册 Web 工具 (web_fetch, web_search, http_request)
  for (const tool of getWebTools()) {
    toolManager.funcList.push(tool);
  }

  // 注册计算机工具 (file_read/write/edit, list_dir, delete, move, grep, shell, python, node)
  for (const tool of getRuntimeComputerTools("local", workspaceRoot)) {
    toolManager.funcList.push(tool);
  }

  // 注册 Memory 工具 + 记忆整理器
  const sqliteMemoryStore = new SqliteMemoryStore(dbManager.getDb("memory"));
  const memoryConsolidator = new MemoryConsolidator(sqliteMemoryStore, {
    interval: defaultConfig.memoryConsolidationInterval,
    enabled: defaultConfig.memoryConsolidationEnabled,
    memoryEnabled: defaultConfig.memoryEnabled,
    maxMemoryLength: defaultConfig.memoryMaxLength,
    maxRetries: defaultConfig.memoryMaxRetries,
    agingAccessThreshold: defaultConfig.memoryAgingAccessThreshold,
    agingMaxAgeDays: defaultConfig.memoryAgingMaxAgeDays,
    shortTermMaxAgeMs: defaultConfig.memoryShortTermMaxAgeHours * 3600 * 1000,
    promoteOnSessionEnd: defaultConfig.memoryPromoteOnSessionEnd,
    bufferMinMessages: defaultConfig.memoryBufferMinMessages,
    autoConsolidateBufferCount: defaultConfig.memoryConsolidationBufferCount,
  });
  conversationManager.setMemoryConsolidator(memoryConsolidator);
  const memoryTool = createMemoryTool({ workspaceRoot, sqliteStore: sqliteMemoryStore, consolidator: memoryConsolidator });
  toolManager.funcList.push(memoryTool);

  // 配置变更时同步 ProviderManager 和 MemoryConsolidator
  configManager.onChange((_configId: string, changeType: string) => {
    if (changeType === "update") {
      const cfg = configManager.getActiveConfig();
      if (cfg) {
        // 同步默认提供商和 fallback 提供商
        providerManager.setDefaultProvider(cfg.defaultProviderId || null);
        if (cfg.fallbackProviderIds) {
          providerManager.setFallbackProviders(cfg.fallbackProviderIds);
        }

        const defaultProvider = providerManager.getUsingProvider("chat_completion" as any);
        if (defaultProvider) {
          memoryConsolidator.setProvider(defaultProvider);
          const fallbackProviders = providerManager.getFallbackProviders();
          if (fallbackProviders.length > 0) {
            memoryConsolidator.setFallbackProviders(fallbackProviders);
          }
        }

        memoryConsolidator.updateConfig({
          interval: cfg.memoryConsolidationInterval,
          enabled: cfg.memoryConsolidationEnabled,
          memoryEnabled: cfg.memoryEnabled,
          maxMemoryLength: cfg.memoryMaxLength,
          maxRetries: cfg.memoryMaxRetries,
          agingAccessThreshold: cfg.memoryAgingAccessThreshold,
          agingMaxAgeDays: cfg.memoryAgingMaxAgeDays,
          shortTermMaxAgeMs: cfg.memoryShortTermMaxAgeHours * 3600 * 1000,
          promoteOnSessionEnd: cfg.memoryPromoteOnSessionEnd,
          bufferMinMessages: cfg.memoryBufferMinMessages,
          autoConsolidateBufferCount: cfg.memoryConsolidationBufferCount,
        });
        // 配置变更后重启周期定时器（应用新的间隔/启用状态）
        memoryConsolidator.startPeriodic();
      }
    }
  });

  // 注册代码搜索工具
  const codeSearchTool = createCodeSearchTool(workspaceRoot);
  toolManager.funcList.push(codeSearchTool);

  // 注册子代理管理工具 (create/list/delete_subagent)
  for (const tool of getSubAgentManagementTools(workspaceRoot)) {
    toolManager.funcList.push(tool);
  }

  // 注册定时任务工具 + 任务调度服务
  const sqliteSchedulerTaskStore = new SqliteSchedulerTaskStore(dbManager.getDb("scheduler"));
  const schedulerTool = createSchedulerTool({ sqliteStore: sqliteSchedulerTaskStore });
  toolManager.funcList.push(schedulerTool);
  const taskScheduler = new TaskScheduler(sqliteSchedulerTaskStore, eventQueue);
  // 6. 创建管线调度器
  const pipelineContext: PipelineContext = {
    get config() { return configManager.getActiveConfig() ?? defaultConfig; },
    configManager,
    configId: "default",
    pluginManager,
    providerManager,
    toolManager,
    conversationManager,
    personaManager,
    knowledgeBaseManager,
    sessionLockManager,
    sessionServiceManager,
    skillManager,
    memoryConsolidator,
    memoryStore: sqliteMemoryStore,
    callHandler: async function* (event: MessageEvent, handler: any, ...args: any[]) {
      yield* callHandlerUtil(event, handler, ...args);
    },
    callEventHook: async (event: MessageEvent, hookType: any, ...args: any[]) => {
      const handlers = pluginManager.getHandlerRegistry().getHandlersByEventType(hookType);
      return callEventHookUtil(event, hookType, handlers, ...args);
    },
  };
  const scheduler = new PipelineScheduler(pipelineContext);
  await scheduler.initialize();

  // 7. 创建 EventBus
  const schedulerMapping = new Map<string, PipelineScheduler>();
  schedulerMapping.set("default", scheduler);
  const eventBus = new EventBus(eventQueue, schedulerMapping, configManager);

  // 8. 注册适配器工厂并创建适配器
  registerBuiltinAdapterFactories(adapterRegistry);

  // 从数据库加载已保存的适配器配置
  const sqliteAdapterStore = new SqliteAdapterStore(dbManager.getDb("config"));
  adapterRegistry.setAdapterStore(sqliteAdapterStore);
  const savedAdapters = sqliteAdapterStore.loadAll();

  if (savedAdapters.length > 0) {
    // 从数据库恢复适配器
    for (const adapterConfig of savedAdapters) {
      if (adapterConfig.enabled === false) continue;
      try {
        adapterRegistry.createAdapter(adapterConfig.type, adapterConfig, eventQueue);
      } catch (e: any) {
        console.error(`[Bootstrap] Failed to create adapter ${adapterConfig.id}:`, e.message);
      }
    }
  } else {
    // 数据库为空：使用启动参数或默认配置
    for (const adapterConfig of options.adapters ?? []) {
      const validated = validateAdapterConfig(adapterConfig);
      if (validated.enabled === false) continue;
      adapterRegistry.createAdapter(validated.type, validated, eventQueue);
      sqliteAdapterStore.save(validated);
    }
  }

  // 9. 初始化并启动所有适配器
  await adapterRegistry.initializeAll();
  await adapterRegistry.startAll();

  // 9.2 配置记忆整理器并启动周期性定时器（使用间隔格式如 "12h"）
  const defaultProvider = providerManager.getUsingProvider("chat_completion" as any);
  if (defaultProvider) {
    memoryConsolidator.setProvider(defaultProvider);
    // 同时设置 fallback providers，主 provider 失败时自动切换
    const fallbackProviders = providerManager.getFallbackProviders();
    if (fallbackProviders.length > 0) {
      memoryConsolidator.setFallbackProviders(fallbackProviders);
    }
  }

  // 启动周期记忆整理
  memoryConsolidator.startPeriodic();

  // 注入 AdapterRegistry 到 TaskScheduler（用于主动推送定时任务消息）
  taskScheduler.setAdapterRegistry(adapterRegistry);

  // 启动定时任务调度器
  taskScheduler.start();

  // 9.5 启动管理后台
  let dashboardServer: any;
  if (options.dashboard?.enabled) {
    const { DashboardServer } = await import("@yachiyo/dashboard/server.js");
    dashboardServer = new DashboardServer(
      {
        eventQueue,
        eventBus,
        adapterRegistry,
        adapterStore: sqliteAdapterStore,
        providerManager,
        configManager,
        conversationManager,
        knowledgeBaseManager,
        sessionLockManager,
        sessionServiceManager,
        personaManager,
        pluginManager,
        skillManager,
        scheduler,
        dbManager,
        toolManager,
        memoryStore: sqliteMemoryStore,
        memoryConsolidator,
        schedulerStore: sqliteSchedulerTaskStore,
        shutdown: async () => {},
      } as any,
      {
        port: options.dashboard.port,
        host: options.dashboard.host,
        debugChatEnabled: options.dashboard.debugChatEnabled === true,
        allowedOrigins: options.dashboard.allowedOrigins,
      }
    );
    await dashboardServer.start();
  }

  // 10. 启动事件总线（非阻塞）
  eventBus.dispatch();

  return {
    eventQueue,
    eventBus,
    adapterRegistry,
    adapterStore: sqliteAdapterStore,
    providerManager,
    configManager,
    conversationManager,
    knowledgeBaseManager,
    sessionLockManager,
    sessionServiceManager,
    personaManager,
    pluginManager,
    skillManager,
    scheduler,
    dbManager,
    toolManager,
    memoryConsolidator,
    taskScheduler,
    dashboardServer,
    async shutdown() {
      if (dashboardServer) {
        try {
          await dashboardServer.stop();
        } catch (e) {
          console.error("[Bootstrap] Error stopping dashboard server:", e);
        }
      }
      // 停止定时任务调度器
      taskScheduler.stop();
      // 停止记忆整理周期定时器
      memoryConsolidator.stop();
      await adapterRegistry.stopAll();
      eventBus.stop();
      await conversationManager.close();
      await knowledgeBaseManager.terminate();
      await providerManager.terminate();
      // 关闭无头浏览器及所有打开的页面，防止 Chromium 进程泄漏
      try { await closeAllBrowserPages(); } catch { /* ignore */ }
      try { await closeWebSearchProviders(); } catch { /* ignore */ }
      try { await closeSharedBrowser(); } catch { /* ignore */ }
      dbManager.close();
    },
  };
}
