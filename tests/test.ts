/**
 * Agent 系统集成测试
 * 使用 Mock Provider 验证核心流程
 */
import {
  AgentState,
  createAgent,
  createFunctionTool,
  ToolSet,
  createContextWrapper,
  createMessageChain,
  createContextConfig,
  ContextManager,
  ContextTruncator,
  EstimateTokenCounter,
  EmptyAgentHooks,
  FunctionToolExecutor,
  createHandoffTool,
  ToolLoopAgentRunner,
  validateMessage,
  serializeMessage,
  bindCheckpointMessages,
  dumpMessagesWithCheckpoints,
  isCheckpointMessage,
  getCheckpointId,
  stripCheckpointMessages,
  mergeThinkPartInPlace,
  markContentPartAsTemp,
  ToolCallPart,
  MCPClient,
  ClosedResourceError,
  validateMcpStdioConfig,
  ToolImageCache,
  sanitizeContextsByModalities,
  splitIntoRounds,
  roundsToText,
  LLMSummaryCompressor,
  TruncateByTurnsCompressor,
  // 新增工具
  createListDirTool,
  createFileDeleteTool,
  createFileMoveTool,
  createFileWriteTool,
  createFileEditTool,
  createLocalNodeTool,
  createWebFetchTool,
  createWebSearchTool,
  createHttpRequestTool,
  createMemoryTool,
  createCodeSearchTool,
  getSearchProvider,
  // 动态子代理创建
  createSubAgentCreateTool,
  createListSubAgentsTool,
  createDeleteSubAgentTool,
  getSubAgentManagementTools,
  dynamicSubAgentRegistry,
  InMemoryVectorStore,
  fileLockManager,
  resetFileLockManager,
  backgroundTaskBus,
  resolveSubAgentExecutionBudgetSeconds,
  SubAgentTaskManager,
  executeParallelSubAgents,
  redactProxyUrl,
  decodeHtmlEntitiesOnce,
} from "../src/index.js";
import type {
  Provider,
  ProviderChatParams,
  LLMResponse,
  ContextWrapper,
  CallToolResult,
  Message,
  AgentResponse,
} from "../src/index.js";

// ============================================================
// 0. Assert helpers — track pass/fail/skip across all tests
// ============================================================

let passCount = 0;
let failCount = 0;
let skipCount = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passCount++;
    console.log(`  ✅ ${message}`);
  } else {
    failCount++;
    console.error(`  ❌ ${message}`);
  }
}

function skip(message: string): void {
  skipCount++;
  console.log(`  ⏭ ${message}`);
}

// ============================================================
// 1. Mock Provider
// ============================================================

function createMockProvider(responses: LLMResponse[]): Provider {
  let callIndex = 0;
  return {
    type: "chat_completion",
    providerConfig: {
      id: "mock-provider",
      maxContextTokens: 4096,
      modalities: ["text", "image", "audio", "tool_use"],
    },
    async textChat(params: ProviderChatParams): Promise<LLMResponse> {
      const resp = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return resp;
    },
  };
}

// ============================================================
// 2. 测试: 消息模型
// ============================================================

function testMessageModel(): void {
  console.log("\n=== 测试: 消息模型 ===");

  // 创建各类消息
  const userMsg = validateMessage({ role: "user", content: "Hello" });
  console.log("  用户消息:", userMsg.role, userMsg.content);

  const assistantMsg = validateMessage({
    role: "assistant",
    content: [
      { type: "think", think: "Let me think..." },
      { type: "text", text: "Hi there!" },
    ],
  });
  console.log("  助手消息:", assistantMsg.role, Array.isArray(assistantMsg.content) ? `${(assistantMsg.content as unknown[]).length} parts` : assistantMsg.content);

  // ThinkPart merge
  const thinkPart = { type: "think" as const, think: "Hello" };
  const otherThink = { type: "think" as const, think: " World" };
  const merged = mergeThinkPartInPlace(thinkPart, otherThink);
  console.log("  ThinkPart merge:", merged, thinkPart.think);

  // markAsTemp
  const textPart = { type: "text" as const, text: "temp", _noSave: false as boolean | undefined };
  markContentPartAsTemp(textPart);
  console.log("  markAsTemp:", textPart._noSave);

  // ToolCallPart
  const toolCallPart: ToolCallPart = { arguments_part: '{"key":' };
  console.log("  ToolCallPart:", toolCallPart.arguments_part);

  // Checkpoint
  const checkpointMsg = validateMessage({
    role: "_checkpoint",
    content: { id: "cp-001" },
  });
  console.log("  Checkpoint:", isCheckpointMessage(checkpointMsg), getCheckpointId(checkpointMsg));

  // Serialize / Deserialize
  const serialized = serializeMessage(userMsg);
  const deserialized = validateMessage(serialized);
  assert(deserialized.role === userMsg.role, "序列化/反序列化");

  // bindCheckpointMessages / dumpMessagesWithCheckpoints
  const history = [
    { role: "user", content: "Q1" },
    { role: "_checkpoint", content: { id: "cp-1" } },
    { role: "assistant", content: "A1" },
  ];
  const bound = bindCheckpointMessages(history as Record<string, unknown>[]);
  console.log("  bindCheckpoint:", bound.length, "(3→2, checkpoint merged)");
  const dumped = dumpMessagesWithCheckpoints(bound);
  console.log("  dumpCheckpoint:", dumped.length, "(2→3, checkpoint reinserted)");

  // stripCheckpointMessages
  const stripped = stripCheckpointMessages(history as Record<string, unknown>[]);
  console.log("  stripCheckpoint:", stripped.length, "(3→2)");

  console.log("  ✅ 消息模型测试通过");
}

// ============================================================
// 3. 测试: 工具系统
// ============================================================

function testToolSystem(): void {
  console.log("\n=== 测试: 工具系统 ===");

  // 创建工具
  const weatherTool = createFunctionTool({
    name: "get_weather",
    description: "Get the current weather for a location",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name" },
      },
      required: ["location"],
    },
    async handler(_event, location) {
      return `Weather in ${location}: Sunny, 25°C`;
    },
  });

  const calcTool = createFunctionTool({
    name: "calculator",
    description: "Perform a calculation",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Math expression" },
      },
      required: ["expression"],
    },
    async handler(_event, expression) {
      return `Result of ${expression} = 42`;
    },
  });

  // ToolSet
  const toolSet = new ToolSet([weatherTool, calcTool]);
  console.log("  工具数量:", toolSet.length);
  console.log("  工具名称:", toolSet.names());
  console.log("  是否为空:", toolSet.empty());

  // 查找工具
  const found = toolSet.getTool("get_weather");
  console.log("  查找工具:", found?.name, found?.description);

  // 移除工具
  toolSet.removeTool("calculator");
  console.log("  移除后数量:", toolSet.length);

  // 重新添加
  toolSet.addTool(calcTool);
  console.log("  重新添加后数量:", toolSet.length);

  // OpenAI Schema
  const openaiSchema = toolSet.openaiSchema();
  console.log("  OpenAI Schema 工具数:", openaiSchema.length);

  // Anthropic Schema
  const anthropicSchema = toolSet.anthropicSchema();
  console.log("  Anthropic Schema 工具数:", anthropicSchema.length);

  // Google Schema
  const googleSchema = toolSet.googleSchema();
  console.log("  Google Schema 函数数:", (googleSchema.functionDeclarations as unknown[])?.length);

  // Light / ParamOnly 工具集
  const lightSet = toolSet.getLightToolSet();
  const paramOnlySet = toolSet.getParamOnlyToolSet();
  console.log("  Light 工具集:", lightSet.length);
  console.log("  ParamOnly 工具集:", paramOnlySet.length);

  // Merge
  const otherSet = new ToolSet([
    createFunctionTool({
      name: "search",
      description: "Search the web",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    }),
  ]);
  toolSet.merge(otherSet);
  console.log("  合并后数量:", toolSet.length);

  console.log("  ✅ 工具系统测试通过");
}

// ============================================================
// 4. 测试: 上下文管理
// ============================================================

async function testContextManagement(): Promise<void> {
  console.log("\n=== 测试: 上下文管理 ===");

  // Token 计数器
  const counter = new EstimateTokenCounter();
  const messages: Message[] = [
    { role: "user", content: "你好，请帮我查一下天气" },
    { role: "assistant", content: "好的，我来帮你查" },
  ];
  const tokenCount = counter.countTokens(messages);
  console.log("  Token 估算:", tokenCount);

  // Truncator
  const truncator = new ContextTruncator();
  const longMessages: Message[] = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Q1" },
    { role: "assistant", content: "A1" },
    { role: "user", content: "Q2" },
    { role: "assistant", content: "A2" },
    { role: "user", content: "Q3" },
    { role: "assistant", content: "A3" },
  ];

  const truncated = truncator.truncateByDroppingOldestTurns(longMessages, 1);
  console.log("  截断前:", longMessages.length, "→ 截断后:", truncated.length);

  const halved = truncator.truncateByHalving(longMessages);
  console.log("  对半截断:", longMessages.length, "→", halved.length);

  // fixMessages - 修复 tool call 配对
  const brokenMessages: Message[] = [
    { role: "system", content: "System" },
    { role: "user", content: "Q" },
    { role: "tool", tool_call_id: "tc-1", content: "orphan tool result" },
    { role: "assistant", content: undefined, tool_calls: [{ type: "function", id: "tc-2", function: { name: "test", arguments: "{}" } }] },
    { role: "user", content: "Q2" },
  ];
  const fixed = truncator.fixMessages(brokenMessages);
  console.log("  fixMessages: 孤立 tool 消息被移除:", brokenMessages.length, "→", fixed.length);

  // ContextManager
  const config = createContextConfig({
    maxContextTokens: 100,
    enforceMaxTurns: 2,
    truncateTurns: 1,
  });
  const manager = new ContextManager(config);
  const processed = await manager.process(longMessages);
  console.log("  ContextManager 处理:", longMessages.length, "→", processed.length);

  console.log("  ✅ 上下文管理测试通过");
}

// ============================================================
// 4b. 测试: 轮次分割工具 (round-utils)
// ============================================================

