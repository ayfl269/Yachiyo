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
import { FunctionToolManager } from "@yachiyo/agent/func-tool-manager.js";

// C-20 fix: global assert mechanism for CI pass/fail detection
let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passCount++;
    console.log(`  ✅ ${message}`);
  } else {
    failCount++;
    console.error(`  ❌ ${message}`);
  }
}

// ============================================================
// 1. 测试: 通用工具层通用工具�?// ============================================================
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
  assert(condResolved, "Condition after notify");

  // generateId
  const id1 = generateId();
  const id2 = generateId();
  assert(id1 !== id2, "generateId unique");
  assert(id1.length > 0, "generateId format");

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
  assert(span.spanId.length > 0, "TraceSpan spanId");

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
  assert(result.isLlmResult() === false, "EventResult isLlmResult (initial)");
  assert(result.isStopped() === false, "EventResult isStopped (initial)");

  result.stopEvent();
  assert(result.isStopped(), "EventResult after stop");

  const llmResult = new EventResult()
    .plain("LLM response")
    .setResultContentType(ResultContentType.LLM_RESULT);
  assert(llmResult.isLlmResult(), "EventResult isLlmResult (after set)");

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
  assert(event.isPrivateChat() === false, "isPrivateChat (group message)");
  assert(event.isWakeUp() === false, "isWakeUp");

  // setResult / getResult
  event.setResult("Hello response");
  console.log("  getResult plainText:", event.getResult()?.getPlainText());

  // stopEvent / isStopped
  assert(event.isStopped() === false, "isStopped (before)");
  event.stopEvent();
  assert(event.isStopped(), "isStopped (after stop)");
  event.continueEvent();
  assert(event.isStopped() === false, "isStopped (after continue)");

  // extras
  event.setExtra("test_key", "test_value");
  console.log("  getExtra:", event.getExtra("test_key"));
  console.log("  getExtra default:", event.getExtra("missing", "fallback"));

  // skipLlm
  event.setSkipLlm(true);
  assert(event.skipLlm === true, "skipLlm");

  // send
  await event.send([{ type: ComponentType.Plain, text: "response", toDict() { return {}; } } as any]);
  assert(sentMessages.length === 1, "send called");

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
  assert(executionLog[0] === "init:Stage1", "初始化顺序正确");
  assert(executionLog[3] === "process:Stage1", "处理顺序正确");

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
  assert(executionLog.length === 1 && executionLog[0] === "stop-stage", "stopEvent 阻止后续阶段");

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
  assert(log.join(",") === "A:pre,B:pre,inner,B:post,A:post", "洋葱模型正确");

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
  assert(!acquired2, "第二次获取等待中");

  // Release first lock
  release1();
  const release2 = await acquire2Promise;
  assert(acquired2, "释放后第二次获取成功");

  release2();

  // Different sessions should not block each other
  const release3 = await lockManager.acquireLock("session-2");
  const release4 = await lockManager.acquireLock("session-3");
  assert(true, "不同会话不互");
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
  assert(confInfo.id === "cfg-1", "未知会话获取默认配置");

  console.log("  �?ConfigManager 测试通过");
}

