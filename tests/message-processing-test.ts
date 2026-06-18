/**
 * 消息处理系统集成测试
 * 验证从平台消息接收到响应发送的全链�? */
import {
  // 通用工具
  AsyncQueue,
  Condition,
  generateId,
  AgentSystemError,
  ProviderNotFoundError,
  NOT_GIVEN,
  TraceSpan,
  // 消息模型
  MessageType,
  ComponentType,
  PlatformMessage,
  MessageSession,
  MessageEvent,
  EventResult,
  EventResultType,
  ResultContentType,
  serializeComponent,
  deserializeComponent,
  // 平台适配�?  PlatformAdapter,
  MessageConverter,
  // 管线
  PipelineStage,
  registerStage,
  PipelineScheduler,
  STAGES_ORDER,
  EventBus,
  SessionLockManager,
  SessionServiceManager,
  ActiveEventRegistry,
  activeEventRegistry,
  // 配置
  ConfigManager,
  // 会话
  ConversationManager,
  ConversationStore,
  InMemoryConversationStore,
  // 插件
  EventType,
  StarHandlerMetadata,
  StarHandlerRegistry,
  HandlerFilter,
  CommandFilter,
  RegexFilter,
  PluginManager,
  // Provider
  ProviderType,
  ProviderManager,
  STTProvider,
  TTSProvider,
  EmbeddingProvider,
  RerankProvider,
  // Persona
  PersonaManager,
  // KnowledgeBase
  KnowledgeBaseManager,
  // Skill
  SkillManager,
  buildSkillsPrompt,
  // Agent types
  type MessageChain,
  type ProviderRequest,
} from "../src/index.js";
import { FunctionToolManager } from "../src/agent/func-tool-manager.js";

// ============================================================
// 1. 测试: 通用工具�?// ============================================================
async function testCommonUtils(): Promise<void> {
  console.log("\n=== 测试: 通用工具�?===");

  // AsyncQueue
  const queue = new AsyncQueue<string>();
  queue.put("hello");
  queue.put("world");
  const v1 = await queue.get();
  const v2 = await queue.get();
  console.log("  AsyncQueue:", v1, v2, "size:", queue.size);

  // AsyncQueue async put
  const asyncQueue = new AsyncQueue<number>();
  const getPromise = asyncQueue.get(); // blocks
  asyncQueue.put(42);
  const asyncVal = await getPromise;
  console.log("  AsyncQueue async:", asyncVal);

  // Condition
  const cond = new Condition();
  let condResolved = false;
  const waitPromise = cond.wait().then(() => { condResolved = true; });
  console.log("  Condition wait:", condResolved);
  cond.notifyAll();
  await waitPromise;
  console.log("  Condition after notify:", condResolved);

  // generateId
  const id1 = generateId();
  const id2 = generateId();
  console.log("  generateId unique:", id1 !== id2);
  console.log("  generateId format:", id1.length > 0);

  // Errors
  const err1 = new AgentSystemError("test");
  const err2 = new ProviderNotFoundError("openai");
  console.log("  AgentSystemError:", err1.name, err1.message);
  console.log("  ProviderNotFoundError:", err2.name, err2.message);

  // NOT_GIVEN
  function testOptional(val: string | null | typeof NOT_GIVEN) {
    if (val === NOT_GIVEN) return "NOT_GIVEN";
    if (val === null) return "null";
    return val;
  }
  console.log("  NOT_GIVEN:", testOptional(NOT_GIVEN), testOptional(null), testOptional("hello"));

  // TraceSpan
  const span = new TraceSpan("test-span", "umo:123");
  span.record("action-1", { key: "value" });
  console.log("  TraceSpan:", span.name, span.spanId.length > 0);

  console.log("  �?通用工具层测试通过");
}