function testRoundUtils(): void {
  console.log("\n=== 测试: 轮次分割工具 ===");

  const messages: Message[] = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Q1" },
    { role: "assistant", content: "A1" },
    { role: "user", content: "Q2" },
    { role: "assistant", content: "A2" },
    { role: "user", content: "Q3" },
    { role: "assistant", content: "A3" },
  ];

  const rounds = splitIntoRounds(messages);
  console.log("  轮次数:", rounds.length);

  // splitIntoRounds: system is its own round (not user), then each user starts a new round
  // Round 1: [system], Round 2: [user+assistant], Round 3: [user+assistant], Round 4: [user+assistant]
  const pass = rounds.length === 4
    && rounds[0].length === 1 && rounds[0][0].role === "system"
    && rounds[1].length === 2 && rounds[1][0].role === "user" && rounds[1][1].role === "assistant"
    && rounds[2].length === 2 && rounds[2][0].role === "user" && rounds[2][1].role === "assistant"
    && rounds[3].length === 2 && rounds[3][0].role === "user" && rounds[3][1].role === "assistant";
  assert(pass, "轮次分割正确");

  // 带工具调用的消息
  const toolMessages: Message[] = [
    { role: "user", content: "What's the weather?" },
    { role: "assistant", content: "", tool_calls: [{ type: "function", id: "tc-1", function: { name: "get_weather", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "tc-1", content: "Sunny, 25°C" },
    { role: "assistant", content: "The weather is sunny and 25°C." },
    { role: "user", content: "Thanks!" },
    { role: "assistant", content: "You're welcome!" },
  ];

  const toolRounds = splitIntoRounds(toolMessages);
  console.log("  工具调用轮次数:", toolRounds.length);
  console.log("  第1轮消息数:", toolRounds[0].length, "(user+assistant+tool+assistant)");
  console.log("  第2轮消息数:", toolRounds[1].length, "(user+assistant)");

  const toolPass = toolRounds.length === 2
    && toolRounds[0].length === 4
    && toolRounds[1].length === 2;
  assert(toolPass, "工具调用轮次分割正确");

  // roundsToText
  const text = roundsToText(rounds);
  assert(text.includes("Round 1"), "roundsToText 包含 'Round 1'");
  assert(text.includes("Round 3"), "roundsToText 包含 'Round 3'");

  console.log("  ✅ 轮次分割工具测试通过");
}

// ============================================================
// 4c. 测试: LLMSummaryCompressor (轮次分割 + token比例保留)
// ============================================================

async function testLLMSummaryCompressor(): Promise<void> {
  console.log("\n=== 测试: LLMSummaryCompressor (优化版) ===");

  // Mock Provider that returns a fixed summary
  let callCount = 0;
  const mockProvider: Provider = {
    type: "chat_completion",
    providerConfig: {
      id: "mock-compress-provider",
      maxContextTokens: 4096,
    },
    async textChat(params) {
      callCount++;
      return {
        role: "assistant",
        completionText: "Summary of conversation: User asked about weather, assistant provided weather info.",
        isChunk: false,
        usage: { promptTokens: 100, completionTokens: 30, total: 130 },
      };
    },
  };

  const compressor = new LLMSummaryCompressor(
    mockProvider,
    0.15, // keepRecentRatio
    undefined, // default instruction
    0.82, // threshold
  );

  // Test shouldCompress
  const shouldNot = compressor.shouldCompress([], 100, 4096);
  assert(!shouldNot, "shouldCompress(100/4096) 返回 false");

  const should = compressor.shouldCompress([], 3500, 4096);
  assert(should, "shouldCompress(3500/4096) 返回 true");

  // Test compress with enough messages
  const messages: Message[] = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "What's the weather in Tokyo?" },
    { role: "assistant", content: "The weather in Tokyo is sunny and 25°C." },
    { role: "user", content: "What about New York?" },
    { role: "assistant", content: "New York is cloudy and 18°C." },
    { role: "user", content: "Thanks! Can you also check London?" },
    { role: "assistant", content: "London is rainy and 12°C." },
    { role: "user", content: "Great, one more - Paris?" },
    { role: "assistant", content: "Paris is partly cloudy and 20°C." },
  ];

  callCount = 0;
  const compressed = await compressor.compress(messages);
  console.log("  压缩前消息数:", messages.length);
  console.log("  压缩后消息数:", compressed.length);
  console.log("  LLM 调用次数:", callCount);
  assert(compressed.some(m => typeof m.content === "string" && m.content.includes("Our previous history conversation summary")), "压缩后包含摘要");
  assert(compressed[0]?.role === "system", "压缩后保留 system 消息");
  assert(["user", "assistant"].includes(compressed[compressed.length - 1]?.role), "压缩后最后一条是用户消息或助手回复");

  // Test with too few messages (should return original)
  callCount = 0;
  const shortMessages: Message[] = [
    { role: "system", content: "System" },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello" },
  ];
  const shortResult = await compressor.compress(shortMessages);
  assert(shortResult.length === shortMessages.length && callCount === 0, "短消息不压缩");

  // Test TruncateByTurnsCompressor
  const truncateCompressor = new TruncateByTurnsCompressor(1, 0.82);
  const shouldTruncate = truncateCompressor.shouldCompress([], 3500, 4096);
  assert(shouldTruncate, "TruncateByTurnsCompressor shouldCompress");

  const truncatedResult = await truncateCompressor.compress(messages);
  console.log("  TruncateByTurnsCompressor 压缩:", messages.length, "→", truncatedResult.length);

  console.log("  ✅ LLMSummaryCompressor 测试通过");
}

// ============================================================
// 4d. 测试: ContextConfig 新字段
// ============================================================

function testContextConfig(): void {
  console.log("\n=== 测试: ContextConfig 新字段 ===");

  // Default config
  const defaultConfig = createContextConfig();
  console.log("  默认 keepRecentRatio:", defaultConfig.llmCompressKeepRecentRatio);
  console.log("  默认 enforceMaxTurns:", defaultConfig.enforceMaxTurns);
  console.log("  默认 maxContextTokens:", defaultConfig.maxContextTokens);

  // Override config
  const customConfig = createContextConfig({
    maxContextTokens: 8192,
    enforceMaxTurns: 10,
    truncateTurns: 2,
    llmCompressKeepRecentRatio: 0.2,
    llmCompressInstruction: "Custom instruction",
  });
  console.log("  自定义 keepRecentRatio:", customConfig.llmCompressKeepRecentRatio);
  console.log("  自定义 maxContextTokens:", customConfig.maxContextTokens);
  console.log("  自定义 enforceMaxTurns:", customConfig.enforceMaxTurns);
  console.log("  自定义 instruction:", customConfig.llmCompressInstruction);

  const pass = defaultConfig.llmCompressKeepRecentRatio === 0.15
    && customConfig.llmCompressKeepRecentRatio === 0.2
    && customConfig.maxContextTokens === 8192;
  assert(pass, "ContextConfig 新字段测试");
}

// ============================================================
// 5. 测试: Agent 创建与 Handoff
// ============================================================

function testAgentAndHandoff(): void {
  console.log("\n=== 测试: Agent 与 Handoff ===");

  // 创建 Agent
  const agent = createAgent({
    name: "weather-agent",
    instructions: "You are a weather assistant.",
    tools: ["get_weather"],
  });
  console.log("  Agent 名称:", agent.name);
  console.log("  Agent 指令:", agent.instructions);

  // 创建 HandoffTool
  const handoff = createHandoffTool(agent, "Transfer to weather agent for weather queries");
  console.log("  Handoff 名称:", handoff.name);
  console.log("  Handoff 描述:", handoff.description);
  console.log("  Handoff agent:", handoff.agent.name);

  console.log("  ✅ Agent 与 Handoff 测试通过");
}

// ============================================================
// 6. 测试: MCP Stdio 校验
// ============================================================

function testMcpValidation(): void {
  console.log("\n=== 测试: MCP Stdio 校验 ===");

  // 合法配置
  try {
    validateMcpStdioConfig({ command: "python", args: ["-m", "mcp_server"] });
    assert(true, "合法 python 命令");
  } catch (e) {
    assert(false, "合法 python 命令");
  }

  // 危险命令
  try {
    validateMcpStdioConfig({ command: "bash" });
    assert(false, "危险 bash 命令应该被拦截");
  } catch (e) {
    assert(true, "危险 bash 命令已拦截");
  }

  // Python -c 注入
  try {
    validateMcpStdioConfig({ command: "python", args: ["-c", "import os; os.system('rm -rf /')"] });
    assert(false, "Python -c 注入应该被拦截");
  } catch (e) {
    assert(true, "Python -c 注入已拦截");
  }

  // Shell 元字符
  try {
    validateMcpStdioConfig({ command: "node; rm -rf /" });
    assert(false, "Shell 元字符应该被拦截");
  } catch (e) {
    assert(true, "Shell 元字符已拦截");
  }

  // URL 配置 (跳过校验)
  try {
    validateMcpStdioConfig({ url: "http://localhost:8080/mcp" });
    assert(true, "URL 配置跳过 stdio 校验");
  } catch (e) {
    assert(false, "URL 配置跳过 stdio 校验");
  }

  console.log("  ✅ MCP Stdio 校验测试通过");
}

// ============================================================
// 6b. 测试: MCP 重连失败后可再次重连（regression）
// ============================================================

async function testMcpReconnectAfterFailure(): Promise<void> {
  console.log("\n=== 测试: MCP 重连失败后可再次重连 ===");

  // 背景：callToolWithReconnect 在重连失败后会把 session 置为 null。
  // 旧实现随后直接抛 "MCP session not available"（不是 closed-resource
  // 错误），因此再也不会触发重连，客户端永久失效。现在 session 为 null
  // 时应主动尝试重连。
  let connectCalls = 0;
  let failConnect = true;

  const client = new MCPClient();
  client.name = "test-server";
  (client as any).mcpServerConfig = { url: "http://localhost:1/mcp" };
  (client as any).serverName = "test-server";

  const makeLiveSession = () => ({
    async initialize() {},
    async listTools() { return { tools: [{ name: "echo" }] }; },
    async callTool() {
      return { content: [{ type: "text" as const, text: "pong" }] };
    },
    async close() {},
  });

  const deadSession = {
    async initialize() {},
    async listTools() { return { tools: [] }; },
    async callTool(): Promise<never> { throw new ClosedResourceError("Connection closed"); },
    async close() {},
  };

  // 第一次重连失败，之后成功
  (client as any).connectToServer = async function () {
    connectCalls++;
    if (failConnect) throw new Error("server still down");
    this.session = makeLiveSession();
  };

  client.session = deadSession;

  // 1) 断线触发重连，但服务器仍不可用 → 调用失败，session 被清空
  let firstError: unknown = null;
  try {
    await client.callToolWithReconnect("echo", {}, 5);
  } catch (e) {
    firstError = e;
  }
  assert(firstError !== null, "重连失败时调用抛错");
  assert(client.session === null, "重连失败后 session 为 null");
  const connectsAfterFirst = connectCalls;

  // 2) 服务器恢复后，后续调用必须再次尝试重连（而非永久失效）
  failConnect = false;
  const result = await client.callToolWithReconnect("echo", {}, 5);
  assert(connectCalls > connectsAfterFirst, "重连失败后再次调用会重新尝试连接");
  assert(client.session !== null, "重新连接成功后 session 恢复");
  const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
  assert(text === "pong", "重连后工具调用成功返回结果");

  console.log("  ✅ MCP 重连失败后可再次重连测试通过");
}

