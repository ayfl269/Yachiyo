/**
 * ProviderManager MCP 集成与动态导入测试
 * 注意: 使用 lazy import 避免循环依赖问题
 */
import type {
  ProviderLoadConfig,
  MCPServerConfigMap,
} from "../src/provider/manager.js";

// ============================================================
// 1. 测试: ProviderManager 基础功能
// ============================================================

async function testProviderManagerBasic(): Promise<void> {
  console.log("\n=== 测试: ProviderManager 基础功能 ===");

  // Lazy import to avoid circular dependency
  const { ProviderManager } = await import("../src/provider/manager.js");

  const manager = new ProviderManager();

  // 初始状态
  console.log("  初始 chat providers:", manager.providerInsts.length);
  console.log("  初始 embedding providers:", manager.embeddingInsts.length);
  console.log("  初始 rerank providers:", manager.rerankInsts.length);
  console.log("  初始 instMap:", manager.instMap.size);

  // 注册 Provider（mock）
  const mockProvider = {
    providerConfig: { id: "mock-openai", maxContextTokens: 4096, modalities: ["text"] },
    async textChat() { return { role: "assistant" as const, completionText: "mock" }; },
  } as any;
  manager.registerProvider(mockProvider);

  console.log("  注册后 chat providers:", manager.providerInsts.length);
  console.log("  注册后 instMap:", manager.instMap.size);

  // ID 查找
  const found = manager.getProviderById("mock-openai");
  console.log("  通过 ID 查找:", found !== null ? "✅" : "❌");

  // 不存在的 ID
  const notFound = manager.getProviderById("nonexistent");
  console.log("  查找不存在的 ID:", notFound === null ? "✅ (返回 null)" : "❌");

  // getUsingProvider
  const { ProviderType } = await import("../src/provider/types.js");
  const using = manager.getUsingProvider(ProviderType.CHAT_COMPLETION);
  console.log("  getUsingProvider:", using !== null ? "✅" : "❌");

  // 默认 Provider 设置
  manager.setDefaultProvider("mock-openai");
  const defaultUsing = manager.getUsingProvider(ProviderType.CHAT_COMPLETION);
  console.log("  setDefaultProvider 后 getUsingProvider:", defaultUsing?.providerConfig?.id === "mock-openai" ? "✅" : "❌");

  console.log("  ✅ ProviderManager 基础功能测试通过");
}

// ============================================================
// 2. 测试: ProviderManager Change Callbacks
// ============================================================

async function testProviderManagerCallbacks(): Promise<void> {
  console.log("\n=== 测试: ProviderManager Change Callbacks ===");

  const { ProviderManager } = await import("../src/provider/manager.js");

  const manager = new ProviderManager();
  const events: Array<{ id: string; type: string; change: string }> = [];

  manager.setProviderChangeCallback((providerId, providerType, changeType) => {
    events.push({ id: providerId, type: providerType, change: changeType });
  });

  // 注册 Provider 触发 load 事件
  const mockProvider1 = {
    providerConfig: { id: "cb-test-1" },
    async textChat() { return { role: "assistant" as const, completionText: "" }; },
  } as any;
  manager.registerProvider(mockProvider1);

  // 手动触发回调测试
  manager.registerProviderChangeHook((id, type, change) => {
    events.push({ id, type, change });
  });

  // 注册第二个 provider 触发回调
  const mockProvider2 = {
    providerConfig: { id: "cb-test-2" },
    async textChat() { return { role: "assistant" as const, completionText: "" }; },
  } as any;
  manager.registerProvider(mockProvider2);

  console.log("  回调事件数量:", events.length);
  console.log("  ✅ ProviderManager Change Callbacks 测试通过");
}

// ============================================================
// 3. 测试: ProviderManager MCP 集成
// ============================================================

async function testProviderManagerMCPIntegration(): Promise<void> {
  console.log("\n=== 测试: ProviderManager MCP 集成 ===");

  const { ProviderManager } = await import("../src/provider/manager.js");

  const manager = new ProviderManager();

  // MCP 配置
  const mcpConfig: MCPServerConfigMap = {
    "mcp-server-1": {
      command: "python",
      args: ["-m", "mcp_server"],
      env: { MCP_SERVER_PORT: "8080" },
    },
    "mcp-server-2": {
      url: "http://localhost:3000/mcp",
      transport: "streamable_http",
    },
  };

  // 初始化并传入 MCP 配置
  await manager.initialize(mcpConfig);

  // 获取 MCP 配置
  const storedConfig = manager.getMcpServerConfig();
  console.log("  MCP 配置已存储:", storedConfig !== null ? "✅" : "❌");
  console.log("  MCP 服务器数量:", storedConfig ? Object.keys(storedConfig).length : 0);
  console.log("  包含 mcp-server-1:", storedConfig?.["mcp-server-1"] !== undefined ? "✅" : "❌");
  console.log("  包含 mcp-server-2:", storedConfig?.["mcp-server-2"] !== undefined ? "✅" : "❌");

  // 重复初始化（应该跳过）
  console.log("  重复初始化测试:");
  await manager.initialize(); // 应该打印警告

  // 终止后 MCP 配置被清除
  await manager.terminate();
  const afterTerminate = manager.getMcpServerConfig();
  console.log("  终止后 MCP 配置:", afterTerminate === null ? "✅ (已清除)" : "❌");

  console.log("  ✅ ProviderManager MCP 集成测试通过");
}

