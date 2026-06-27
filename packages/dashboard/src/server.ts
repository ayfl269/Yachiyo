import { createServer, type IncomingMessage, type ServerResponse, type Server } from "http";
import { join, extname, resolve, relative, isAbsolute } from "path";
import { readFile, stat, writeFile, mkdir, unlink, readdir } from "fs/promises";
import { cpus, tmpdir, totalmem } from "os";
import { timingSafeEqual } from "crypto";

import type { AsyncQueue } from "@yachiyo/common/async-queue.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import type { ProviderManager } from "@yachiyo/provider/manager.js";
import type { ConversationManager } from "@yachiyo/conversation/manager.js";
import type { PersonaManager } from "@yachiyo/persona/manager.js";
import type { KnowledgeBaseManager } from "@yachiyo/knowledge-base/manager.js";
import type { SessionLockManager } from "@yachiyo/pipeline/session-lock.js";
import type { SessionServiceManager } from "@yachiyo/pipeline/stages/session-status-check.js";
import type { PluginManager } from "@yachiyo/plugin/manager.js";
import type { ConfigManager } from "@yachiyo/config/manager.js";
import type { EventBus } from "@yachiyo/pipeline/event-bus.js";
import type { PipelineScheduler } from "@yachiyo/pipeline/scheduler.js";
import type { AdapterRegistry } from "@yachiyo/platform/registry.js";
import type { SqliteAdapterStore } from "@yachiyo/platform/sqlite-adapter-store.js";
import type { DatabaseManager } from "@yachiyo/common/database.js";
import type { FunctionToolManager } from "@yachiyo/agent/func-tool-manager.js";
import type { MemoryConsolidator } from "@yachiyo/agent/memory-consolidator.js";
import type { SkillManager } from "@yachiyo/skill/index.js";

export interface BootstrapContext {
  eventQueue: AsyncQueue<MessageEvent>;
  eventBus: EventBus;
  adapterRegistry: AdapterRegistry;
  adapterStore?: SqliteAdapterStore;
  providerManager: ProviderManager;
  configManager: ConfigManager;
  conversationManager: ConversationManager;
  knowledgeBaseManager: KnowledgeBaseManager;
  sessionLockManager: SessionLockManager;
  sessionServiceManager: SessionServiceManager;
  personaManager: PersonaManager;
  pluginManager: PluginManager;
  skillManager: SkillManager;
  scheduler: PipelineScheduler;
  dbManager: DatabaseManager;
  toolManager: FunctionToolManager;
  memoryConsolidator: MemoryConsolidator;
  dashboardServer?: any;
  shutdown: () => Promise<void>;
}

