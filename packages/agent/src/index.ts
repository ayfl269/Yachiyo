// Agent core
export { Agent, createAgent } from "./agent.js";

// Message model
export {
  ContentPart,
  TextPart,
  ThinkPart,
  ImageURLPart,
  AudioURLPart,
  ToolCall,
  ToolCallPart,
  CheckpointData,
  Message,
  AssistantMessageSegment,
  ToolCallMessageSegment,
  UserMessageSegment,
  SystemMessageSegment,
  CheckpointMessageSegment,
  deserializeContentPart,
  serializeContentPart,
  mergeThinkPartInPlace,
  markContentPartAsTemp,
  serializeToolCall,
  validateMessage,
  serializeMessage,
  isCheckpointMessage,
  getCheckpointId,
  stripCheckpointMessages,
  bindCheckpointMessages,
  dumpMessagesWithCheckpoints,
} from "./message.js";

// Types
export {
  AgentState,
  createAgentStats,
  getStatsDuration,
  createContextWrapper,
  createMessageChain,
} from "./types.js";

export type {
  TokenUsage,
  AgentStats,
  ContextWrapper,
  NoContext,
  MessageChain,
  AgentResponseData,
  AgentResponseType,
  AgentResponse,
  LLMResponse,
  ProviderRequest,
  Conversation,
  ToolCallsResult,
  ProviderConfig,
  Provider,
  ProviderChatParams,
  CallToolResult,
  TextContent,
  ImageContent,
  EmbeddedResource,
  TextResourceContents,
  BlobResourceContents,
  BuiltinToolConfigRule,
} from "./types.js";

// Tool system
export { ToolSet, createFunctionTool } from "./tool.js";
export type { ToolSchema, FunctionTool, ToolHandler, ToolExecResult } from "./tool.js";

// Hooks
export { EmptyAgentHooks } from "./hooks.js";
export type { BaseAgentRunHooks } from "./hooks.js";

// Tool executor
export { FunctionToolExecutor, backgroundTaskBus } from "./tool-executor.js";
export type { BaseFunctionToolExecutor, BackgroundTaskResult, BackgroundTaskWaker } from "./tool-executor.js";

// Handoff
export { createHandoffTool } from "./handoff.js";
export type { HandoffTool } from "./handoff.js";

// MCP Client
export { MCPClient, validateMcpStdioConfig, ClosedResourceError } from "./mcp-client.js";
export type { MCPToolDefinition, MCPClientSession } from "./mcp-client.js";

// MCP Tool
export { createMCPTool, normalizeMcpInputSchema } from "./mcp-tool.js";
export type { MCPToolInstance } from "./mcp-tool.js";

// Tool Image Cache
export { ToolImageCache, toolImageCache } from "./tool-image-cache.js";
export type { CachedImage } from "./tool-image-cache.js";

// SubAgent Orchestrator
export { SubAgentOrchestrator } from "./subagent-orchestrator.js";
export type { SubAgentConfig, SubAgentOrchestratorConfig, PersonaData, SubAgentPersonaManager } from "./subagent-orchestrator.js";

// Dynamic Sub-Agent Creation
export {
  createSubAgentCreateTool,
  createListSubAgentsTool,
  createDeleteSubAgentTool,
  getSubAgentManagementTools,
  dynamicSubAgentRegistry,
} from "./subagent-create-tool.js";
export type { SubAgentCreateToolContext, DynamicSubAgentRegistry } from "./subagent-create-tool.js";

// Function Tool Manager
export { FunctionToolManager, MCPInitError, MCPInitTimeoutError } from "./func-tool-manager.js";
export type { BuiltinToolConstructor, MCPInitSummary } from "./func-tool-manager.js";

// Agent Runner (high-level)
export { runAgent, runLiveAgent } from "./agent-runner.js";
export type { RunAgentOptions, RunAgentResult } from "./agent-runner.js";

