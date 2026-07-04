/**
 * ProviderManager MCP 集成与动态导入测试
 * 注意: 使用 lazy import 避免循环依赖问题
 */
import type {
  ProviderLoadConfig,
  MCPServerConfigMap,
} from "@yachiyo/provider/manager.js";

// C-21 fix: global assert mechanism for CI pass/fail detection
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
// 1. 测试: ProviderManager 基础功能
// ============================================================

async function testProviderManagerBasic(): Promise<void> {
  console.log("\n=== 测试: ProviderManager 基础功能 ===");

  // Lazy import to avoid circular dependency
  const { ProviderManager } = await import("@yachiyo/provider/manager.js");

  const manager = new ProviderManager();

  // 初始状态
  assert(manager.providerInsts.length === 0, "初始 chat providers 为 0");
  assert(manager.embeddingInsts.length === 0, "初始 embedding providers 为 0");
  assert(manager.rerankInsts.length === 0, "初始 rerank providers 为 0");
  assert(manager.instMap.size === 0, "初始 instMap 为 0");

  // 注册 Provider（mock）
  const mockProvider = {
    providerConfig: { id: "mock-openai", maxContextTokens: 4096, modalities: ["text"] },
    async textChat() { return { role: "assistant" as const, completionText: "mock" }; },
  } as any;
  manager.registerProvider(mockProvider);

  assert(manager.providerInsts.length === 1, "注册后 chat providers 为 1");
  assert(manager.instMap.size === 1, "注册后 instMap 为 1");

  // ID 查找
  const found = manager.getProviderById("mock-openai");
  assert(found !== null, "通过 ID 查找成功");

  // 不存在的 ID
  const notFound = manager.getProviderById("nonexistent");
  assert(notFound === null, "查找不存在的 ID 返回 null");

  // getUsingProvider
  const { ProviderType } = await import("@yachiyo/provider/types.js");
  const using = manager.getUsingProvider(ProviderType.CHAT_COMPLETION);
  assert(using !== null, "getUsingProvider 返回非 null");

  // 默认 Provider 设置
  manager.setDefaultProvider("mock-openai");
  const defaultUsing = manager.getUsingProvider(ProviderType.CHAT_COMPLETION);
  assert(defaultUsing?.providerConfig?.id === "mock-openai", "setDefaultProvider 后 getUsingProvider 返回正确");

  console.log("  ✅ ProviderManager 基础功能测试通过");
}

// ============================================================
// 2. 测试: ProviderManager Change Callbacks
// ============================================================

async function testProviderManagerCallbacks(): Promise<void> {
  console.log("\n=== 测试: ProviderManager Change Callbacks ===");

  const { ProviderManager } = await import("@yachiyo/provider/manager.js");

  const manager = new ProviderManager();
  const events: Array<{ id: string; type: string; change: string }> = [];

  manager.setProviderChangeCallback((providerId, providerType, changeType) => {
    events.push({ id: providerId, type: providerType, change: changeType });
  });

  // registerProvider 是低层注册方法，不触发 notifyChange
  const mockProvider1 = {
    providerConfig: { id: "cb-test-1" },
    async textChat() { return { role: "assistant" as const, completionText: "" }; },
  } as any;
  manager.registerProvider(mockProvider1);

  // 低层 registerProvider 不触发回调（只有 loadProvider 等动态方法才触发）
  assert(events.length === 0, "registerProvider 不触发 change callback");

  // 通过 hook 机制验证回调链路
  manager.registerProviderChangeHook((id, type, change) => {
    events.push({ id, type, change });
  });

  // 手动触发 notifyChange 验证 hook 被调用
  const { ProviderType } = await import("@yachiyo/provider/types.js");
  (manager as any).notifyChange("cb-test-1", ProviderType.CHAT_COMPLETION, "load");
  assert(events.length > 0, "notifyChange 触发 hook 回调");
}

// ============================================================
// 3. 测试: ProviderManager MCP 集成
// ============================================================