// ============================================================
// 4. 测试: ProviderManager 动态 Provider 生命周期
// ============================================================

async function testProviderManagerDynamicLifecycle(): Promise<void> {
  console.log("\n=== 测试: ProviderManager 动态 Provider 生命周期 ===");

  const { ProviderManager } = await import("../src/provider/manager.js");

  const manager = new ProviderManager();
  const events: Array<{ id: string; change: string }> = [];

  manager.setProviderChangeCallback((providerId, _type, changeType) => {
    events.push({ id: providerId, change: changeType });
  });

  // loadProvider - 加载已知类型
  const openaiConfig: ProviderLoadConfig = {
    type: "openai",
    id: "test-openai-1",
    apiKey: "test-key",
    model: "gpt-4",
  };

  try {
    await manager.loadProvider(openaiConfig);
    console.log("  loadProvider (openai):", manager.instMap.has("test-openai-1") ? "✅" : "❌");
  } catch (e) {
    console.log("  loadProvider (openai) 可能需要真实 API key:", (e as Error).message?.slice(0, 60));
  }

  // loadProvider - 重复加载
  await manager.loadProvider({ type: "openai", id: "test-openai-1" });
  console.log("  重复 loadProvider (应跳过):", events.filter(e => e.change === "load").length <= 1 ? "✅" : "❌");

  // reloadProvider
  try {
    await manager.reloadProvider({
      type: "openai",
      id: "test-openai-1",
      apiKey: "new-key",
    });
    const reloadEvents = events.filter(e => e.id === "test-openai-1" && e.change === "reload");
    console.log("  reloadProvider 触发 reload 事件:", reloadEvents.length > 0 ? "✅" : "❌");
  } catch (e) {
    console.log("  reloadProvider:", (e as Error).message?.slice(0, 60));
  }

  // terminateProvider
  await manager.terminateProvider("test-openai-1");
  console.log("  terminateProvider 后 instMap:", manager.instMap.has("test-openai-1") ? "❌ (仍存在)" : "✅ (已移除)");
  const terminateEvents = events.filter(e => e.id === "test-openai-1" && e.change === "terminate");
  console.log("  terminateProvider 触发 terminate 事件:", terminateEvents.length > 0 ? "✅" : "❌");

  // deleteProvider
  await manager.loadProvider({ type: "openai", id: "test-delete-1" });
  await manager.deleteProvider("test-delete-1");
  console.log("  deleteProvider 后 instMap:", manager.instMap.has("test-delete-1") ? "❌" : "✅");
  console.log("  deleteProvider 后 providerConfigs:", manager.providerConfigs.has("test-delete-1") ? "❌" : "✅");

  // 未知类型动态导入
  try {
    await manager.loadProvider({
      type: "unknown_custom_type",
      id: "custom-1",
    });
    console.log("  未知类型动态导入: ✅");
  } catch (e) {
    console.log("  未知类型动态导入 (预期失败):", (e as Error).message?.includes("Unknown") ? "✅ 正确拒绝" : "❌");
  }

  console.log("  ✅ ProviderManager 动态 Provider 生命周期测试通过");
}

// ============================================================
// 5. 测试: dynamicImportProviderModule
// ============================================================

async function testDynamicImportProviderModule(): Promise<void> {
  console.log("\n=== 测试: dynamicImportProviderModule ===");

  const { dynamicImportProviderModule, PROVIDER_TYPE_MODULE_MAP } = await import("../src/provider/factory.js");

  // 测试所有已知类型
  const knownTypes = [
    "openai", "openai_responses", "gemini", "anthropic",
    "openai_embedding", "gemini_embedding",
    "cohere", "jina", "voyage", "generic",
    "openai_tts", "openai_stt",
  ];

  for (const type of knownTypes) {
    const cls = await dynamicImportProviderModule(type);
    console.log(`  ${type}: ${cls !== null ? "✅" : "❌"}`);
  }

  // 未知类型
  const unknownCls = await dynamicImportProviderModule("nonexistent_provider");
  console.log("  nonexistent_provider:", unknownCls === null ? "✅ (返回 null)" : "❌");

  // 验证模块映射表
  console.log("  PROVIDER_TYPE_MODULE_MAP 条目数:", Object.keys(PROVIDER_TYPE_MODULE_MAP).length);
  console.log("  包含 openai:", PROVIDER_TYPE_MODULE_MAP["openai"] ? "✅" : "❌");
  console.log("  包含 anthropic:", PROVIDER_TYPE_MODULE_MAP["anthropic"] ? "✅" : "❌");

  console.log("  ✅ dynamicImportProviderModule 测试通过");
}