export function isPathSafe(basePath: string, targetPath: string): boolean {
  const resolvedBase = resolve(basePath);
  const resolvedTarget = resolve(resolvedBase, targetPath);
  const rel = relative(resolvedBase, resolvedTarget);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Sentinel value returned in place of a real secret in API responses.
 * The frontend treats this as "key unchanged": when the user saves a form
 * without editing the key field, this value is sent back and the backend
 * (resolveSecretSentinel) substitutes the previously-stored key.
 */
const MASKED_SECRET = "********";

/** Return a masked indicator if the value is a non-empty secret, else the empty string. */
function maskSecret(value: unknown): string {
  return value && typeof value === "string" && value.length > 0 ? MASKED_SECRET : "";
}

/**
 * Replace any secret fields (`key`, `apiKey`) on a provider config object
 * with the masked sentinel. Returns a shallow copy so the caller's original
 * object (which may hold the real key for internal use) is untouched.
 */
function maskProviderSecrets<T extends Record<string, any>>(config: T): T {
  const out: Record<string, any> = { ...config };
  if ("key" in out) out.key = maskSecret(out.key);
  if ("apiKey" in out) out.apiKey = maskSecret(out.apiKey);
  return out as T;
}

export interface DashboardServerOptions {
  port?: number;
  host?: string;
  debugChatEnabled?: boolean;
  /**
   * Bearer token required for all `/api/` requests. When empty/undefined,
   * authentication is DISABLED (dev mode) and a warning is logged. Set this
   * to a strong secret in production so that anyone who can reach the port
   * cannot fully control the system (providers, conversations, shell tools…).
   */
  authToken?: string;
  /**
   * Allowed CORS origins. When set, `Access-Control-Allow-Origin` echoes a
   * matching request `Origin` instead of `*`, preventing cross-origin abuse.
   * The SPA is served same-origin and does not need CORS; this is mainly for
   * the Vite dev server. Leave undefined to disallow all cross-origin access.
   */
  allowedOrigins?: string[];
}

export class DashboardServer {
  private server: Server | null = null;
  private ctx: BootstrapContext;
  private port: number;
  private host: string;
  private debugChatEnabled: boolean;
  private authToken: string | undefined;
  private allowedOrigins: Set<string> | undefined;
  private startTime: number = 0;
  private prevCpuInfo: { idle: number; total: number } | null = null;
  private todayTokens: number = 0;
  private lastTokenDate: string = new Date().toDateString();

  constructor(ctx: BootstrapContext, options: DashboardServerOptions = {}) {
    this.ctx = ctx;
    this.port = options.port ?? 8000;
    this.host = options.host ?? "127.0.0.1";
    this.debugChatEnabled = options.debugChatEnabled === true;
    this.authToken = options.authToken;
    this.allowedOrigins = options.allowedOrigins ? new Set(options.allowedOrigins) : undefined;
  }

  /**
   * Constant-time Bearer token check. Returns true when auth is disabled
   * (no authToken configured) so dev mode keeps working.
   */
  private isRequestAuthenticated(req: IncomingMessage): boolean {
    if (!this.authToken) return true; // auth disabled (dev mode)
    const header = req.headers["authorization"];
    if (typeof header !== "string") return false;
    const expected = `Bearer ${this.authToken}`;
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Apply CORS headers based on the configured allowlist. No allowlist => no ACAO (same-origin only). */
  private applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (this.allowedOrigins && this.allowedOrigins.size > 0) {
      const origin = req.headers["origin"];
      if (typeof origin === "string" && this.allowedOrigins.has(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
    }
    // When no allowlist is configured, we intentionally do NOT set
    // Access-Control-Allow-Origin — the SPA is same-origin and cross-origin
    // callers get no CORS permission (the previous "*" allowed any site).
  }

  async start(): Promise<void> {
    this.startTime = Date.now();
    this.server = createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, this.host, () => {
        console.log(`[DashboardServer] Admin Dashboard is running at http://${this.host}:${this.port}`);
        if (!this.authToken) {
          console.warn(`[DashboardServer] WARNING: API authentication is DISABLED (no authToken configured). Anyone who can reach this port can fully control the system. Set dashboard.authToken in production.`);
        }
        if (this.debugChatEnabled) {
          console.warn(`[DashboardServer] WARNING: debug chat endpoint (/api/debug/chat) is ENABLED. It runs the full agent pipeline (tools, shell, file access) on any authorized request — enable only in trusted environments.`);
        }
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      console.log("[DashboardServer] Stopped.");
    }
  }

  private calculateCpuUsage(): number {
    const cpuInfo = cpus();
    let totalIdle = 0;
    let totalTick = 0;

    for (const cpu of cpuInfo) {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    }

    if (this.prevCpuInfo) {
      const idleDiff = totalIdle - this.prevCpuInfo.idle;
      const totalDiff = totalTick - this.prevCpuInfo.total;
      this.prevCpuInfo = { idle: totalIdle, total: totalTick };
      if (totalDiff === 0) return 0;
      return Math.round((1 - idleDiff / totalDiff) * 1000) / 10;
    }

    this.prevCpuInfo = { idle: totalIdle, total: totalTick };
    return 0;
  }

  public addTokenUsage(tokens: number): void {
    const today = new Date().toDateString();
    if (today !== this.lastTokenDate) {
      this.todayTokens = 0;
      this.lastTokenDate = today;
    }
    this.todayTokens += tokens;
  }

  private _hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash);
  }

  private generateTrendSeriesFromStats(
    stats: Array<{ model: string; tokenInputOther: number; tokenInputCached: number; tokenOutput: number; createdAt: Date }>,
    days: number
  ): Array<{ name: string; data: [number, number][] }> {
    if (stats.length === 0) return [];

    // Group by model, then by time bucket
    const intervalMs = days <= 1 ? 3600000 : (days <= 3 ? 7200000 : 86400000);
    const now = Date.now();
    const buckets = Math.min(days * (days <= 1 ? 24 : days <= 3 ? 12 : 7), 24);

    const modelBuckets = new Map<string, Map<number, number>>();
    for (const s of stats) {
      const totalTokens = (s.tokenInputOther || 0) + (s.tokenInputCached || 0) + (s.tokenOutput || 0);
      if (!modelBuckets.has(s.model)) modelBuckets.set(s.model, new Map());
      const bucketIdx = Math.floor((s.createdAt.getTime() - (now - buckets * intervalMs)) / intervalMs);
      const clampedIdx = Math.max(0, Math.min(buckets - 1, bucketIdx));
      const bucketsMap = modelBuckets.get(s.model)!;
      bucketsMap.set(clampedIdx, (bucketsMap.get(clampedIdx) || 0) + totalTokens);
    }

    return Array.from(modelBuckets.entries())
      .sort((a, b) => {
        const sumA = [...a[1].values()].reduce((s, v) => s + v, 0);
        const sumB = [...b[1].values()].reduce((s, v) => s + v, 0);
        return sumB - sumA;
      })
      .slice(0, 8)
      .map(([name, bucketsMap]) => ({
        name,
        data: Array.from({ length: buckets }, (_, i) => {
          const ts = now - (buckets - 1 - i) * intervalMs;
          return [ts, bucketsMap.get(i) || 0] as [number, number];
        }),
      }));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS (allowlist-based; no longer reflects "*")
    this.applyCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // Authenticate all API routes. Static assets (the SPA shell) are served
    // without auth so the login screen can load.
    if (pathname.startsWith("/api/") && !this.isRequestAuthenticated(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized", message: "Missing or invalid Authorization header." }));
      return;
    }

    // Route handling
    try {
      if (pathname.startsWith("/api/")) {
        await this.handleApiRequest(req, res, pathname, url);
      } else {
        await this.handleStaticRequest(req, res, pathname);
      }
    } catch (error: any) {
      console.error(`[DashboardServer] Error handling request ${req.method} ${pathname}:`, error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error", details: error.message }));
    }
  }

  private async handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    url: URL
  ): Promise<void> {
    res.setHeader("Content-Type", "application/json");

    // 1. GET /api/status
    if (pathname === "/api/status" && req.method === "GET") {
      const response = {
        uptime: Date.now() - this.startTime,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        memoryUsage: process.memoryUsage(),
        defaultProviderId: this.ctx.providerManager.getDefaultProviderId(),
        fallbackProviderIds: this.ctx.providerManager.getFallbackProviderIds(),
        hasConfig: !!this.ctx.configManager.getActiveConfig(),
        adapters: this.ctx.adapterRegistry.getAllAdapters().map(a => ({
          id: a.meta().id,
          name: a.meta().name,
          status: a.status,
        })),
        cpuUsage: this.calculateCpuUsage(),
        todayTokens: this.todayTokens,
      };
      res.writeHead(200);
      res.end(JSON.stringify(response));
      return;
    }

    // 2. GET /api/config — 获取当前活跃配置 (单配置模式)
    if (pathname === "/api/config" && req.method === "GET") {
      const config = this.ctx.configManager.getActiveConfig();
      if (!config) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "No config found" }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(config));
      return;
    }

    // 3. PUT /api/config — 更新当前配置
    if (pathname === "/api/config" && req.method === "PUT") {
      const body = await this.readBody(req);
      const config = JSON.parse(body);
      if (!config.id) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing config ID" }));
        return;
      }
      this.ctx.configManager.updateConfig(config);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, config }));
      return;
    }

    // 4.5 POST /api/providers/test
    if (pathname === "/api/providers/test" && req.method === "POST") {
      const body = await this.readBody(req);
      const payload = JSON.parse(body);
      const { type, config } = payload;
      if (!type || !config) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing type or config" }));
        return;
      }
      try {
        const { createChatProvider } = await import("@yachiyo/provider/factory.js");
        const prov = createChatProvider(type, config);
        const response = await prov.textChat({
          contexts: [{ role: "user", content: "hello" } as any]
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: response.completionText || "Connection success" }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // 4.6 POST /api/providers/models - 获取可用模型列表
    if (pathname === "/api/providers/models" && req.method === "POST") {
      const body = await this.readBody(req);
      const payload = JSON.parse(body);
      const { type, config } = payload;
      if (!type || !config || !config.apiKey) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing type, config or apiKey" }));
        return;
      }
      try {
        const models = await this.fetchModelsFromProvider(type, config);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, models }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // 5. GET /api/providers
    if (pathname === "/api/providers" && req.method === "GET") {
      const providerConfigsMap = this.ctx.providerManager.providerConfigs;
      const providersList: any[] = [];
      const disabledIds = this.ctx.providerManager.getDisabledIds();
      for (const [id, config] of providerConfigsMap.entries()) {
        providersList.push({
          id,
          type: config.type,
          // Mask apiKey/key so secrets are not exposed in list responses.
          config: maskProviderSecrets(config),
          disabled: disabledIds.includes(id),
        });
      }
      res.writeHead(200);
      res.end(JSON.stringify({
        providers: providersList,
        defaultProviderId: this.ctx.providerManager.getDefaultProviderId(),
        fallbackProviderIds: this.ctx.providerManager.getFallbackProviderIds(),
      }));
      return;
    }

    // 6. POST /api/providers
    if (pathname === "/api/providers" && req.method === "POST") {
      const body = await this.readBody(req);
      const payload = JSON.parse(body);
      const { id, type, config } = payload;
      if (!id || !type) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing provider id or type" }));
        return;
      }

      // Merge config fields into the load config shape
      const loadConfig = {
        id,
        type,
        ...(config || {}),
      };

      await this.ctx.providerManager.updateProvider(id, loadConfig);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 7. DELETE /api/providers/:id
    if (pathname.startsWith("/api/providers/") && req.method === "DELETE") {
      const id = pathname.substring("/api/providers/".length);
      if (!id) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing provider ID" }));
        return;
      }
      await this.ctx.providerManager.deleteProvider(id);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 8. POST /api/providers/default
    if (pathname === "/api/providers/default" && req.method === "POST") {
      const body = await this.readBody(req);
      const { id } = JSON.parse(body);
      if (id === undefined) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing default provider id" }));
        return;
      }
      this.ctx.providerManager.setDefaultProvider(id);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 9. POST /api/providers/fallback
    if (pathname === "/api/providers/fallback" && req.method === "POST") {
      const body = await this.readBody(req);
      const { ids } = JSON.parse(body);
      if (!Array.isArray(ids)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "ids must be an array of strings" }));
        return;
      }
      this.ctx.providerManager.setFallbackProviders(ids);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 10. PATCH /api/providers/:id/toggle — 停用/启用提供商
    if (pathname.startsWith("/api/providers/") && pathname.endsWith("/toggle") && req.method === "PATCH") {
      const id = decodeURIComponent(pathname.substring("/api/providers/".length, pathname.length - "/toggle".length));
      try {
        const body = await this.readBody(req);
        const { enabled } = JSON.parse(body);
        if (enabled) {
          this.ctx.providerManager.setEnabled(id);
        } else {
          this.ctx.providerManager.setDisabled(id);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, disabled: this.ctx.providerManager.isDisabled(id) }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 11. GET /api/mcp
    if (pathname === "/api/mcp" && req.method === "GET") {
      const sqliteStore = (this.ctx.providerManager as any).sqliteStore;
      const mcpConfigs = sqliteStore ? sqliteStore.getAllMcpServerConfigs() : [];
      res.writeHead(200);
      res.end(JSON.stringify(mcpConfigs));
      return;
    }

    // 11. POST /api/mcp
    if (pathname === "/api/mcp" && req.method === "POST") {
      const body = await this.readBody(req);
      const payload = JSON.parse(body);
      const { serverName, config } = payload;
      if (!serverName || !config) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing serverName or config" }));
        return;
      }

      const sqliteStore = (this.ctx.providerManager as any).sqliteStore;
      if (sqliteStore) {
        sqliteStore.saveMcpServerConfig({
          serverName,
          config,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }

      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 12. DELETE /api/mcp/:id
    if (pathname.startsWith("/api/mcp/") && req.method === "DELETE") {
      const serverName = pathname.substring("/api/mcp/".length);
      if (!serverName) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing serverName" }));
        return;
      }

      const sqliteStore = (this.ctx.providerManager as any).sqliteStore;
      if (sqliteStore) {
        sqliteStore.deleteMcpServerConfig(serverName);
      }

      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 13. Sub-agents CRUD
    if (pathname === "/api/subagents" && req.method === "GET") {
      const { dynamicSubAgentRegistry } = await import("@yachiyo/agent/subagent-create-tool.js");
      const list = dynamicSubAgentRegistry.getAll().map(x => ({
        name: x.agent.name,
        instructions: x.agent.instructions || "",
        description: x.handoff.description || "",
        tools: Array.isArray(x.agent.tools) ? x.agent.tools.map(t => typeof t === "string" ? t : t.name) : null,
      }));
      res.writeHead(200);
      res.end(JSON.stringify(list));
      return;
    }

    if (pathname === "/api/subagents" && req.method === "POST") {
      const { dynamicSubAgentRegistry } = await import("@yachiyo/agent/subagent-create-tool.js");
      const { createAgent } = await import("@yachiyo/agent/agent.js");
      const { createHandoffTool } = await import("@yachiyo/agent/handoff.js");
      const body = await this.readBody(req);
      const { name, instructions, description, tools } = JSON.parse(body);
      const agent = createAgent({ name, instructions, tools });
      agent.dynamic = true;
      const handoff = createHandoffTool(agent, description || instructions.slice(0, 120).trim());
      dynamicSubAgentRegistry.register(agent, handoff);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (pathname.startsWith("/api/subagents/") && req.method === "DELETE") {
      const { dynamicSubAgentRegistry } = await import("@yachiyo/agent/subagent-create-tool.js");
      const name = pathname.substring("/api/subagents/".length);
      dynamicSubAgentRegistry.unregister(decodeURIComponent(name));
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 14. Skills CRUD
    if (pathname === "/api/skills" && req.method === "GET") {
      const skills = this.ctx.skillManager.listSkills();
      res.writeHead(200);
      res.end(JSON.stringify(skills));
      return;
    }

    if (pathname === "/api/skills" && req.method === "POST") {
      const body = await this.readBody(req);
      const skill = JSON.parse(body);
      this.ctx.skillManager.registerSkill(skill);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (pathname.startsWith("/api/skills/") && pathname.endsWith("/toggle") && req.method === "POST") {
      const name = pathname.substring("/api/skills/".length, pathname.lastIndexOf("/toggle"));
      const body = await this.readBody(req);
      const { active } = JSON.parse(body);
      this.ctx.skillManager.setSkillActive(decodeURIComponent(name), active);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (pathname.startsWith("/api/skills/") && req.method === "DELETE") {
      const name = pathname.substring("/api/skills/".length);
      this.ctx.skillManager.deleteSkill(decodeURIComponent(name));
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 14.5 POST /api/skills/upload-zip - 批量上传 ZIP 技能包
    if (pathname === "/api/skills/upload-zip" && req.method === "POST") {
      try {
        const { files, error } = await this.parseMultipartRequest(req);
        if (error || !files || files.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: error || "未检测到文件" }));
          return;
        }

        const results = await this.processZipFiles(files);

        for (const file of files) {
          try { await unlink(file.tempPath); } catch { /* cleanup best effort */ }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, results }));
      } catch (err: any) {
        console.error("[Dashboard] Error processing skill ZIP upload:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // 15. Knowledge Bases CRUD
    if (pathname === "/api/kbs" && req.method === "GET") {
      const kbs = this.ctx.knowledgeBaseManager.listKbs();
      res.writeHead(200);
      res.end(JSON.stringify(kbs));
      return;
    }

    if (pathname === "/api/kbs" && req.method === "POST") {
      const body = await this.readBody(req);
      const options = JSON.parse(body);
      const kb = await this.ctx.knowledgeBaseManager.createKb(options);
      res.writeHead(200);
      res.end(JSON.stringify(kb));
      return;
    }

    if (pathname.startsWith("/api/kbs/") && pathname.endsWith("/documents") && req.method === "GET") {
      const kbId = pathname.substring("/api/kbs/".length, pathname.lastIndexOf("/documents"));
      const docs = this.ctx.knowledgeBaseManager.getDocuments(kbId);
      res.writeHead(200);
      res.end(JSON.stringify(docs));
      return;
    }

    if (pathname.startsWith("/api/kbs/") && pathname.endsWith("/documents") && req.method === "POST") {
      const kbId = pathname.substring("/api/kbs/".length, pathname.lastIndexOf("/documents"));
      const body = await this.readBody(req);
      const { text, docName } = JSON.parse(body);
      await this.ctx.knowledgeBaseManager.uploadText(kbId, text, docName);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (pathname.startsWith("/api/kbs/") && pathname.includes("/documents/") && req.method === "DELETE") {
      const parts = pathname.split("/");
      const docId = parts[parts.length - 1];
      await this.ctx.knowledgeBaseManager.deleteDocument(docId);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (pathname.startsWith("/api/kbs/") && req.method === "DELETE") {
      const id = pathname.substring("/api/kbs/".length);
      await this.ctx.knowledgeBaseManager.deleteKb(id);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 16. Personas CRUD
    if (pathname === "/api/personas" && req.method === "GET") {
      const personasMap = await this.ctx.personaManager.getAllPersonas();
      const list: any[] = [];
      for (const [id, p] of personasMap.entries()) {
        list.push({ id, ...p });
      }
      res.writeHead(200);
      res.end(JSON.stringify(list));
      return;
    }

    if (pathname === "/api/personas" && req.method === "POST") {
      const body = await this.readBody(req);
      const payload = JSON.parse(body);
      const { id, name, prompt, beginDialogs, moodImitationDialogs, tools, skills, customErrorMessage } = payload;
      await this.ctx.personaManager.registerPersona(id, {
        name,
        prompt,
        beginDialogs: beginDialogs || [],
        moodImitationDialogs: moodImitationDialogs || [],
        tools: tools || null,
        skills: skills || null,
        customErrorMessage: customErrorMessage || null,
      });
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (pathname.startsWith("/api/personas/") && req.method === "DELETE") {
      const id = pathname.substring("/api/personas/".length);
      await this.ctx.personaManager.deletePersona(id);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 16.5 POST /api/personas/update — Update persona
    if (pathname === "/api/personas/update" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const payload = JSON.parse(body);
        const { id, name, prompt, beginDialogs, moodImitationDialogs, tools, skills, customErrorMessage } = payload;
        if (!id) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing persona id" }));
          return;
        }
        await this.ctx.personaManager.updatePersona(id, {
          name,
          prompt,
          beginDialogs: beginDialogs || [],
          moodImitationDialogs: moodImitationDialogs || [],
          tools: tools ?? null,
          skills: skills ?? null,
          customErrorMessage: customErrorMessage || null,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
      return;
    }

    // 16.6 KB new-style API: GET /api/kb/list
    if (pathname === "/api/kb/list" && req.method === "GET") {
      const kbs = this.ctx.knowledgeBaseManager.listKbs();
      res.writeHead(200);
      res.end(JSON.stringify(kbs));
      return;
    }

    // 16.7 KB new-style API: GET /api/kb/get?kb_id=xxx
    if (pathname === "/api/kb/get" && req.method === "GET") {
      const kbId = url.searchParams.get("kb_id");
      if (!kbId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing kb_id" }));
        return;
      }
      const kb = this.ctx.knowledgeBaseManager.getKb(kbId);
      if (!kb) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Knowledge base not found" }));
        return;
      }
      const docs = this.ctx.knowledgeBaseManager.getDocuments(kbId);
      res.writeHead(200);
      res.end(JSON.stringify({ ...kb, doc_count: docs.length, chunk_count: docs.reduce((s: number, d: any) => s + (d.chunkCount || 0), 0) }));
      return;
    }

    // 16.8 KB new-style API: POST /api/kb/create
    if (pathname === "/api/kb/create" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const options = JSON.parse(body);
        const kb = await this.ctx.knowledgeBaseManager.createKb(options);
        res.writeHead(200);
        res.end(JSON.stringify(kb));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 16.9 KB new-style API: POST /api/kb/update
    if (pathname === "/api/kb/update" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const { kb_id, ..._updates } = JSON.parse(body);
        if (!kb_id) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing kb_id" }));
          return;
        }
        // KB update is limited - just return success for now
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
      return;
    }

    // 16.10 KB new-style API: POST /api/kb/delete
    if (pathname === "/api/kb/delete" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const { kb_id } = JSON.parse(body);
        if (!kb_id) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing kb_id" }));
          return;
        }
        await this.ctx.knowledgeBaseManager.deleteKb(kb_id);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
      return;
    }

    // 16.11 KB new-style API: GET /api/kb/document/list?kb_id=xxx
    if (pathname === "/api/kb/document/list" && req.method === "GET") {
      const kbId = url.searchParams.get("kb_id");
      if (!kbId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing kb_id" }));
        return;
      }
      const docs = this.ctx.knowledgeBaseManager.getDocuments(kbId);
      res.writeHead(200);
      res.end(JSON.stringify(docs));
      return;
    }

    // 16.12 KB new-style API: POST /api/kb/document/upload — Upload text to KB
    if (pathname === "/api/kb/document/upload" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const { kb_id, text, doc_name } = JSON.parse(body);
        if (!kb_id || !text || !doc_name) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing kb_id, text or doc_name" }));
          return;
        }
        await this.ctx.knowledgeBaseManager.uploadText(kb_id, text, doc_name);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
      return;
    }

    // 16.13 KB new-style API: POST /api/kb/document/delete
    if (pathname === "/api/kb/document/delete" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const { doc_id } = JSON.parse(body);
        if (!doc_id) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing doc_id" }));
          return;
        }
        await this.ctx.knowledgeBaseManager.deleteDocument(doc_id);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
      return;
    }

    // 16.14 KB new-style API: POST /api/kb/retrieve
    if (pathname === "/api/kb/retrieve" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const { query, kb_names, top_k } = JSON.parse(body);
        if (!query || !kb_names) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing query or kb_names" }));
          return;
        }
        const result = await this.ctx.knowledgeBaseManager.retrieve(query, kb_names, top_k);
        res.writeHead(200);
        res.end(JSON.stringify({ result }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ result: null, error: err.message }));
      }
      return;
    }

    // 16.15 GET /api/config/provider/list — List providers by type
    if (pathname === "/api/config/provider/list" && req.method === "GET") {
      try {
        const providerType = url.searchParams.get("provider_type") || "";
        const types = providerType.split(",").filter(Boolean);
        const providerConfigsMap = this.ctx.providerManager.providerConfigs;
        const providers: any[] = [];
        for (const [id, config] of providerConfigsMap.entries()) {
          const pType = (config as any).type || "";
          if (types.length === 0 || types.includes(pType)) {
            providers.push({
              id,
              provider_type: pType,
              model: (config as any).model || "",
            });
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify(providers));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify([]));
      }
      return;
    }

    // 16.16 GET /api/tools/list — List all function tools
    if (pathname === "/api/tools/list" && req.method === "GET") {
      try {
        const toolMgr = this.ctx.toolManager as any;
        const mcpClientDict = toolMgr?.mcpClientDict as Map<string, any> | undefined;
        const tools: Array<{ name: string; description: string; origin: string; active: boolean; readonly: boolean }> = [];

        // Collect from funcList (all registered tools)
        if (Array.isArray(toolMgr?.funcList)) {
          for (const fnTool of toolMgr.funcList) {
            tools.push({
              name: fnTool.name || "",
              description: fnTool.description || "",
              origin: fnTool.origin || "builtin",
              active: fnTool.active !== false,
              readonly: false,
            });
          }
        }

        // Collect from builtinFuncList
        if (toolMgr?.builtinFuncList instanceof Map) {
          for (const [name, fnTool] of toolMgr.builtinFuncList.entries()) {
            if (!tools.find(t => t.name === name)) {
              tools.push({
                name,
                description: fnTool.description || "",
                origin: "builtin",
                active: fnTool.active !== false,
                readonly: true,
              });
            }
          }
        }

        // Collect MCP tools
        if (mcpClientDict) {
          for (const [serverName, client] of mcpClientDict.entries()) {
            const mcpTools = client?.tools || [];
            for (const tool of mcpTools) {
              if (!tools.find(t => t.name === tool.name)) {
                tools.push({
                  name: tool.name || "",
                  description: tool.description || "",
                  origin: `mcp:${serverName}`,
                  active: true,
                  readonly: false,
                });
              }
            }
          }
        }

        res.writeHead(200);
        res.end(JSON.stringify(tools));
      } catch (err: any) {
        console.error("[tools/list] Error:", err.message);
        res.writeHead(200);
        res.end(JSON.stringify([]));
      }
      return;
    }

    // 17. Adapters (Message Platforms)
    if (pathname === "/api/adapters" && req.method === "GET") {
      const list = this.ctx.adapterRegistry.getAllAdapters().map(a => ({
        id: a.meta().id,
        name: a.meta().name,
        type: a.meta().name,
        status: a.status,
        isRunning: a.isRunning,
        meta: a.meta(),
        config: (a as any).config || {},
      }));
      res.writeHead(200);
      res.end(JSON.stringify(list));
      return;
    }

    if (pathname === "/api/adapters" && req.method === "POST") {
      const body = await this.readBody(req);
      const { type, id, config } = JSON.parse(body);
      if (!type || !id) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing type or id" }));
        return;
      }
      try {
        const fullConfig = { type, id, ...config };
        const adapter = await this.ctx.adapterRegistry.addAndStart(type, fullConfig, this.ctx.eventQueue);
        this.ctx.adapterStore?.save(fullConfig as any);
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          adapter: {
            id: adapter.meta().id,
            name: adapter.meta().name,
            type: adapter.meta().name,
            status: adapter.status,
            isRunning: adapter.isRunning,
            meta: adapter.meta(),
            config: (adapter as any).config || {},
          }
        }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname.startsWith("/api/adapters/") && req.method === "DELETE") {
      const id = pathname.substring("/api/adapters/".length);
      try {
        const success = await this.ctx.adapterRegistry.removeAdapter(id);
        // 从数据库删除
        if (success) this.ctx.adapterStore?.delete(id);
        res.writeHead(200);
        res.end(JSON.stringify({ success }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // PUT /api/adapters/:id — 更新适配器配置（删除旧实例 + 创建新实例）
    if (pathname.startsWith("/api/adapters/") && req.method === "PUT") {
      const id = decodeURIComponent(pathname.substring("/api/adapters/".length));
      try {
        const body = await this.readBody(req);
        const { type, config } = JSON.parse(body);
        if (!type) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing adapter type" }));
          return;
        }
        // Stop & remove old adapter (ignore errors)
        try {
          await this.ctx.adapterRegistry.removeAdapter(id);
        } catch (removeErr: any) {
          console.warn(`[DashboardServer] Warning: failed to stop old adapter ${id}:`, removeErr.message);
          // Force remove from map even if stop failed
          (this.ctx.adapterRegistry as any).adapters.delete(id);
        }
        // Create new adapter with updated config
        const fullConfig = { ...config, type, id };
        const adapter = await this.ctx.adapterRegistry.addAndStart(
          type, fullConfig, this.ctx.eventQueue,
        );
        // 持久化到数据库
        this.ctx.adapterStore?.save(fullConfig as any);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, adapter: { id: adapter.meta().id, status: adapter.status } }));
      } catch (err: any) {
        console.error("[DashboardServer] PUT /api/adapters error:", err);
        try {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message || String(err) }));
        } catch { /* response already sent */ }
      }
      return;
    }

    // GET /api/adapters/:id/qrcode — 获取 weixin_oc 适配器二维码登录状态
    if (pathname.startsWith("/api/adapters/") && pathname.endsWith("/qrcode") && req.method === "GET") {
      const id = decodeURIComponent(pathname.substring("/api/adapters/".length, pathname.length - "/qrcode".length));
      try {
        const adapter = this.ctx.adapterRegistry.getAdapter(id);
        if (!adapter) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Adapter not found" }));
          return;
        }
        if (typeof (adapter as any).getLoginStatus === "function") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify((adapter as any).getLoginStatus()));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ loggedIn: true, qrStatus: null, qrImgContent: null, qrError: null }));
        }
      } catch (err: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // PATCH /api/adapters/:id/toggle — 停用/启用适配器
    if (pathname.startsWith("/api/adapters/") && pathname.endsWith("/toggle") && req.method === "PATCH") {
      const id = decodeURIComponent(pathname.substring("/api/adapters/".length, pathname.length - "/toggle".length));
      try {
        const adapter = this.ctx.adapterRegistry.getAdapter(id);
        const savedConfig = this.ctx.adapterStore?.get(id);

        if (adapter && adapter.isRunning) {
          // 停用：只停止运行，不从 registry 删除
          try { await adapter.stop(); } catch(e) { console.warn(`[DashboardServer] Stop adapter ${id}:`, e); }
          adapter.setStatus("stopped");
          // 更新 DB 中的 enabled 标记
          if (savedConfig) {
            this.ctx.adapterStore?.save({ ...savedConfig, enabled: false } as any);
          }
        } else {
          // 启用：如果实例存在则重启，否则从 DB 配置重新创建
          if (adapter && !adapter.isRunning) {
            adapter.setStatus("running");
            adapter.run().catch(e => {
              console.error(`[DashboardServer] Adapter ${id} crashed on restart:`, e);
              adapter.setStatus("error");
            });
            if (savedConfig) {
              this.ctx.adapterStore?.save({ ...savedConfig, enabled: true } as any);
            }
          } else if (savedConfig) {
            // 实例不存在，从 DB 重新创建并启动
            savedConfig.enabled = true;
            await this.ctx.adapterRegistry.addAndStart(savedConfig.type, savedConfig as any, this.ctx.eventQueue);
            this.ctx.adapterStore?.save(savedConfig as any);
          } else {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "No saved config for this adapter" }));
            return;
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 18. Conversations (Chat Data)
    if (pathname === "/api/conversations" && req.method === "GET") {
      const store = (this.ctx.conversationManager as any).store;
      if (!store) {
        res.writeHead(200);
        res.end(JSON.stringify({ list: [], total: 0 }));
        return;
      }
      const page = parseInt(url.searchParams.get("page") || "1");
      const pageSize = parseInt(url.searchParams.get("pageSize") || "20");
      const searchQuery = url.searchParams.get("searchQuery") || "";
      const [list, total] = await store.getFilteredConversations({ page, pageSize, searchQuery });
      res.writeHead(200);
      res.end(JSON.stringify({ list, total }));
      return;
    }

    if (pathname.startsWith("/api/conversations/") && req.method === "GET") {
      const id = pathname.substring("/api/conversations/".length);
      const store = (this.ctx.conversationManager as any).store;
      if (!store) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Store not available" }));
        return;
      }
      const conv = await store.getConversationById(id);
      if (!conv) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Conversation not found" }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(conv));
      return;
    }

    // 18.5. PUT /api/conversations/:id - 编辑对话历史（防上下文污染）
    if (pathname.startsWith("/api/conversations/") && req.method === "PUT") {
      const id = pathname.substring("/api/conversations/".length);
      const store = (this.ctx.conversationManager as any).store;
      try {
        if (!store) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Store not available" }));
          return;
        }

        const body = await this.readBody(req);
        const { history } = JSON.parse(body);

        if (!Array.isArray(history)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "history must be an array" }));
          return;
        }

        for (const msg of history) {
          if (typeof msg.role !== "string" || typeof msg.content !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Each message must have role (string) and content (string)" }));
            return;
          }
        }

        await store.updateConversation(id, { history: JSON.stringify(history) });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, updatedCount: history.length }));
      } catch (err: any) {
        console.error("[Dashboard] Error updating conversation:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message || "更新对话失败" }));
      }
      return;
    }

    if (pathname.startsWith("/api/conversations/") && req.method === "DELETE") {
      const id = pathname.substring("/api/conversations/".length);
      const store = (this.ctx.conversationManager as any).store;
      if (store) {
        await store.deleteConversation(id);
      }
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 19. Plugins
    if (pathname === "/api/plugins" && req.method === "GET") {
      const list = this.ctx.pluginManager.getAllStars();
      res.writeHead(200);
      res.end(JSON.stringify(list));
      return;
    }

    if (pathname === "/api/plugins/toggle" && req.method === "POST") {
      const body = await this.readBody(req);
      const { modulePath, activated } = JSON.parse(body);
      if (!modulePath) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing modulePath" }));
        return;
      }
      if (activated) {
        this.ctx.pluginManager.activateStar(modulePath);
      } else {
        this.ctx.pluginManager.deactivateStar(modulePath);
      }
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 20. GET /api/config/provider_sources/models - 获取提供商可用模型列表 (Dashboard 用)
    if (pathname === "/api/config/provider_sources/models" && req.method === "GET") {
      const sourceId = url.searchParams.get("source_id");

      try {
        let apiKey = "";
        let apiBase = "";
        let providerType = "openai";

        if (sourceId) {
          // 从已保存的配置中读取（优先查 providerConfigs，再查 provider_sources 表）
          // NOTE: API keys must never be accepted via URL query params — they
          // would leak into access logs, browser history, and Referer headers.
          // Use POST /api/providers/models with a JSON body for the "type a new
          // key and fetch models" scenario instead.
          const sqliteStore = (this.ctx.providerManager as any).sqliteStore;
          let providerConfig = this.ctx.providerManager.getProviderConfigById(sourceId, true);

          if (!providerConfig && sqliteStore) {
            try {
              const source = sqliteStore.getProviderSource(sourceId);
              if (source) {
                providerConfig = {
                  key: source.key,
                  api_base: source.api_base,
                  type: source.type,
                  provider: source.provider,
                  ...source.extra_config,
                };
              }
            } catch { /* table may not exist yet */ }
          }

          if (!providerConfig) {
            res.writeHead(404);
            res.end(JSON.stringify({ status: "error", message: `Provider source '${sourceId}' not found` }));
            return;
          }
          apiKey = (providerConfig.key || providerConfig.apiKey || "") as string;
          apiBase = (providerConfig.api_base || providerConfig.baseUrl || "") as string;
          providerType = (providerConfig.type || providerConfig.provider || "openai") as string;
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ status: "error", message: "Missing source_id parameter. To fetch models for an unsaved key, POST to /api/providers/models with a JSON body." }));
          return;
        }

        if (!apiKey) {
          res.writeHead(400);
          res.end(JSON.stringify({ status: "error", message: "API Key 未配置，无法获取模型列表" }));
          return;
        }

        // 调用内部方法获取模型列表
        const models = await this.fetchModelsFromProvider(providerType, {
          apiKey,
          baseUrl: apiBase,
        });

        // 构建元数据映射（简化版）
        const modelMetadata: Record<string, any> = {};
        for (const model of models) {
          modelMetadata[model] = {
            modalities: { input: ["text", "image"] },
            tool_call: true,
            reasoning: model.includes("reasoning") || model.includes("think"),
            limit: { context: model.includes("32k") ? 32768 : model.includes("128k") ? 131072 : 1024 },
          };
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          status: "ok",
          data: {
            models,
            model_metadata: modelMetadata,
          },
        }));
        return;
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: err.message || "获取模型列表失败" }));
        return;
      }
    }

    // ── Provider Template & Source Management APIs ──

    // 21. GET /api/config/provider/template — 获取提供商模板、源和模型列表
    if (pathname === "/api/config/provider/template" && req.method === "GET") {
      try {
        const configTemplate = this.buildProviderTemplates();
        const sqliteStore = (this.ctx.providerManager as any).sqliteStore;
        let providerSources: any[] = [];
        let providers: any[] = [];

        if (sqliteStore) {
          try {
            providerSources = sqliteStore.getAllProviderSources().map((s: any) => ({
              id: s.id,
              type: s.type,
              provider_type: s.provider_type,
              provider: s.provider,
              // Mask the secret in list responses; the save endpoint resolves
              // the MASKED_SECRET sentinel back to the stored key on write.
              key: maskSecret(s.key),
              api_base: s.api_base,
              enable: s.enable,
              ...s.extra_config,
            }));
          } catch {
            // provider_sources 表可能尚未创建（首次使用），返回空数组
            providerSources = [];
          }
        }

        // 从 providerConfigs 构建提供商列表
        const providerConfigsMap = this.ctx.providerManager.providerConfigs;
        const disabledIds = this.ctx.providerManager.getDisabledIds();
        for (const [id, config] of providerConfigsMap.entries()) {
          providers.push({
            id,
            enable: !disabledIds.includes(id),
            model: (config as any).model || "",
            provider_source_id: (config as any).provider_source_id || "",
            provider_type: (config as any).provider_type || this.guessProviderTypeFromConfig(config),
            type: (config as any).type || "",
            modalities: (config as any).modalities || [],
            custom_extra_body: (config as any).custom_extra_body || {},
            max_context_tokens: (config as any).max_context_tokens || 0,
            reasoning: (config as any).reasoning || false,
          });
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          status: "ok",
          data: {
            config_schema: {
              provider: {
                config_template: configTemplate,
              },
            },
            provider_sources: providerSources,
            providers: providers,
          },
        }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: err.message || "获取模板失败" }));
      }
      return;
    }

    // 22. POST /api/config/provider_sources/update — 创建或更新提供商源
    if (pathname === "/api/config/provider_sources/update" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const payload = JSON.parse(body);
        const { config, original_id } = payload;
        if (!config || !config.id) {
          res.writeHead(400);
          res.end(JSON.stringify({ status: "error", message: "缺少配置或 ID" }));
          return;
        }

        const sqliteStore = (this.ctx.providerManager as any).sqliteStore;
        if (!sqliteStore) {
          res.writeHead(500);
          res.end(JSON.stringify({ status: "error", message: "数据库未初始化" }));
          return;
        }

        // 如果 ID 变更，删除旧记录
        if (original_id && original_id !== config.id) {
          sqliteStore.deleteProviderSource(original_id);
          // 同时更新关联的 provider 的 provider_source_id
          const providerConfigsMap = this.ctx.providerManager.providerConfigs;
          for (const [pid, pconfig] of providerConfigsMap.entries()) {
            if ((pconfig as any).provider_source_id === original_id) {
              (pconfig as any).provider_source_id = config.id;
              await this.ctx.providerManager.updateProvider(pid, pconfig as any);
            }
          }
        }

        // 分离基础字段和额外配置
        const basicKeys = new Set(["id", "type", "provider_type", "provider", "key", "api_base", "enable"]);
        const extraConfig: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(config)) {
          if (!basicKeys.has(k)) extraConfig[k] = v;
        }

        // Resolve the masked sentinel: if the client sent back the masked
        // value (i.e. the user did not edit the key field), keep the
        // previously-stored key instead of overwriting it with the sentinel.
        let resolvedKey = config.key || "";
        if (resolvedKey === MASKED_SECRET) {
          const lookupId = original_id && original_id !== config.id ? original_id : config.id;
          try {
            const existing = sqliteStore.getProviderSource(lookupId);
            resolvedKey = (existing?.key as string) || "";
          } catch {
            resolvedKey = "";
          }
        }

        const now = new Date().toISOString();
        sqliteStore.saveProviderSource({
          id: config.id,
          type: config.type || "",
          provider_type: config.provider_type || "chat_completion",
          provider: config.provider || "",
          key: resolvedKey,
          api_base: config.api_base || "",
          enable: config.enable !== false,
          extra_config: extraConfig,
          createdAt: now,
          updatedAt: now,
        });

        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok", message: "提供商源已保存" }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: err.message || "保存失败" }));
      }
      return;
    }

    // 23. POST /api/config/provider_sources/delete — 删除提供商源
    if (pathname === "/api/config/provider_sources/delete" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const payload = JSON.parse(body);
        const { id } = payload;
        if (!id) {
          res.writeHead(400);
          res.end(JSON.stringify({ status: "error", message: "缺少 ID" }));
          return;
        }

        const sqliteStore = (this.ctx.providerManager as any).sqliteStore;
        if (!sqliteStore) {
          res.writeHead(500);
          res.end(JSON.stringify({ status: "error", message: "数据库未初始化" }));
          return;
        }

        // 删除关联的 providers
        const providerConfigsMap = this.ctx.providerManager.providerConfigs;
        const idsToDelete: string[] = [];
        for (const [pid, pconfig] of providerConfigsMap.entries()) {
          if ((pconfig as any).provider_source_id === id) {
            idsToDelete.push(pid);
          }
        }
        for (const pid of idsToDelete) {
          await this.ctx.providerManager.deleteProvider(pid);
        }

        // 删除源
        sqliteStore.deleteProviderSource(id);

        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok", message: "提供商源已删除" }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: err.message || "删除失败" }));
      }
      return;
    }

    // 24. POST /api/config/provider/new — 新建提供商（模型实例）
    if (pathname === "/api/config/provider/new" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const providerConfig = JSON.parse(body);
        if (!providerConfig.id) {
          res.writeHead(400);
          res.end(JSON.stringify({ status: "error", message: "缺少提供商 ID" }));
          return;
        }

        // 查找关联的 provider source 以获取连接信息
        // 注意：source.type 仅作为默认值，用户显式指定的 config.type 优先
        const sqliteStore = (this.ctx.providerManager as any).sqliteStore;
        let sourceType = providerConfig.type || "";
        let apiKey = providerConfig.key || "";
        let apiBase = providerConfig.api_base || "";

        if (sqliteStore && providerConfig.provider_source_id) {
          const source = sqliteStore.getProviderSource(providerConfig.provider_source_id);
          if (source) {
            // 仅当用户未显式指定类型时才使用 source 的类型
            if (!providerConfig.type) {
              sourceType = source.type;
            }
            apiKey = source.key || apiKey;
            apiBase = source.api_base || apiBase;
          }
        }

        if (!sourceType) {
          res.writeHead(400);
          res.end(JSON.stringify({ status: "error", message: "无法确定提供商类型" }));
          return;
        }

        // 构建 loadConfig
        const loadConfig: Record<string, unknown> = {
          id: providerConfig.id,
          type: sourceType,
          model: providerConfig.model || "",
          apiKey,
          baseUrl: apiBase,
          provider_source_id: providerConfig.provider_source_id || "",
          provider_type: providerConfig.provider_type || "chat_completion",
          modalities: providerConfig.modalities || [],
          custom_extra_body: providerConfig.custom_extra_body || {},
          max_context_tokens: providerConfig.max_context_tokens || 0,
          reasoning: providerConfig.reasoning || false,
          enable: providerConfig.enable !== false,
        };

        // 合并 source 的额外配置
        if (sqliteStore && providerConfig.provider_source_id) {
          const source = sqliteStore.getProviderSource(providerConfig.provider_source_id);
          if (source && source.extra_config) {
            Object.assign(loadConfig, source.extra_config);
          }
        }

        await this.ctx.providerManager.loadProvider(loadConfig as any);

        if (providerConfig.enable === false) {
          this.ctx.providerManager.setDisabled(providerConfig.id);
        }

        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok", message: "提供商已创建" }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: err.message || "创建失败" }));
      }
      return;
    }

    // 25. POST /api/config/provider/delete — 删除提供商
    if (pathname === "/api/config/provider/delete" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const payload = JSON.parse(body);
        const { id } = payload;
        if (!id) {
          res.writeHead(400);
          res.end(JSON.stringify({ status: "error", message: "缺少提供商 ID" }));
          return;
        }

        await this.ctx.providerManager.deleteProvider(id);
        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok", message: "提供商已删除" }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: err.message || "删除失败" }));
      }
      return;
    }

    // 26. POST /api/config/provider/update — 更新提供商
    if (pathname === "/api/config/provider/update" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const payload = JSON.parse(body);
        const { id, config } = payload;
        if (!id || !config) {
          res.writeHead(400);
          res.end(JSON.stringify({ status: "error", message: "缺少 ID 或配置" }));
          return;
        }

        // 查找关联的 provider source 以获取连接信息
        // 注意：source.type 仅作为默认值，用户显式指定的 config.type 优先
        const sqliteStore = (this.ctx.providerManager as any).sqliteStore;
        let sourceType = config.type || "";
        let apiKey = config.key || "";
        let apiBase = config.api_base || "";

        if (sqliteStore && config.provider_source_id) {
          const source = sqliteStore.getProviderSource(config.provider_source_id);
          if (source) {
            // 仅当用户未显式指定类型时才使用 source 的类型
            if (!config.type) {
              sourceType = source.type;
            }
            apiKey = source.key || apiKey;
            apiBase = source.api_base || apiBase;
          }
        }

        const loadConfig: Record<string, unknown> = {
          ...config,
          id: config.id || id,
          type: sourceType,
          apiKey,
          baseUrl: apiBase,
        };

        await this.ctx.providerManager.updateProvider(id, loadConfig as any);

        if (config.enable === false) {
          this.ctx.providerManager.setDisabled(config.id || id);
        } else {
          this.ctx.providerManager.setEnabled(config.id || id);
        }

        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok", message: "提供商已更新" }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: err.message || "更新失败" }));
      }
      return;
    }

    // 27. GET /api/config/provider/check_one — 测试提供商连通性
    if (pathname === "/api/config/provider/check_one" && req.method === "GET") {
      const providerId = url.searchParams.get("id");
      if (!providerId) {
        res.writeHead(400);
        res.end(JSON.stringify({ status: "error", message: "缺少提供商 ID" }));
        return;
      }

      try {
        const providerConfig = this.ctx.providerManager.getProviderConfigById(providerId, true);
        if (!providerConfig) {
          res.writeHead(200);
          res.end(JSON.stringify({ status: "ok", data: { error: `提供商 ${providerId} 不存在` } }));
          return;
        }

        const type = String(providerConfig.type || "openai");
        const apiKey = String(providerConfig.apiKey || providerConfig.key || "");
        const baseUrl = String(providerConfig.baseUrl || providerConfig.api_base || "");
        const model = String(providerConfig.model || "test");

        if (!apiKey) {
          res.writeHead(200);
          res.end(JSON.stringify({ status: "ok", data: { error: "API Key 未配置" } }));
          return;
        }

        // 使用完整配置（含实际模型名）创建临时 provider 进行测试，确保测试结果反映真实对话行为
        const { createChatProvider } = await import("@yachiyo/provider/factory.js");
        const prov = createChatProvider(type as any, { apiKey, baseUrl, model, modalities: providerConfig.modalities || [] } as any);

        // 优先使用流式调用测试（与实际对话一致），配置禁用或不支持流式时回退到非流式
        const config = this.ctx.configManager.getActiveConfig();
        const modelStreaming = config?.modelStreaming ?? true;

        if (modelStreaming && prov.textChatStream) {
          let received = false;
          for await (const chunk of prov.textChatStream({
            contexts: [{ role: "user", content: "hello" } as any],
          })) {
            if (chunk.completionText || chunk.reasoningContent || chunk.toolsCallName) {
              received = true;
              break; // 收到有效内容后确认连通并退出
            }
          }
          if (!received) throw new Error("流式响应未返回有效内容");
        } else {
          await prov.textChat({
            contexts: [{ role: "user", content: "hello" } as any],
          });
        }

        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok", data: { error: null } }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok", data: { error: err.message || "测试失败" } }));
      }
      return;
    }

    // 28. GET /api/stat/get — 获取基础统计数据
    if (pathname === "/api/stat/get" && req.method === "GET") {
      const _offsetSec = parseInt(url.searchParams.get("offset_sec") || "86400", 10);
      try {
        const now = Date.now();
        const memUsage = process.memoryUsage();
        const adapters = this.ctx.adapterRegistry?.getAllAdapters() || [];
        const messageCount = await this.ctx.conversationManager.getMessageCount();

        res.writeHead(200);
        res.end(JSON.stringify({
          status: "ok",
          data: {
            platform_count: adapters.length,
            message_count: messageCount,
            cpu_percent: this.calculateCpuUsage(),
            memory: { process: memUsage.rss, system: totalmem() },
            running: Math.floor((now - this.startTime) / 1000),
            start_time: Math.floor(this.startTime / 1000),
            message_time_series: [],
            platform: adapters.map((a: any) => ({
              name: a.meta?.().name || a.meta?.().id || "unknown",
              count: 0,
            })),
          },
        }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    // 29. GET /api/stat/provider-tokens — 获取提供商 Token 统计（真实数据）
    if (pathname === "/api/stat/provider-tokens" && req.method === "GET") {
      const days = parseInt(url.searchParams.get("days") || "1", 10);
      try {
        const since = new Date(Date.now() - days * 86400000);
        const stats = await this.ctx.conversationManager.getProviderStats({ since, limit: 10000 });

        // Aggregate by model (fallback to providerId when model is empty)
        const modelAgg = new Map<string, {
          tokens: number; calls: number; ttftSum: number; durationSum: number;
        }>();
        for (const s of stats) {
          const totalTokens = (s.tokenInputOther || 0) + (s.tokenInputCached || 0) + (s.tokenOutput || 0);
          // Use model name, fall back to providerId for legacy records with empty model
          const key = s.model?.trim() || s.providerId || "unknown";
          const prev = modelAgg.get(key) || { tokens: 0, calls: 0, ttftSum: 0, durationSum: 0 };
          prev.tokens += totalTokens;
          prev.calls += 1;
          const duration = Math.max(0, (s.endTime || 0) - (s.startTime || 0));
          const ttft = (s.timeToFirstToken && s.timeToFirstToken > 0) ? s.timeToFirstToken : duration;
          prev.ttftSum += ttft;
          prev.durationSum += duration;
          modelAgg.set(key, prev);
        }

        const providers = Array.from(modelAgg.entries())
          .map(([model, agg]) => ({
            model,
            tokens: agg.tokens,
            _calls: agg.calls,
            _ttftSum: agg.ttftSum,
            _durationSum: agg.durationSum,
          }))
          .sort((a, b) => b.tokens - a.tokens);

        const totalTokens = providers.reduce((sum, p) => sum + p.tokens, 0);
        const totalCalls = providers.reduce((sum, p) => sum + p._calls, 0);
        const avgTtft = totalCalls > 0 ? providers.reduce((s, p) => s + p._ttftSum, 0) / totalCalls : 0;
        const avgDuration = totalCalls > 0 ? providers.reduce((s, p) => s + p._durationSum, 0) / totalCalls : 0;

        // Clean internal fields for response
        const ranking = providers.map(({ model, tokens }) => ({ model, tokens }));

        // Calculate today's stats
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayStats = stats.filter(s => s.createdAt >= todayStart);
        const todayTokens = todayStats.reduce((sum, s) => sum + (s.tokenInputOther || 0) + (s.tokenInputCached || 0) + (s.tokenOutput || 0), 0);
        const todayCalls = todayStats.length;

        // Aggregate today by provider
        const todayModelAgg = new Map<string, number>();
        for (const s of todayStats) {
          const t = (s.tokenInputOther || 0) + (s.tokenInputCached || 0) + (s.tokenOutput || 0);
          const key = s.model?.trim() || s.providerId || "unknown";
          todayModelAgg.set(key, (todayModelAgg.get(key) || 0) + t);
        }
        const todayByProvider = Array.from(todayModelAgg.entries())
          .map(([model, tokens]) => ({ model, tokens }))
          .sort((a, b) => b.tokens - a.tokens);

        // TPM: tokens per minute across the entire range
        const rangeMinutes = days * 24 * 60;
        const avgTpm = rangeMinutes > 0 ? Math.round(totalTokens / rangeMinutes) : 0;

        res.writeHead(200);
        res.end(JSON.stringify({
          status: "ok",
          data: {
            days,
            today_total_tokens: todayTokens,
            today_total_calls: todayCalls,
            today_by_provider: todayByProvider,
            trend: {
              series: this.generateTrendSeriesFromStats(stats, days),
            },
            range_by_provider: ranking,
            range_total_tokens: totalTokens,
            range_total_calls: totalCalls,
            range_avg_ttft_ms: Math.round(avgTtft),
            range_avg_duration_ms: Math.round(avgDuration),
            range_avg_tpm: avgTpm,
            range_success_rate: 1.0,
          },
        }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    // 30. GET /api/tools/mcp/servers — Enhanced MCP server list with runtime info
    if (pathname === "/api/tools/mcp/servers" && req.method === "GET") {
      try {
        const sqliteStore = (this.ctx.providerManager as any).sqliteStore;
        const mcpConfigs = sqliteStore ? sqliteStore.getAllMcpServerConfigs() : [];
        const toolMgr = this.ctx.toolManager as any;
        const mcpClientDict = toolMgr?.mcpClientDict as Map<string, any> | undefined;

        const servers = mcpConfigs.map((cfg: any) => {
          const client = mcpClientDict?.get(cfg.serverName);
          return {
            name: cfg.serverName,
            config: cfg.config,
            active: client?.active ?? false,
            tools: client?.tools?.map((t: any) => t.name) ?? [],
            errlogs: client?.serverErrLogs ?? [],
            createdAt: cfg.createdAt,
            updatedAt: cfg.updatedAt,
          };
        });

        res.writeHead(200);
        res.end(JSON.stringify(servers));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify([]));
      }
      return;
    }

    // 31. POST /api/tools/mcp/test — Test MCP server connection
    if (pathname === "/api/tools/mcp/test" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const { config } = JSON.parse(body);
        const { quickTestMcpConnection } = await import("@yachiyo/agent/mcp-client.js");
        const [success, error] = await quickTestMcpConnection(config);
        if (success) {
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, tools: [], message: "连接成功" }));
        } else {
          res.writeHead(200);
          res.end(JSON.stringify({ success: false, tools: [], message: error || "连接失败" }));
        }
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, tools: [], message: err.message || "连接失败" }));
      }
      return;
    }

    // 32. POST /api/tools/mcp/update — Update MCP server (including toggle active)
    if (pathname === "/api/tools/mcp/update" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const { serverName, config, active, oldName } = JSON.parse(body);
        const sqliteStore = (this.ctx.providerManager as any).sqliteStore;

        if (oldName && oldName !== serverName && sqliteStore) {
          sqliteStore.deleteMcpServerConfig(oldName);
        }

        if (sqliteStore) {
          sqliteStore.saveMcpServerConfig({
            serverName,
            config: config || {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }

        // Handle active/inactive toggle
        if (typeof active === "boolean") {
          const toolMgr = this.ctx.toolManager as any;
          if (active) {
            await toolMgr?.enableMcpServer?.(serverName, config || {});
          } else {
            await toolMgr?.disableMcpServer?.(serverName);
          }
        }

        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
      return;
    }

    // 33. POST /api/tools/mcp/delete — Delete MCP server
    if (pathname === "/api/tools/mcp/delete" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const { serverName } = JSON.parse(body);
        const sqliteStore = (this.ctx.providerManager as any).sqliteStore;
        if (sqliteStore) sqliteStore.deleteMcpServerConfig(serverName);
        const toolMgr = this.ctx.toolManager as any;
        await toolMgr?.terminateMcpClient?.(serverName);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
      return;
    }

    // 34. GET /api/skills/download — Download skill as zip
    if (pathname === "/api/skills/download" && req.method === "GET") {
      try {
        const skillName = url.searchParams.get("name");
        if (!skillName) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing name parameter" }));
          return;
        }
        const skills = this.ctx.skillManager.listSkills();
        const skill = skills.find((s: any) => s.name === skillName);
        if (!skill?.path) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Skill not found or no path" }));
          return;
        }

        const { createReadStream: _createReadStream } = await import("fs");

        // Simple: serve the skill directory as a zip using archiver or fallback
        const skillPath = skill.path;
        const statResult = await stat(skillPath).catch(() => null);
        if (!statResult) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Skill path not accessible" }));
          return;
        }

        // Use JSZip-like approach or just return the directory listing
        const Archiver = await import("archiver").catch(() => null);
        if (Archiver) {
          res.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="${skillName}.zip"`,
          });
          const archive = (Archiver as any).default("zip", { zlib: { level: 9 } });
          archive.pipe(res);
          archive.directory(skillPath, false);
          await archive.finalize();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Archiver not available", path: skillPath }));
        }
      } catch (err: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 35. GET /api/skills/files — List skill directory files
    if (pathname === "/api/skills/files" && req.method === "GET") {
      try {
        const skillName = url.searchParams.get("name");
        const subPath = url.searchParams.get("path") || "";
        if (!skillName) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing name" }));
          return;
        }
        const skills = this.ctx.skillManager.listSkills();
        const skill = skills.find((s: any) => s.name === skillName);
        if (!skill?.path) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Skill not found" }));
          return;
        }
        if (!isPathSafe(skill.path, subPath)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid path" }));
          return;
        }
        const dirPath = join(skill.path, subPath);
        const entries = await readdir(dirPath, { withFileTypes: true });
        const files = entries.map((e: any) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          path: subPath ? `${subPath}/${e.name}` : e.name,
        }));
        res.writeHead(200);
        res.end(JSON.stringify(files));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify([]));
      }
      return;
    }

    // ── Memory APIs ──

    // M1. GET /api/memories — 列出记忆（支持分页、搜索、类型/作用域筛选）
    if (pathname === "/api/memories" && req.method === "GET") {
      try {
        const memoryStore = (this.ctx as any).memoryStore;
        if (!memoryStore) {
          res.writeHead(200);
          res.end(JSON.stringify({ memories: [], total: 0 }));
          return;
        }
        const limit = parseInt(url.searchParams.get("limit") || "50");
        const query = url.searchParams.get("search") || "";
        const memoryType = url.searchParams.get("memory_type") || undefined;
        const scope = url.searchParams.get("scope") || undefined;
        const scopeId = url.searchParams.get("scope_id") || undefined;

        const filterOptions: any = {};
        if (memoryType) filterOptions.memoryType = memoryType;
        if (scope) filterOptions.scope = scope;
        if (scopeId) filterOptions.scopeId = scopeId;

        let memories: any[];
        if (query) {
          memories = memoryStore.search(query, limit, filterOptions);
        } else {
          memories = memoryStore.list(limit, filterOptions);
        }
        const total = memoryStore.count(filterOptions);
        res.writeHead(200);
        res.end(JSON.stringify({ memories, total }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ memories: [], total: 0, error: err.message }));
      }
      return;
    }

    // M2. POST /api/memories — 新建/更新记忆（支持分层参数）
    if (pathname === "/api/memories" && req.method === "POST") {
      try {
        const memoryStore = (this.ctx as any).memoryStore;
        if (!memoryStore) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Memory store not initialized" }));
          return;
        }
        const body = await this.readBody(req);
        const { key, value, tags, memory_type, scope, scope_id, priority, expires_at } = JSON.parse(body);
        if (!key) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing key" }));
          return;
        }
        const options: any = {};
        if (memory_type) options.memoryType = memory_type;
        if (scope) options.scope = scope;
        if (scope_id) options.scopeId = scope_id;
        if (priority !== undefined) options.priority = priority;
        if (expires_at !== undefined) options.expiresAt = expires_at;

        memoryStore.save(key, value || "", tags || [], options);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // M3. GET /api/memories/search — 搜索记忆（支持类型/作用域筛选）
    if (pathname === "/api/memories/search" && req.method === "GET") {
      try {
        const memoryStore = (this.ctx as any).memoryStore;
        if (!memoryStore) {
          res.writeHead(200);
          res.end(JSON.stringify([]));
          return;
        }
        const query = url.searchParams.get("q") || "";
        const limit = parseInt(url.searchParams.get("limit") || "20");
        const memoryType = url.searchParams.get("memory_type") || undefined;
        const scope = url.searchParams.get("scope") || undefined;
        const scopeId = url.searchParams.get("scope_id") || undefined;
        if (!query) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing search query" }));
          return;
        }
        const filterOptions: any = {};
        if (memoryType) filterOptions.memoryType = memoryType;
        if (scope) filterOptions.scope = scope;
        if (scopeId) filterOptions.scopeId = scopeId;

        const memories = memoryStore.search(query, limit, filterOptions);
        res.writeHead(200);
        res.end(JSON.stringify(memories));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify([]));
      }
      return;
    }

    // M4. DELETE /api/memories/:key — 删除记忆
    if (pathname.startsWith("/api/memories/") && req.method === "DELETE") {
      try {
        const memoryStore = (this.ctx as any).memoryStore;
        if (!memoryStore) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Memory store not initialized" }));
          return;
        }
        const key = decodeURIComponent(pathname.substring("/api/memories/".length));
        if (!key) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing key" }));
          return;
        }
        const deleted = memoryStore.delete(key);
        res.writeHead(200);
        res.end(JSON.stringify({ success: deleted }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // M5. POST /api/memories/clear — 清空所有记忆
    if (pathname === "/api/memories/clear" && req.method === "POST") {
      try {
        const memoryStore = (this.ctx as any).memoryStore;
        if (!memoryStore) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Memory store not initialized" }));
          return;
        }
        const count = memoryStore.clear();
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, deletedCount: count }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // M6. GET /api/memories/stats — 记忆统计
    if (pathname === "/api/memories/stats" && req.method === "GET") {
      try {
        const memoryStore = (this.ctx as any).memoryStore;
        if (!memoryStore) {
          res.writeHead(200);
          res.end(JSON.stringify({ total: 0, byType: {}, byScope: {} }));
          return;
        }
        const stats = memoryStore.stats();
        res.writeHead(200);
        res.end(JSON.stringify(stats));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ total: 0, byType: {}, byScope: {}, error: err.message }));
      }
      return;
    }

    // M7. POST /api/memories/consolidate — 手动触发记忆整理
    if (pathname === "/api/memories/consolidate" && req.method === "POST") {
      try {
        const consolidator = (this.ctx as any).memoryConsolidator;
        if (!consolidator) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Memory consolidator not initialized" }));
          return;
        }
        const result = await consolidator.consolidate({ force: true });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, result }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // M8. GET /api/memories/consolidation-config — 获取整理配置
    if (pathname === "/api/memories/consolidation-config" && req.method === "GET") {
      try {
        const consolidator = (this.ctx as any).memoryConsolidator;
        if (!consolidator) {
          res.writeHead(200);
          res.end(JSON.stringify({ enabled: false }));
          return;
        }
        const config = consolidator.getConfig();
        res.writeHead(200);
        res.end(JSON.stringify(config));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ enabled: false, error: err.message }));
      }
      return;
    }

    // M9. PATCH /api/memories/consolidation-config — 更新整理配置
    if (pathname === "/api/memories/consolidation-config" && req.method === "PATCH") {
      try {
        const consolidator = (this.ctx as any).memoryConsolidator;
        if (!consolidator) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Memory consolidator not initialized" }));
          return;
        }
        const body = await this.readBody(req);
        const updates = JSON.parse(body);
        consolidator.updateConfig(updates);
        const config = consolidator.getConfig();
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, config }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // 36. GET /api/skills/file — Read skill file content
    if (pathname === "/api/skills/file" && req.method === "GET") {
      try {
        const skillName = url.searchParams.get("name");
        const filePath = url.searchParams.get("path");
        if (!skillName || !filePath) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing name or path" }));
          return;
        }
        const skills = this.ctx.skillManager.listSkills();
        const skill = skills.find((s: any) => s.name === skillName);
        if (!skill?.path) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Skill not found" }));
          return;
        }
        if (!isPathSafe(skill.path, filePath)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid path" }));
          return;
        }
        const fullPath = join(skill.path, filePath);
        const content = await readFile(fullPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(content);
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 37. POST /api/skills/file — Save skill file content
    if (pathname === "/api/skills/file" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const { name, path: filePath, content } = JSON.parse(body);
        if (!name || !filePath || content === undefined) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing name, path or content" }));
          return;
        }
        const skills = this.ctx.skillManager.listSkills();
        const skill = skills.find((s: any) => s.name === name);
        if (!skill?.path) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Skill not found" }));
          return;
        }
        if (!isPathSafe(skill.path, filePath)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid path" }));
          return;
        }
        const fullPath = join(skill.path, filePath);
        await writeFile(fullPath, content, "utf-8");
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
      return;
    }

    // ---- Debug Webhook: POST /api/debug/chat ----
    // Disabled by default: this endpoint runs the FULL agent pipeline (all
    // tools, file access, shell execution, web scraping) and is therefore an
    // RCE attack surface. It must be explicitly enabled via the
    // `debugChatEnabled` constructor flag (threaded from
    // BootstrapOptions.dashboard.debugChatEnabled). When disabled we return
    // 404 so the endpoint is not even discoverable.
    if (pathname === "/api/debug/chat" && req.method === "POST") {
      if (!this.debugChatEnabled) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Debug chat endpoint is disabled." }));
        return;
      }
      const body = await this.readBody(req);
      const { message, session_id } = JSON.parse(body);
      if (!message) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing 'message' field" }));
        return;
      }

      const sessionId = session_id ?? "debug-session";
      const umo = `debug:webhook:${sessionId}`;

      try {
        const { MessageEvent: ME, PlatformMessage, MessageSession, ResultContentType: RCT } = await import("@yachiyo/message/index.js");
        const { ComponentType } = await import("@yachiyo/message/components.js");
        const { MessageType } = await import("@yachiyo/message/types.js");
        const { generateId: gid } = await import("@yachiyo/common/id-generator.js");

        // Build a synthetic MessageEvent
        const platformMsg = new PlatformMessage();
        platformMsg.type = MessageType.FRIEND_MESSAGE;
        platformMsg.selfId = "debug-webhook";
        platformMsg.sessionId = sessionId;
        platformMsg.messageId = gid();
        platformMsg.sender = { userId: "debug-user", nickname: "Debug User" };
        platformMsg.components = [{ type: ComponentType.Plain, text: message } as any];
        platformMsg.messageStr = message;
        platformMsg.timestamp = Date.now();

        const platformMeta = {
          name: "debug-webhook",
          description: "Debug Webhook",
          id: "debug-webhook",
          supportStreamingMessage: false,
          supportProactiveMessage: false,
        };

        let responseText = "";
        let responseResolve: ((value: void) => void) | null = null;
        const responsePromise = new Promise<void>((r) => { responseResolve = r; });

        const event = new (class extends ME {
          async send(components: any[]): Promise<void> {
            for (const c of components) {
              if (c.type === ComponentType.Plain) responseText += (c as any).text ?? "";
            }
          }
          async sendStreaming(gen: any): Promise<void> {
            for await (const chunk of gen) {
              if (chunk.message) responseText += chunk.message;
            }
          }
          async sendTyping(): Promise<void> {}
          async stopTyping(): Promise<void> {}
          get unifiedMsgOrigin(): string { return umo; }
        })(message, platformMsg, platformMeta, sessionId);

        // Push to event queue
        this.ctx.eventQueue.put(event);

        // Wait for response with timeout
        const timeout = setTimeout(() => { responseResolve?.(); }, 60000);

        // Poll for result
        const pollInterval = setInterval(() => {
          if (event.getResult()) {
            const r = event.getResult();
            if (r?.resultContentType === RCT.LLM_RESULT || r?.resultContentType === RCT.STREAMING_RESULT) {
              const text = r.getPlainText();
              if (text) responseText = text;
            }
            clearInterval(pollInterval);
            clearTimeout(timeout);
            responseResolve?.();
          }
        }, 100);

        await responsePromise;
        clearInterval(pollInterval);
        clearTimeout(timeout);

        res.writeHead(200);
        res.end(JSON.stringify({ response: responseText, session_id: sessionId, umo }));
      } catch (err: any) {
        console.error("[DebugWebhook] Error:", err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ---- Debug: GET /api/debug/conversation ----
    if (pathname === "/api/debug/conversation" && req.method === "GET") {
      const sessionId = url.searchParams.get("session_id") ?? "debug-session";
      const umo = `debug:webhook:${sessionId}`;
      try {
        const convId = await this.ctx.conversationManager.getCurrConversationId(umo);
        let history: any[] = [];
        if (convId) {
          const conv = await this.ctx.conversationManager.getConversation(umo, convId);
          if (conv) history = JSON.parse(conv.history);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ umo, convId, messageCount: history.length, history }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ---- Debug: DELETE /api/debug/conversation ----
    if (pathname === "/api/debug/conversation" && req.method === "DELETE") {
      const sessionId = url.searchParams.get("session_id") ?? "debug-session";
      const umo = `debug:webhook:${sessionId}`;
      try {
        const convId = await this.ctx.conversationManager.getCurrConversationId(umo);
        if (convId) {
          await this.ctx.conversationManager.deleteConversation(umo, convId);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, umo }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "API Endpoint not found" }));
  }

  private async handleStaticRequest(
    _req: IncomingMessage,
    res: ServerResponse,
    pathname: string
  ): Promise<void> {
    const projectRoot = join(process.cwd());
    const publicDir = join(projectRoot, "frontend", "dist");

    // Verify the resolved path stays inside publicDir via a proper
    // directory-containment check (isPathSafe). The previous approach only
    // stripped *leading* `../` sequences with a regex and was trivially
    // bypassed by embedded traversal (e.g. `/a/../..`), encoded variants
    // (`..%2f`), or `....//` — allowing reads of arbitrary files.
    let safePath = pathname;
    if (safePath === "/") safePath = "/index.html";
    // Strip leading slashes so resolve() treats it as relative to publicDir.
    const relPath = safePath.replace(/^\/+/, "");
    if (!isPathSafe(publicDir, relPath)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    let filePath = join(publicDir, relPath);

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        filePath = join(publicDir, "index.html");
      }
    } catch {
      // Fallback to index.html for SPA routing
      filePath = join(publicDir, "index.html");
    }

    try {
      const content = await readFile(filePath);
      const mimeTypes: Record<string, string> = {
        ".html": "text/html",
        ".css": "text/css",
        ".js": "application/javascript",
        ".json": "application/json",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
      };
      const ext = extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || "application/octet-stream";

      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Static File Not Found");
    }
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", (err) => reject(err));
    });
  }

  /**
   * 从提供商获取可用模型列表
   * 支持: openai, openai_responses, gemini, anthropic 及兼容 OpenAI 的自定义端点
   */
  private async fetchModelsFromProvider(type: string, config: Record<string, any>): Promise<string[]> {
    const apiKey = config.apiKey;
    const baseUrl = config.baseUrl;

    // OpenAI 兼容接口 (openai, openai_responses)
    if (type === "openai" || type === "openai_responses") {
      const url = `${baseUrl || "https://api.openai.com/v1"}/models`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        throw new Error(`获取模型列表失败 (${response.status}): ${response.statusText}`);
      }

      const data = await response.json() as any;
      if (!Array.isArray(data.data)) {
        return [];
      }

      // 过滤出聊天模型，按 id 排序
      return data.data
        .map((m: any) => m.id || "")
        .filter((id: string) => !!id && !id.startsWith("babbage-") && !id.startsWith("curie-"))
        .sort();
    }

    // Google Gemini
    if (type === "gemini") {
      if (baseUrl && !baseUrl.includes("generativelanguage.googleapis.com")) {
        let cleanBase = baseUrl.replace(/\/+$/, "");
        const knownSuffixes = ["/v1beta", "/v1"];
        for (const suffix of knownSuffixes) {
          if (cleanBase.endsWith(suffix)) {
            cleanBase = cleanBase.slice(0, -suffix.length);
            break;
          }
        }
        const url = `${cleanBase}/v1/models`;
        console.log(`[Dashboard] Gemini proxy mode: fetching models from ${url}`);
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15000),
        });
        const respText = await response.text();
        console.log(`[Dashboard] Gemini models response status=${response.status}, contentType=${response.headers.get('content-type')}, bodyLen=${respText.length}`);

        if (!response.ok || !respText.startsWith("{")) {
          if (respText.startsWith("<")) {
            throw new Error(`代理端点返回了HTML页面而非JSON (${response.status})，请确认 Base URL 正确指向 OpenAI 兼容 API。请求URL: ${url}`);
          }
          throw new Error(`获取模型列表失败 (${response.status}): ${respText.substring(0, 200)}`);
        }
        const data = JSON.parse(respText) as any;
        if (!Array.isArray(data.data)) return [];
        return data.data
          .map((m: any) => m.id || "")
          .filter((id: string) => !!id)
          .sort();
      }
      // Google 官方端点
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });

      if (!response.ok) {
        throw new Error(`获取模型列表失败 (${response.status}): ${response.statusText}`);
      }

      const data = await response.json() as any;
      if (!Array.isArray(data.models)) {
        return [];
      }

      // 只返回支持 generateContent 的模型
      return data.models
        .filter((m: any) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m: any) => m.name.replace("models/", ""))
        .sort();
    }

    // Anthropic Claude
    if (type === "anthropic") {
      const url = `${baseUrl || "https://api.anthropic.com"}/v1/models`;
      const response = await fetch(url, {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        throw new Error(`获取模型列表失败 (${response.status}): ${response.statusText}`);
      }

      const data = await response.json() as any;
      if (!Array.isArray(data.data)) {
        return [];
      }

      return data.data.map((m: any) => m.id || "").sort();
    }

    throw new Error(`不支持的提供商类型: ${type}，暂无法获取模型列表`);
  }

  /**
   * 构建提供商模板配置，用于前端"添加供应商源"对话框
   */
  private buildProviderTemplates(): Record<string, any> {
    return {
      openai: {
        id: "openai",
        type: "openai",
        provider_type: "chat_completion",
        provider: "openai",
        key: "",
        api_base: "https://api.openai.com/v1",
        model: "gpt-4o",
        modalities: ["text", "image", "tool_use"],
      },
      openai_responses: {
        id: "openai_responses",
        type: "openai_responses",
        provider_type: "chat_completion",
        provider: "openai",
        key: "",
        api_base: "https://api.openai.com/v1",
        model: "gpt-4o",
        modalities: ["text", "image", "tool_use"],
      },
      gemini: {
        id: "gemini",
        type: "gemini",
        provider_type: "chat_completion",
        provider: "google",
        key: "",
        api_base: "",
        model: "gemini-2.0-flash",
        modalities: ["text", "image", "tool_use"],
      },
      anthropic: {
        id: "anthropic",
        type: "anthropic",
        provider_type: "chat_completion",
        provider: "anthropic",
        key: "",
        api_base: "https://api.anthropic.com",
        model: "claude-sonnet-4-20250514",
        modalities: ["text", "image", "tool_use"],
        anthropic_version: "2023-06-01",
        max_tokens: 1024,
      },
      openai_embedding: {
        id: "openai_embedding",
        type: "openai_embedding",
        provider_type: "embedding",
        provider: "openai",
        key: "",
        api_base: "https://api.openai.com/v1",
        model: "text-embedding-3-small",
      },
      gemini_embedding: {
        id: "gemini_embedding",
        type: "gemini_embedding",
        provider_type: "embedding",
        provider: "google",
        key: "",
        api_base: "",
        model: "text-embedding-004",
      },
      cohere: {
        id: "cohere",
        type: "cohere",
        provider_type: "rerank",
        provider: "cohere",
        key: "",
        api_base: "https://api.cohere.ai/v1",
        model: "rerank-v3.5",
      },
      jina: {
        id: "jina",
        type: "jina",
        provider_type: "rerank",
        provider: "jina",
        key: "",
        api_base: "https://api.jina.ai/v1",
        model: "jina-reranker-v2-base-multilingual",
      },
      voyage: {
        id: "voyage",
        type: "voyage",
        provider_type: "rerank",
        provider: "voyage",
        key: "",
        api_base: "https://api.voyageai.com/v1",
        model: "rerank-2",
      },
      generic_rerank: {
        id: "generic_rerank",
        type: "generic",
        provider_type: "rerank",
        provider: "generic",
        key: "",
        api_base: "",
        model: "",
      },
      openai_tts: {
        id: "openai_tts",
        type: "openai_tts",
        provider_type: "text_to_speech",
        provider: "openai",
        key: "",
        api_base: "https://api.openai.com/v1",
        model: "tts-1",
        voice: "alloy",
      },
      openai_stt: {
        id: "openai_stt",
        type: "openai_stt",
        provider_type: "speech_to_text",
        provider: "openai",
        key: "",
        api_base: "https://api.openai.com/v1",
        model: "whisper-1",
      },
    };
  }

  /**
   * 从 provider config 推断 provider_type
   */
  private guessProviderTypeFromConfig(config: Record<string, unknown>): string {
    const type = String(config.type || "");
    if (["openai", "openai_responses", "gemini", "anthropic"].includes(type)) return "chat_completion";
    if (type.includes("embedding")) return "embedding";
    if (type.includes("rerank") || ["cohere", "jina", "voyage", "generic"].includes(type)) return "rerank";
    if (type.includes("tts")) return "text_to_speech";
    if (type.includes("stt")) return "speech_to_text";
    return "chat_completion";
  }

  // ── Multipart & ZIP Upload Helpers ──

  private async parseMultipartRequest(req: IncomingMessage): Promise<{
    files: Array<{ originalName: string; tempPath: string; size: number }>;
    error?: string;
  }> {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/);
    if (!boundaryMatch) {
      return { files: [], error: "无效的 Content-Type (缺少 boundary)" };
    }
    const boundary = boundaryMatch[1] || boundaryMatch[2];

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    const files: Array<{ originalName: string; tempPath: string; size: number }> = [];

    const parts = body.toString("binary").split("--" + boundary);

    for (const part of parts) {
      if (!part.includes("filename=")) continue;

      const headerEnd = part.indexOf("\r\n\r\n");
      if (headerEnd < 0) continue;
      const header = part.substring(0, headerEnd);
      const fileData = part.substring(headerEnd + 4);

      const filenameMatch = header.match(/filename="(.+?)"/);
      if (!filenameMatch) continue;
      const originalName = decodeURIComponent(filenameMatch[1]);

      const dataBuffer = Buffer.from(fileData, "binary");
      if (dataBuffer.length === 0) {
        files.push({ originalName, tempPath: "", size: 0 });
        continue;
      }

      const tmpDir = join(tmpdir(), `skill-upload-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });
      const tempPath = join(tmpDir, originalName.replace(/[^a-zA-Z0-9._-]/g, "_"));
      await writeFile(tempPath, dataBuffer);
      files.push({ originalName, tempPath, size: dataBuffer.length });
    }

    return { files };
  }

  private async processZipFiles(
    files: Array<{ originalName: string; tempPath: string; size: number }>
  ): Promise<Array<{
    zipFile: string;
    skills: Array<{
      name: string;
      status: "registered" | "skipped_duplicate" | "error";
      message: string;
    }>;
  }>> {
    const AdmZip = (await import("adm-zip")).default;
    const results: ReturnType<typeof this.processZipFiles> extends Promise<infer R> ? R : never = [];

    for (const file of files) {
      const zipResult: typeof results[0] = { zipFile: file.originalName, skills: [] };

      try {
        if (!file.tempPath || file.size === 0) {
          zipResult.skills.push({
            name: file.originalName,
            status: "error",
            message: "文件为空或无法读取",
          });
          results.push(zipResult);
          continue;
        }

        if (!extname(file.originalName).toLowerCase().includes(".zip")) {
          zipResult.skills.push({
            name: file.originalName,
            status: "error",
            message: "非 ZIP 文件（仅支持 .zip 格式）",
          });
          results.push(zipResult);
          continue;
        }

        const zip = new AdmZip(file.tempPath);
        const entries = zip.getEntries();

        const skillDirs = new Set<string>();
        for (const entry of entries) {
          const entryName = entry.entryName.replace(/\\/g, "/");
          const parts = entryName.split("/").filter(Boolean);
          if (parts.length >= 2) {
            skillDirs.add(parts[0]);
          }
        }

        if (skillDirs.size === 0) {
          const rootEntries = entries.filter((e: any) => !e.entryName.includes("/"));
          const hasSkillMd = rootEntries.some((e: any) =>
            e.name.toLowerCase() === "skill.md" ||
            e.name.toLowerCase() === "skills.md" ||
            e.name.toLowerCase() === "manifest.json"
          );

          if (hasSkillMd) {
            const parsed = this.parseZipRootSkills(zip, rootEntries);
            for (const ps of parsed) {
              const existing = this.ctx.skillManager.listSkills().find(s => s.name === ps.name);
              if (existing) {
                zipResult.skills.push({ name: ps.name, status: "skipped_duplicate", message: `已存在同名技能（描述: "${existing.description}"）` });
              } else {
                this.ctx.skillManager.registerSkill(ps);
                zipResult.skills.push({ name: ps.name, status: "registered", message: `成功注册 - ${ps.description}` });
              }
            }
          } else {
            zipResult.skills.push({
              name: "(root)",
              status: "error",
              message: "ZIP 根目录未找到 SKILL.md / manifest.json / skills.md",
            });
          }
        } else {
          for (const dirName of skillDirs) {
            const dirPrefix = dirName + "/";
            const dirEntries = entries.filter((e: any) => e.entryName.startsWith(dirPrefix));

            const hasSkillMd = dirEntries.some((e: any) => {
              const name = e.entryName.substring(dirPrefix.length).toLowerCase();
              return name === "skill.md" || name === "manifest.json" || name === "skills.md";
            });

            if (!hasSkillMd) {
              zipResult.skills.push({ name: dirName, status: "error", message: "缺少 SKILL.md 或 manifest.json" });
              continue;
            }

            const parsed = this.parseZipSkillDir(zip, dirPrefix, dirEntries, dirName);

            const existing = this.ctx.skillManager.listSkills().find(s => s.name === parsed.name);
            if (existing) {
              zipResult.skills.push({ name: parsed.name, status: "skipped_duplicate", message: `已存在同名技能（描述: "${existing.description}"）` });
            } else {
              this.ctx.skillManager.registerSkill(parsed);
              zipResult.skills.push({ name: parsed.name, status: "registered", message: `${parsed.description || "注册成功"}` });
            }
          }
        }
      } catch (err: any) {
        zipResult.skills.push({
          name: file.originalName,
          status: "error",
          message: err.message || "ZIP 解析失败",
        });
      }

      results.push(zipResult);
    }

    return results;
  }

  private parseZipRootSkills(
    zip: any,
    entries: any[]
  ): Array<{ name: string; description: string; path: string; active: boolean; sourceType: string; sourceLabel: string; localExists: boolean; sandboxExists: boolean; pluginName: string; readonly: boolean }> {
    const results: any[] = [];

    const skillMdEntry = entries.find(e => e.name.toLowerCase() === "skill.md");
    const manifestEntry = entries.find(e => e.name.toLowerCase() === "manifest.json");
    const skillsMdEntry = entries.find(e => e.name.toLowerCase() === "skills.md");

    if (skillsMdEntry) {
      const content = zip.readAsText(skillsMdEntry);
      const lines = content.split("\n");
      let i = 0;
      while (i < lines.length) {
        const line = lines[i].trim();
        if (line.startsWith("- ") || line.startsWith("* ")) {
          const item = line.replace(/^[-*]\s+/, "");
          const colonIdx = item.indexOf(":");
          if (colonIdx > 0) {
            results.push({
              name: item.substring(0, colonIdx).trim(),
              description: item.substring(colonIdx + 1).trim(),
              path: "skills.md", active: true, sourceType: "upload", sourceLabel: "ZIP上传",
              localExists: false, sandboxExists: false, pluginName: "", readonly: false,
            });
          }
        } else if (line.startsWith("# ")) {
          const name = line.replace(/^#+\s*/, "").trim();
          const descLines: string[] = [];
          i++;
          while (i < lines.length && !lines[i].startsWith("#") && lines[i].trim()) descLines.push(lines[i++].trim());
          i--;
          results.push({
            name, description: descLines.join(" "), path: "skills.md", active: true, sourceType: "upload", sourceLabel: "ZIP上传",
            localExists: false, sandboxExists: false, pluginName: "", readonly: false,
          });
        }
        i++;
      }
    } else if (manifestEntry) {
      const content = zip.readAsText(manifestEntry);
      try {
        const parsed = JSON.parse(content);
        results.push({
          name: parsed.name || "unnamed-skill",
          description: parsed.description || "",
          path: "manifest.json", active: parsed.active !== false, sourceType: "upload", sourceLabel: "ZIP上传",
          localExists: false, sandboxExists: false, pluginName: "", readonly: !!parsed.readonly,
        });
      } catch {
        results.push({
          name: "unknown", description: "manifest.json 解析失败", path: "manifest.json",
          active: true, sourceType: "upload", sourceLabel: "ZIP上传",
          localExists: false, sandboxExists: false, pluginName: "", readonly: false,
        });
      }
    } else if (skillMdEntry) {
      const content = zip.readAsText(skillMdEntry);
      const lines = content.split("\n");
      let name = "";
      let description = "";

      if (lines[0]?.trim()?.startsWith("---")) {
        const endIdx = lines.indexOf("---", 1);
        if (endIdx > 0) {
          for (let j = 1; j < endIdx; j++) {
            const l = lines[j].trim();
            if (l.startsWith("name:")) name = l.split(":")[1].trim();
            if (l.startsWith("description:")) description = l.split(":")[1].slice(1).trim();
          }
          const bodyLines = lines.slice(endIdx + 1).map((l: string) => l.trim()).filter((l: string) => l && !l.startsWith("#"));
          if (!description && bodyLines.length > 0) description = bodyLines[0];
        }
      } else {
        for (const l of lines) {
          if (l.startsWith("# ")) { name = l.replace(/^#+\s*/, "").trim(); continue; }
          if (name && l.trim() && !l.startsWith("#")) { description += (description ? " " : "") + l.trim(); }
        }
      }

      results.push({
        name: name || "unnamed-skill", description,
        path: "skill.md", active: true, sourceType: "upload", sourceLabel: "ZIP上传",
        localExists: false, sandboxExists: false, pluginName: "", readonly: false,
      });
    }

    return results;
  }

  private parseZipSkillDir(
    zip: any,
    dirPrefix: string,
    _entries: any[],
    dirName: string
  ): { name: string; description: string; path: string; active: boolean; sourceType: string; sourceLabel: string; localExists: boolean; sandboxExists: boolean; pluginName: string; readonly: boolean } {
    const skillMdEntry = _entries.find(e => {
      const name = e.entryName.substring(dirPrefix.length).toLowerCase();
      return name === "skill.md";
    });
    const manifestEntry = _entries.find(e => {
      const name = e.entryName.substring(dirPrefix.length).toLowerCase();
      return name === "manifest.json";
    });

    let name = dirName;
    let description = "";
    let active = true;
    let readonly = false;

    if (skillMdEntry) {
      const content = zip.readAsText(skillMdEntry);
      const lines = content.split("\n");

      if (lines[0]?.trim()?.startsWith("---")) {
        const endIdx = lines.indexOf("---", 1);
        if (endIdx > 0) {
          for (let j = 1; j < endIdx; j++) {
            const l = lines[j].trim();
            if (l.startsWith("name:")) name = l.split(":")[1].trim();
            if (l.startsWith("description:")) description = l.split(":")[1].slice(1).trim();
            if (l === "active: false") active = false;
            if (l === "readonly: true") readonly = true;
          }
          const bodyLines = lines.slice(endIdx + 1).map((l: string) => l.trim()).filter((l: string) => l && !l.startsWith("#"));
          if (!description && bodyLines.length > 0) description = bodyLines[0];
        }
      } else {
        for (const l of lines) {
          if (l.startsWith("# ")) { name = l.replace(/^#+\s*/, "").trim(); continue; }
          if (name && l.trim() && !l.startsWith("#")) { description += (description ? " " : "") + l.trim(); }
        }
      }
    } else if (manifestEntry) {
      try {
        const content = zip.readAsText(manifestEntry);
        const parsed = JSON.parse(content);
        if (parsed.name) name = parsed.name;
        if (parsed.description) description = parsed.description;
        if (parsed.active === false) active = false;
        if (parsed.readonly) readonly = true;
      } catch { /* keep defaults */ }
    }

    return {
      name, description, path: `${dirName}/`, active, sourceType: "upload", sourceLabel: "ZIP上传",
      localExists: true, sandboxExists: false, pluginName: "", readonly,
    };
  }
}