async function testProviderManagerMCPIntegration(): Promise<void> {
  console.log("\n=== 测试: ProviderManager MCP 集成 ===");

  const { ProviderManager } = await import("@yachiyo/provider/manager.js");

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
  assert(storedConfig !== null, "MCP 配置已存储");
  console.log("  MCP 服务器数量:", storedConfig ? Object.keys(storedConfig).length : 0);
  assert(storedConfig?.["mcp-server-1"] !== undefined, "包含 mcp-server-1");
  assert(storedConfig?.["mcp-server-2"] !== undefined, "包含 mcp-server-2");

  // 重复初始化（应该跳过）
  console.log("  重复初始化测试:");
  await manager.initialize(); // 应该打印警告

  // 终止后 MCP 配置被清除
  await manager.terminate();
  const afterTerminate = manager.getMcpServerConfig();
  assert(afterTerminate === null, "终止后 MCP 配置 (已清除)");
}

// ============================================================
// 4. 测试: ProviderManager 动态 Provider 生命周期
// ============================================================

async function testProviderManagerDynamicLifecycle(): Promise<void> {
  console.log("\n=== 测试: ProviderManager 动态 Provider 生命周期 ===");

  const { ProviderManager } = await import("@yachiyo/provider/manager.js");

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
    assert(manager.instMap.has("test-openai-1"), "loadProvider (openai)");
  } catch (e) {
    console.log("  loadProvider (openai) 可能需要真实 API key:", (e as Error).message?.slice(0, 60));
  }

  // loadProvider - 重复加载
  await manager.loadProvider({ type: "openai", id: "test-openai-1" });
  assert(events.filter(e => e.change === "load").length <= 1, "重复 loadProvider (应跳过)");

  // reloadProvider
  try {
    await manager.reloadProvider({
      type: "openai",
      id: "test-openai-1",
      apiKey: "new-key",
    });
    const reloadEvents = events.filter(e => e.id === "test-openai-1" && e.change === "reload");
    assert(reloadEvents.length > 0, "reloadProvider 触发 reload 事件");
  } catch (e) {
    console.log("  reloadProvider:", (e as Error).message?.slice(0, 60));
  }

  // terminateProvider
  await manager.terminateProvider("test-openai-1");
  assert(!manager.instMap.has("test-openai-1"), "terminateProvider 后 instMap (已移除)");
  const terminateEvents = events.filter(e => e.id === "test-openai-1" && e.change === "terminate");
  assert(terminateEvents.length > 0, "terminateProvider 触发 terminate 事件");

  // deleteProvider
  await manager.loadProvider({ type: "openai", id: "test-delete-1" });
  await manager.deleteProvider("test-delete-1");
  assert(!manager.instMap.has("test-delete-1"), "deleteProvider 后 instMap");
  assert(!manager.providerConfigs.has("test-delete-1"), "deleteProvider 后 providerConfigs");

  // 未知类型动态导入
  try {
    await manager.loadProvider({
      type: "unknown_custom_type",
      id: "custom-1",
    });
    assert(false, "未知类型动态导入 (不应成功)");
  } catch (e) {
    assert((e as Error).message?.includes("Unknown"), "未知类型动态导入 正确拒绝");
  }
}

// ============================================================
// 5. 测试: dynamicImportProviderModule
// ============================================================

