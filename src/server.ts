import { bootstrap } from "./bootstrap.js";
import type { ChatProviderType } from "@yachiyo/provider/factory.js";

/**
 * 便捷启动入口
 * 通过环境变量配置系统
 *
 * 环境变量:
 *   PROVIDER_TYPE       - LLM Provider 类型: openai | openai_responses | gemini | anthropic
 *   PROVIDER_API_KEY    - API Key
 *   PROVIDER_MODEL      - 模型名称
 *   PROVIDER_BASE_URL   - (可选) API Base URL
 *   WEBHOOK_PORT        - (可选) Webhook 端口，默认 8080
 *   WEBHOOK_HOST        - (可选) Webhook 监听地址，默认 0.0.0.0
 */

async function main() {
  const providerType = process.env.PROVIDER_TYPE as ChatProviderType;
  const apiKey = process.env.PROVIDER_API_KEY ?? "";
  const model = process.env.PROVIDER_MODEL ?? "gpt-4o-mini";
  const baseUrl = process.env.PROVIDER_BASE_URL;
  const webhookPort = parseInt(process.env.WEBHOOK_PORT ?? "8080", 10);
  const webhookHost = process.env.WEBHOOK_HOST ?? "0.0.0.0";
  const dashboardEnabled = process.env.DASHBOARD_ENABLED !== "false";
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT ?? "8000", 10);
  const dashboardHost = process.env.DASHBOARD_HOST ?? "0.0.0.0";


  console.log(`[Server] Starting${providerType ? ` with provider: ${providerType}, model: ${model}` : " without LLM provider"}`);
  if (dashboardEnabled) {
    console.log(`[Server] Admin Dashboard will be available at http://${dashboardHost}:${dashboardPort}`);
  }

  const ctx = await bootstrap({
    provider: (providerType && apiKey) ? {
      type: providerType,
      config: {
        id: "default-provider",
        apiKey,
        model,
        ...(baseUrl ? { baseUrl } : {}),
      },
    } : undefined,
    onebot11: {
      port: webhookPort,
      host: webhookHost,
    },
    dashboard: {
      enabled: dashboardEnabled,
      port: dashboardPort,
      host: dashboardHost,
      debugChatEnabled: false,
    },
  });

  // 优雅关闭
  const shutdown = async () => {
    console.log("\n[Server] Shutting down...");
    await ctx.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("[Server] Ready. Press Ctrl+C to stop.");
}

main().catch((e) => {
  console.error("[Server] Fatal error:", e);
  process.exit(1);
});