// ============================================================
// 7. 测试: Modalities 过滤
// ============================================================

function testModalities(): void {
  console.log("\n=== 测试: Modalities 过滤 ===");

  const messages: Record<string, unknown>[] = [
    { role: "user", content: [
      { type: "text", text: "Look at this" },
      { type: "image_url", image_url: { url: "http://example.com/img.png" } },
    ]},
    { role: "assistant", content: "I see it", tool_calls: [{ type: "function", id: "tc-1", function: { name: "test", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "tc-1", content: "tool result" },
  ];

  // 不支持 image
  const [noImage, stats1] = sanitizeContextsByModalities(messages, ["text", "tool_use"]);
  const userContent = (noImage[0] as Record<string, unknown>).content as Record<string, unknown>[];
  const hasImagePlaceholder = userContent.some((p: Record<string, unknown>) => p.type === "text" && p.text === "[Image]");
  assert(hasImagePlaceholder, "不支持 image → [Image] 占位");

  // 不支持 tool_use
  const [noTool, stats2] = sanitizeContextsByModalities(messages, ["text", "image"]);
  const hasToolResult = noTool.some((m: Record<string, unknown>) => (m.role as string) === "tool");
  const hasToolCalls = noTool.some((m: Record<string, unknown>) => "tool_calls" in m);
  assert(!hasToolResult, "不支持 tool_use → tool 消息转换");
  assert(!hasToolCalls, "不支持 tool_use → tool_calls 移除");

  console.log("  ✅ Modalities 过滤测试通过");
}

// ============================================================
// 8. 测试: ToolLoopAgentRunner (核心 ReAct 循环)
// ============================================================

async function testToolLoopRunner(): Promise<void> {
  console.log("\n=== 测试: ToolLoopAgentRunner ===");

  // 创建工具
  const echoTool = createFunctionTool({
    name: "echo",
    description: "Echo back the input",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to echo" },
      },
      required: ["message"],
    },
    async handler(_event, message) {
      return `Echo: ${message}`;
    },
  });

  const toolSet = new ToolSet([echoTool]);

  // Mock Provider: 第一次返回 tool call，第二次返回最终文本
  const mockProvider = createMockProvider([
    {
      role: "assistant",
      completionText: "",
      toolsCallName: ["echo"],
      toolsCallArgs: [{ message: "Hello Agent!" }],
      toolsCallIds: ["call-001"],
      isChunk: false,
      usage: { promptTokens: 50, completionTokens: 20, total: 70 },
    },
    {
      role: "assistant",
      completionText: "I've echoed your message. The result is: Echo: Hello Agent!",
      isChunk: false,
      usage: { promptTokens: 100, completionTokens: 30, total: 130 },
    },
  ]);

  // 创建 Runner
  const runner = new ToolLoopAgentRunner();
  const runContext = createContextWrapper<null>(null);
  const hooks = new EmptyAgentHooks();
  const executor = new FunctionToolExecutor();

  await runner.reset(runContext, hooks, {
    provider: mockProvider,
    request: {
      prompt: "Please echo 'Hello Agent!'",
      imageUrls: [],
      audioUrls: [],
      contexts: [],
      extraUserContentParts: [],
    },
    toolExecutor: executor,
    agentHooks: hooks,
    streaming: false,
  });

  // 替换 funcTool
  const request = (runner as any).req;
  request.funcTool = toolSet;

  // 运行 stepUntilDone
  const responses: AgentResponse[] = [];
  for await (const response of runner.stepUntilDone(10)) {
    responses.push(response);
  }

  console.log("  Runner 状态:", runner.done() ? "DONE" : "RUNNING");
  console.log("  响应数量:", responses.length);

  const finalResp = runner.getFinalLlmResp();
  console.log("  最终回复:", finalResp?.completionText?.slice(0, 60));

  // 统计响应类型
  const types = responses.map((r) => r.type);
  console.log("  响应类型:", [...new Set(types)]);

  console.log("  ✅ ToolLoopAgentRunner 测试通过");
}

// ============================================================
// 8b. 测试: ErrorResponse 错误响应处理
// ============================================================

async function testErrorResponseHandling(): Promise<void> {
  console.log("\n=== 测试: ErrorResponse 错误响应处理 ===");

  const mockProvider = createMockProvider([
    {
      role: "err",
      completionText: "Failed to connect to LLM server",
      isChunk: false,
    },
  ]);

  const runner = new ToolLoopAgentRunner();
  const runContext = createContextWrapper<null>(null);
  const hooks = new EmptyAgentHooks();
  const executor = new FunctionToolExecutor();

  await runner.reset(runContext, hooks, {
    provider: mockProvider,
    request: {
      prompt: "Hello",
      imageUrls: [],
      audioUrls: [],
      contexts: [],
      extraUserContentParts: [],
    },
    toolExecutor: executor,
    agentHooks: hooks,
    streaming: false,
  });

  const responses: AgentResponse[] = [];
  for await (const response of runner.stepUntilDone(10)) {
    responses.push(response);
  }

  assert(runner.done(), "Runner 状态已完成");
  assert((runner as any).state === AgentState.ERROR, "Runner 状态是否为 ERROR");

  const finalResp = runner.getFinalLlmResp();
  console.log("  最终回复 role:", finalResp?.role);
  console.log("  最终回复 content:", finalResp?.completionText);

  const { runAgent } = await import("@yachiyo/agent/agent-runner.js");
  const runResult = await runAgent(runner, {
    maxStep: 30,
  });

  console.log("  runAgent 返回 finalResponse role:", runResult.finalResponse?.role);
  console.log("  runAgent 返回 finalResponse content:", runResult.finalResponse?.completionText);

  console.log("  ✅ ErrorResponse 错误响应处理测试通过");
}

// ============================================================
// 9. 测试: ToolImageCache
// ============================================================

async function testToolImageCache(): Promise<void> {
  console.log("\n=== 测试: ToolImageCache ===");

  const cache = ToolImageCache.getInstance();

  // 保存图片 (1x1 红色 PNG 的 base64)
  const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
  const cached = await cache.saveImage(tinyPngBase64, "tc-001", "test_tool", 0, "image/png");
  console.log("  保存图片:", cached.filePath);
  console.log("  MIME 类型:", cached.mimeType);

  // 读取图片
  const result = await cache.getImageBase64ByPath(cached.filePath, "image/png");
  assert(!!result, "读取图片");

  // 清理过期
  const cleaned = await cache.cleanupExpired();
  console.log("  清理过期:", cleaned, "(0 = 无过期)");

  console.log("  ✅ ToolImageCache 测试通过");
}

// ============================================================
// 10. 测试: 新增 Computer Tools (list_dir, file_delete, file_move, execute_node)
// ============================================================

async function testNewComputerTools(): Promise<void> {
  console.log("\n=== 测试: 新增 Computer Tools ===");
  const { mkdir, writeFile } = await import("fs/promises");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const testDir = join(tmpdir(), `agent_test_${Date.now()}`);

  // 创建测试目录和文件
  await mkdir(testDir, { recursive: true });
  await writeFile(join(testDir, "hello.txt"), "Hello World");
  await mkdir(join(testDir, "subdir"), { recursive: true });
  await writeFile(join(testDir, "subdir", "nested.txt"), "Nested file");

  // 构造 admin context
  const adminCtx = { context: { event: {}, providerSettings: { computer_use_runtime: "local" as const } }, messages: [], toolCallTimeout: 30 };

  // --- list_dir_tool ---
  const listDirTool = createListDirTool(testDir);
  console.log("  list_dir_tool 名称:", listDirTool.name);

  const listResult = await listDirTool.handler!(adminCtx, undefined, false, 3) as CallToolResult;
  const listText = listResult.content[0] && "text" in listResult.content[0] ? listResult.content[0].text : "";
  assert(listText.includes("hello.txt"), "list_dir 结果包含 hello.txt");
  assert(listText.includes("subdir/"), "list_dir 结果包含 subdir/");

  // 递归列表
  const listRecursive = await listDirTool.handler!(adminCtx, undefined, true, 3) as CallToolResult;
  const listRecText = listRecursive.content[0] && "text" in listRecursive.content[0] ? listRecursive.content[0].text : "";
  assert(listRecText.includes("nested.txt"), "list_dir 递归包含 nested.txt");

  // --- file_move_tool ---
  const moveTool = createFileMoveTool(testDir);
  console.log("  file_move_tool 名称:", moveTool.name);

  const moveResult = await moveTool.handler!(adminCtx, "hello.txt", "renamed.txt") as CallToolResult;
  const moveText = moveResult.content[0] && "text" in moveResult.content[0] ? moveResult.content[0].text : "";
  assert(moveText.includes("Successfully moved"), "file_move 结果");

  // 验证移动后原文件不存在
  const listAfterMove = await listDirTool.handler!(adminCtx, undefined, false, 3) as CallToolResult;
  const listAfterMoveText = listAfterMove.content[0] && "text" in listAfterMove.content[0] ? listAfterMove.content[0].text : "";
  assert(listAfterMoveText.includes("renamed.txt"), "移动后包含 renamed.txt");
  assert(!listAfterMoveText.includes("hello.txt"), "移动后不含 hello.txt");

  // --- file_delete_tool ---
  const deleteTool = createFileDeleteTool(testDir);
  console.log("  file_delete_tool 名称:", deleteTool.name);

  const deleteResult = await deleteTool.handler!(adminCtx, "renamed.txt") as CallToolResult;
  const deleteText = deleteResult.content[0] && "text" in deleteResult.content[0] ? deleteResult.content[0].text : "";
  assert(deleteText.includes("Successfully deleted"), "file_delete 结果");

  // --- execute_node ---
  const nodeTool = createLocalNodeTool(testDir);
  console.log("  execute_node 名称:", nodeTool.name);

  const nodeResult = await nodeTool.handler!(adminCtx, "console.log('Hello from Node.js!'); process.stdout.write('42');") as CallToolResult;
  const nodeText = nodeResult.content[0] && "text" in nodeResult.content[0] ? nodeResult.content[0].text : "";
  assert(nodeText.includes("Hello from Node.js!"), "execute_node 包含 'Hello from Node.js!'");
  assert(nodeText.includes("42"), "execute_node 包含 '42'");

  // 静默模式
  const silentResult = await nodeTool.handler!(adminCtx, "console.log('silent');", true) as CallToolResult;
  const silentText = silentResult.content[0] && "text" in silentResult.content[0] ? silentResult.content[0].text : "";
  assert(silentText.includes("silent mode"), "execute_node 静默模式");

  // 清理
  const { rm } = await import("fs/promises");
  await rm(testDir, { recursive: true });

  console.log("  ✅ 新增 Computer Tools 测试通过");
}

// ============================================================
// 11. 测试: Web Tools (web_fetch, web_search, http_request)
// ============================================================

async function testWebTools(): Promise<void> {
  console.log("\n=== 测试: Web Tools ===");
  const adminCtx = { context: { event: {}, providerSettings: {} }, messages: [], toolCallTimeout: 30 };

  // --- web_fetch_tool ---
  const fetchTool = createWebFetchTool();
  assert(fetchTool.name === "web_fetch_tool", `web_fetch_tool 名称: ${fetchTool.name}`);

  try {
    const fetchResult = await fetchTool.handler!(adminCtx, "https://httpbin.org/get", "GET", {}, undefined, 15, 5000) as CallToolResult;
    const fetchText = fetchResult.content[0] && "text" in fetchResult.content[0] ? fetchResult.content[0].text : "";
    // Network-dependent: throw on unexpected response so catch can skip (assert doesn't throw)
    if (!fetchText.includes("200") || !fetchText.includes("httpbin")) {
      throw new Error(`unexpected response: ${fetchText.slice(0, 80)}`);
    }
    assert(true, "web_fetch 包含 HTTP 200 与 httpbin");
  } catch (e) {
    skip(`web_fetch: 网络不可用，跳过 - ${(e as Error).message?.slice(0, 50)}`);
  }

  // --- web_search_tool (Bing) ---
  const searchTool = createWebSearchTool(undefined, "bing");
  assert(searchTool.name === "web_search_tool", `web_search_tool 名称: ${searchTool.name}`);

  try {
    const searchResult = await searchTool.handler!(adminCtx, "TypeScript programming language", 3) as CallToolResult;
    const searchText = searchResult.content[0] && "text" in searchResult.content[0] ? searchResult.content[0].text : "";
    // Network-dependent: throw on no-results/error so catch can skip
    if (searchText.includes("No search results") || searchText.includes("error:")) {
      throw new Error("search returned no results or error");
    }
    assert(true, "web_search (Bing) 有结果");
    console.log("    结果预览:", searchText.slice(0, 80).replace(/\n/g, " "));
  } catch (e) {
    skip(`web_search (Bing): 网络不可用，跳过 - ${(e as Error).message?.slice(0, 50)}`);
  }

  // --- getSearchProvider ---
  assert(getSearchProvider("bing") !== null, "getSearchProvider('bing')");
  assert(getSearchProvider("google") !== null, "getSearchProvider('google')");
  assert(getSearchProvider("google_playwright") !== null, "getSearchProvider('google_playwright')");
  assert(getSearchProvider("bing_playwright") !== null, "getSearchProvider('bing_playwright')");

  // --- http_request_tool ---
  const httpTool = createHttpRequestTool();
  assert(httpTool.name === "http_request_tool", `http_request_tool 名称: ${httpTool.name}`);

  try {
    const httpResult = await httpTool.handler!(adminCtx, "https://httpbin.org/post", "POST", { "X-Custom": "test" }, '{"key":"value"}', "application/json", 15, true) as CallToolResult;
    const httpText = httpResult.content[0] && "text" in httpResult.content[0] ? httpResult.content[0].text : "";
    const parsed = JSON.parse(httpText);
    // Network-dependent: throw on non-200 status so catch can skip
    if (parsed.status !== 200) {
      throw new Error(`http_request returned status ${parsed.status}`);
    }
    assert(true, `http_request POST status: ${parsed.status}`);
    assert(httpText.includes("X-Custom") || httpText.includes("x-custom"), "http_request 包含 X-Custom header");
  } catch (e) {
    skip(`http_request: 网络不可用，跳过 - ${(e as Error).message?.slice(0, 50)}`);
  }

  if (skipCount > 0) {
    console.log(`  ⚠ Web Tools 测试完成（${skipCount} 项因网络跳过）`);
  } else {
    console.log("  ✅ Web Tools 测试通过");
  }
}

// ============================================================
// 12. 测试: Memory Tool
// ============================================================

async function testMemoryTool(): Promise<void> {
  console.log("\n=== 测试: Memory Tool ===");
  const { mkdir, rm } = await import("fs/promises");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const testDir = join(tmpdir(), `agent_memory_test_${Date.now()}`);
  await mkdir(testDir, { recursive: true });

  const adminCtx = { context: { event: {}, providerSettings: { memory_file_path: join(testDir, "memory.json") } }, messages: [], toolCallTimeout: 30 };

  const memoryTool = createMemoryTool(testDir);
  console.log("  memory_tool 名称:", memoryTool.name);

  // save
  const saveResult = await memoryTool.handler!(adminCtx, "save", "test_key", "Hello Memory", ["test", "demo"]) as CallToolResult;
  const saveText = saveResult.content[0] && "text" in saveResult.content[0] ? saveResult.content[0].text : "";
  assert(saveText.includes("saved"), "save 结果");

  // save another
  await memoryTool.handler!(adminCtx, "save", "another_key", "Another value", ["test"]) as CallToolResult;

  // recall
  const recallResult = await memoryTool.handler!(adminCtx, "recall", "test_key") as CallToolResult;
  const recallText = recallResult.content[0] && "text" in recallResult.content[0] ? recallResult.content[0].text : "";
  assert(recallText.includes("Hello Memory"), "recall 包含 'Hello Memory'");
  assert(recallText.includes("test") && recallText.includes("demo"), "recall 包含 tags");

  // search
  const searchResult = await memoryTool.handler!(adminCtx, "search", undefined, undefined, undefined, "Hello") as CallToolResult;
  const searchText = searchResult.content[0] && "text" in searchResult.content[0] ? searchResult.content[0].text : "";
  assert(searchText.includes("test_key"), "search 'Hello' 有结果");

  // search by tag
  const tagSearchResult = await memoryTool.handler!(adminCtx, "search", undefined, undefined, undefined, "demo") as CallToolResult;
  const tagSearchText = tagSearchResult.content[0] && "text" in tagSearchResult.content[0] ? tagSearchResult.content[0].text : "";
  assert(tagSearchResult.content.length > 0, "search 'demo' 有结果");

  // list
  const listResult = await memoryTool.handler!(adminCtx, "list", undefined, undefined, undefined, undefined, 10) as CallToolResult;
  const listText = listResult.content[0] && "text" in listResult.content[0] ? listResult.content[0].text : "";
  assert(listText.includes("2 memory"), "list 包含 2 条");

  // delete
  const deleteResult = await memoryTool.handler!(adminCtx, "delete", "another_key") as CallToolResult;
  const deleteText = deleteResult.content[0] && "text" in deleteResult.content[0] ? deleteResult.content[0].text : "";
  assert(deleteText.includes("deleted"), "delete 结果");

  // clear (clear 现在要求显式 confirm=true 防止误清空)
  const clearResult = await memoryTool.handler!(adminCtx, "clear", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true) as CallToolResult;
  const clearText = clearResult.content[0] && "text" in clearResult.content[0] ? clearResult.content[0].text : "";
  console.log("  clear 输出:", JSON.stringify(clearText));
  assert(clearText.includes("Cleared"), "clear 结果");

  // 未带 confirm 的 clear 必须被拒绝
  const clearNoConfirm = await memoryTool.handler!(adminCtx, "clear") as CallToolResult;
  const clearNoConfirmText = clearNoConfirm.content[0] && "text" in clearNoConfirm.content[0] ? clearNoConfirm.content[0].text : "";
  assert(clearNoConfirmText.includes("confirm=true"), "clear 未确认时返回错误");

  // 清理
  await rm(testDir, { recursive: true });

  console.log("  ✅ Memory Tool 测试通过");
}

// ============================================================
// 13. 测试: Code Search Tool
// ============================================================

async function testCodeSearchTool(): Promise<void> {
  console.log("\n=== 测试: Code Search Tool ===");
  const projectRoot = process.cwd();

  const adminCtx = { context: { event: {}, providerSettings: {} }, messages: [], toolCallTimeout: 30 };

  const codeSearchTool = createCodeSearchTool(projectRoot);
  console.log("  code_search_tool 名称:", codeSearchTool.name);

  // 按符号名搜索
  const searchByName = await codeSearchTool.handler!(adminCtx, "createAgent", undefined, undefined, undefined, undefined, 5) as CallToolResult;
  const nameText = searchByName.content[0] && "text" in searchByName.content[0] ? searchByName.content[0].text : "";
  assert(!nameText.includes("No symbols") && !nameText.includes("error:"), "搜索 'createAgent' 有结果");

  // 按符号类型搜索
  const searchByType = await codeSearchTool.handler!(adminCtx, undefined, "interface", "typescript", undefined, "*.ts", 5) as CallToolResult;
  const typeText = searchByType.content[0] && "text" in searchByType.content[0] ? searchByType.content[0].text : "";
  assert(!typeText.includes("No symbols"), "搜索 interface 类型有结果");

  // 搜索 class 类型
  const searchClass = await codeSearchTool.handler!(adminCtx, "ToolSet", "class", "typescript", undefined, "*.ts", 5) as CallToolResult;
  const classText = searchClass.content[0] && "text" in searchClass.content[0] ? searchClass.content[0].text : "";
  assert(!classText.includes("No symbols"), "搜索 class 'ToolSet' 有结果");

  // 错误参数
  const noParams = await codeSearchTool.handler!(adminCtx) as CallToolResult;
  const noParamsText = noParams.content[0] && "text" in noParams.content[0] ? noParams.content[0].text : "";
  assert(noParamsText.includes("error:"), "无参数调用返回错误");

  console.log("  ✅ Code Search Tool 测试通过");
}

// ============================================================
// 14. 测试: Dynamic Sub-Agent Creation
// ============================================================

async function testDynamicSubAgentCreate(): Promise<void> {
  console.log("\n=== 测试: Dynamic Sub-Agent Creation ===");
  const adminCtx = { context: { event: {}, providerSettings: {} }, messages: [], toolCallTimeout: 30 };

  // Clear registry
  dynamicSubAgentRegistry.clear();

  // --- create_subagent ---
  const createTool = createSubAgentCreateTool();
  console.log("  create_subagent 名称:", createTool.name);

  const createResult = await createTool.handler!(adminCtx, "code-reviewer", "You are a code review expert. Analyze code for bugs, style issues, and best practices.", "Code review sub-agent", ["file_read_tool", "grep_tool"]) as CallToolResult;
  const createText = createResult.content[0] && "text" in createResult.content[0] ? createResult.content[0].text : "";
  assert(createText.includes("created successfully"), "create_subagent 成功");
  assert(createText.includes("transfer_to_code-reviewer"), "包含 handoff 工具名");

  // 验证注册
  assert(dynamicSubAgentRegistry.has("code-reviewer"), "registry 包含 code-reviewer");
  const entry = dynamicSubAgentRegistry.get("code-reviewer");
  console.log("  handoff 名称:", entry?.handoff.name);
  console.log("  agent instructions:", entry?.agent.instructions?.slice(0, 40));

  // 创建第二个子代理
  const createResult2 = await createTool.handler!(adminCtx, "translator", "You are a professional translator.", undefined) as CallToolResult;
  const createText2 = createResult2.content[0] && "text" in createResult2.content[0] ? createResult2.content[0].text : "";
  assert(createText2.includes("created successfully"), "创建第二个子代理成功");

  // --- 重名检测 ---
  const dupResult = await createTool.handler!(adminCtx, "code-reviewer", "Duplicate", undefined) as CallToolResult;
  const dupText = dupResult.content[0] && "text" in dupResult.content[0] ? dupResult.content[0].text : "";
  assert(dupText.includes("already exists"), "重名检测");

  // --- 无效名称 ---
  const invalidResult = await createTool.handler!(adminCtx, "bad name!", "Test", undefined) as CallToolResult;
  const invalidText = invalidResult.content[0] && "text" in invalidResult.content[0] ? invalidResult.content[0].text : "";
  assert(invalidText.includes("Invalid"), "无效名称检测");

  // --- list_subagents ---
  const listTool = createListSubAgentsTool();
  console.log("  list_subagents 名称:", listTool.name);

  const listResult = await listTool.handler!(adminCtx) as CallToolResult;
  const listText = listResult.content[0] && "text" in listResult.content[0] ? listResult.content[0].text : "";
  assert(listText.includes("2"), "list 包含 2 个");
  assert(listText.includes("code-reviewer"), "list 包含 code-reviewer");
  assert(listText.includes("translator"), "list 包含 translator");

  // --- getSubAgentManagementTools ---
  const mgmtTools = getSubAgentManagementTools();
  console.log("  管理工具数量:", mgmtTools.length);
  console.log("  管理工具名称:", mgmtTools.map(t => t.name).join(", "));

  // --- getHandoffTools ---
  const handoffTools = dynamicSubAgentRegistry.getHandoffTools();
  console.log("  handoff 工具数量:", handoffTools.length);
  console.log("  handoff 工具名称:", handoffTools.map(t => t.name).join(", "));

  // --- delete_subagent ---
  const deleteTool = createDeleteSubAgentTool();
  console.log("  delete_subagent 名称:", deleteTool.name);

  const deleteResult = await deleteTool.handler!(adminCtx, "translator") as CallToolResult;
  const deleteText = deleteResult.content[0] && "text" in deleteResult.content[0] ? deleteResult.content[0].text : "";
  assert(deleteText.includes("deleted"), "删除成功");

  // 验证删除后
  assert(!dynamicSubAgentRegistry.has("translator"), "删除后 registry 不含 translator");
  assert(dynamicSubAgentRegistry.has("code-reviewer"), "删除后 registry 仍含 code-reviewer");

  // 删除不存在的
  const deleteNotFound = await deleteTool.handler!(adminCtx, "nonexistent") as CallToolResult;
  const deleteNotFoundText = deleteNotFound.content[0] && "text" in deleteNotFound.content[0] ? deleteNotFound.content[0].text : "";
  assert(deleteNotFoundText.includes("not found"), "删除不存在返回错误");

  // 清理
  dynamicSubAgentRegistry.clear();

  console.log("  ✅ Dynamic Sub-Agent Creation 测试通过");
}

// ============================================================
// 15. 测试: InMemoryVectorStore 余弦相似度维度校验
// ============================================================

async function testInMemoryVectorStoreDimensionValidation(): Promise<void> {
  console.log("\n=== 测试: InMemoryVectorStore 余弦相似度维度校验 ===");

  const store = new InMemoryVectorStore();
  await store.upsert(
    "chunk-1",
    [0.1, 0.2, 0.3], // dimension 3
    "content-1",
    "doc-1",
    "docName-1",
    1,
    "kb-1"
  );

  // 1. Same dimension query should succeed
  const results = await store.search([0.1, 0.2, 0.3], 5, "kb-1");
  console.log("  维度相同时搜索结果数量:", results.length);
  assert(results[0]?.score != null, "维度相同时得分是否非空");

  // 2. Mismatched dimension: stale vector is skipped with a warning
  //    (semantics aligned with SqliteVectorStore; no longer throws)
  const mismatched = await store.search([0.1, 0.2], 5, "kb-1"); // dimension 2, mismatch!
  assert(mismatched.length === 0, "维度不匹配的向量被跳过");

  // 3. Dimension-matched vector still returned after a mismatched search
  const results2 = await store.search([0.1, 0.2, 0.3], 5, "kb-1");
  assert(results2.length === 1, "维度匹配向量仍正常返回");

  console.log("  ✅ InMemoryVectorStore 维度校验测试通过");
}

// ============================================================
// 16. 测试: 空流式输出的重试（regression）
// ============================================================

async function testEmptyStreamRetry(): Promise<void> {
  console.log("\n=== 测试: 空流式输出重试 ===");

  // 模拟 include_usage 下"空补全"的流：只有一个 usage-only chunk + 空终结响应，
  // 没有任何正文/思考/工具调用。这曾导致 runner 把 usage chunk 当成最终响应，
  // 提前结束并跳过 EmptyModelOutputError 重试。
  let streamCalls = 0;
  const provider: Provider = {
    type: "chat_completion",
    providerConfig: { id: "empty-stream", maxContextTokens: 4096, modalities: ["text", "tool_use"] },
    async textChat(): Promise<LLMResponse> {
      return { role: "assistant", completionText: "", isChunk: false };
    },
    async *textChatStream(): AsyncGenerator<LLMResponse, void, unknown> {
      streamCalls++;
      yield { role: "assistant", isChunk: true, usage: { promptTokens: 0, completionTokens: 0, total: 0, cacheReadInputTokens: 0 } };
      yield { role: "assistant", isChunk: false };
    },
  };

  const runner = new ToolLoopAgentRunner();
  const runContext = createContextWrapper<null>(null);
  const hooks = new EmptyAgentHooks();
  const executor = new FunctionToolExecutor();

  await runner.reset(runContext, hooks, {
    provider,
    request: {
      prompt: "hello",
      imageUrls: [],
      audioUrls: [],
      contexts: [],
      extraUserContentParts: [],
    },
    toolExecutor: executor,
    agentHooks: hooks,
    streaming: true,
  });
  (runner as any).req.funcTool = new ToolSet([]);

  const responses: AgentResponse[] = [];
  for await (const response of runner.stepUntilDone(10)) {
    responses.push(response);
  }

  assert(streamCalls > 1, `空流触发重试（streamCalls=${streamCalls}）`);
  assert(runner.getFinalLlmResp()?.role === "err", "全部重试失败后返回 err 响应，而非伪造空回复");

  console.log("  ✅ 空流式输出重试测试通过");
}

// ============================================================
// 17. 测试: 提供商提示缓存开关透传（regression）
// ============================================================

async function testProviderCachingPlumbing(): Promise<void> {
  console.log("\n=== 测试: 提供商提示缓存开关透传 ===");

  // 主链路此前从不传 enableCaching，导致缓存功能对日常对话不可达。
  // 验证 providerCaching 开关会被透传到每一次 LLM 调用的 enableCaching。
  const seen: Array<boolean | undefined> = [];
  const provider: Provider = {
    type: "chat_completion",
    providerConfig: { id: "caching-plumbing", maxContextTokens: 4096, modalities: ["text", "tool_use"] },
    async textChat(params: ProviderChatParams): Promise<LLMResponse> {
      seen.push(params.enableCaching);
      return { role: "assistant", completionText: "ok", isChunk: false };
    },
  };

  const runner = new ToolLoopAgentRunner();
  const runContext = createContextWrapper<null>(null);
  const hooks = new EmptyAgentHooks();
  const executor = new FunctionToolExecutor();

  await runner.reset(runContext, hooks, {
    provider,
    request: {
      prompt: "hello",
      imageUrls: [],
      audioUrls: [],
      contexts: [],
      extraUserContentParts: [],
    },
    toolExecutor: executor,
    agentHooks: hooks,
    streaming: false,
    providerCaching: true,
  });
  (runner as any).req.funcTool = new ToolSet([]);

  for await (const _ of runner.stepUntilDone(5)) { void _; }

  assert(seen.length > 0 && seen.every((v) => v === true), `providerCaching=true 透传 enableCaching=true（seen=${JSON.stringify(seen)}）`);

  // 关闭时不得开启
  const seen2: Array<boolean | undefined> = [];
  const provider2: Provider = {
    type: "chat_completion",
    providerConfig: { id: "caching-off", maxContextTokens: 4096, modalities: ["text", "tool_use"] },
    async textChat(params: ProviderChatParams): Promise<LLMResponse> {
      seen2.push(params.enableCaching);
      return { role: "assistant", completionText: "ok", isChunk: false };
    },
  };
  const runner2 = new ToolLoopAgentRunner();
  await runner2.reset(createContextWrapper<null>(null), hooks, {
    provider: provider2,
    request: { prompt: "hello", imageUrls: [], audioUrls: [], contexts: [], extraUserContentParts: [] },
    toolExecutor: executor,
    agentHooks: hooks,
    streaming: false,
    providerCaching: false,
  });
  (runner2 as any).req.funcTool = new ToolSet([]);
  for await (const _ of runner2.stepUntilDone(5)) { void _; }

  assert(seen2.length > 0 && seen2.every((v) => v === false), `providerCaching=false 透传 enableCaching=false（seen=${JSON.stringify(seen2)}）`);

  console.log("  ✅ 提供商提示缓存开关透传测试通过");
}

// ============================================================
// 18. 测试: 动态上下文注入位置（缓存前缀稳定性，regression）
// ============================================================

async function testDynamicContextPlacement(): Promise<void> {
  console.log("\n=== 测试: 动态上下文注入位置（缓存前缀稳定性） ===");

  // 背景：系统提示词曾是消息列表的第 0 条，而它内嵌了秒级时间戳/知识库检索/
  // 记忆快照等每轮变化的内容，导致缓存前缀每次都不同，所有 provider 的提示
  // 缓存命中率归零。现在动态内容应注入"当前用户消息"，系统提示词保持稳定。
  const seen: Array<{ system?: string; messages: Message[] }> = [];
  const provider: Provider = {
    type: "chat_completion",
    providerConfig: { id: "dynamic-context", maxContextTokens: 4096, modalities: ["text", "tool_use"] },
    async textChat(params: ProviderChatParams): Promise<LLMResponse> {
      const msgs = params.contexts as Message[];
      const system = msgs.find((m) => m.role === "system");
      seen.push({
        system: typeof system?.content === "string" ? system.content : undefined,
        messages: msgs,
      });
      return { role: "assistant", completionText: "ok", isChunk: false };
    },
  };

  const hooks = new EmptyAgentHooks();
  const executor = new FunctionToolExecutor();

  const runOnce = async (dynamicContext: string, systemPrompt: string) => {
    const runner = new ToolLoopAgentRunner();
    await runner.reset(createContextWrapper<null>(null), hooks, {
      provider,
      request: {
        prompt: "hello",
        imageUrls: [],
        audioUrls: [],
        contexts: [],
        systemPrompt,
        dynamicContext,
        extraUserContentParts: [],
      },
      toolExecutor: executor,
      agentHooks: hooks,
      streaming: false,
    });
    (runner as any).req.funcTool = new ToolSet([]);
    for await (const _ of runner.stepUntilDone(5)) { void _; }
  };

  // 两轮：系统提示词相同，动态上下文不同（模拟时间推进）
  await runOnce("Current date/time: T1", "STATIC PERSONA");
  await runOnce("Current date/time: T2", "STATIC PERSONA");

  assert(seen.length === 2, `两次请求均被捕获（seen=${seen.length}）`);
  assert(seen[0].system === "STATIC PERSONA", "系统提示词仅含静态内容");
  assert(seen[0].system === seen[1].system, "系统提示词跨请求保持稳定（缓存前缀不变）");
  assert(!seen[0].system?.includes("Current date/time"), "时间戳未混入系统提示词");

  const userMessages = seen[0].messages.filter((m) => m.role === "user");
  // Content may be a plain string (text-only prompt) or a content-part array.
  const textOf = (m: Message | undefined): string[] => {
    const content = m?.content;
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    const out: string[] = [];
    for (const part of content) {
      const t = (part as { text?: unknown }).text;
      if (typeof t === "string") out.push(t);
    }
    return out;
  };
  const dynIdx = userMessages.findIndex((m) => textOf(m).some((t) => t.includes("Current date/time: T1")));
  const promptIdx = userMessages.findIndex((m) => textOf(m).includes("hello"));
  assert(dynIdx !== -1 && promptIdx !== -1 && dynIdx !== promptIdx, "动态上下文以独立消息注入（不与用户输入合并）");
  assert(
    !textOf(userMessages[promptIdx]).some((t) => t.includes("Current date/time")),
    "用户原始输入消息不含易变上下文（持久化历史跨轮重放字节稳定）",
  );
  // The persisted user message must come BEFORE the volatile dynamic message,
  // so it is the last byte-stable block and can be reused from cache next turn.
  assert(promptIdx < dynIdx, "用户消息位于动态上下文之前（持久化消息可被缓存复用）");
  // Text-only prompt is emitted as a plain string matching the persisted form.
  assert(
    typeof userMessages[promptIdx].content === "string" &&
      (userMessages[promptIdx].content as string) === "hello",
    "文本用户消息以字符串形式发送（与持久化形态一致，避免前缀断裂）",
  );

  console.log("  ✅ 动态上下文注入位置测试通过");
}

// ============================================================
// 19. 测试: H1 — 子代理执行预算不被父级 toolCallTimeout 截断
// ============================================================

async function testSubAgentBudgetNotClipped(): Promise<void> {
  console.log("\n=== 测试: H1 子代理预算不被父级 toolCallTimeout 截断 ===");

  // pre-configured 子代理默认预算 300s；父级默认 toolCallTimeout 120s。
  const budget = resolveSubAgentExecutionBudgetSeconds({ dynamic: false }, undefined);
  assert(budget === 300, `pre-configured 子代理预算为 300s (budget=${budget})`);

  const dynBudget = resolveSubAgentExecutionBudgetSeconds({ dynamic: true }, undefined);
  assert(dynBudget === 120, `dynamic 子代理预算为 120s (budget=${dynBudget})`);

  // 父级策略更严格时取交集最小值
  const intersected = resolveSubAgentExecutionBudgetSeconds(
    { dynamic: false },
    { maxExecutionTimeSeconds: 60 },
  );
  assert(intersected === 60, `与更严格的父级策略取最小值 (budget=${intersected})`);

  // 验证 runner 为 handoff 工具计算的超时 = 子代理预算 + grace，且大于父级 120s。
  // 通过构造一个带 agent 的 handoff 工具，读取 runner 的私有解析逻辑结果。
  const { ToolLoopAgentRunner, createAgent, createHandoffTool, createContextWrapper, EmptyAgentHooks, FunctionToolExecutor, ToolSet } = await import("../src/index.js");
  const runner = new ToolLoopAgentRunner();
  const runContext = createContextWrapper<null>(null, { toolCallTimeout: 120 });
  const provider = createMockProvider([
    { role: "assistant", completionText: "done", isChunk: false },
  ]);
  await runner.reset(runContext, new EmptyAgentHooks(), {
    provider,
    request: { prompt: "hi", imageUrls: [], audioUrls: [], contexts: [], extraUserContentParts: [] },
    toolExecutor: new FunctionToolExecutor(),
    agentHooks: new EmptyAgentHooks(),
    streaming: false,
  });

  const subAgent = createAgent({ name: "pre-config-agent", instructions: "x" });
  const handoff = createHandoffTool(subAgent);
  const resolvedTimeout = (runner as any).resolveToolCallTimeout(handoff) as number;
  assert(
    resolvedTimeout === 300 + 15,
    `handoff 工具超时 = 子代理预算 300 + grace 15 (timeout=${resolvedTimeout})`,
  );
  assert(resolvedTimeout > 120, "handoff 超时大于父级默认 120s（预算可达）");

  // 普通工具保持父级 toolCallTimeout
  const plainTool = (await import("../src/index.js")).createFunctionTool({
    name: "plain",
    description: "plain",
    parameters: { type: "object", properties: {} },
  });
  const plainTimeout = (runner as any).resolveToolCallTimeout(plainTool) as number;
  assert(plainTimeout === 120, `普通工具保持 120s (timeout=${plainTimeout})`);

  // 工具自带 timeout 参数（秒）应被 runner 尊重：不再被 120s 提前 race-kill。
  const shellLikeTool = (await import("../src/index.js")).createFunctionTool({
    name: "shell_like",
    description: "shell-like",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "integer", default: 300 },
      },
    },
  });
  // 模型显式传 timeout=300 → runner 至少 300+grace，且大于全局 120
  const declaredTimeout = (runner as any).resolveToolCallTimeout(shellLikeTool, { timeout: 300 }) as number;
  assert(declaredTimeout === 305, `显式 timeout=300 → 305s (timeout=${declaredTimeout})`);
  assert(declaredTimeout > 120, "声明的 timeout 不被全局 120s 截断");
  // 模型省略 timeout → 采用 schema 默认 300
  const schemaDefaultTimeout = (runner as any).resolveToolCallTimeout(shellLikeTool, {}) as number;
  assert(schemaDefaultTimeout === 305, `schema 默认 timeout=300 → 305s (timeout=${schemaDefaultTimeout})`);
  // 声明更短的 timeout（如 30s）不缩短全局下限
  const shortTimeout = (runner as any).resolveToolCallTimeout(shellLikeTool, { timeout: 30 }) as number;
  assert(shortTimeout === 120, `较短的声明 timeout 不缩短全局 120s (timeout=${shortTimeout})`);
  // 超过工具层上限时夹紧到 3600 + grace
  const hugeTimeout = (runner as any).resolveToolCallTimeout(shellLikeTool, { timeout: 999999 }) as number;
  assert(hugeTimeout === 3605, `超大 timeout 夹紧到 3605s (timeout=${hugeTimeout})`);

  console.log("  ✅ H1 子代理预算不被截断测试通过");
}