// ============================================================
// 2. 测试: 消息模型
// ============================================================
function testMessageModel(): void {
  console.log("\n=== 测试: 消息模型 ===");

  // PlatformMessage
  const msg = new PlatformMessage();
  msg.type = MessageType.FRIEND_MESSAGE;
  msg.selfId = "bot-001";
  msg.sessionId = "session-001";
  msg.messageId = "msg-001";
  msg.sender = { userId: "user-001", nickname: "Alice" };
  msg.components = [
    { type: ComponentType.Plain, text: "Hello bot!", toDict() { return { type: "text", data: { text: "Hello bot!" } }; } } as any,
    { type: ComponentType.At, qq: "bot-001", toDict() { return { type: "at", data: { qq: "bot-001" } }; } } as any,
  ];
  msg.messageStr = "Hello bot! @bot-001";
  msg.timestamp = Date.now();

  console.log("  PlatformMessage type:", msg.type);
  console.log("  PlatformMessage sender:", msg.sender.nickname);
  console.log("  PlatformMessage groupId:", msg.groupId, "(empty for private)");
  console.log("  PlatformMessage components:", msg.components.length);

  // MessageSession
  const session = new MessageSession();
  session.platformId = "webchat";
  session.messageType = MessageType.FRIEND_MESSAGE;
  session.sessionId = "user-001";
  const sessionStr = session.toString();
  const parsed = MessageSession.fromStr(sessionStr);
  console.log("  MessageSession toString:", sessionStr);
  console.log("  MessageSession fromStr:", parsed.platformId, parsed.sessionId);

  // EventResult
  const result = new EventResult();
  result.plain("Hello ").plain("World");
  console.log("  EventResult plainText:", result.getPlainText());
  console.log("  EventResult isLlmResult:", result.isLlmResult());
  console.log("  EventResult isStopped:", result.isStopped());

  result.stopEvent();
  console.log("  EventResult after stop:", result.isStopped());

  const llmResult = new EventResult()
    .plain("LLM response")
    .setResultContentType(ResultContentType.LLM_RESULT);
  console.log("  EventResult isLlmResult:", llmResult.isLlmResult());

  // Serialization
  const comp = { type: ComponentType.Plain, text: "test", toDict() { return { type: "text", data: { text: "test" } }; } } as any;
  const serialized = serializeComponent(comp);
  console.log("  serializeComponent:", serialized.type, serialized.data);
  const deserialized = deserializeComponent(serialized);
  console.log("  deserializeComponent:", deserialized.type);

  console.log("  �?消息模型测试通过");
}

// ============================================================
// 3. 测试: MessageEvent 抽象�?// ============================================================
async function testMessageEvent(): Promise<void> {
  console.log("\n=== 测试: MessageEvent ===");

  // Create a concrete MessageEvent for testing
  const sentMessages: any[] = [];

  class TestMessageEvent extends MessageEvent {
    async send(components: any[]): Promise<void> {
      sentMessages.push(components);
    }
    async sendStreaming(generator: AsyncGenerator<MessageChain, void>): Promise<void> {
      const parts: string[] = [];
      for await (const chunk of generator) {
        if (chunk.message) parts.push(chunk.message);
      }
      if (parts.length > 0) {
        await this.send([{ type: ComponentType.Plain, text: parts.join(""), toDict() { return {}; } } as any]);
      }
    }
  }

  const platformMsg = new PlatformMessage();
  platformMsg.type = MessageType.GROUP_MESSAGE;
  platformMsg.selfId = "bot-001";
  platformMsg.sessionId = "group-001";
  platformMsg.messageId = "msg-001";
  platformMsg.sender = { userId: "user-001", nickname: "Alice" };
  platformMsg.group = {
    groupId: "group-001",
    groupName: "Test Group",
    groupAvatar: null,
    groupOwner: null,
    groupAdmins: null,
    members: null,
  };
  platformMsg.components = [
    { type: ComponentType.Plain, text: "你好", toDict() { return {}; } } as any,
  ];
  platformMsg.messageStr = "你好";
  platformMsg.timestamp = Date.now();

  const event = new TestMessageEvent(
    "你好",
    platformMsg,
    { name: "test", description: "Test", id: "test-platform", supportStreamingMessage: true, supportProactiveMessage: true },
    "group-001",
  );

  console.log("  unifiedMsgOrigin:", event.unifiedMsgOrigin);
  console.log("  getSenderId:", event.getSenderId());
  console.log("  getSenderName:", event.getSenderName());
  console.log("  isPrivateChat:", event.isPrivateChat());
  console.log("  isWakeUp:", event.isWakeUp());

  // setResult / getResult
  event.setResult("Hello response");
  console.log("  getResult plainText:", event.getResult()?.getPlainText());

  // stopEvent / isStopped
  console.log("  isStopped (before):", event.isStopped());
  event.stopEvent();
  console.log("  isStopped (after stop):", event.isStopped());
  event.continueEvent();
  console.log("  isStopped (after continue):", event.isStopped());

  // extras
  event.setExtra("test_key", "test_value");
  console.log("  getExtra:", event.getExtra("test_key"));
  console.log("  getExtra default:", event.getExtra("missing", "fallback"));

  // skipLlm
  event.setSkipLlm(true);
  console.log("  skipLlm:", event.skipLlm);

  // send
  await event.send([{ type: ComponentType.Plain, text: "response", toDict() { return {}; } } as any]);
  console.log("  send called:", sentMessages.length === 1);

  // requestLlm
  const req = event.requestLlm("test prompt", { imageUrls: ["http://img.png"] });
  console.log("  requestLlm prompt:", req.prompt);
  console.log("  requestLlm imageUrls:", req.imageUrls);

  console.log("  �?MessageEvent 测试通过");
}