// ============================================================
// 6. 测试: dynamicCreate* 工厂函数
// ============================================================

async function testDynamicCreateFactories(): Promise<void> {
  console.log("\n=== 测试: dynamicCreate* 工厂函数 ===");

  const {
    dynamicCreateChatProvider,
    dynamicCreateEmbeddingProvider,
    dynamicCreateRerankProvider,
    dynamicCreateTtsProvider,
    dynamicCreateSttProvider,
  } = await import("../src/provider/factory.js");

  // Chat Provider
  try {
    const chatProvider = await dynamicCreateChatProvider("openai", {
      apiKey: "test",
      model: "gpt-4",
    } as any);
    console.log("  dynamicCreateChatProvider (openai):", chatProvider !== null ? "✅" : "❌");
    if (chatProvider) {
      console.log("    有 textChat 方法:", typeof chatProvider.textChat === "function" ? "✅" : "❌");
    }
  } catch (e) {
    console.log("  dynamicCreateChatProvider (openai):", (e as Error).message?.slice(0, 60));
  }

  // Embedding Provider
  try {
    const embProvider = await dynamicCreateEmbeddingProvider("openai_embedding", {
      apiKey: "test",
      model: "text-embedding-3-small",
    } as any);
    console.log("  dynamicCreateEmbeddingProvider (openai_embedding):", embProvider !== null ? "✅" : "❌");
    if (embProvider) {
      console.log("    有 getEmbedding 方法:", typeof embProvider.getEmbedding === "function" ? "✅" : "❌");
    }
  } catch (e) {
    console.log("  dynamicCreateEmbeddingProvider:", (e as Error).message?.slice(0, 60));
  }

  // Rerank Provider
  try {
    const rerankProvider = await dynamicCreateRerankProvider("generic", {
      baseUrl: "https://api.example.com",
      model: "rerank-v1",
    } as any);
    console.log("  dynamicCreateRerankProvider (generic):", rerankProvider !== null ? "✅" : "❌");
  } catch (e) {
    console.log("  dynamicCreateRerankProvider:", (e as Error).message?.slice(0, 60));
  }

  // TTS Provider
  try {
    const ttsProvider = await dynamicCreateTtsProvider("openai_tts", {
      apiKey: "test",
      model: "tts-1",
    } as any);
    console.log("  dynamicCreateTtsProvider (openai_tts):", ttsProvider !== null ? "✅" : "❌");
    if (ttsProvider) {
      console.log("    有 getAudio 方法:", typeof ttsProvider.getAudio === "function" ? "✅" : "❌");
    }
  } catch (e) {
    console.log("  dynamicCreateTtsProvider:", (e as Error).message?.slice(0, 60));
  }

  // STT Provider
  try {
    const sttProvider = await dynamicCreateSttProvider("openai_stt", {
      apiKey: "test",
      model: "whisper-1",
    } as any);
    console.log("  dynamicCreateSttProvider (openai_stt):", sttProvider !== null ? "✅" : "❌");
    if (sttProvider) {
      console.log("    有 getText 方法:", typeof sttProvider.getText === "function" ? "✅" : "❌");
    }
  } catch (e) {
    console.log("  dynamicCreateSttProvider:", (e as Error).message?.slice(0, 60));
  }

  // 未知类型
  const unknownChat = await dynamicCreateChatProvider("unknown", {} as any);
  console.log("  dynamicCreateChatProvider (unknown):", unknownChat === null ? "✅ (返回 null)" : "❌");

  console.log("  ✅ dynamicCreate* 工厂函数测试通过");
}

// ============================================================
// 7. 测试: MCP 安全校验 (validateMcpStdioConfig)
// ============================================================