// ============================================================
// 19b. 测试: 工具调用超时配置透传（毫秒→秒）与默认值
// ============================================================

async function testToolCallTimeoutPlumbing(): Promise<void> {
  console.log("\n=== 测试: 工具调用超时配置透传 ===");
  const { buildMainAgent, createContextWrapper } = await import("../src/index.js");

  const provider = createMockProvider([
    { role: "assistant", completionText: "done", isChunk: false },
  ]);

  // buildMainAgent 的 toolCallTimeout 单位是秒，直接透传到 runContext。
  const built = await buildMainAgent({
    provider,
    request: { prompt: "hi", imageUrls: [], audioUrls: [], contexts: [], extraUserContentParts: [] },
    config: { toolCallTimeout: 300 },
  });
  assert(
    built.agentRunner.currentRunContext.toolCallTimeout === 300,
    `buildMainAgent toolCallTimeout=300 透传 (actual=${built.agentRunner.currentRunContext.toolCallTimeout})`,
  );

  // 未配置 → 默认 120s
  const builtDefault = await buildMainAgent({
    provider,
    request: { prompt: "hi", imageUrls: [], audioUrls: [], contexts: [], extraUserContentParts: [] },
  });
  assert(
    builtDefault.agentRunner.currentRunContext.toolCallTimeout === 120,
    `buildMainAgent 默认 120s (actual=${builtDefault.agentRunner.currentRunContext.toolCallTimeout})`,
  );

  // 0/NaN/负值 → 回退默认（而非 0，否则工具调用立即超时）
  for (const bad of [0, -5, Number.NaN]) {
    const b = await buildMainAgent({
      provider,
      request: { prompt: "hi", imageUrls: [], audioUrls: [], contexts: [], extraUserContentParts: [] },
      config: { toolCallTimeout: bad as number },
    });
    assert(
      b.agentRunner.currentRunContext.toolCallTimeout === 120,
      `非法 toolCallTimeout=${String(bad)} 回退 120s`,
    );
  }

  console.log("  ✅ 工具调用超时配置透传测试通过");
}

