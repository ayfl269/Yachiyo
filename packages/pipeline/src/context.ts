import type { AgentConfig, ConfigManager } from "@yachiyo/config/manager.js";
import type { PluginManager } from "@yachiyo/plugin/manager.js";
import type { ProviderManager } from "@yachiyo/provider/manager.js";
import type { ConversationManager } from "@yachiyo/conversation/manager.js";
import type { PersonaManager } from "@yachiyo/persona/manager.js";
import type { KnowledgeBaseManager } from "@yachiyo/knowledge-base/manager.js";
import type { SessionLockManager } from "./session-lock.js";
import type { SessionServiceManager } from "./stages/session-status-check.js";
import type { FunctionToolManager } from "@yachiyo/agent/func-tool-manager.js";
import type { SkillManager } from "@yachiyo/skill/manager.js";
import type { MemoryConsolidator } from "@yachiyo/agent/memory-consolidator.js";
import type { SqliteMemoryStore } from "@yachiyo/agent/sqlite-memory-store.js";
import type { StarHandlerMetadata } from "@yachiyo/plugin/handler.js";
import type { EventType } from "@yachiyo/plugin/event-type.js";

export interface PipelineContext {
  /** 动态获取当前活跃配置（通过 ConfigManager，确保 Dashboard 更新后立即生效） */
  config: AgentConfig;
  configManager: ConfigManager;
  configId: string;
  pluginManager: PluginManager;
  providerManager: ProviderManager;
  toolManager: FunctionToolManager;
  conversationManager: ConversationManager;
  personaManager: PersonaManager;
  knowledgeBaseManager: KnowledgeBaseManager;
  sessionLockManager: SessionLockManager;
  sessionServiceManager: SessionServiceManager;
  skillManager: SkillManager;
  memoryConsolidator?: MemoryConsolidator;
  memoryStore?: SqliteMemoryStore;
  callHandler: (event: import("@yachiyo/message/event.js").MessageEvent, handler: StarHandlerMetadata, ...args: unknown[]) => AsyncGenerator<unknown>;
  callEventHook: (event: import("@yachiyo/message/event.js").MessageEvent, hookType: EventType, ...args: unknown[]) => Promise<boolean>;
}