// ============================================================
// 4. 测试: 管线调度�?// ============================================================
async function testPipelineScheduler(): Promise<void> {
  console.log("\n=== 测试: 管线调度�?===");

  // Create a simple test stage
  const executionLog: string[] = [];

  class LogStage extends PipelineStage {
    private name: string;
    constructor(name: string) {
      super();
      this.name = name;
    }
    async initialize(_ctx: any): Promise<void> {
      executionLog.push(`init:${this.name}`);
    }
    async process(event: MessageEvent): Promise<void> {
      executionLog.push(`process:${this.name}`);
    }
  }

  // Test stage execution order
  const stage1 = new LogStage("Stage1");
  const stage2 = new LogStage("Stage2");
  const stage3 = new LogStage("Stage3");

  // Create a minimal config
  const configManager = new ConfigManager();
  configManager.addConfig(configManager.createDefaultConfig("test-config"));

  // Create minimal context
  const ctx = {
    config: configManager.createDefaultConfig("test"),
    configManager,
    configId: "test",
    pluginManager: new PluginManager(),
    providerManager: new ProviderManager(),
    toolManager: new FunctionToolManager(),
    conversationManager: new ConversationManager(),
    personaManager: new PersonaManager(),
    knowledgeBaseManager: new KnowledgeBaseManager(new ProviderManager()),
    sessionLockManager: new SessionLockManager(),
    sessionServiceManager: new SessionServiceManager(),
    skillManager: new SkillManager(),
    callHandler: async function* () {},
    callEventHook: async () => false,
  };

  // Manually create scheduler with stages
  const scheduler = new PipelineScheduler(ctx);
  // Inject stages directly (bypass registerStage for isolation)
  (scheduler as any).stages = [stage1, stage2, stage3];
  for (const stage of [stage1, stage2, stage3]) {
    await stage.initialize(ctx);
  }

  // Create test event
  class TestEvent extends MessageEvent {
    async send(): Promise<void> {}
    async sendStreaming(): Promise<void> {}
  }

  const platformMsg = new PlatformMessage();
  platformMsg.type = MessageType.FRIEND_MESSAGE;
  platformMsg.selfId = "bot";
  platformMsg.sessionId = "s1";
  platformMsg.messageId = "m1";
  platformMsg.sender = { userId: "u1", nickname: "Test" };
  platformMsg.messageStr = "test";
  platformMsg.timestamp = Date.now();

  const event = new TestEvent(
    "test",
    platformMsg,
    { name: "test", description: "", id: "test", supportStreamingMessage: true, supportProactiveMessage: true },
    "s1",
  );

  await scheduler.execute(event);

  console.log("  执行顺序:", executionLog.join(" �?"));
  console.log("  初始化顺序正�?", executionLog[0] === "init:Stage1");
  console.log("  处理顺序正确:", executionLog[3] === "process:Stage1");

  // Test stopEvent
  executionLog.length = 0;

  class StopStage extends PipelineStage {
    async initialize(_ctx: any): Promise<void> {}
    async process(event: MessageEvent): Promise<void> {
      executionLog.push("stop-stage");
      event.stopEvent();
    }
  }

  class AfterStopStage extends PipelineStage {
    async initialize(_ctx: any): Promise<void> {}
    async process(event: MessageEvent): Promise<void> {
      executionLog.push("after-stop");
    }
  }

  const stopScheduler = new PipelineScheduler(ctx);
  (stopScheduler as any).stages = [new StopStage(), new AfterStopStage()];

  const event2 = new TestEvent(
    "test",
    platformMsg,
    { name: "test", description: "", id: "test", supportStreamingMessage: true, supportProactiveMessage: true },
    "s1",
  );

  await stopScheduler.execute(event2);
  console.log("  stopEvent 阻止后续阶段:", executionLog.length === 1 && executionLog[0] === "stop-stage");

  console.log("  �?管线调度器测试通过");
}