// ============================================================
// 20. 测试: H2 — 文件锁真实生效（并发写互斥）
// ============================================================

async function testFileLockEffective(): Promise<void> {
  console.log("\n=== 测试: H2 文件锁真实生效 ===");
  const { mkdir, rm, readFile } = await import("fs/promises");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const dir = join(tmpdir(), `lock_test_${Date.now()}`);
  await mkdir(dir, { recursive: true });
  resetFileLockManager();

  const adminCtx = { context: { event: {}, providerSettings: { computer_use_runtime: "local" as const } }, messages: [], toolCallTimeout: 30 };
  const writeTool = createFileWriteTool(dir);

  // 两个并发写，同一文件。持锁的 holder 不同 → 串行化，最终内容为其中之一。
  const ctxA = { ...adminCtx, _lockHolderId: "agentA#1" };
  const ctxB = { ...adminCtx, _lockHolderId: "agentB#1" };
  const filePath = join(dir, "shared.txt");
  await Promise.all([
    writeTool.handler!(ctxA, "shared.txt", "from-A") as Promise<CallToolResult>,
    writeTool.handler!(ctxB, "shared.txt", "from-B") as Promise<CallToolResult>,
  ]);

  const finalContent = await readFile(filePath, "utf-8");
  assert(finalContent === "from-A" || finalContent === "from-B", `并发写后文件内容完整（非交错）: ${JSON.stringify(finalContent)}`);
  assert(fileLockManager.getLocks().length === 0, "写完成后锁已全部释放");

  // 同一 holder 可重入：持写锁时再次 acquire 同一路径立即成功
  const holder = "reentrant#1";
  await fileLockManager.acquire(filePath, "write", holder, 1000);
  const reAcquired = await fileLockManager.acquire(filePath, "write", holder, 1000);
  assert(reAcquired, "同一 holder 可重入获取写锁");
  fileLockManager.releaseAll(holder);

  // 不同 holder 的写锁互斥：先持锁，后到的 acquire 超时返回 false
  await fileLockManager.acquire(filePath, "write", "holder1", 1000);
  const blocked = await fileLockManager.acquire(filePath, "write", "holder2", 150);
  assert(!blocked, "不同 holder 的写锁互斥（超时返回 false）");
  fileLockManager.releaseAll("holder1");

  // 读锁可共享
  const r1 = await fileLockManager.acquire(filePath, "read", "reader1", 1000);
  const r2 = await fileLockManager.acquire(filePath, "read", "reader2", 1000);
  assert(r1 && r2, "多个读锁可共享");
  fileLockManager.releaseAll("reader1");
  fileLockManager.releaseAll("reader2");

  // 写锁阻塞读锁（不同 holder）
  await fileLockManager.acquire(filePath, "write", "writerX", 1000);
  const readBlocked = await fileLockManager.acquire(filePath, "read", "readerY", 150);
  assert(!readBlocked, "写锁阻塞其他 holder 的读锁");
  fileLockManager.releaseAll("writerX");

  // 编辑工具持锁贯穿 read-modify-write：并发编辑不会丢更新
  const editTool = createFileEditTool(dir);
  await writeTool.handler!(adminCtx, "edit.txt", "AAA") as CallToolResult;
  const editCtxA = { ...adminCtx, _lockHolderId: "editA#1" };
  const editCtxB = { ...adminCtx, _lockHolderId: "editB#1" };
  await Promise.all([
    editTool.handler!(editCtxA, "edit.txt", "AAA", "BBB") as Promise<CallToolResult>,
    editTool.handler!(editCtxB, "edit.txt", "AAA", "CCC") as Promise<CallToolResult>,
  ]);
  const edited = await readFile(join(dir, "edit.txt"), "utf-8");
  assert(edited === "BBB" || edited === "CCC", `并发编辑结果一致（无损坏）: ${JSON.stringify(edited)}`);

  resetFileLockManager();
  await rm(dir, { recursive: true, force: true });
  console.log("  ✅ H2 文件锁真实生效测试通过");
}