// ============================================================
// 8. 测试: ConversationManager + InMemoryConversationStore
// ============================================================
async function testConversationManager(): Promise<void> {
  console.log("\n=== 测试: ConversationManager ===");

  const store = new InMemoryConversationStore();
  await store.initialize();

  const manager = new ConversationManager(store);
  const umo = "webchat:FriendMessage:user-1";

  // New conversation
  const convId = await manager.newConversation(umo, {
    platformId: "webchat",
    title: "Test Conversation",
  });
  assert(convId.length > 0, "新建对话 id");

  // Get conversation
  const conv = await manager.getConversation(umo, convId);
  console.log("  获取对话:", conv?.title);
  console.log("  对话历史初始:", conv?.history);

  // Update conversation
  await manager.updateConversation(umo, convId, {
    history: JSON.stringify([{ role: "user", content: "Hello" }]),
  });
  const updated = await manager.getConversation(umo, convId);
  assert(updated?.history?.includes("Hello") === true, "更新后历史包含 Hello");

  // Test truncation in addMessagePair
  manager.setMaxHistoryMessages(3);
  await manager.addMessagePair(umo, "Hello 1", "Reply 1");
  await manager.addMessagePair(umo, "Hello 2", "Reply 2");
  const truncatedConv = await manager.getConversation(umo, convId);
  const truncatedHistory = JSON.parse(truncatedConv?.history || "[]");
  console.log("  截断后历史消息数:", truncatedHistory.length);
  assert(truncatedHistory.length === 3, "截断正确 (应该为 3)");
  assert(truncatedHistory[1].content === "Hello 2", "保留的消息包括 Hello 2");

  // Get current conversation id
  console.log("  当前对话 id:", await manager.getCurrConversationId(umo));

  // InMemoryStore initialized at the start of the test

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
  assert(found.length === 1, "Registry 查找 handler");
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
  assert(cmdFilter.filter(mockEvent, {}) === true, "CommandFilter 匹配");

  const regexFilter = new RegexFilter(/^\/hello/);
  assert(regexFilter.filter(mockEvent, {}) === true, "RegexFilter 匹配");

  const noMatchFilter = new CommandFilter("/goodbye");
  assert(!noMatchFilter.filter(mockEvent, {}), "CommandFilter 不匹配");

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
  assert(pluginManager.getAllStars().length === 1, "PluginManager stars");

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
  assert(manager.providerInsts.length === 0, "ProviderManager 初始 provider 数");
  assert(manager.getUsingProvider(ProviderType.CHAT_COMPLETION) === null, "ProviderManager getUsingProvider (空)");

  // STTProvider stub
  class MockSTTProvider extends STTProvider {
    async getText(audioUrl: string): Promise<string> {
      return "transcribed text";
    }
  }
  const stt = new MockSTTProvider();
  assert(stt.getText("http://audio.mp3") instanceof Promise, "STTProvider getText returns Promise");

  // TTSProvider stub
  class MockTTSProvider extends TTSProvider {
    async getAudio(text: string): Promise<string> {
      return "/tmp/audio.wav";
    }
  }
  const tts = new MockTTSProvider();
  assert(tts.supportStream() === false, "TTSProvider supportStream");

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
  assert(skills.length === 1, "SkillManager skills count");
  assert(skillManager.listSkills({ activeOnly: true }).length === 1, "SkillManager activeOnly count");

  // buildSkillsPrompt
  const prompt = buildSkillsPrompt(skills);
  assert(prompt.includes("code-review"), "buildSkillsPrompt 包含 code-review");

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

  assert(processedEvents.length === 1, "处理的事件数");
  assert(processedEvents[0] === "E2E test message", "处理的消息");
  assert(event.getResult()?.getPlainText() === "Response: E2E test message", "事件结果");

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
  // Note: MessageEvent.base unifiedMsgOrigin returns "single:user:session"
  // so stopAll must use that key, not a constructed "test:FriendMessage:s1".
  const stopKey = event1.unifiedMsgOrigin; // "single:user:session"
  const stoppedCount = activeEventRegistry.stopAll(stopKey, event1);
  console.log("  stopAll 停止数:", stoppedCount);
  assert(!event1.isStopped(), "event1 未停止");
  assert(event2.isStopped(), "event2 已停止");

  activeEventRegistry.unregister(event1);
  activeEventRegistry.unregister(event2);

  console.log("  ✅ ActiveEventRegistry 测试通过");
  return Promise.resolve();
}