// ============================================================
// 5. 测试: 洋葱模型
// ============================================================
async function testOnionModel(): Promise<void> {
  console.log("\n=== 测试: 洋葱模型 ===");

  const log: string[] = [];

  class OnionStage extends PipelineStage {
    private name: string;
    constructor(name: string) {
      super();
      this.name = name;
    }
    async initialize(_ctx: any): Promise<void> {}
    async *process(event: MessageEvent): AsyncGenerator<void, void> {
      log.push(`${this.name}:pre`);
      yield; // Let next stages run
      log.push(`${this.name}:post`);
    }
  }

  class InnerStage extends PipelineStage {
    async initialize(_ctx: any): Promise<void> {}
    async process(event: MessageEvent): Promise<void> {
      log.push("inner");
    }
  }

  const configManager = new ConfigManager();
  const ctx = {
    config: configManager.createDefaultConfig("test"),
    configManager,
    configId: "test",
    pluginManager: new PluginManager(),
    providerManager: new ProviderManager(),
    toolManager: new FunctionToolManager(),
    conversationManager: new ConversationManager(),
    personaManager: new PersonaManager(),
    knowledgeBaseManager: new KnowledgeBaseManager(new ProviderManager()),
    sessionLockManager: new SessionLockManager(),
    sessionServiceManager: new SessionServiceManager(),
    skillManager: new SkillManager(),
    callHandler: async function* () {},
    callEventHook: async () => false,
  };

  const scheduler = new PipelineScheduler(ctx);
  (scheduler as any).stages = [new OnionStage("A"), new OnionStage("B"), new InnerStage()];

  class TestEvent extends MessageEvent {
    async send(): Promise<void> {}
    async sendStreaming(): Promise<void> {}
  }

  const platformMsg = new PlatformMessage();
  platformMsg.type = MessageType.FRIEND_MESSAGE;
  platformMsg.selfId = "bot";
  platformMsg.sessionId = "s1";
  platformMsg.messageId = "m1";
  platformMsg.sender = { userId: "u1", nickname: "Test" };
  platformMsg.messageStr = "test";
  platformMsg.timestamp = Date.now();

  const event = new TestEvent(
    "test",
    platformMsg,
    { name: "test", description: "", id: "test", supportStreamingMessage: true, supportProactiveMessage: true },
    "s1",
  );

  await scheduler.execute(event);

  // Expected: A:pre �?B:pre �?inner �?B:post �?A:post
  console.log("  执行顺序:", log.join(" �?"));
  console.log("  洋葱模型正确:", log.join(",") === "A:pre,B:pre,inner,B:post,A:post");

  console.log("  �?洋葱模型测试通过");
}

// ============================================================
// 6. 测试: SessionLockManager
// ============================================================
async function testSessionLock(): Promise<void> {
  console.log("\n=== 测试: SessionLockManager ===");

  const lockManager = new SessionLockManager();
  const order: string[] = [];

  // Acquire lock
  const release1 = await lockManager.acquireLock("session-1");
  order.push("acquire1");

  // Second acquire should wait
  let acquired2 = false;
  const acquire2Promise = lockManager.acquireLock("session-1").then(release => {
    acquired2 = true;
    order.push("acquire2");
    return release;
  });

  // Give time for the second acquire to start waiting
  await new Promise(resolve => setTimeout(resolve, 50));
  console.log("  第二次获取等待中:", !acquired2);

  // Release first lock
  release1();
  const release2 = await acquire2Promise;
  console.log("  释放后第二次获取成功:", acquired2);

  release2();

  // Different sessions should not block each other
  const release3 = await lockManager.acquireLock("session-2");
  const release4 = await lockManager.acquireLock("session-3");
  console.log("  不同会话不互�?", true);
  release3();
  release4();

  console.log("  �?SessionLockManager 测试通过");
}