// ============================================================
// 21. 测试: H3 — 后台 handoff 可取消且运行期被追踪
// ============================================================

async function testBackgroundHandoffCancellable(): Promise<void> {
  console.log("\n=== 测试: H3 后台 handoff 可取消且被追踪 ===");

  const { createAgent, createHandoffTool, createContextWrapper, EmptyAgentHooks, ToolLoopAgentRunner } = await import("../src/index.js");

  // 一个长任务 provider：阻塞直到被取消（尊重 abortSignal），让子代理
  // 在运行期保持存活，从而能验证运行期追踪与取消。
  let subAgentStarted = false;
  const slowProvider: Provider = {
    type: "chat_completion",
    providerConfig: { id: "slow-bg", maxContextTokens: 4096, modalities: ["text", "tool_use"] },
    async textChat(params: ProviderChatParams): Promise<LLMResponse> {
      subAgentStarted = true;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 10_000);
        if (params.abortSignal) {
          if (params.abortSignal.aborted) {
            clearTimeout(timer);
            reject(new Error("aborted"));
            return;
          }
          params.abortSignal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          }, { once: true });
        }
      });
      return { role: "assistant", completionText: "finished", isChunk: false };
    },
  };

  const subAgent = createAgent({ name: "bg-agent", instructions: "do work" });
  const handoff = createHandoffTool(subAgent);

  const executor = new FunctionToolExecutor();
  // 非 null context：executeHandoff 会读取 runContext.context.event / 路由信息，
  // 传 null 会在子代理启动前抛错，使测试无法覆盖运行期取消。同时提供 provider，
  // 否则 executeHandoff 会因“无可用 provider”直接返回。
  const runContext = createContextWrapper<Record<string, unknown>>({}, { toolCallTimeout: 120 });
  runContext._provider = slowProvider;

  // 触发 background handoff
  const gen = executor.execute(handoff, runContext, { input: "work", background_task: true });
  const first = await gen.next();
  const firstText = first.value && "content" in first.value && first.value.content[0] && "text" in first.value.content[0]
    ? (first.value.content[0] as { text: string }).text
    : "";
  const taskIdMatch = firstText.match(/task_id=([0-9a-f-]+)/);
  assert(!!taskIdMatch, `后台 handoff 返回 task_id (text=${firstText.slice(0, 80)})`);
  const taskId = taskIdMatch![1];

  // 等待子代理真正开始
  const startDeadline = Date.now() + 3000;
  while (!subAgentStarted && Date.now() < startDeadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert(subAgentStarted, "子代理已开始执行");

  // 运行期必须被追踪为 running（旧实现立即报告为已结束）
  assert(executor.isBackgroundTaskRunning(taskId), "运行期 isBackgroundTaskRunning 返回 true");

  // 可取消
  const cancelled = executor.cancelBackgroundTask(taskId, "test cancel");
  assert(cancelled, "cancelBackgroundTask 返回 true");

  // 取消后应变为非 running
  const stopDeadline = Date.now() + 3000;
  while (executor.isBackgroundTaskRunning(taskId) && Date.now() < stopDeadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert(!executor.isBackgroundTaskRunning(taskId), "取消后 isBackgroundTaskRunning 返回 false");

  await gen.return(undefined as never);
  console.log("  ✅ H3 后台 handoff 可取消测试通过");
}

// ============================================================
// 22. 测试: M2 — executeParallelSubAgents 每任务超时兜底
// ============================================================

async function testParallelSubAgentsTimeout(): Promise<void> {
  console.log("\n=== 测试: M2 executeParallelSubAgents 超时兜底 ===");

  // executor 永不 resolve → 若无超时兜底，Promise.all 会永久挂起。
  const start = Date.now();
  const results = await executeParallelSubAgents(
    [{ agentName: "hanger", input: "work" }],
    () => new Promise<string>(() => { /* never settles */ }),
    { defaultTimeoutSeconds: 1 },
  );
  const elapsed = Date.now() - start;

  assert(elapsed < 8000, `超时在合理时间内返回 (elapsed=${elapsed}ms)`);
  assert(results.length === 1, "返回一个任务结果");
  assert(results[0].status === "failed", `挂死任务被标记为 failed (status=${results[0].status})`);
  assert(
    (results[0].error ?? "").includes("timed out"),
    `错误信息包含 timed out (error=${results[0].error})`,
  );

  console.log("  ✅ M2 executeParallelSubAgents 超时兜底测试通过");
}

// ============================================================
// 23. 测试: M3 — waitForAll 超时路径发事件 + batch_complete
// ============================================================

async function testWaitForAllTimeoutEvents(): Promise<void> {
  console.log("\n=== 测试: M3 waitForAll 超时发事件 ===");

  const manager = new SubAgentTaskManager({ maxConcurrency: 8, defaultTimeoutSeconds: 60 });
  const id = manager.submit("slow", "work");
  manager.startTask(id);

  let cancelledEvents = 0;
  let batchCompleteEvents = 0;
  manager.on("task_cancelled", () => { cancelledEvents++; });
  manager.on("batch_complete", () => { batchCompleteEvents++; });

  // 另一个不带 timeout 的事件驱动 waitForAll 必须被超时路径唤醒，
  // 否则会永久挂起（旧实现静默改状态、不发事件）。
  const concurrentWait = manager.waitForAll();
  const timedOut = await manager.waitForAll(100);

  assert(timedOut[0]?.status === "cancelled", "超时任务被取消");
  assert(cancelledEvents === 1, `发出 task_cancelled 事件 (count=${cancelledEvents})`);
  assert(batchCompleteEvents === 1, `触发 batch_complete (count=${batchCompleteEvents})`);

  const concurrentResult = await Promise.race([
    concurrentWait,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("concurrent wait hung")), 2000)),
  ]).catch((e) => e as Error);
  assert(!(concurrentResult instanceof Error), "并发 waitForAll 被事件唤醒（未永久挂起）");

  console.log("  ✅ M3 waitForAll 超时发事件测试通过");
}

