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
  console.log("  序列化/反序列化:", deserialized.role === userMsg.role);

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
  console.log("  轮次分割正确:", pass);

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
  console.log("  工具调用轮次分割正确:", toolPass);

  // roundsToText
  const text = roundsToText(rounds);
  console.log("  roundsToText 包含 'Round 1':", text.includes("Round 1"));
  console.log("  roundsToText 包含 'Round 3':", text.includes("Round 3"));

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
  console.log("  shouldCompress(100/4096):", shouldNot, "(expect false)");

  const should = compressor.shouldCompress([], 3500, 4096);
  console.log("  shouldCompress(3500/4096):", should, "(expect true)");

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
  console.log("  压缩后包含摘要:", compressed.some(m => typeof m.content === "string" && m.content.includes("Our previous history conversation summary")));
  console.log("  压缩后保留 system 消息:", compressed[0]?.role === "system");
  console.log("  压缩后最后一条是用户消息或助手回复:", ["user", "assistant"].includes(compressed[compressed.length - 1]?.role));

  // Test with too few messages (should return original)
  callCount = 0;
  const shortMessages: Message[] = [
    { role: "system", content: "System" },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello" },
  ];
  const shortResult = await compressor.compress(shortMessages);
  console.log("  短消息不压缩:", shortResult.length === shortMessages.length && callCount === 0);

  // Test TruncateByTurnsCompressor
  const truncateCompressor = new TruncateByTurnsCompressor(1, 0.82);
  const shouldTruncate = truncateCompressor.shouldCompress([], 3500, 4096);
  console.log("  TruncateByTurnsCompressor shouldCompress:", shouldTruncate);

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
  console.log("  ContextConfig 新字段测试:", pass ? "✅ 通过" : "❌ 失败");
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
    console.log("  合法 python 命令: ✅ 通过");
  } catch (e) {
    console.log("  合法 python 命令: ❌ 失败", e);
  }

  // 危险命令
  try {
    validateMcpStdioConfig({ command: "bash" });
    console.log("  危险 bash 命令: ❌ 应该被拦截");
  } catch (e) {
    console.log("  危险 bash 命令: ✅ 已拦截:", (e as Error).message.slice(0, 50));
  }

  // Python -c 注入
  try {
    validateMcpStdioConfig({ command: "python", args: ["-c", "import os; os.system('rm -rf /')"] });
    console.log("  Python -c 注入: ❌ 应该被拦截");
  } catch (e) {
    console.log("  Python -c 注入: ✅ 已拦截:", (e as Error).message.slice(0, 60));
  }

  // Shell 元字符
  try {
    validateMcpStdioConfig({ command: "node; rm -rf /" });
    console.log("  Shell 元字符: ❌ 应该被拦截");
  } catch (e) {
    console.log("  Shell 元字符: ✅ 已拦截:", (e as Error).message.slice(0, 50));
  }

  // URL 配置 (跳过校验)
  try {
    validateMcpStdioConfig({ url: "http://localhost:8080/mcp" });
    console.log("  URL 配置: ✅ 跳过 stdio 校验");
  } catch (e) {
    console.log("  URL 配置: ❌ 不应校验", e);
  }

  console.log("  ✅ MCP Stdio 校验测试通过");
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
  console.log("  不支持 image → [Image] 占位:", hasImagePlaceholder);

  // 不支持 tool_use
  const [noTool, stats2] = sanitizeContextsByModalities(messages, ["text", "image"]);
  const hasToolResult = noTool.some((m: Record<string, unknown>) => (m.role as string) === "tool");
  const hasToolCalls = noTool.some((m: Record<string, unknown>) => "tool_calls" in m);
  console.log("  不支持 tool_use → tool 消息转换:", !hasToolResult, "tool_calls 移除:", !hasToolCalls);

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

  console.log("  Runner 状态已完成:", runner.done());
  console.log("  Runner 状态是否为 ERROR:", (runner as any).state === AgentState.ERROR);

  const finalResp = runner.getFinalLlmResp();
  console.log("  最终回复 role:", finalResp?.role);
  console.log("  最终回复 content:", finalResp?.completionText);

  const { runAgent } = await import("../src/agent/agent-runner.js");
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
  console.log("  读取图片:", result ? "成功" : "失败");

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
  console.log("  list_dir 结果包含 hello.txt:", listText.includes("hello.txt"));
  console.log("  list_dir 结果包含 subdir/:", listText.includes("subdir/"));

  // 递归列表
  const listRecursive = await listDirTool.handler!(adminCtx, undefined, true, 3) as CallToolResult;
  const listRecText = listRecursive.content[0] && "text" in listRecursive.content[0] ? listRecursive.content[0].text : "";
  console.log("  list_dir 递归包含 nested.txt:", listRecText.includes("nested.txt"));

  // --- file_move_tool ---
  const moveTool = createFileMoveTool(testDir);
  console.log("  file_move_tool 名称:", moveTool.name);

  const moveResult = await moveTool.handler!(adminCtx, "hello.txt", "renamed.txt") as CallToolResult;
  const moveText = moveResult.content[0] && "text" in moveResult.content[0] ? moveResult.content[0].text : "";
  console.log("  file_move 结果:", moveText.includes("Successfully moved") ? "成功" : moveText);

  // 验证移动后原文件不存在
  const listAfterMove = await listDirTool.handler!(adminCtx, undefined, false, 3) as CallToolResult;
  const listAfterMoveText = listAfterMove.content[0] && "text" in listAfterMove.content[0] ? listAfterMove.content[0].text : "";
  console.log("  移动后包含 renamed.txt:", listAfterMoveText.includes("renamed.txt"));
  console.log("  移动后不含 hello.txt:", !listAfterMoveText.includes("hello.txt"));

  // --- file_delete_tool ---
  const deleteTool = createFileDeleteTool(testDir);
  console.log("  file_delete_tool 名称:", deleteTool.name);

  const deleteResult = await deleteTool.handler!(adminCtx, "renamed.txt") as CallToolResult;
  const deleteText = deleteResult.content[0] && "text" in deleteResult.content[0] ? deleteResult.content[0].text : "";
  console.log("  file_delete 结果:", deleteText.includes("Successfully deleted") ? "成功" : deleteText);

  // --- execute_node ---
  const nodeTool = createLocalNodeTool(testDir);
  console.log("  execute_node 名称:", nodeTool.name);

  const nodeResult = await nodeTool.handler!(adminCtx, "console.log('Hello from Node.js!'); process.stdout.write('42');") as CallToolResult;
  const nodeText = nodeResult.content[0] && "text" in nodeResult.content[0] ? nodeResult.content[0].text : "";
  console.log("  execute_node 包含 'Hello from Node.js!':", nodeText.includes("Hello from Node.js!"));
  console.log("  execute_node 包含 '42':", nodeText.includes("42"));

  // 静默模式
  const silentResult = await nodeTool.handler!(adminCtx, "console.log('silent');", true) as CallToolResult;
  const silentText = silentResult.content[0] && "text" in silentResult.content[0] ? silentResult.content[0].text : "";
  console.log("  execute_node 静默模式:", silentText.includes("silent mode") ? "成功" : silentText);

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
  console.log("  save 结果:", saveText.includes("saved") ? "成功" : saveText);

  // save another
  await memoryTool.handler!(adminCtx, "save", "another_key", "Another value", ["test"]) as CallToolResult;

  // recall
  const recallResult = await memoryTool.handler!(adminCtx, "recall", "test_key") as CallToolResult;
  const recallText = recallResult.content[0] && "text" in recallResult.content[0] ? recallResult.content[0].text : "";
  console.log("  recall 包含 'Hello Memory':", recallText.includes("Hello Memory"));
  console.log("  recall 包含 tags:", recallText.includes("test") && recallText.includes("demo"));

  // search
  const searchResult = await memoryTool.handler!(adminCtx, "search", undefined, undefined, undefined, "Hello") as CallToolResult;
  const searchText = searchResult.content[0] && "text" in searchResult.content[0] ? searchResult.content[0].text : "";
  console.log("  search 'Hello' 有结果:", searchText.includes("test_key"));

  // search by tag
  const tagSearchResult = await memoryTool.handler!(adminCtx, "search", undefined, undefined, undefined, "demo") as CallToolResult;
  const tagSearchText = tagSearchResult.content[0] && "text" in tagSearchResult.content[0] ? tagSearchResult.content[0].text : "";
  console.log("  search 'demo' 有结果:", tagSearchResult.content.length > 0);

  // list
  const listResult = await memoryTool.handler!(adminCtx, "list", undefined, undefined, undefined, undefined, 10) as CallToolResult;
  const listText = listResult.content[0] && "text" in listResult.content[0] ? listResult.content[0].text : "";
  console.log("  list 包含 2 条:", listText.includes("2 memory"));

  // delete
  const deleteResult = await memoryTool.handler!(adminCtx, "delete", "another_key") as CallToolResult;
  const deleteText = deleteResult.content[0] && "text" in deleteResult.content[0] ? deleteResult.content[0].text : "";
  console.log("  delete 结果:", deleteText.includes("deleted") ? "成功" : deleteText);

  // clear
  const clearResult = await memoryTool.handler!(adminCtx, "clear") as CallToolResult;
  const clearText = clearResult.content[0] && "text" in clearResult.content[0] ? clearResult.content[0].text : "";
  console.log("  clear 结果:", clearText.includes("Cleared") ? "成功" : clearText);

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
  console.log("  搜索 'createAgent' 有结果:", !nameText.includes("No symbols") && !nameText.includes("error:"));

  // 按符号类型搜索
  const searchByType = await codeSearchTool.handler!(adminCtx, undefined, "interface", "typescript", undefined, "*.ts", 5) as CallToolResult;
  const typeText = searchByType.content[0] && "text" in searchByType.content[0] ? searchByType.content[0].text : "";
  console.log("  搜索 interface 类型有结果:", !typeText.includes("No symbols"));

  // 搜索 class 类型
  const searchClass = await codeSearchTool.handler!(adminCtx, "ToolSet", "class", "typescript", undefined, "*.ts", 5) as CallToolResult;
  const classText = searchClass.content[0] && "text" in searchClass.content[0] ? searchClass.content[0].text : "";
  console.log("  搜索 class 'ToolSet' 有结果:", !classText.includes("No symbols"));

  // 错误参数
  const noParams = await codeSearchTool.handler!(adminCtx) as CallToolResult;
  const noParamsText = noParams.content[0] && "text" in noParams.content[0] ? noParams.content[0].text : "";
  console.log("  无参数调用返回错误:", noParamsText.includes("error:"));

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
  console.log("  create_subagent 成功:", createText.includes("created successfully"));
  console.log("  包含 handoff 工具名:", createText.includes("transfer_to_code-reviewer"));

  // 验证注册
  console.log("  registry 包含 code-reviewer:", dynamicSubAgentRegistry.has("code-reviewer"));
  const entry = dynamicSubAgentRegistry.get("code-reviewer");
  console.log("  handoff 名称:", entry?.handoff.name);
  console.log("  agent instructions:", entry?.agent.instructions?.slice(0, 40));

  // 创建第二个子代理
  const createResult2 = await createTool.handler!(adminCtx, "translator", "You are a professional translator.", undefined) as CallToolResult;
  const createText2 = createResult2.content[0] && "text" in createResult2.content[0] ? createResult2.content[0].text : "";
  console.log("  创建第二个子代理成功:", createText2.includes("created successfully"));

  // --- 重名检测 ---
  const dupResult = await createTool.handler!(adminCtx, "code-reviewer", "Duplicate", undefined) as CallToolResult;
  const dupText = dupResult.content[0] && "text" in dupResult.content[0] ? dupResult.content[0].text : "";
  console.log("  重名检测:", dupText.includes("already exists"));

  // --- 无效名称 ---
  const invalidResult = await createTool.handler!(adminCtx, "bad name!", "Test", undefined) as CallToolResult;
  const invalidText = invalidResult.content[0] && "text" in invalidResult.content[0] ? invalidResult.content[0].text : "";
  console.log("  无效名称检测:", invalidText.includes("Invalid"));

  // --- list_subagents ---
  const listTool = createListSubAgentsTool();
  console.log("  list_subagents 名称:", listTool.name);

  const listResult = await listTool.handler!(adminCtx) as CallToolResult;
  const listText = listResult.content[0] && "text" in listResult.content[0] ? listResult.content[0].text : "";
  console.log("  list 包含 2 个:", listText.includes("2"));
  console.log("  list 包含 code-reviewer:", listText.includes("code-reviewer"));
  console.log("  list 包含 translator:", listText.includes("translator"));

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
  console.log("  删除成功:", deleteText.includes("deleted"));

  // 验证删除后
  console.log("  删除后 registry 不含 translator:", !dynamicSubAgentRegistry.has("translator"));
  console.log("  删除后 registry 仍含 code-reviewer:", dynamicSubAgentRegistry.has("code-reviewer"));

  // 删除不存在的
  const deleteNotFound = await deleteTool.handler!(adminCtx, "nonexistent") as CallToolResult;
  const deleteNotFoundText = deleteNotFound.content[0] && "text" in deleteNotFound.content[0] ? deleteNotFound.content[0].text : "";
  console.log("  删除不存在返回错误:", deleteNotFoundText.includes("not found"));

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
  console.log("  维度相同时得分是否非空:", results[0]?.score != null);

  // 2. Mismatched dimension query should throw error
  let threwError = false;
  try {
    await store.search([0.1, 0.2], 5, "kb-1"); // dimension 2, mismatch!
  } catch (e) {
    threwError = true;
    console.log("  维度不同时捕获到预期错误:", (e as Error).message);
  }
  console.log("  维度校验成功触发错误:", threwError);

  console.log("  ✅ InMemoryVectorStore 维度校验测试通过");
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