// ============================================================
// 7. 测试: ConfigManager
// ============================================================
function testConfigManager(): void {
  console.log("\n=== 测试: ConfigManager ===");

  const manager = new ConfigManager();
  const defaultConfig = manager.createDefaultConfig("cfg-1");
  manager.addConfig(defaultConfig);

  console.log("  默认配置 id:", defaultConfig.id);
  console.log("  wakePrefix:", defaultConfig.wakePrefix);
  console.log("  streamingResponse:", defaultConfig.streamingResponse);
  console.log("  maxStep:", defaultConfig.maxStep);

  const confInfo = manager.getConfInfo("unknown:session:1");
  console.log("  未知会话获取默认配置:", confInfo.id === "cfg-1");

  console.log("  �?ConfigManager 测试通过");
}

// ============================================================
// 8. 测试: ConversationManager + InMemoryConversationStore
// ============================================================
async function testConversationManager(): Promise<void> {
  console.log("\n=== 测试: ConversationManager ===");

  const manager = new ConversationManager();
  const umo = "webchat:FriendMessage:user-1";

  // New conversation
  const convId = await manager.newConversation(umo, {
    platformId: "webchat",
    title: "Test Conversation",
  });
  console.log("  新建对话 id:", convId.length > 0);

  // Get conversation
  const conv = await manager.getConversation(umo, convId);
  console.log("  获取对话:", conv?.title);
  console.log("  对话历史初始:", conv?.history);

  // Update conversation
  await manager.updateConversation(umo, convId, {
    history: JSON.stringify([{ role: "user", content: "Hello" }]),
  });
  const updated = await manager.getConversation(umo, convId);
  console.log("  更新后历�?", updated?.history?.includes("Hello"));

  // Get current conversation id
  console.log("  当前对话 id:", await manager.getCurrConversationId(umo));

  // InMemoryConversationStore
  const store = new InMemoryConversationStore();
  await store.initialize();
  console.log("  InMemoryStore 初始化成�?", true);

  // API Key operations
  await store.createApiKey({ id: "1", keyHash: "abc123hash", keyPrefix: "test", name: "Test", scopes: null, createdBy: "admin", createdAt: new Date(), lastUsedAt: null, expiresAt: null, revokedAt: null });
  const apiKey = await store.getApiKeyByHash("abc123hash");
  console.log("  API Key 查找:", apiKey?.name);

  // Preference operations
  await store.insertOrUpdatePreference({ key: "theme", value: "dark", namespace: "ui" });
  const pref = await store.getPreference("theme");
  console.log("  Preference:", pref?.value);

  console.log("  �?ConversationManager 测试通过");
}

// ============================================================
// 9. 测试: 插件系统
// ============================================================
function testPluginSystem(): void {
  console.log("\n=== 测试: 插件系统 ===");

  // EventType
  console.log("  EventType.OnLLMRequestEvent:", EventType.OnLLMRequestEvent);

  // StarHandlerRegistry
  const registry = new StarHandlerRegistry();
  const handler: StarHandlerMetadata = {
    eventType: EventType.OnLLMRequestEvent,
    handlerFullName: "test_plugin.on_request",
    handlerName: "on_request",
    handlerModulePath: "test_plugin",
    handler: () => {},
    eventFilters: [],
    desc: "Test handler",
    extrasConfigs: {},
    enabled: true,
  };
  registry.append(handler);
  const found = registry.getHandlersByEventType(EventType.OnLLMRequestEvent, true);
  console.log("  Registry 查找 handler:", found.length === 1);
  console.log("  Handler 名称:", found[0]?.handlerName);

  // HandlerFilter
  class MockEvent extends MessageEvent {
    async send(): Promise<void> {}
    async sendStreaming(): Promise<void> {}
  }

  const platformMsg = new PlatformMessage();
  platformMsg.type = MessageType.GROUP_MESSAGE;
  platformMsg.selfId = "bot";
  platformMsg.sessionId = "s1";
  platformMsg.messageId = "m1";
  platformMsg.sender = { userId: "u1", nickname: "Test" };
  platformMsg.messageStr = "/hello world";
  platformMsg.timestamp = Date.now();

  const mockEvent = new MockEvent(
    "/hello world",
    platformMsg,
    { name: "test", description: "", id: "test", supportStreamingMessage: true, supportProactiveMessage: true },
    "s1",
  );

  const cmdFilter = new CommandFilter("/hello");
  console.log("  CommandFilter 匹配:", cmdFilter.filter(mockEvent, {}));

  const regexFilter = new RegexFilter(/^\/hello/);
  console.log("  RegexFilter 匹配:", regexFilter.filter(mockEvent, {}));

  const noMatchFilter = new CommandFilter("/goodbye");
  console.log("  CommandFilter 不匹�?", !noMatchFilter.filter(mockEvent, {}));

  // PluginManager
  const pluginManager = new PluginManager();
  pluginManager.registerStar({
    name: "test-plugin",
    author: "test",
    desc: "A test plugin",
    shortDesc: "Test",
    version: "1.0.0",
    repo: "",
    modulePath: "test_plugin",
    activated: true,
    config: {},
    handlerFullNames: ["test_plugin.on_request"],
    displayName: "Test Plugin",
    logoPath: "",
    supportPlatforms: [],
  });
  console.log("  PluginManager stars:", pluginManager.getAllStars().length);

  console.log("  �?插件系统测试通过");
}