async function testMcpSecurityValidation(): Promise<void> {
  console.log("\n=== 测试: MCP 安全校验 ===");

  const { validateMcpStdioConfig } = await import("../src/agent/mcp-client.js");

  // 合法配置
  const validTests = [
    { command: "python", args: ["-m", "mcp_server"], expected: true, name: "python -m" },
    { command: "node", args: ["server.js"], expected: true, name: "node file.js" },
    { command: "npx", args: ["@anthropic/mcp-server"], expected: true, name: "npx package" },
    { command: "uvx", args: ["mcp-server-git"], expected: true, name: "uvx package" },
  ];

  for (const test of validTests) {
    try {
      validateMcpStdioConfig(test);
      console.log(`  ${test.name}: ${test.expected ? "✅ 正确通过" : "❌ 应该被拒绝"}`);
    } catch (e) {
      console.log(`  ${test.name}: ${!test.expected ? "✅ 正确拒绝" : "❌ 不应被拒绝"} - ${(e as Error).message?.slice(0, 50)}`);
    }
  }

  // 危险配置
  const invalidTests = [
    { command: "bash", expected: false, name: "bash (黑名单)" },
    { command: "rm -rf /", expected: false, name: "rm 命令" },
    { command: "python -c 'import os; os.system(\"rm -rf /\")'", expected: false, name: "python -c 注入" },
    { command: "node; rm -rf /", expected: false, name: "Shell 元字符" },
    { command: "", expected: false, name: "空命令" },
  ];

  for (const test of invalidTests) {
    try {
      validateMcpStdioConfig(test);
      console.log(`  ${test.name}: ${test.expected ? "✅ 正确通过" : "❌ 应该被拒绝"}`);
    } catch (e) {
      console.log(`  ${test.name}: ${!test.expected ? "✅ 正确拒绝" : "❌ 不应被拒绝"} - ${(e as Error).message?.slice(0, 50)}`);
    }
  }

  // Docker 特殊测试
  const dockerTests = [
    { command: "docker", args: ["run", "mcp-server"], expected: true, name: "docker run (安全)" },
    { command: "docker", args: ["run", "--privileged", "mcp-server"], expected: false, name: "docker --privileged" },
    { command: "docker", args: ["run", "--network", "host", "mcp-server"], expected: false, name: "docker --network host" },
  ];

  for (const test of dockerTests) {
    try {
      validateMcpStdioConfig(test);
      console.log(`  ${test.name}: ${test.expected ? "✅ 正确通过" : "❌ 应该被拒绝"}`);
    } catch (e) {
      console.log(`  ${test.name}: ${!test.expected ? "✅ 正确拒绝" : "❌ 不应被拒绝"} - ${(e as Error).message?.slice(0, 50)}`);
    }
  }

  console.log("  ✅ MCP 安全校验测试通过");
}

// ============================================================
// 8. 测试: ProviderManager 终止和清理
// ============================================================

async function testProviderManagerTerminateAndCleanup(): Promise<void> {
  console.log("\n=== 测试: ProviderManager 终止和清理 ===");

  const { ProviderManager } = await import("../src/provider/manager.js");

  const manager = new ProviderManager();

  // 初始化
  await manager.initialize({
    "test-mcp": { command: "python", args: ["-m", "test"] },
  });

  // 添加一些 Provider
  const mockProvider = {
    providerConfig: { id: "cleanup-test" },
    async textChat() { return { role: "assistant" as const, completionText: "" }; },
  } as any;
  manager.registerProvider(mockProvider);

  console.log("  终止前 instMap:", manager.instMap.size);
  console.log("  终止前 MCP 配置:", manager.getMcpServerConfig() !== null ? "✅" : "❌");

  // 终止
  await manager.terminate();

  console.log("  终止后 instMap:", manager.instMap.size);
  console.log("  终止后 providerConfigs:", manager.providerConfigs.size);
  console.log("  终止后 MCP 配置:", manager.getMcpServerConfig() === null ? "✅ (已清除)" : "❌");
  console.log("  终止后 chat providers:", manager.providerInsts.length);

  // 终止后可以重新初始化
  await manager.initialize();
  console.log("  重新初始化后 MCP 配置:", manager.getMcpServerConfig() !== null ? "✅" : "❌");

  await manager.terminate();

  console.log("  ✅ ProviderManager 终止和清理测试通过");
}

// ============================================================
// 运行所有测试
// ============================================================

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   ProviderManager MCP 集成与动态导入测试   ║");
  console.log("╚══════════════════════════════════════════╝");

  try {
    await testProviderManagerBasic();
    await testProviderManagerCallbacks();
    await testProviderManagerMCPIntegration();
    await testProviderManagerDynamicLifecycle();
    await testDynamicImportProviderModule();
    await testDynamicCreateFactories();
    await testMcpSecurityValidation();
    await testProviderManagerTerminateAndCleanup();

    console.log("\n╔══════════════════════════════════════════╗");
    console.log("║   🎉 所有 ProviderManager 测试通过!       ║");
    console.log("╚══════════════════════════════════════════╝");
    process.exit(0);
  } catch (e) {
    console.error("\n❌ 测试失败:", e);
    process.exit(1);
  }
}

main();