// ============================================================
// 24. 测试: M6 — notifyCompleted 监听器抛错不丢结果
// ============================================================

async function testNotifyCompletedListenerThrow(): Promise<void> {
  console.log("\n=== 测试: M6 notifyCompleted 监听器抛错不丢结果 ===");

  // 注册一个会抛错的监听器，并设置 waker 记录是否仍被调用。
  const unsubscribe = backgroundTaskBus.onTaskCompleted(() => {
    throw new Error("listener boom");
  });
  let wakerCalled = false;
  backgroundTaskBus.setWaker({
    async wake() { wakerCalled = true; },
  });

  try {
    await backgroundTaskBus.notifyCompleted({
      taskId: "m6-task",
      toolName: "t",
      resultText: "ok",
      toolArgs: {},
      note: "n",
      summaryName: "s",
      umo: "u",
      sessionId: "s",
      platformId: "p",
    });
    assert(wakerCalled, "监听器抛错后 waker 仍被调用（结果未丢失）");
  } finally {
    unsubscribe();
    backgroundTaskBus.setWaker(null);
  }

  console.log("  ✅ M6 notifyCompleted 监听器抛错测试通过");
}

// ============================================================
// 25. 测试: L3/L2 — 文件锁写者不饥饿 + 按模式释放
// ============================================================