// ============================================================
// 12b. 测试: EventBus 错误保护
// ============================================================
async function testEventBusErrorProtection(): Promise<void> {
  console.log("\n=== 测试: EventBus 错误保护 ===");

  const assertAndThrow = (cond: boolean, msg: string) => {
    assert(cond, msg);
    if (!cond) throw new Error(msg);
  };

  const eventQueue = new AsyncQueue<MessageEvent>();
  let schedulerExecuteCalled = 0;
  let schedulerExecuteThrown = 0;

  // Mock scheduler that throws when execute is called
  class ErrorThrowingScheduler extends PipelineScheduler {
    constructor() {
      super({} as any);
    }
    async initialize() {}
    async execute(event: MessageEvent): Promise<void> {
      schedulerExecuteCalled++;
      if (event.getMessageStr() === "throw-execution") {
        schedulerExecuteThrown++;
        throw new Error("Execution failed intentionally");
      }
    }
  }

  const errorScheduler = new ErrorThrowingScheduler();
  const schedulerMapping = new Map<string, PipelineScheduler>();
  schedulerMapping.set("good-config", errorScheduler);

  // Mock config manager that throws on a specific message
  let configGetConfInfoCalled = 0;
  const configManager = {
    getConfInfo(umo: string) {
      configGetConfInfoCalled++;
      if (umo.includes("throw-config")) {
        throw new Error("ConfigManager failed intentionally");
      }
      return { id: "good-config" };
    }
  };

  const eventBus = new EventBus(eventQueue, schedulerMapping, configManager);

  // Start the event bus
  const busPromise = eventBus.dispatch();

  // Create mock events
  class TestEvent extends MessageEvent {
    async send(): Promise<void> {}
    async sendStreaming(): Promise<void> {}
  }

  const platformMsg = new PlatformMessage();
  platformMsg.type = MessageType.FRIEND_MESSAGE;
  platformMsg.selfId = "bot";
  platformMsg.messageId = "m1";
  platformMsg.sender = { userId: "u1", nickname: "Test" };
  platformMsg.timestamp = Date.now();

  const event1 = new TestEvent(
    "throw-execution",
    { ...platformMsg, messageStr: "throw-execution" } as any,
    { name: "test", id: "test" } as any,
    "s1"
  );

  const event2 = new TestEvent(
    "throw-config",
    { ...platformMsg, messageStr: "throw-config" } as any,
    { name: "test", id: "test" } as any,
    "throw-config"
  );
  Object.defineProperty(event2, "unifiedMsgOrigin", {
    get() {
      return "throw-config";
    }
  });

  const event3 = new TestEvent(
    "normal",
    { ...platformMsg, messageStr: "normal" } as any,
    { name: "test", id: "test" } as any,
    "s2"
  );

  // 1. Put event1 (throws in execute) into queue
  eventQueue.put(event1);

  // 2. Put event2 (throws in getConfInfo) into queue
  eventQueue.put(event2);

  // 3. Put event3 (normal execution) into queue
  eventQueue.put(event3);

  // Wait a short time for event loop processing
  await new Promise(resolve => setTimeout(resolve, 100));

  console.log("  configManager.getConfInfo 递交次数:", configGetConfInfoCalled);
  console.log("  scheduler.execute 调用次数:", schedulerExecuteCalled);
  console.log("  scheduler.execute 故意抛错次数:", schedulerExecuteThrown);

  assertAndThrow(configGetConfInfoCalled === 3, "Config manager should have been queried 3 times");
  assertAndThrow(schedulerExecuteCalled === 2, "Scheduler execute should have been called 2 times");
  assertAndThrow(schedulerExecuteThrown === 1, "Scheduler execute should have intentionally thrown 1 time");

  // Stop the event bus
  eventBus.stop();
  // Put a dummy event to wake up eventQueue.get() to allow loop termination
  eventQueue.put(null as any);
  await busPromise;

  console.log("  ✅ EventBus 错误保护测试通过");
}

// ============================================================
// 运行所有测试
// ============================================================

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
    await testEventBusErrorProtection();
    await testActiveEventRegistry();

    console.log("\n╔══════════════════════════════════════════╗");
    console.log(`║   通过: ${passCount}  失败: ${failCount}`.padEnd(46) + "║");
    console.log("╚══════════════════════════════════════════╝");
    if (failCount > 0) {
      console.error(`❌ ${failCount} 项测试失败`);
      process.exit(1);
    }
    console.log("🎉 所有消息处理系统测试通过!");
  } catch (e) {
    console.error("\n❌测试失败:", e);
    process.exit(1);
  }
}

main();