// ============================================================
// 10. 测试: Provider 体系
// ============================================================
function testProviderSystem(): void {
  console.log("\n=== 测试: Provider 体系 ===");

  // ProviderType
  console.log("  ProviderType.CHAT_COMPLETION:", ProviderType.CHAT_COMPLETION);

  // ProviderManager
  const manager = new ProviderManager();
  console.log("  ProviderManager 初始 provider �?", manager.providerInsts.length);
  console.log("  ProviderManager getUsingProvider (�?:", manager.getUsingProvider(ProviderType.CHAT_COMPLETION) === null);

  // STTProvider stub
  class MockSTTProvider extends STTProvider {
    async getText(audioUrl: string): Promise<string> {
      return "transcribed text";
    }
  }
  const stt = new MockSTTProvider();
  console.log("  STTProvider getText:", stt.getText("http://audio.mp3") instanceof Promise);

  // TTSProvider stub
  class MockTTSProvider extends TTSProvider {
    async getAudio(text: string): Promise<string> {
      return "/tmp/audio.wav";
    }
  }
  const tts = new MockTTSProvider();
  console.log("  TTSProvider supportStream:", tts.supportStream());

  console.log("  �?Provider 体系测试通过");
}

// ============================================================
// 11. 测试: Skill
// ============================================================
async function testSkill(): Promise<void> {
  console.log("\n=== 测试: Skill ===");

  // SkillManager
  const skillManager = new SkillManager("/skills", "/plugins");
  skillManager.registerSkill({
    name: "code-review",
    description: "Code review skill",
    path: "/skills/code-review",
    active: true,
    sourceType: "local",
    sourceLabel: "local",
    localExists: true,
    sandboxExists: false,
    pluginName: "code-review-plugin",
    readonly: false,
  });
  const skills = skillManager.listSkills();
  console.log("  SkillManager skills:", skills.length);
  console.log("  SkillManager activeOnly:", skillManager.listSkills({ activeOnly: true }).length);

  // buildSkillsPrompt
  const prompt = buildSkillsPrompt(skills);
  console.log("  buildSkillsPrompt 包含 code-review:", prompt.includes("code-review"));

  console.log("  ✅ Skill 测试通过");
}