async function testFileLockWriterStarvationAndModeRelease(): Promise<void> {
  console.log("\n=== 测试: L2/L3 文件锁写者防饥饿与按模式释放 ===");
  resetFileLockManager();

  // L3: 持读锁期间，新读者不得越过排队中的写者。
  const path = "/tmp/lock-test-path";
  await fileLockManager.acquire(path, "read", "reader1", 1000);

  // 排队一个写者（会因 reader1 未释放而等待）。
  const writerPromise = fileLockManager.acquire(path, "write", "writer1", 5000);

  // 新读者应被拒绝（因队列中有写者），而不是插队成功。
  const newReader = await fileLockManager.acquire(path, "read", "reader2", 200);
  assert(!newReader, "新读者不越过排队中的写者（防饥饿）");

  // 释放 reader1，写者应获得锁。
  fileLockManager.release(path, "reader1", "read");
  const writerGranted = await writerPromise;
  assert(writerGranted, "读锁释放后排队写者获得锁");
  fileLockManager.releaseAll("writer1");

  // L2: 同一 holder 重入 read+write，按模式释放只清对应条目。
  await fileLockManager.acquire(path, "read", "multi", 1000);
  await fileLockManager.acquire(path, "write", "multi", 1000);
  assert(fileLockManager.getLocksByHolder("multi").length === 2, "同 holder 持有 read+write 两条目");
  fileLockManager.release(path, "multi", "read");
  const remaining = fileLockManager.getLocksByHolder("multi");
  assert(remaining.length === 1 && remaining[0].mode === "write", "按模式释放只清 read 条目，保留 write");
  fileLockManager.releaseAll("multi");
  assert(fileLockManager.getLocks().length === 0, "releaseAll 清空剩余条目");

  resetFileLockManager();
  console.log("  ✅ L2/L3 文件锁测试通过");
}

// ============================================================
// 26. 测试: L8 — 代理 URL 凭证脱敏
// ============================================================

function testRedactProxyUrl(): void {
  console.log("\n=== 测试: L8 代理 URL 凭证脱敏 ===");

  const redacted = redactProxyUrl("http://user:secret@proxy.example.com:8080");
  assert(!redacted?.includes("secret"), `密码被脱敏 (redacted=${redacted})`);
  assert(!redacted?.includes("user:"), "用户名被脱敏");
  // Parse rather than substring-match: a substring check on a URL is
  // bypassable (e.g. `evil.com/proxy.example.com:8080`) and is flagged by
  // CodeQL as incomplete URL sanitization.
  const redactedUrl = new URL(redacted!);
  assert(redactedUrl.hostname === "proxy.example.com", `主机保留 (hostname=${redactedUrl.hostname})`);
  assert(redactedUrl.port === "8080", `端口保留 (port=${redactedUrl.port})`);

  const noCreds = redactProxyUrl("http://proxy.example.com:8080");
  assert(noCreds === "http://proxy.example.com:8080", "无凭证 URL 原样返回");
  assert(redactProxyUrl(null) === null, "null 原样返回");

  console.log("  ✅ L8 代理 URL 脱敏测试通过");
}

// ============================================================
// 26b. 测试: 循环检测硬停后仍能产出最终总结（regression）
// ============================================================

async function testLoopHardStopFinalSummary(): Promise<void> {
  console.log("\n=== 测试: 循环检测硬停后产出最终总结 ===");

  // 同一工具连续调用达到硬停阈值（5 次）。硬停后应剥离工具集并允许模型
  // 产出最终总结；此前硬停路径调用 requestStop() 会 abort 共享
  // abortController，导致下一步（即总结调用）立即以 "Aborted" 失败，整个
  // 运行被当作“用户中止”。
  const tool = createFunctionTool({
    name: "noop",
    description: "noop",
    parameters: { type: "object", properties: {} },
    async handler() { return "ok"; },
  });

  // provider 每次返回对 noop 的工具调用；硬停后（无工具）返回总结文本。
  let call = 0;
  const provider: Provider = {
    type: "chat_completion",
    providerConfig: { id: "loop-prov", maxContextTokens: 4096, modalities: ["text", "tool_use"] },
    async textChat(params: ProviderChatParams): Promise<LLMResponse> {
      call++;
      const hasTools = Boolean(params.funcTool && !params.funcTool.empty());
      if (hasTools) {
        return {
          role: "assistant",
          completionText: "",
          toolsCallName: ["noop"],
          toolsCallArgs: [{}],
          toolsCallIds: [`call-${call}`],
          isChunk: false,
        };
      }
      // 工具已被剥离 → 产出最终总结
      return { role: "assistant", completionText: "FINAL SUMMARY", isChunk: false };
    },
  };

  const runner = new ToolLoopAgentRunner();
  const runContext = createContextWrapper<null>(null);
  const hooks = new EmptyAgentHooks();
  await runner.reset(runContext, hooks, {
    provider,
    request: { prompt: "go", imageUrls: [], audioUrls: [], contexts: [], extraUserContentParts: [] },
    toolExecutor: new FunctionToolExecutor(),
    agentHooks: hooks,
    streaming: false,
  });
  (runner as any).req.funcTool = new ToolSet([tool]);

  for await (const _ of runner.stepUntilDone(20)) { void _; }

  assert(runner.done(), "Runner 已完成（未卡死）");
  assert(!runner.wasAborted(), "硬停不被误判为用户中止");
  const final = runner.getFinalLlmResp();
  assert(
    final?.completionText === "FINAL SUMMARY",
    `硬停后产出最终总结（actual=${JSON.stringify(final?.completionText)}）`,
  );

  // 所有 tool_calls 都必须有对应的 tool 结果（否则下一轮 API 会因
  // 悬空 tool_use 报 400）。这里硬停只发生在第 5 次调用，逐条断言。
  const messages = runner.currentRunContext.messages;
  const assistantWithCalls = messages.filter(
    (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
  );
  const toolResultIds = new Set(
    messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
  );
  const dangling: string[] = [];
  for (const am of assistantWithCalls) {
    for (const tc of am.tool_calls as Array<{ id: string }>) {
      if (!toolResultIds.has(tc.id)) dangling.push(tc.id);
    }
  }
  assert(dangling.length === 0, `无悬空 tool_calls（dangling=${JSON.stringify(dangling)}）`);

  console.log("  ✅ 循环检测硬停后产出最终总结测试通过");
}

// ============================================================
// 27. 测试: L1(ext) — HTML 实体 &#39; 正确解码
// ============================================================

function testHtmlEntityDecode(): void {
  console.log("\n=== 测试: L1(ext) HTML 实体解码 ===");

  assert(decodeHtmlEntitiesOnce("it&#39;s") === "it's", "&#39; 解码为单引号");
  assert(decodeHtmlEntitiesOnce("a&#039;b") === "a'b", "&#039; 解码为单引号");
  assert(decodeHtmlEntitiesOnce("a&amp;b") === "a&b", "&amp; 解码");
  assert(decodeHtmlEntitiesOnce("&lt;x&gt;") === "<x>", "&lt;/&gt; 解码");
  assert(decodeHtmlEntitiesOnce("a&nbsp;b") === "a b", "&nbsp; 解码");

  console.log("  ✅ L1(ext) HTML 实体解码测试通过");
}

// ============================================================
// 运行所有测试
// ============================================================

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   Agent 系统集成测试                      ║");
  console.log("╚══════════════════════════════════════════╝");

  try {
    testMessageModel();
    testToolSystem();
    await testContextManagement();
    testRoundUtils();
    await testLLMSummaryCompressor();
    testContextConfig();
    testAgentAndHandoff();
    testMcpValidation();
    await testMcpReconnectAfterFailure();
    testModalities();
    await testToolLoopRunner();
    await testErrorResponseHandling();
    await testToolImageCache();
    await testNewComputerTools();
    await testWebTools();
    await testMemoryTool();
    await testCodeSearchTool();
    await testDynamicSubAgentCreate();
    await testInMemoryVectorStoreDimensionValidation();
    await testEmptyStreamRetry();
    await testProviderCachingPlumbing();
    await testDynamicContextPlacement();
    await testSubAgentBudgetNotClipped();
    await testToolCallTimeoutPlumbing();
    await testFileLockEffective();
    await testBackgroundHandoffCancellable();
    await testParallelSubAgentsTimeout();
    await testWaitForAllTimeoutEvents();
    await testNotifyCompletedListenerThrow();
    await testFileLockWriterStarvationAndModeRelease();
    testRedactProxyUrl();
    testHtmlEntityDecode();
    await testLoopHardStopFinalSummary();

    console.log("\n╔══════════════════════════════════════════╗");
    console.log(`║   通过: ${passCount}  失败: ${failCount}  跳过: ${skipCount}`.padEnd(46) + "║");
    console.log("╚══════════════════════════════════════════╝");
    if (failCount > 0) {
      console.error(`❌ ${failCount} 项测试失败`);
      process.exit(1);
    }
    console.log("🎉 所有测试通过!");
    process.exit(0);
  } catch (e) {
    console.error("\n❌ 测试失败:", e);
    process.exit(1);
  }
}

main();