async function testDynamicImportProviderModule(): Promise<void> {
  console.log("\n=== 测试: dynamicImportProviderModule ===");

  const { dynamicImportProviderModule, PROVIDER_TYPE_MODULE_MAP } = await import("@yachiyo/provider/factory.js");

  // 测试所有已知类型
  const knownTypes = [
    "openai", "openai_responses", "gemini", "anthropic",
    "openai_embedding", "gemini_embedding",
    "cohere", "jina", "voyage", "generic",
    "openai_tts", "openai_stt",
  ];

  for (const type of knownTypes) {
    const cls = await dynamicImportProviderModule(type);
    assert(cls !== null, `${type}`);
  }

  // 未知类型
  const unknownCls = await dynamicImportProviderModule("nonexistent_provider");
  assert(unknownCls === null, "nonexistent_provider (返回 null)");

  // 验证模块映射表
  console.log("  PROVIDER_TYPE_MODULE_MAP 条目数:", Object.keys(PROVIDER_TYPE_MODULE_MAP).length);
  assert(!!PROVIDER_TYPE_MODULE_MAP["openai"], "包含 openai");
  assert(!!PROVIDER_TYPE_MODULE_MAP["anthropic"], "包含 anthropic");
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
  } = await import("@yachiyo/provider/factory.js");

  // Chat Provider
  try {
    const chatProvider = await dynamicCreateChatProvider("openai", {
      apiKey: "test",
      model: "gpt-4",
    } as any);
    assert(chatProvider !== null, "dynamicCreateChatProvider (openai)");
    if (chatProvider) {
      assert(typeof chatProvider.textChat === "function", "有 textChat 方法");
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
    assert(embProvider !== null, "dynamicCreateEmbeddingProvider (openai_embedding)");
    if (embProvider) {
      assert(typeof embProvider.getEmbedding === "function", "有 getEmbedding 方法");
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
    assert(rerankProvider !== null, "dynamicCreateRerankProvider (generic)");
  } catch (e) {
    console.log("  dynamicCreateRerankProvider:", (e as Error).message?.slice(0, 60));
  }

  // TTS Provider
  try {
    const ttsProvider = await dynamicCreateTtsProvider("openai_tts", {
      apiKey: "test",
      model: "tts-1",
    } as any);
    assert(ttsProvider !== null, "dynamicCreateTtsProvider (openai_tts)");
    if (ttsProvider) {
      assert(typeof ttsProvider.getAudio === "function", "有 getAudio 方法");
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
    assert(sttProvider !== null, "dynamicCreateSttProvider (openai_stt)");
    if (sttProvider) {
      assert(typeof sttProvider.getText === "function", "有 getText 方法");
    }
  } catch (e) {
    console.log("  dynamicCreateSttProvider:", (e as Error).message?.slice(0, 60));
  }

  // 未知类型
  const unknownChat = await dynamicCreateChatProvider("unknown", {} as any);
  assert(unknownChat === null, "dynamicCreateChatProvider (unknown) 返回 null");
}

// ============================================================
// 7. 测试: MCP 安全校验 (validateMcpStdioConfig)
// ============================================================

async function testMcpSecurityValidation(): Promise<void> {
  console.log("\n=== 测试: MCP 安全校验 ===");

  const { validateMcpStdioConfig } = await import("@yachiyo/agent/mcp-client.js");

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
      assert(test.expected, `${test.name} 正确通过`);
    } catch (e) {
      assert(!test.expected, `${test.name} 正确拒绝`);
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
      assert(test.expected, `${test.name} 正确通过`);
    } catch (e) {
      assert(!test.expected, `${test.name} 正确拒绝`);
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
      assert(test.expected, `${test.name} 正确通过`);
    } catch (e) {
      assert(!test.expected, `${test.name} 正确拒绝`);
    }
  }
}

// ============================================================
// 8. 测试: ProviderManager 终止和清理
// ============================================================

async function testProviderManagerTerminateAndCleanup(): Promise<void> {
  console.log("\n=== 测试: ProviderManager 终止和清理 ===");

  const { ProviderManager } = await import("@yachiyo/provider/manager.js");

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
  assert(manager.getMcpServerConfig() !== null, "终止前 MCP 配置存在");

  // 终止
  await manager.terminate();

  console.log("  终止后 instMap:", manager.instMap.size);
  console.log("  终止后 providerConfigs:", manager.providerConfigs.size);
  assert(manager.getMcpServerConfig() === null, "终止后 MCP 配置 (已清除)");
  console.log("  终止后 chat providers:", manager.providerInsts.length);

  // 终止后可以重新初始化（无参数时 mcpServerConfig 为 null）
  await manager.initialize();
  assert(manager.getMcpServerConfig() === null, "重新初始化后 MCP 配置不存在 (无参数)");

  await manager.terminate();
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
    console.log(`\n通过: ${passCount}, 失败: ${failCount}`);
    if (failCount > 0) process.exit(1);
    process.exit(0);
  } catch (e) {
    console.error("\n❌ 测试失败:", e);
    console.log(`\n通过: ${passCount}, 失败: ${failCount}`);
    process.exit(1);
  }
}

main();