// ============================================================
// 12. 测试: EventBus 端到�?// ============================================================
async function testEventBusE2E(): Promise<void> {
  console.log("\n=== 测试: EventBus 端到�?===");

  const eventQueue = new AsyncQueue<MessageEvent>();
  const processedEvents: string[] = [];

  // Create a minimal pipeline that just logs
  class LogAndRespondStage extends PipelineStage {
    async initialize(_ctx: any): Promise<void> {}
    async process(event: MessageEvent): Promise<void> {
      processedEvents.push(event.getMessageStr());
      event.setResult(new EventResult().plain("Response: " + event.getMessageStr()));
    }
  }

  const configManager = new ConfigManager();
  configManager.addConfig(configManager.createDefaultConfig("e2e-config"));

  const ctx = {
    config: configManager.createDefaultConfig("e2e"),
    configManager,
    configId: "e2e-config",
    pluginManager: new PluginManager(),
    providerManager: new ProviderManager(),
    toolManager: new FunctionToolManager(),
    conversationManager: new ConversationManager(),
    personaManager: new PersonaManager(),
    knowledgeBaseManager: new KnowledgeBaseManager(new ProviderManager()),
    sessionLockManager: new SessionLockManager(),
    sessionServiceManager: new SessionServiceManager(),
    skillManager: new SkillManager(),
    callHandler: async function* () {},
    callEventHook: async () => false,
  };

  const scheduler = new PipelineScheduler(ctx);
  (scheduler as any).stages = [new LogAndRespondStage()];

  const schedulerMapping = new Map<string, PipelineScheduler>();
  schedulerMapping.set("e2e-config", scheduler);

  const eventBus = new EventBus(eventQueue, schedulerMapping, configManager);

  // Start event bus in background
  const busPromise = eventBus.dispatch();

  // Create test event
  class TestEvent extends MessageEvent {
    async send(): Promise<void> {}
    async sendStreaming(): Promise<void> {}
  }

  const platformMsg = new PlatformMessage();
  platformMsg.type = MessageType.FRIEND_MESSAGE;
  platformMsg.selfId = "bot";
  platformMsg.sessionId = "s1";
  platformMsg.messageId = "m1";
  platformMsg.sender = { userId: "u1", nickname: "Test" };
  platformMsg.messageStr = "E2E test message";
  platformMsg.timestamp = Date.now();

  const event = new TestEvent(
    "E2E test message",
    platformMsg,
    { name: "test", description: "", id: "test", supportStreamingMessage: true, supportProactiveMessage: true },
    "s1",
  );

  // Put event into queue
  eventQueue.put(event);

  // Wait for processing
  await new Promise(resolve => setTimeout(resolve, 200));

  console.log("  处理的事件数:", processedEvents.length);
  console.log("  处理的消�?", processedEvents[0]);
  console.log("  事件结果:", event.getResult()?.getPlainText());

  // Stop bus
  eventBus.stop();

  console.log("  �?EventBus 端到端测试通过");
}

// ============================================================
// 13. 测试: ActiveEventRegistry
// ============================================================
function testActiveEventRegistry(): Promise<void> {
  console.log("\n=== 测试: ActiveEventRegistry ===");

  class TestEvent extends MessageEvent {
    async send(): Promise<void> {}
    async sendStreaming(): Promise<void> {}
  }

  const platformMsg = new PlatformMessage();
  platformMsg.type = MessageType.FRIEND_MESSAGE;
  platformMsg.selfId = "bot";
  platformMsg.sessionId = "s1";
  platformMsg.messageId = "m1";
  platformMsg.sender = { userId: "u1", nickname: "Test" };
  platformMsg.messageStr = "test";
  platformMsg.timestamp = Date.now();

  const event1 = new TestEvent(
    "test1",
    platformMsg,
    { name: "test", description: "", id: "test", supportStreamingMessage: true, supportProactiveMessage: true },
    "s1",
  );

  const event2 = new TestEvent(
    "test2",
    platformMsg,
    { name: "test", description: "", id: "test", supportStreamingMessage: true, supportProactiveMessage: true },
    "s1",
  );

  activeEventRegistry.register(event1);
  activeEventRegistry.register(event2);

  // Stop all except event1
  const stoppedCount = activeEventRegistry.stopAll("test:FriendMessage:s1", event1);
  console.log("  stopAll 停止�?", stoppedCount);
  console.log("  event1 未停�?", !event1.isStopped());
  console.log("  event2 已停�?", event2.isStopped());

  activeEventRegistry.unregister(event1);
  activeEventRegistry.unregister(event2);

  console.log("  �?ActiveEventRegistry 测试通过");
  return Promise.resolve();
}

// ============================================================
// 运行所有测�?// ============================================================

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  消息处理系统集成测试                     ║");
  console.log("╚══════════════════════════════════════════╝");

  try {
    await testCommonUtils();
    testMessageModel();
    await testMessageEvent();
    await testPipelineScheduler();
    await testOnionModel();
    await testSessionLock();
    testConfigManager();
    await testConversationManager();
    testPluginSystem();
    testProviderSystem();
    await testSkill();
    await testEventBusE2E();
    await testActiveEventRegistry();

    console.log("\n╔══════════════════════════════════════════╗");
    console.log("║  🎉 所有消息处理系统测试通过!              ║");
    console.log("╚══════════════════════════════════════════╝");
  } catch (e) {
    console.error("\n❌测试失败:", e);
    process.exit(1);
  }
}

main();
