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
 *   WEBHOOK_HOST        - (可选) Webhook 监听地址，默认 127.0.0.1
 *   WEBHOOK_ACCESS_TOKEN - (可选) OneBot11 WebSocket 鉴权 Token
 */

async function main() {
  const providerType = process.env.PROVIDER_TYPE as ChatProviderType;
  const apiKey = process.env.PROVIDER_API_KEY ?? "";
  const model = process.env.PROVIDER_MODEL ?? "gpt-4o-mini";
  const baseUrl = process.env.PROVIDER_BASE_URL;
  const webhookPort = parseInt(process.env.WEBHOOK_PORT ?? "8080", 10);
  const webhookHost = process.env.WEBHOOK_HOST ?? "127.0.0.1";
  const dashboardEnabled = process.env.DASHBOARD_ENABLED !== "false";
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT ?? "8000", 10);
  const dashboardHost = process.env.DASHBOARD_HOST ?? "0.0.0.0";

  if (process.env.WEBHOOK_HOST === undefined) {
    console.warn("[Server] OneBot11 default bind address is now 127.0.0.1. Remote/container deployments must explicitly set WEBHOOK_HOST (for example 0.0.0.0). Saved adapter settings are preserved unless overridden.");
  }
  if (!process.env.WEBHOOK_ACCESS_TOKEN) {
    console.warn("[Server] WEBHOOK_ACCESS_TOKEN is not set. OneBot11 will use any saved token; without one, its WebSocket endpoint is unauthenticated.");
  }

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
      ...(process.env.WEBHOOK_PORT !== undefined ? { port: webhookPort } : {}),
      ...(process.env.WEBHOOK_HOST !== undefined ? { host: webhookHost } : {}),
      ...(process.env.WEBHOOK_ACCESS_TOKEN !== undefined ? { accessToken: process.env.WEBHOOK_ACCESS_TOKEN } : {}),
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