// Agent Builder
export { buildMainAgent } from "./agent-builder.js";
export type { MainAgentBuildConfig, MainAgentBuildResult, ProviderSelector } from "./agent-builder.js";

// Runners
export { BaseAgentRunner, ToolLoopAgentRunner } from "./runners/index.js";
export type { ToolLoopResetParams } from "./runners/index.js";

// Context management
export {
  ContextManager,
  ContextTruncator,
  EstimateTokenCounter,
  TruncateByTurnsCompressor,
  LLMSummaryCompressor,
  splitHistory,
  splitIntoRounds,
  roundsToText,
  createContextConfig,
  isTextPart,
  isThinkPart,
  isImageURLPart,
  isAudioURLPart,
} from "./context/index.js";

export type {
  TokenCounter,
  ContextCompressor,
  ContextConfig,
} from "./context/index.js";

// Modalities
export { sanitizeContextsByModalities, logContextSanitizeStats } from "@yachiyo/provider/modalities.js";
export type { ContextSanitizeStats } from "@yachiyo/provider/modalities.js";

// Computer tools (runtime toolset)
export {
  createFileReadTool,
  createFileWriteTool,
  createFileEditTool,
  createListDirTool,
  createFileDeleteTool,
  createFileMoveTool,
  createGrepTool,
  createShellTool,
  createLocalPythonTool,
  createLocalNodeTool,
  getRuntimeComputerTools,
} from "./computer-tools.js";
export type { ComputerToolContext, ComputerRuntime } from "./computer-tools.js";

// Web tools
export {
  createWebFetchTool,
  createWebSearchTool,
  createHttpRequestTool,
  getWebTools,
  getSearchProvider,
} from "./web-tools.js";
export type { WebToolContext, WebSearchProvider, SearchEngine } from "./web-tools.js";

// Memory tool
export {
  createMemoryTool,
} from "./memory-tool.js";
export type { MemoryToolContext, CreateMemoryToolOptions } from "./memory-tool.js";

// Memory store
export {
  SqliteMemoryStore,
  MEMORY_MIGRATIONS,
} from "./sqlite-memory-store.js";
export type {
  MemoryEntry,
  MemoryType,
  MemoryScope,
  MemoryStats,
  ConversationIndexEntry,
} from "./sqlite-memory-store.js";

// Memory consolidator
export {
  MemoryConsolidator,
  DEFAULT_CONSOLIDATION_CONFIG,
} from "./memory-consolidator.js";
export type {
  ConsolidationConfig,
  ConsolidationResult,
  UserProfile,
} from "./memory-consolidator.js";

// Code search tool
export {
  createCodeSearchTool,
} from "./code-search-tool.js";
export type { CodeSearchToolContext } from "./code-search-tool.js";

// Image reference utilities
export {
  normalizeAndDedupeStrings,
  isSupportedImageRef,
  resolveFileUrlPath,
  collectAndValidateImageUrls,
  collectImageUrlsFromArgs,
} from "./image-ref-utils.js";

// Download utilities
export {
  downloadBytes,
  downloadImageByUrl,
  downloadFile,
  encodeImageToBase64,
  encodeAudioToBase64,
  resolveImageToDataUrl,
  resolveAudioToDataUrl,
} from "./download-utils.js";

// Sandbox
export {
  applySandboxPolicyToToolSet,
  isPathAllowed,
  isDomainAllowed,
  DEFAULT_DYNAMIC_SUBAGENT_POLICY,
  DEFAULT_PRECONFIGURED_SUBAGENT_POLICY,
  buildLinuxSandboxCommand,
  setupLinuxCgroup,
  teardownLinuxCgroup,
} from "./sandbox.js";
export type { SandboxPolicy, ProcessSandboxConfig } from "./sandbox.js";

// Coordination
export {
  FileLockManager,
  fileLockManager,
  SubAgentTaskManager,
  executeParallelSubAgents,
} from "./coordination.js";
export type { SubAgentTask, SubAgentTaskOptions, FileLockMode } from "./coordination.js";
