import { createServer, type IncomingMessage, type ServerResponse, type Server } from "http";
import { join, extname, resolve, relative, isAbsolute } from "path";
import { readFile, stat, writeFile, mkdir, unlink, readdir } from "fs/promises";
import { cpus, tmpdir, totalmem } from "os";
import { timingSafeEqual, randomBytes, scryptSync } from "crypto";

/**
 * Helper to generate an scrypt password hash.
 */
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

/**
 * Helper to verify an scrypt password hash.
 * Uses `timingSafeEqual` to prevent timing attacks.
 */
function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  const verifyHash = scryptSync(password, salt, 64).toString("hex");
  // Constant-time comparison to mitigate timing attacks.
  const a = Buffer.from(verifyHash, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}


import type { AsyncQueue } from "@yachiyo/common/async-queue.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import type { ProviderManager } from "@yachiyo/provider/manager.js";
import type { ConversationManager } from "@yachiyo/conversation/manager.js";
import type { PersonaManager, Personality } from "@yachiyo/persona/manager.js";
import type { KnowledgeBaseManager } from "@yachiyo/knowledge-base/manager.js";
import type { SessionLockManager } from "@yachiyo/pipeline/session-lock.js";
import type { SessionServiceManager } from "@yachiyo/pipeline/stages/session-status-check.js";
import type { PluginManager } from "@yachiyo/plugin/manager.js";
import type { ConfigManager } from "@yachiyo/config/manager.js";
import type { EventBus } from "@yachiyo/pipeline/event-bus.js";
import type { PipelineScheduler } from "@yachiyo/pipeline/scheduler.js";
import type { AdapterRegistry } from "@yachiyo/platform/registry.js";
import type { SqliteAdapterStore } from "@yachiyo/platform/sqlite-adapter-store.js";
import type { AdapterConfigBase } from "@yachiyo/platform/config.js";
import type { DatabaseManager } from "@yachiyo/common/database.js";
import type { FunctionToolManager } from "@yachiyo/agent/func-tool-manager.js";
import type { MemoryConsolidator } from "@yachiyo/agent/memory-consolidator.js";
import type { SqliteMemoryStore, MemoryEntry, ConversationIndexEntry, MemoryType, MemoryScope } from "@yachiyo/agent/sqlite-memory-store.js";
import type { SqliteSchedulerTaskStore, SchedulerTask, TaskType, TaskStatus } from "@yachiyo/agent/scheduler-task-store.js";
import type { SkillManager } from "@yachiyo/skill/index.js";
import { safeFetch } from "@yachiyo/common/ssrf-guard.js";
import { proxyManager } from "@yachiyo/agent/proxy-manager.js";

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
  schedulerStore?: SqliteSchedulerTaskStore;
  memoryStore?: SqliteMemoryStore;
  dashboardServer?: DashboardServer;
  shutdown: () => Promise<void>;
}

/**
 * Runtime shape of a provider config stored in `ProviderManager.providerConfigs`.
 *
 * The underlying storage type is `Record<string, unknown>` (an index
 * signature), so dashboard code that needs to read specific fields must
 * narrow through this interface instead of casting to `any`.
 */
interface ProviderRuntimeConfig {
  type?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  provider_source_id?: string;
  provider_type?: string;
  modalities?: string[];
  custom_extra_body?: Record<string, unknown>;
  max_context_tokens?: number;
  reasoning?: boolean;
  [key: string]: unknown;
}

/** Minimal entry shape returned by adm-zip's `zip.getEntries()`. */
interface ZipEntry {
  name: string;
  entryName: string;
}

/** Minimal zip reader shape used by skill-parsing helpers. */
interface ZipReader {
  readAsText(entry: unknown): string;
}

export function isPathSafe(basePath: string, targetPath: string): boolean {
  const resolvedBase = resolve(basePath);
  const resolvedTarget = resolve(resolvedBase, targetPath);
  const rel = relative(resolvedBase, resolvedTarget);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Error class for client-visible errors. Instances of this class are
 * considered safe to return verbatim to the HTTP client because the
 * developer explicitly constructed them with a user-facing message.
 *
 * Use `throw new ClientError("配置不存在")` in handlers to signal
 * 4xx-style errors. Generic `Error` instances caught in handlers must
 * NOT be returned as-is — use `safeClientMessage(err, fallback)` which
 * only surfaces `ClientError` messages and substitutes a generic
 * fallback for unknown errors (preventing internal detail leakage).
 */
export class ClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientError";
  }
}

/**
 * Return a message safe to send to the HTTP client.
 *
 * - `ClientError` instances: return `err.message` (developer-vetted).
 * - Other errors: return `fallback` (default `"操作失败"`). The full
 *   original error is logged server-side by the caller via `console.error`.
 * - Falsy/empty messages on `ClientError`: also fall back.
 *
 * This prevents internal error details (DB paths, SQL errors, stack
 * frames, file system structure) from leaking to clients via `err.message`.
 */
export function safeClientMessage(err: unknown, fallback: string = "操作失败"): string {
  if (err instanceof ClientError && err.message) return err.message;
  return fallback;
}

/**
 * Parse an HTTP request body as JSON and validate that the result is a
 * plain object (not an array, string, number, boolean, or null).
 *
 * Returns `{ ok: true, value }` on success, or `{ ok: false, error }`
 * with a client-safe message on failure. The caller decides whether to
 * treat the failure as a 400 or skip processing.
 *
 * This guards against malformed/non-object payloads that would otherwise
 * propagate as `any` and trigger undefined behavior deeper in the handler
 * (e.g. `const { id } = body` on `body = 123` yields `id = undefined`).
 */
export function parseJsonObject(
  body: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: "请求体不是有效的 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "请求体必须是 JSON 对象" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
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
function maskProviderSecrets<T extends Record<string, unknown>>(config: T): T {
  const out: Record<string, unknown> = { ...config };
  if ("key" in out) out.key = maskSecret(out.key);
  if ("apiKey" in out) out.apiKey = maskSecret(out.apiKey);
  return out as T;
}

export interface DashboardServerOptions {
  port?: number;
  host?: string;
  debugChatEnabled?: boolean;
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
  private allowedOrigins: Set<string> | undefined;
  private startTime: number = 0;
  private prevCpuInfo: { idle: number; total: number } | null = null;
  private todayTokens: number = 0;
  private lastTokenDate: string = new Date().toDateString();
  /** Session absolute lifetime in ms (7 days). */
  private static readonly SESSION_ABSOLUTE_TTL_MS = 168 * 60 * 60 * 1000;
  /** Login rate-limit: max attempts per key (username+ip) within the window. */
  private static readonly LOGIN_RATE_LIMIT_MAX = 5;
  /** Login rate-limit window in ms (1 minute). */
  private static readonly LOGIN_RATE_LIMIT_WINDOW_MS = 60 * 1000;
  private loginAttempts: Map<string, { count: number; firstAttemptAt: number }> = new Map();

  // ── Session persistence (SQLite-backed) ──

  private saveSession(token: string, username: string, mustChange: boolean, expiresAt: number): void {
    const db = this.ctx.dbManager.getDb("config");
    db.prepare(`
      INSERT OR REPLACE INTO dashboard_sessions (token, username, must_change, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(token, username, mustChange ? 1 : 0, expiresAt);
  }

  private deleteSession(token: string): void {
    const db = this.ctx.dbManager.getDb("config");
    db.prepare("DELETE FROM dashboard_sessions WHERE token = ?").run(token);
  }

  private getSession(token: string): { username: string; mustChange: boolean; expiresAt: number } | null {
    const db = this.ctx.dbManager.getDb("config");
    const row = db.prepare("SELECT username, must_change, expires_at FROM dashboard_sessions WHERE token = ?").get(token) as
      | { username: string; must_change: number; expires_at: number } | undefined;
    if (!row) return null;
    return {
      username: row.username,
      mustChange: row.must_change === 1,
      expiresAt: row.expires_at,
    };
  }

  /** Remove expired sessions to prevent unbounded growth. Called lazily on each auth check. */
  private cleanExpiredSessions(): void {
    const now = Date.now();
    const db = this.ctx.dbManager.getDb("config");
    db.prepare("DELETE FROM dashboard_sessions WHERE expires_at < ?").run(now);
  }

  /**
   * Minimum password length enforced for any default/admin password.
   * Matches the policy in `changePassword` / `setupFirstUser` routes.
   */
  private static readonly MIN_PASSWORD_LENGTH = 8;

  /**
   * Minimum entropy (in bytes) for auto-generated default passwords.
   * 24 bytes → 192 bits → 48 hex chars, well beyond brute-force reach.
   */
  private static readonly AUTO_PASSWORD_BYTES = 24;

  private ensureDefaultUser(): void {
    try {
      const db = this.ctx.dbManager.getDb("config");
      const countRow = db.prepare("SELECT COUNT(*) as count FROM dashboard_users").get() as { count: number } | undefined;
      if (!countRow || countRow.count === 0) {
        const defaultUser = process.env.DASHBOARD_DEFAULT_USER || "admin";

        // Reject the historical "admin/admin" weak-default.
        // Operator must either:
        //   (a) set DASHBOARD_DEFAULT_PASSWORD to a value ≥ MIN_PASSWORD_LENGTH, or
        //   (b) let us autogenerate a strong one-time password (logged once below).
        const envPass = process.env.DASHBOARD_DEFAULT_PASSWORD;
        let defaultPass: string;
        let autogenerated = false;
        if (typeof envPass === "string" && envPass.length >= DashboardServer.MIN_PASSWORD_LENGTH) {
          defaultPass = envPass;
        } else {
          defaultPass = randomBytes(DashboardServer.AUTO_PASSWORD_BYTES).toString("hex");
          autogenerated = true;
        }

        const hashedPassword = hashPassword(defaultPass);
        db.prepare(`
          INSERT INTO dashboard_users (username, password_hash, is_first_login)
          VALUES (?, ?, 1)
        `).run(defaultUser, hashedPassword);

        if (autogenerated) {
          // Do NOT log the generated password (even partially) to prevent
          // clear-text leakage in shared log streams. The operator must
          // set DASHBOARD_DEFAULT_PASSWORD explicitly or read the value from
          // a secure channel. Only the fact that a password was generated
          // is logged here.
          console.warn(
            `[DashboardServer] No strong DASHBOARD_DEFAULT_PASSWORD provided; ` +
            `a random one-time password was generated for user "${defaultUser}". ` +
            `It will not be shown in logs for security. ` +
            `Set DASHBOARD_DEFAULT_PASSWORD (≥ ${DashboardServer.MIN_PASSWORD_LENGTH} chars) ` +
            `to specify your own password and suppress this message.`
          );
        } else {
          console.log(`[DashboardServer] Created default user "${defaultUser}". Forced password change on first login is active.`);
        }
      }
    } catch (err) {
      console.error("[DashboardServer] Failed to ensure default user exists:", err);
    }
  }

  constructor(ctx: BootstrapContext, options: DashboardServerOptions = {}) {
    this.ctx = ctx;
    this.port = options.port ?? 8000;
    this.host = options.host ?? "0.0.0.0";
    this.debugChatEnabled = options.debugChatEnabled === true;
    this.allowedOrigins = options.allowedOrigins ? new Set(options.allowedOrigins) : undefined;
  }

  /**
   * Bearer token check via dynamic session tokens (SQLite-backed).
   */
  private isRequestAuthenticated(req: IncomingMessage, pathname: string): boolean {
    const header = req.headers["authorization"];
    if (typeof header !== "string") return false;
    if (!header.startsWith("Bearer ")) return false;
    const token = header.slice(7).trim();

    // Lazy cleanup of expired sessions (cheap DELETE, runs on each auth check).
    this.cleanExpiredSessions();

    const session = this.getSession(token);
    if (session) {
      const now = Date.now();
      // Expired: absolute lifetime exceeded.
      if (now > session.expiresAt) {
        this.deleteSession(token);
        return false;
      }
      if (session.mustChange) {
        // If mustChange is true, only /api/auth/change-credentials is allowed
        return pathname === "/api/auth/change-credentials";
      }
      return true;
    }

    return false;
  }

  /**
   * Enforce login rate limiting per (username + client IP) key.
   * Returns `null` if allowed, or an error message string if blocked.
   */
  private checkLoginRateLimit(username: string, clientIp: string): string | null {
    const key = `${username}:${clientIp}`;
    const now = Date.now();
    const entry = this.loginAttempts.get(key);
    if (!entry || now - entry.firstAttemptAt > DashboardServer.LOGIN_RATE_LIMIT_WINDOW_MS) {
      // Reset window.
      this.loginAttempts.set(key, { count: 1, firstAttemptAt: now });
      return null;
    }
    entry.count++;
    if (entry.count > DashboardServer.LOGIN_RATE_LIMIT_MAX) {
      const retryAfterSec = Math.ceil((DashboardServer.LOGIN_RATE_LIMIT_WINDOW_MS - (now - entry.firstAttemptAt)) / 1000);
      return `登录尝试过于频繁，请 ${retryAfterSec} 秒后重试`;
    }
    return null;
  }

  /** Reset the rate-limit counter after a successful login. */
  private clearLoginRateLimit(username: string, clientIp: string): void {
    this.loginAttempts.delete(`${username}:${clientIp}`);
  }

  /** Extract client IP from request, accounting for trusted proxies. */
  private getClientIp(req: IncomingMessage): string {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      return forwarded.split(",")[0].trim();
    }
    return req.socket.remoteAddress || "unknown";
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
    this.ensureDefaultUser();
    this.startTime = Date.now();
    this.server = createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, this.host, () => {
        console.log(`[DashboardServer] Admin Dashboard is running at http://${this.host}:${this.port}`);
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

  /**
   * 生成缓存命中 Token 的趋势数据（按时间桶聚合所有模型的 tokenInputCached 总和）。
   * 时间桶划分与 generateTrendSeriesFromStats 保持一致，便于在同一图表中对比。
   */
  private generateCachedTrendFromStats(
    stats: Array<{ tokenInputCached: number; createdAt: Date }>,
    days: number
  ): Array<[number, number]> {
    if (stats.length === 0) return [];

    const intervalMs = days <= 1 ? 3600000 : (days <= 3 ? 7200000 : 86400000);
    const now = Date.now();
    const buckets = Math.min(days * (days <= 1 ? 24 : days <= 3 ? 12 : 7), 24);

    const bucketSums = new Array<number>(buckets).fill(0);
    for (const s of stats) {
      const bucketIdx = Math.floor((s.createdAt.getTime() - (now - buckets * intervalMs)) / intervalMs);
      const clampedIdx = Math.max(0, Math.min(buckets - 1, bucketIdx));
      bucketSums[clampedIdx] += (s.tokenInputCached || 0);
    }

    return Array.from({ length: buckets }, (_, i) => {
      const ts = now - (buckets - 1 - i) * intervalMs;
      return [ts, bucketSums[i]] as [number, number];
    });
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
    const isAuthExempt = pathname === "/api/auth/login" || pathname === "/api/auth/status";
    if (pathname.startsWith("/api/") && !isAuthExempt && !this.isRequestAuthenticated(req, pathname)) {
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
    } catch (error: unknown) {
      console.error(`[DashboardServer] Error handling request ${req.method} ${pathname}:`, error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error", details: safeClientMessage(error) }));
    }
  }

  private async handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    url: URL
  ): Promise<void> {
    res.setHeader("Content-Type", "application/json");

    // Auth Endpoint: POST /api/auth/login
    if (pathname === "/api/auth/login" && req.method === "POST") {
      const result = await this.readJsonObject(req);
      if (!result.ok) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Bad Request", message: result.error }));
        return;
      }
      const { username, password } = result.value;
      if (typeof username !== "string" || typeof password !== "string") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Bad Request", message: "用户名或密码格式不正确" }));
        return;
      }

      // Rate-limit check (per username + client IP).
      const clientIp = this.getClientIp(req);
      const rateLimited = this.checkLoginRateLimit(username, clientIp);
      if (rateLimited) {
        res.writeHead(429, { "Retry-After": String(Math.ceil(DashboardServer.LOGIN_RATE_LIMIT_WINDOW_MS / 1000)) });
        res.end(JSON.stringify({ error: "Too Many Requests", message: rateLimited }));
        return;
      }

      const db = this.ctx.dbManager.getDb("config");
      const user = db.prepare("SELECT username, password_hash, is_first_login, created_at, updated_at FROM dashboard_users WHERE username = ?").get(username) as { username: string; password_hash: string; is_first_login: number } | undefined;

      if (!user || !verifyPassword(password, user.password_hash)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Unauthorized", message: "用户名或密码错误" }));
        return;
      }

      // Success: clear rate-limit counter.
      this.clearLoginRateLimit(username, clientIp);

      const sessionToken = randomBytes(24).toString("hex");
      const mustChange = user.is_first_login === 1;
      const now = Date.now();
      this.saveSession(sessionToken, user.username, mustChange, now + DashboardServer.SESSION_ABSOLUTE_TTL_MS);

      res.writeHead(200);
      res.end(JSON.stringify({
        status: mustChange ? "must_change" : "success",
        token: sessionToken,
        username: user.username
      }));
      return;
    }

    // Auth Endpoint: POST /api/auth/change-credentials
    if (pathname === "/api/auth/change-credentials" && req.method === "POST") {
      const header = req.headers["authorization"];
      if (typeof header !== "string" || !header.startsWith("Bearer ")) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Unauthorized", message: "未登录" }));
        return;
      }
      const token = header.slice(7).trim();
      const session = this.getSession(token);
      if (!session) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Unauthorized", message: "会话已过期" }));
        return;
      }

      const result = await this.readJsonObject(req);
      if (!result.ok) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Bad Request", message: result.error }));
        return;
      }
      const { newUsername, newPassword, confirmPassword } = result.value;
      if (typeof newUsername !== "string" || typeof newPassword !== "string" || !newUsername.trim() || !newPassword.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Bad Request", message: "新用户名或密码不能为空" }));
        return;
      }

      if (typeof confirmPassword !== "string" || confirmPassword !== newPassword) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Bad Request", message: "两次输入的密码不一致" }));
        return;
      }

      if (newUsername.trim().length < 3 || newPassword.trim().length < 8) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Bad Request", message: "用户名长度至少为3位，密码长度至少为8位" }));
        return;
      }

      const db = this.ctx.dbManager.getDb("config");

      if (newUsername.trim() !== session.username) {
        const existing = db.prepare("SELECT 1 FROM dashboard_users WHERE username = ?").get(newUsername.trim());
        if (existing) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Bad Request", message: "用户名已存在" }));
          return;
        }
      }

      try {
        db.transaction(() => {
          if (newUsername.trim() !== session.username) {
            db.prepare("DELETE FROM dashboard_users WHERE username = ?").run(session.username);
            db.prepare(`
              INSERT INTO dashboard_users (username, password_hash, is_first_login, updated_at)
              VALUES (?, ?, 0, datetime('now'))
            `).run(newUsername.trim(), hashPassword(newPassword));
          } else {
            db.prepare(`
              UPDATE dashboard_users
              SET password_hash = ?, is_first_login = 0, updated_at = datetime('now')
              WHERE username = ?
            `).run(hashPassword(newPassword), session.username);
          }
        })();
      } catch (err) {
        console.error("[DashboardServer] Failed to update credentials:", err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Internal Server Error", message: safeClientMessage(err, "更新凭证失败") }));
        return;
      }

      this.deleteSession(token);
      const newSessionToken = randomBytes(24).toString("hex");
      const now = Date.now();
      this.saveSession(newSessionToken, newUsername.trim(), false, now + DashboardServer.SESSION_ABSOLUTE_TTL_MS);

      res.writeHead(200);
      res.end(JSON.stringify({
        status: "success",
        token: newSessionToken,
        username: newUsername.trim()
      }));
      return;
    }

    // Auth Endpoint: POST /api/auth/update-credentials
    // For already-authenticated users to change username/password.
    // Requires current password verification + new password confirmation.
    if (pathname === "/api/auth/update-credentials" && req.method === "POST") {
      const header = req.headers["authorization"];
      if (typeof header !== "string" || !header.startsWith("Bearer ")) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Unauthorized", message: "未登录" }));
        return;
      }
      const token = header.slice(7).trim();
      const session = this.getSession(token);
      if (!session) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Unauthorized", message: "会话已过期" }));
        return;
      }
      // Reject if user is in mustChange state (use change-credentials instead).
      if (session.mustChange) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "Forbidden", message: "请先完成首次密码修改" }));
        return;
      }

      const result = await this.readJsonObject(req);
      if (!result.ok) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Bad Request", message: result.error }));
        return;
      }
      const { currentPassword, newUsername, newPassword, confirmPassword } = result.value;
      if (typeof currentPassword !== "string" || !currentPassword ||
          typeof newUsername !== "string" || !newUsername.trim() ||
          typeof newPassword !== "string" || !newPassword.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Bad Request", message: "所有字段均为必填项" }));
        return;
      }

      if (typeof confirmPassword !== "string" || confirmPassword !== newPassword) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Bad Request", message: "两次输入的新密码不一致" }));
        return;
      }

      if (newUsername.trim().length < 3 || newPassword.trim().length < 8) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Bad Request", message: "用户名长度至少为3位，密码长度至少为8位" }));
        return;
      }

      const db = this.ctx.dbManager.getDb("config");
      const user = db.prepare("SELECT username, password_hash, is_first_login, created_at, updated_at FROM dashboard_users WHERE username = ?").get(session.username) as { username: string; password_hash: string; is_first_login: number } | undefined;
      if (!user || !verifyPassword(currentPassword, user.password_hash)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Unauthorized", message: "当前密码错误" }));
        return;
      }

      if (newUsername.trim() !== session.username) {
        const existing = db.prepare("SELECT 1 FROM dashboard_users WHERE username = ?").get(newUsername.trim());
        if (existing) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Bad Request", message: "用户名已存在" }));
          return;
        }
      }

      try {
        db.transaction(() => {
          if (newUsername.trim() !== session.username) {
            db.prepare("DELETE FROM dashboard_users WHERE username = ?").run(session.username);
            db.prepare(`
              INSERT INTO dashboard_users (username, password_hash, is_first_login, updated_at)
              VALUES (?, ?, 0, datetime('now'))
            `).run(newUsername.trim(), hashPassword(newPassword));
          } else {
            db.prepare(`
              UPDATE dashboard_users
              SET password_hash = ?, updated_at = datetime('now')
              WHERE username = ?
            `).run(hashPassword(newPassword), session.username);
          }
        })();
      } catch (err) {
        console.error("[DashboardServer] Failed to update credentials:", err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Internal Server Error", message: safeClientMessage(err, "更新凭证失败") }));
        return;
      }

      // Issue a new session token (invalidates old one).
      this.deleteSession(token);
      const newSessionToken = randomBytes(24).toString("hex");
      const now = Date.now();
      this.saveSession(newSessionToken, newUsername.trim(), false, now + DashboardServer.SESSION_ABSOLUTE_TTL_MS);

      res.writeHead(200);
      res.end(JSON.stringify({
        status: "success",
        token: newSessionToken,
        username: newUsername.trim()
      }));
      return;
    }

    // Auth Endpoint: GET /api/auth/status
    if (pathname === "/api/auth/status" && req.method === "GET") {
      const header = req.headers["authorization"];
      if (typeof header !== "string" || !header.startsWith("Bearer ")) {
        res.writeHead(200);
        res.end(JSON.stringify({ authenticated: false }));
        return;
      }
      const token = header.slice(7).trim();

      const session = this.getSession(token);
      if (session) {
        res.writeHead(200);
        res.end(JSON.stringify({ authenticated: true, username: session.username, mustChange: session.mustChange }));
        return;
      }

      res.writeHead(200);
      res.end(JSON.stringify({ authenticated: false }));
      return;
    }

    // Auth Endpoint: POST /api/auth/logout
    if (pathname === "/api/auth/logout" && req.method === "POST") {
      const header = req.headers["authorization"];
      if (typeof header === "string" && header.startsWith("Bearer ")) {
        const token = header.slice(7).trim();
        this.deleteSession(token);
      }
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

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
      const parsed = await this.readJsonObject(req);
      if (!parsed.ok) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: parsed.error }));
        return;
      }
      const config = parsed.value as { id?: string; [k: string]: unknown };
      if (!config.id) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing config ID" }));
        return;
      }
      this.ctx.configManager.updateConfig(config as unknown as Parameters<typeof this.ctx.configManager.updateConfig>[0]);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, config }));
      return;
    }

    // 4.5 Session Whitelist — list / add / remove / candidates
    if (pathname === "/api/session-whitelist" && req.method === "GET") {
      const entries = this.ctx.sessionServiceManager.listWhitelist();
      const config = this.ctx.configManager.getActiveConfig();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ enabled: config?.sessionWhitelistEnabled ?? false, entries }));
      return;
    }
    if (pathname === "/api/session-whitelist" && req.method === "POST") {
      const parsed = await this.readJsonObject(req);
      if (!parsed.ok) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: parsed.error }));
        return;
      }
      const { umo } = parsed.value as { umo?: string };
      if (!umo || typeof umo !== "string") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing 'umo' field" }));
        return;
      }
      this.ctx.sessionServiceManager.addWhitelist(umo);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }
    if (pathname === "/api/session-whitelist" && req.method === "DELETE") {
      const parsed = await this.readJsonObject(req);
      if (!parsed.ok) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: parsed.error }));
        return;
      }
      const { umo } = parsed.value as { umo?: string };
      if (!umo || typeof umo !== "string") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing 'umo' field" }));
        return;
      }
      this.ctx.sessionServiceManager.removeWhitelist(umo);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }
    if (pathname === "/api/session-whitelist/candidates" && req.method === "GET") {
      const store = this.ctx.conversationManager.getStore();
      if (!store) {
        res.writeHead(200);
        res.end(JSON.stringify({ candidates: [] }));
        return;
      }
      const allConvs = await store.getAllConversationMetadata();
      const seen = new Set<string>();
      const candidates: Array<{ umo: string; title: string }> = [];
      for (const conv of allConvs) {
        const umo = conv.unifiedMsgOrigin;
        if (umo && !seen.has(umo)) {
          seen.add(umo);
          candidates.push({ umo, title: conv.title || umo });
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ candidates }));
      return;
    }

    // 4.6 POST /api/providers/test
    if (pathname === "/api/providers/test" && req.method === "POST") {
      const parsed = await this.readJsonObject(req);
      if (!parsed.ok) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: parsed.error }));
        return;
      }
      const { type, config } = parsed.value as { type?: string; config?: Record<string, unknown> };
      if (!type || !config) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing type or config" }));
        return;
      }
      try {
        const { createChatProvider } = await import("@yachiyo/provider/factory.js");
        const prov = createChatProvider(type as unknown as Parameters<typeof createChatProvider>[0], config as unknown as Parameters<typeof createChatProvider>[1]);
        const response = await prov.textChat({
          contexts: [{ role: "user" as const, content: "hello" }]
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: response.completionText || "Connection success" }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: safeClientMessage(err) }));
      }
      return;
    }

    // 4.6 POST /api/providers/models - 获取可用模型列表
    if (pathname === "/api/providers/models" && req.method === "POST") {
      const parsed = await this.readJsonObject(req);
      if (!parsed.ok) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: parsed.error }));
        return;
      }
      const { type, config } = parsed.value as { type?: string; config?: { apiKey?: string; [k: string]: unknown } };
      if (!type || !config || !config.apiKey) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing type, config or apiKey" }));
        return;
      }
      try {
        const models = await this.fetchModelsFromProvider(type, config);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, models }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: safeClientMessage(err) }));
      }
      return;
    }

    // 5. GET /api/providers
    if (pathname === "/api/providers" && req.method === "GET") {
      const providerConfigsMap = this.ctx.providerManager.providerConfigs;
      const providersList: Array<Record<string, unknown>> = [];
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
      const parsed = await this.readJsonObject(req);
      if (!parsed.ok) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: parsed.error }));
        return;
      }
      const { id, type, config } = parsed.value as { id?: string; type?: string; config?: Record<string, unknown> };
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
      } catch (err: unknown) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: safeClientMessage(err) }));
      }
      return;
    }

    // 11. GET /api/mcp
    if (pathname === "/api/mcp" && req.method === "GET") {
      const sqliteStore = this.ctx.providerManager.getStore();
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

      const sqliteStore = this.ctx.providerManager.getStore();
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

      const sqliteStore = this.ctx.providerManager.getStore();
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
      } catch (err: unknown) {
        console.error("[Dashboard] Error processing skill ZIP upload:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: safeClientMessage(err) }));
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
      const list: Array<Record<string, unknown>> = [];
      for (const [id, p] of personasMap.entries()) {
        list.push({ id, ...p });
      }
      res.writeHead(200);
      res.end(JSON.stringify(list));
      return;
    }

    if (pathname === "/api/personas" && req.method === "POST") {
      const parsed = await this.readJsonObject(req);
      if (!parsed.ok) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: parsed.error }));
        return;
      }
      const { id, name, prompt, beginDialogs, moodImitationDialogs, tools, skills, customErrorMessage } = parsed.value as {
        id?: string; name?: string; prompt?: string;
        beginDialogs?: unknown[]; moodImitationDialogs?: unknown[];
        tools?: unknown; skills?: unknown; customErrorMessage?: string;
      };
      if (!id) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing id" }));
        return;
      }
      await this.ctx.personaManager.registerPersona(id, {
        name,
        prompt,
        beginDialogs: beginDialogs || [],
        moodImitationDialogs: moodImitationDialogs || [],
        tools: tools || null,
        skills: skills || null,
        customErrorMessage: customErrorMessage || null,
      } as unknown as Personality);
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
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: safeClientMessage(err) }));
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
      res.end(JSON.stringify({ ...kb, doc_count: docs.length, chunk_count: docs.reduce((s: number, d: { chunkCount?: number }) => s + (d.chunkCount || 0), 0) }));
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
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ error: safeClientMessage(err) }));
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
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: safeClientMessage(err) }));
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
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: safeClientMessage(err) }));
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
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: safeClientMessage(err) }));
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
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: safeClientMessage(err) }));
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
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ result: null, error: safeClientMessage(err) }));
      }
      return;
    }

    // 16.15 GET /api/config/provider/list — List providers by type
    if (pathname === "/api/config/provider/list" && req.method === "GET") {
      try {
        const providerType = url.searchParams.get("provider_type") || "";
        const types = providerType.split(",").filter(Boolean);
        const providerConfigsMap = this.ctx.providerManager.providerConfigs;
        const providers: Array<Record<string, unknown>> = [];
        for (const [id, config] of providerConfigsMap.entries()) {
          const cfg = config as ProviderRuntimeConfig;
          const pType = cfg.type || "";
          if (types.length === 0 || types.includes(pType)) {
            providers.push({
              id,
              provider_type: pType,
              model: cfg.model || "",
            });
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify(providers));
      } catch (_err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify([]));
      }
      return;
    }

    // 16.16 GET /api/tools/list — List all function tools
    if (pathname === "/api/tools/list" && req.method === "GET") {
      try {
        const toolMgr = this.ctx.toolManager;
        const mcpClientDict = toolMgr?.mcpClientDict as Map<string, unknown> | undefined;
        const tools: Array<{ name: string; description: string; origin: string; active: boolean; readonly: boolean }> = [];

        // Collect from funcList (all registered tools, including MCP tools)
        if (Array.isArray(toolMgr?.funcList)) {
          for (const fnTool of toolMgr.funcList) {
            // MCP tools in funcList carry mcpServerName — use it for origin
            const isMcp = "mcpServerName" in fnTool;
            const mcpName = isMcp ? (fnTool as { mcpServerName?: string }).mcpServerName : undefined;
            tools.push({
              name: fnTool.name || "",
              description: fnTool.description || "",
              origin: mcpName ? `mcp:${mcpName}` : "builtin",
              active: fnTool.active !== false,
              readonly: false,
            });
          }
        }

        // Also check mcpClientDict for any tools not yet in funcList
        // (e.g. mid-connection race). This is a defensive fallback.
        if (mcpClientDict) {
          for (const [serverName, client] of mcpClientDict.entries()) {
            const mcpClient = client as { tools?: Array<{ name?: string; description?: string }> } | null;
            const mcpTools = mcpClient?.tools || [];
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
      } catch (err: unknown) {
        console.error("[tools/list] Error:", err instanceof Error ? err.message : String(err));
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
        config: (a as { config?: Record<string, unknown> }).config || {},
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
        this.ctx.adapterStore?.save(fullConfig as AdapterConfigBase);
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
            config: (adapter as { config?: Record<string, unknown> }).config || {},
          }
        }));
      } catch (err: unknown) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: safeClientMessage(err) }));
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
      } catch (err: unknown) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: safeClientMessage(err) }));
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
        } catch (removeErr: unknown) {
          console.warn(`[DashboardServer] Warning: failed to stop old adapter ${id}:`, removeErr instanceof Error ? removeErr.message : removeErr);
          // Force remove from map even if stop failed
          (this.ctx.adapterRegistry as unknown as { adapters: Map<string, unknown> }).adapters.delete(id);
        }
        // Create new adapter with updated config
        const fullConfig = { ...config, type, id };
        const adapter = await this.ctx.adapterRegistry.addAndStart(
          type, fullConfig, this.ctx.eventQueue,
        );
        // 持久化到数据库
        this.ctx.adapterStore?.save(fullConfig as AdapterConfigBase);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, adapter: { id: adapter.meta().id, status: adapter.status } }));
      } catch (err: unknown) {
        console.error("[DashboardServer] PUT /api/adapters error:", err);
        try {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: safeClientMessage(err) }));
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
        if (typeof (adapter as { getLoginStatus?: unknown }).getLoginStatus === "function") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify((adapter as unknown as { getLoginStatus: () => unknown }).getLoginStatus()));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ loggedIn: true, qrStatus: null, qrImgContent: null, qrError: null }));
        }
      } catch (err: unknown) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: safeClientMessage(err) }));
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
            this.ctx.adapterStore?.save({ ...savedConfig, enabled: false } as AdapterConfigBase);
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
              this.ctx.adapterStore?.save({ ...savedConfig, enabled: true } as AdapterConfigBase);
            }
          } else if (savedConfig) {
            // 实例不存在，从 DB 重新创建并启动
            savedConfig.enabled = true;
            await this.ctx.adapterRegistry.addAndStart(savedConfig.type, savedConfig as AdapterConfigBase, this.ctx.eventQueue);
            this.ctx.adapterStore?.save(savedConfig as AdapterConfigBase);
          } else {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "No saved config for this adapter" }));
            return;
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err: unknown) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: safeClientMessage(err) }));
      }
      return;
    }

    // 18. Conversations (Chat Data)
    if (pathname === "/api/conversations" && req.method === "GET") {
      const store = this.ctx.conversationManager.getStore();
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
      const store = this.ctx.conversationManager.getStore();
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
      const store = this.ctx.conversationManager.getStore();
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
      } catch (err: unknown) {
        console.error("[Dashboard] Error updating conversation:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: safeClientMessage(err, "更新对话失败") }));
      }
      return;
    }

    if (pathname.startsWith("/api/conversations/") && req.method === "DELETE") {
      const id = pathname.substring("/api/conversations/".length);
      const store = this.ctx.conversationManager.getStore();
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
          const sqliteStore = this.ctx.providerManager.getStore();
          let providerConfig = this.ctx.providerManager.getProviderConfigById(sourceId, true, true);

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
        const modelMetadata: Record<string, unknown> = {};
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
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: safeClientMessage(err, "获取模型列表失败") }));
        return;
      }
    }

    // ── Provider Template & Source Management APIs ──

    // 21. GET /api/config/provider/template — 获取提供商模板、源和模型列表
    if (pathname === "/api/config/provider/template" && req.method === "GET") {
      try {
        const configTemplate = this.buildProviderTemplates();
        const sqliteStore = this.ctx.providerManager.getStore();
        let providerSources: Array<Record<string, unknown>> = [];
        let providers: Array<Record<string, unknown>> = [];

        if (sqliteStore) {
          try {
            providerSources = sqliteStore.getAllProviderSources().map((s: { id: string; type: string; provider_type: string; provider: string; key: string; api_base: string; enable: boolean; extra_config: Record<string, unknown> }) => ({
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
          const cfg = config as ProviderRuntimeConfig;
          providers.push({
            id,
            enable: !disabledIds.includes(id),
            model: cfg.model || "",
            provider_source_id: cfg.provider_source_id || "",
            provider_type: cfg.provider_type || this.guessProviderTypeFromConfig(config),
            type: cfg.type || "",
            modalities: cfg.modalities || [],
            custom_extra_body: cfg.custom_extra_body || {},
            max_context_tokens: cfg.max_context_tokens || 0,
            reasoning: cfg.reasoning || false,
            // Masked key — real key only returned via reveal_key endpoint
            key: maskSecret(cfg.apiKey),
            api_base: cfg.baseUrl || "",
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
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: safeClientMessage(err, "获取模板失败") }));
      }
      return;
    }

    // 21.5 GET /api/config/provider_sources/reveal_key — 获取提供商源的真实 API Key
    //
    // Security notes:
    // - This endpoint returns the API key in plain text. It is protected by
    //   the global /api/ auth middleware (Bearer token session).
    // - Responses carry `Cache-Control: no-store` to prevent browsers/proxies
    //   from caching the key in disk or memory.
    // - A per-session rate limiter caps reveal requests to mitigate ID
    //   enumeration and reduce exposure window.
    if (pathname === "/api/config/provider_sources/reveal_key" && req.method === "GET") {
      try {
        const id = url.searchParams.get("id");
        if (!id) {
          res.writeHead(400);
          res.end(JSON.stringify({ status: "error", message: "缺少 id 参数" }));
          return;
        }

        // Per-session rate limiting: max 30 reveals per 5 minutes. This
        // prevents scripted ID enumeration while remaining generous enough
        // for normal dashboard use.
        const authToken = (req.headers["authorization"] ?? "").slice(7).trim();
        const rlKey = `reveal:${authToken}`;
        const now = Date.now();
        const rlEntry = this.loginAttempts.get(rlKey);
        const REVEAL_WINDOW_MS = 5 * 60 * 1000;
        const REVEAL_MAX = 30;
        if (rlEntry && now - rlEntry.firstAttemptAt <= REVEAL_WINDOW_MS) {
          rlEntry.count++;
          if (rlEntry.count > REVEAL_MAX) {
            const retryAfterSec = Math.ceil((REVEAL_WINDOW_MS - (now - rlEntry.firstAttemptAt)) / 1000);
            res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(retryAfterSec) });
            res.end(JSON.stringify({ status: "error", message: `密钥查看过于频繁，请 ${retryAfterSec} 秒后重试` }));
            return;
          }
        } else {
          this.loginAttempts.set(rlKey, { count: 1, firstAttemptAt: now });
        }

        const sqliteStore = this.ctx.providerManager.getStore();
        let realKey = "";
        if (sqliteStore) {
          try {
            const source = sqliteStore.getProviderSource(id);
            if (source?.key) {
              realKey = source.key as string;
            }
          } catch { /* table not created yet */ }
        }
        // 也查找 provider config 中的 apiKey（非聊天类型可能直接存储在 config 中）
        if (!realKey) {
          const config = this.ctx.providerManager.providerConfigs.get(id);
          if (config) {
            const cfg = config as ProviderRuntimeConfig;
            if (cfg.apiKey) {
              realKey = cfg.apiKey as string;
            }
          }
        }
        // no-store prevents browsers/proxies from caching the key response.
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          "Pragma": "no-cache",
          "Expires": "0",
        });
        res.end(JSON.stringify({ status: "ok", key: realKey }));
      } catch (err: unknown) {
        res.writeHead(200, { "Cache-Control": "no-store" });
        res.end(JSON.stringify({ status: "error", message: safeClientMessage(err, "获取密钥失败") }));
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

        const sqliteStore = this.ctx.providerManager.getStore();
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
            const pcfg = pconfig as ProviderRuntimeConfig;
            if (pcfg.provider_source_id === original_id) {
              pcfg.provider_source_id = config.id;
              await this.ctx.providerManager.updateProvider(pid, pcfg as unknown as Parameters<typeof this.ctx.providerManager.updateProvider>[1]);
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
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: safeClientMessage(err, "保存失败") }));
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

        const sqliteStore = this.ctx.providerManager.getStore();
        if (!sqliteStore) {
          res.writeHead(500);
          res.end(JSON.stringify({ status: "error", message: "数据库未初始化" }));
          return;
        }

        // 删除关联的 providers
        const providerConfigsMap = this.ctx.providerManager.providerConfigs;
        const idsToDelete: string[] = [];
        for (const [pid, pconfig] of providerConfigsMap.entries()) {
          if ((pconfig as ProviderRuntimeConfig).provider_source_id === id) {
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
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: safeClientMessage(err, "删除失败") }));
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
        const sqliteStore = this.ctx.providerManager.getStore();
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

        await this.ctx.providerManager.loadProvider(loadConfig as unknown as Parameters<typeof this.ctx.providerManager.loadProvider>[0]);

        if (providerConfig.enable === false) {
          this.ctx.providerManager.setDisabled(providerConfig.id);
        }

        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok", message: "提供商已创建" }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: safeClientMessage(err, "创建失败") }));
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
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: safeClientMessage(err, "删除失败") }));
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
        const sqliteStore = this.ctx.providerManager.getStore();
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

        await this.ctx.providerManager.updateProvider(id, loadConfig as unknown as Parameters<typeof this.ctx.providerManager.updateProvider>[1]);

        if (config.enable === false) {
          this.ctx.providerManager.setDisabled(config.id || id);
        } else {
          this.ctx.providerManager.setEnabled(config.id || id);
        }

        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok", message: "提供商已更新" }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: safeClientMessage(err, "更新失败") }));
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
        const providerConfig = this.ctx.providerManager.getProviderConfigById(providerId, true, true);
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
        const prov = createChatProvider(type as unknown as Parameters<typeof createChatProvider>[0], { apiKey, baseUrl, model, modalities: providerConfig.modalities || [] } as unknown as Parameters<typeof createChatProvider>[1]);

        // 优先使用流式调用测试（与实际对话一致），配置禁用或不支持流式时回退到非流式
        const config = this.ctx.configManager.getActiveConfig();
        const modelStreaming = config?.modelStreaming ?? true;

        if (modelStreaming && prov.textChatStream) {
          let received = false;
          for await (const chunk of prov.textChatStream({
            contexts: [{ role: "user" as const, content: "hello" }],
          })) {
            if (chunk.completionText || chunk.reasoningContent || chunk.toolsCallName) {
              received = true;
              break; // 收到有效内容后确认连通并退出
            }
          }
          if (!received) throw new Error("流式响应未返回有效内容");
        } else {
          await prov.textChat({
            contexts: [{ role: "user" as const, content: "hello" }],
          });
        }

        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok", data: { error: null } }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok", data: { error: safeClientMessage(err, "测试失败") } }));
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
            platform: adapters.map((a) => ({
              name: a.meta?.().name || a.meta?.().id || "unknown",
              count: 0,
            })),
          },
        }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: safeClientMessage(err) }));
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

        // Cache hit stats: tokenInputCached is the cache-read hit tokens
        const totalCachedTokens = stats.reduce((sum, s) => sum + (s.tokenInputCached || 0), 0);
        const totalInputTokens = stats.reduce((sum, s) => sum + (s.tokenInputOther || 0) + (s.tokenInputCached || 0), 0);
        const cacheHitRate = totalInputTokens > 0 ? totalCachedTokens / totalInputTokens : 0;

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
              cached_trend: this.generateCachedTrendFromStats(stats, days),
            },
            range_by_provider: ranking,
            range_total_tokens: totalTokens,
            range_total_calls: totalCalls,
            range_avg_ttft_ms: Math.round(avgTtft),
            range_avg_duration_ms: Math.round(avgDuration),
            range_avg_tpm: avgTpm,
            range_success_rate: 1.0,
            range_total_cached_tokens: totalCachedTokens,
            range_cache_hit_rate: Math.round(cacheHitRate * 10000) / 10000,
          },
        }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "error", message: safeClientMessage(err) }));
      }
      return;
    }

    // 30. GET /api/tools/mcp/servers — Enhanced MCP server list with runtime info
    if (pathname === "/api/tools/mcp/servers" && req.method === "GET") {
      try {
        const sqliteStore = this.ctx.providerManager.getStore();
        const mcpConfigs = sqliteStore ? sqliteStore.getAllMcpServerConfigs() : [];
        const toolMgr = this.ctx.toolManager;
        const mcpClientDict = toolMgr?.mcpClientDict as unknown as ReadonlyMap<string, { active?: boolean; tools?: Array<{ name: string }>; serverErrLogs?: unknown[] }> | undefined;

        const servers = mcpConfigs.map((cfg) => {
          const client = mcpClientDict?.get(cfg.serverName);
          return {
            name: cfg.serverName,
            config: cfg.config,
            active: client?.active ?? false,
            tools: client?.tools?.map((t: { name: string }) => t.name) ?? [],
            errlogs: client?.serverErrLogs ?? [],
            createdAt: cfg.createdAt,
            updatedAt: cfg.updatedAt,
          };
        });

        res.writeHead(200);
        res.end(JSON.stringify(servers));
      } catch (_err: unknown) {
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
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, tools: [], message: safeClientMessage(err, "连接失败") }));
      }
      return;
    }

    // 32. POST /api/tools/mcp/update — Update MCP server (including toggle active)
    if (pathname === "/api/tools/mcp/update" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const { serverName, config, active, oldName } = JSON.parse(body);
        const sqliteStore = this.ctx.providerManager.getStore();

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
          const toolMgr = this.ctx.toolManager;
          if (active) {
            await toolMgr?.enableMcpServer?.(serverName, config || {});
          } else {
            await toolMgr?.disableMcpServer?.(serverName);
          }
        }

        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: safeClientMessage(err) }));
      }
      return;
    }

    // 33. POST /api/tools/mcp/delete — Delete MCP server
    if (pathname === "/api/tools/mcp/delete" && req.method === "POST") {
      try {
        const body = await this.readBody(req);
        const { serverName } = JSON.parse(body);
        const sqliteStore = this.ctx.providerManager.getStore();
        if (sqliteStore) sqliteStore.deleteMcpServerConfig(serverName);
        const toolMgr = this.ctx.toolManager;
        await toolMgr?.terminateMcpClient?.(serverName);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: safeClientMessage(err) }));
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
        const skill = skills.find((s) => s.name === skillName);
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
          const archive = (Archiver as { default: (type: string, opts?: Record<string, unknown>) => { pipe: (dest: ServerResponse) => void; directory: (path: string, flag: boolean) => void; finalize: () => Promise<void> } }).default("zip", { zlib: { level: 9 } });
          archive.pipe(res);
          archive.directory(skillPath, false);
          await archive.finalize();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Archiver not available", path: skillPath }));
        }
      } catch (err: unknown) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: safeClientMessage(err) }));
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
        const skill = skills.find((s) => s.name === skillName);
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
        const files = entries.map((e: { name: string; isDirectory: () => boolean }) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          path: subPath ? `${subPath}/${e.name}` : e.name,
        }));
        res.writeHead(200);
        res.end(JSON.stringify(files));
      } catch (_err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify([]));
      }
      return;
    }

    // ── Memory APIs ──

    // M1. GET /api/memories — 列出记忆（支持分页、搜索、类型/作用域筛选）
    if (pathname === "/api/memories" && req.method === "GET") {
      try {
        const memoryStore = this.ctx.memoryStore;
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

        const filterOptions: { memoryType?: MemoryType; scope?: MemoryScope; scopeId?: string } = {};
        if (memoryType) filterOptions.memoryType = memoryType as MemoryType;
        if (scope) filterOptions.scope = scope as MemoryScope;
        if (scopeId) filterOptions.scopeId = scopeId;

        let memories: MemoryEntry[];
        if (query) {
          memories = memoryStore.search(query, limit, filterOptions);
        } else {
          memories = memoryStore.list(limit, filterOptions);
        }
        const total = memoryStore.count(filterOptions);
        res.writeHead(200);
        res.end(JSON.stringify({ memories, total }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ memories: [], total: 0, error: safeClientMessage(err) }));
      }
      return;
    }

    // M2. POST /api/memories — 新建/更新记忆（支持分层参数）
    if (pathname === "/api/memories" && req.method === "POST") {
      try {
        const memoryStore = this.ctx.memoryStore;
        if (!memoryStore) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Memory store not initialized" }));
          return;
        }
        const parsed = await this.readJsonObject(req);
        if (!parsed.ok) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: parsed.error }));
          return;
        }
        const { key, value, tags, memory_type, scope, scope_id, priority, expires_at } = parsed.value as {
          key?: string; value?: string; tags?: unknown[];
          memory_type?: string; scope?: string; scope_id?: string;
          priority?: number; expires_at?: string;
        };
        if (!key) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing key" }));
          return;
        }
        const options: { memoryType?: MemoryType; scope?: MemoryScope; scopeId?: string; priority?: number; expiresAt?: string | null } = {};
        if (memory_type) options.memoryType = memory_type as MemoryType;
        if (scope) options.scope = scope as MemoryScope;
        if (scope_id) options.scopeId = scope_id;
        if (priority !== undefined) options.priority = priority;
        if (expires_at !== undefined) options.expiresAt = expires_at;

        memoryStore.save(key, value || "", Array.isArray(tags) ? tags.map(String) : [], options);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: safeClientMessage(err) }));
      }
      return;
    }

    // M3. GET /api/memories/search — 搜索记忆（支持类型/作用域筛选）
    if (pathname === "/api/memories/search" && req.method === "GET") {
      try {
        const memoryStore = this.ctx.memoryStore;
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
        const filterOptions: { memoryType?: MemoryType; scope?: MemoryScope; scopeId?: string } = {};
        if (memoryType) filterOptions.memoryType = memoryType as MemoryType;
        if (scope) filterOptions.scope = scope as MemoryScope;
        if (scopeId) filterOptions.scopeId = scopeId;

        const memories = memoryStore.search(query, limit, filterOptions);
        res.writeHead(200);
        res.end(JSON.stringify(memories));
      } catch (_err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify([]));
      }
      return;
    }

    // M4. DELETE /api/memories/:key — 删除记忆
    if (pathname.startsWith("/api/memories/") && req.method === "DELETE") {
      try {
        const memoryStore = this.ctx.memoryStore;
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
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: safeClientMessage(err) }));
      }
      return;
    }

    // M5. POST /api/memories/clear — 清空所有记忆
    if (pathname === "/api/memories/clear" && req.method === "POST") {
      try {
        const memoryStore = this.ctx.memoryStore;
        if (!memoryStore) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Memory store not initialized" }));
          return;
        }
        const count = memoryStore.clear();
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, deletedCount: count }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: safeClientMessage(err) }));
      }
      return;
    }

    // M6. GET /api/memories/stats — 记忆统计
    if (pathname === "/api/memories/stats" && req.method === "GET") {
      try {
        const memoryStore = this.ctx.memoryStore;
        if (!memoryStore) {
          res.writeHead(200);
          res.end(JSON.stringify({ total: 0, byType: {}, byScope: {} }));
          return;
        }
        const stats = memoryStore.stats();
        res.writeHead(200);
        res.end(JSON.stringify(stats));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ total: 0, byType: {}, byScope: {}, error: safeClientMessage(err) }));
      }
      return;
    }

    // M7. POST /api/memories/consolidate — 手动触发记忆整理
    if (pathname === "/api/memories/consolidate" && req.method === "POST") {
      try {
        const consolidator = this.ctx.memoryConsolidator;
        if (!consolidator) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Memory consolidator not initialized" }));
          return;
        }
        const result = await consolidator.consolidate({ force: true });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, result }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: safeClientMessage(err) }));
      }
      return;
    }

    // M8. GET /api/memories/consolidation-config — 获取整理配置
    if (pathname === "/api/memories/consolidation-config" && req.method === "GET") {
      try {
        const consolidator = this.ctx.memoryConsolidator;
        if (!consolidator) {
          res.writeHead(200);
          res.end(JSON.stringify({ enabled: false }));
          return;
        }
        const config = consolidator.getConfig();
        res.writeHead(200);
        res.end(JSON.stringify(config));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ enabled: false, error: safeClientMessage(err) }));
      }
      return;
    }

    // M9. PATCH /api/memories/consolidation-config — 更新整理配置
    if (pathname === "/api/memories/consolidation-config" && req.method === "PATCH") {
      try {
        const consolidator = this.ctx.memoryConsolidator;
        if (!consolidator) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Memory consolidator not initialized" }));
          return;
        }
        const body = await this.readBody(req);
        const updates = JSON.parse(body);
        consolidator.updateConfig(updates);
        // Apply the new interval / enabled state to the running periodic timer
        // so config changes take effect immediately (mirrors bootstrap.ts).
        consolidator.startPeriodic();
        const config = consolidator.getConfig();
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, config }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: safeClientMessage(err) }));
      }
      return;
    }

    // M10. GET /api/conversation-indices — 列出/搜索对话索引（由整理器写入的 title+topics）
    if (pathname === "/api/conversation-indices" && req.method === "GET") {
      try {
        const memoryStore = this.ctx.memoryStore;
        if (!memoryStore) {
          res.writeHead(200);
          res.end(JSON.stringify({ indices: [], total: 0 }));
          return;
        }
        const limit = parseInt(url.searchParams.get("limit") || "50");
        const query = url.searchParams.get("search") || "";
        let indices: ConversationIndexEntry[];
        if (query) {
          indices = memoryStore.searchConversationIndices(query, limit);
        } else {
          indices = memoryStore.listConversationIndices(limit);
        }
        const total = memoryStore.countConversationIndices();
        res.writeHead(200);
        res.end(JSON.stringify({ indices, total }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ indices: [], total: 0, error: safeClientMessage(err) }));
      }
      return;
    }

    // M11. DELETE /api/conversation-indices/:id — 删除单条对话索引
    if (pathname.startsWith("/api/conversation-indices/") && req.method === "DELETE") {
      try {
        const memoryStore = this.ctx.memoryStore;
        if (!memoryStore) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Memory store not initialized" }));
          return;
        }
        const idStr = pathname.substring("/api/conversation-indices/".length);
        const id = parseInt(idStr, 10);
        if (!Number.isFinite(id)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid index id" }));
          return;
        }
        const deleted = memoryStore.deleteConversationIndex(id);
        res.writeHead(200);
        res.end(JSON.stringify({ success: deleted }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: safeClientMessage(err) }));
      }
      return;
    }

    // M12. POST /api/conversation-indices/clear — 清空所有对话索引
    if (pathname === "/api/conversation-indices/clear" && req.method === "POST") {
      try {
        const memoryStore = this.ctx.memoryStore;
        if (!memoryStore) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Memory store not initialized" }));
          return;
        }
        // list all then delete in a loop; store has no bulk-delete for indices
        const all = memoryStore.listConversationIndices(Number.MAX_SAFE_INTEGER);
        for (const idx of all) {
          memoryStore.deleteConversationIndex(idx.id);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, deletedCount: all.length }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: safeClientMessage(err) }));
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
        const skill = skills.find((s) => s.name === skillName);
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
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ error: safeClientMessage(err) }));
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
        const skill = skills.find((s) => s.name === name);
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
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: safeClientMessage(err) }));
      }
      return;
    }

    // ─── Scheduler Task API ──────────────────────────────────────────────
    // S1. GET /api/scheduler/tasks — 列出定时任务（支持分页、类型/状态筛选、搜索）
    if (pathname === "/api/scheduler/tasks" && req.method === "GET") {
      try {
        const store = this.ctx.schedulerStore;
        if (!store) {
          res.writeHead(200);
          res.end(JSON.stringify({ tasks: [], total: 0 }));
          return;
        }
        const limit = parseInt(url.searchParams.get("limit") || "50");
        const type = url.searchParams.get("type") || undefined;
        const status = url.searchParams.get("status") || undefined;
        const umo = url.searchParams.get("umo") || undefined;
        const search = url.searchParams.get("search") || "";

        const opts: { type?: TaskType; status?: TaskStatus; umo?: string } = {};
        if (type) opts.type = type as TaskType;
        if (status) opts.status = status as TaskStatus;
        if (umo) opts.umo = umo;

        let tasks: SchedulerTask[];
        if (search) {
          tasks = store.search(search, limit, opts);
        } else {
          tasks = store.list(limit, opts);
        }
        const total = store.count(opts);
        res.writeHead(200);
        res.end(JSON.stringify({ tasks, total }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ tasks: [], total: 0, error: safeClientMessage(err) }));
      }
      return;
    }

    // S2. GET /api/scheduler/tasks/:id — 获取单个定时任务
    if (pathname.startsWith("/api/scheduler/tasks/") && !pathname.includes("/fire") && req.method === "GET") {
      try {
        const store = this.ctx.schedulerStore;
        if (!store) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Scheduler store not initialized" }));
          return;
        }
        const taskId = decodeURIComponent(pathname.slice("/api/scheduler/tasks/".length));
        const task = store.get(taskId);
        if (!task) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Task not found" }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ task }));
      } catch (err: unknown) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: safeClientMessage(err) }));
      }
      return;
    }

    // S3. POST /api/scheduler/tasks — 创建定时任务
    if (pathname === "/api/scheduler/tasks" && req.method === "POST") {
      try {
        const store = this.ctx.schedulerStore;
        if (!store) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Scheduler store not initialized" }));
          return;
        }
        const parsed = await this.readJsonObject(req);
        if (!parsed.ok) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: parsed.error }));
          return;
        }
        const body = parsed.value as Record<string, unknown>;
        if (!body.title) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing title" }));
          return;
        }
        const now = new Date();
        const { computeInitialNextFireAt } = await import("@yachiyo/agent/scheduler-task-store.js");
        const nextFireAt = computeInitialNextFireAt(
          (body.scheduled_at as string | null | undefined) ?? null,
          (body.recurrence as string | null | undefined) ?? null,
          now,
        );
        const taskId = (body.id as string) || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const plan = Array.isArray(body.plan) ? body.plan : [];
        const task = {
          id: taskId,
          type: (body.type as TaskType) || "reminder",
          title: body.title as string,
          description: (body.description as string) || "",
          status: (body.status as TaskStatus) || "pending",
          priority: (body.priority as number) ?? 0,
          scheduledAt: (body.scheduled_at as string | null) ?? null,
          recurrence: (body.recurrence as string | null) ?? null,
          goal: (body.goal as string | null) ?? null,
          plan,
          currentStep: plan.length > 0 ? 0 : -1,
          tags: Array.isArray(body.tags) ? body.tags as string[] : [],
          umo: (body.umo as string | null) ?? null,
          sessionId: (body.session_id as string | null) ?? null,
          platformId: (body.platform_id as string | null) ?? null,
          payload: (body.payload as unknown) ?? null,
          lastFiredAt: null,
          nextFireAt,
        } as SchedulerTask;
        store.save(task);
        res.writeHead(201);
        res.end(JSON.stringify({ task }));
      } catch (err: unknown) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: safeClientMessage(err) }));
      }
      return;
    }

    // S4. PATCH /api/scheduler/tasks/:id — 更新定时任务
    if (pathname.startsWith("/api/scheduler/tasks/") && req.method === "PATCH") {
      try {
        const store = this.ctx.schedulerStore;
        if (!store) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Scheduler store not initialized" }));
          return;
        }
        const taskId = decodeURIComponent(pathname.slice("/api/scheduler/tasks/".length));
        const existing = store.get(taskId);
        if (!existing) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Task not found" }));
          return;
        }
        const parsed = await this.readJsonObject(req);
        if (!parsed.ok) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: parsed.error }));
          return;
        }
        const body = parsed.value as Record<string, unknown>;
        const updated = {
          ...existing,
          ...(body.title !== undefined && { title: body.title as string }),
          ...(body.description !== undefined && { description: body.description as string }),
          ...(body.status !== undefined && { status: body.status as TaskStatus }),
          ...(body.priority !== undefined && { priority: body.priority as number }),
          ...(body.scheduled_at !== undefined && { scheduledAt: body.scheduled_at as string | null }),
          ...(body.recurrence !== undefined && { recurrence: body.recurrence as string | null }),
          ...(body.goal !== undefined && { goal: body.goal as string | null }),
          ...(body.payload !== undefined && { payload: body.payload as unknown }),
          ...(body.tags !== undefined && { tags: Array.isArray(body.tags) ? body.tags as string[] : existing.tags }),
        } as SchedulerTask;
        store.save(updated);
        res.writeHead(200);
        res.end(JSON.stringify({ task: updated }));
      } catch (err: unknown) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: safeClientMessage(err) }));
      }
      return;
    }

    // S5. DELETE /api/scheduler/tasks/:id — 删除定时任务
    if (pathname.startsWith("/api/scheduler/tasks/") && req.method === "DELETE") {
      try {
        const store = this.ctx.schedulerStore;
        if (!store) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Scheduler store not initialized" }));
          return;
        }
        const taskId = decodeURIComponent(pathname.slice("/api/scheduler/tasks/".length));
        const deleted = store.delete(taskId);
        if (!deleted) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Task not found" }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err: unknown) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: safeClientMessage(err) }));
      }
      return;
    }

    // S6. GET /api/scheduler/stats — 定时任务统计
    if (pathname === "/api/scheduler/stats" && req.method === "GET") {
      try {
        const store = this.ctx.schedulerStore;
        if (!store) {
          res.writeHead(200);
          res.end(JSON.stringify({ stats: { total: 0, byType: {}, byStatus: {} } }));
          return;
        }
        const stats = store.stats();
        res.writeHead(200);
        res.end(JSON.stringify({ stats }));
      } catch (err: unknown) {
        res.writeHead(200);
        res.end(JSON.stringify({ stats: { total: 0, byType: {}, byStatus: {} }, error: safeClientMessage(err) }));
      }
      return;
    }

    // S7. POST /api/scheduler/tasks/:id/fire — 立即触发任务
    if (pathname.includes("/fire") && pathname.startsWith("/api/scheduler/tasks/") && req.method === "POST") {
      try {
        const store = this.ctx.schedulerStore;
        if (!store) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Scheduler store not initialized" }));
          return;
        }
        const taskId = decodeURIComponent(pathname.slice("/api/scheduler/tasks/".length, pathname.lastIndexOf("/fire")));
        const task = store.get(taskId);
        if (!task) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Task not found" }));
          return;
        }
        const now = new Date();
        const { computeInitialNextFireAt } = await import("@yachiyo/agent/scheduler-task-store.js");
        const nextFireAt = task.recurrence
          ? computeInitialNextFireAt(task.scheduledAt, task.recurrence, now)
          : null;
        const updated = {
          ...task,
          lastFiredAt: now.toISOString(),
          nextFireAt,
          status: task.recurrence ? task.status : "completed",
        };
        store.save(updated);
        res.writeHead(200);
        res.end(JSON.stringify({ task: updated }));
      } catch (err: unknown) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: safeClientMessage(err) }));
      }
      return;
    }

    // ─── End Scheduler Task API ──────────────────────────────────────────

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
        const { MessageEvent: ME, PlatformMessage, ResultContentType: RCT } = await import("@yachiyo/message/index.js");
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
        platformMsg.components = [{ type: ComponentType.Plain, text: message } as unknown as import("@yachiyo/message/components.js").PlainComponent];
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
          async send(components: import("@yachiyo/message/components.js").MessageComponent[]): Promise<void> {
            for (const c of components) {
              if (c.type === ComponentType.Plain) responseText += (c as import("@yachiyo/message/components.js").PlainComponent).text ?? "";
            }
          }
          async sendStreaming(gen: AsyncIterable<{ message?: string }>): Promise<void> {
            for await (const chunk of gen) {
              if (chunk.message) responseText += chunk.message;
            }
          }
          async sendTyping(): Promise<void> {}
          async stopTyping(): Promise<void> {}
          get unifiedMsgOrigin(): string { return umo; }
        })(message, platformMsg, platformMeta, sessionId);

        // Mark this event as a debug chat so the pipeline can skip
        // recording it to memory (avoids triggering memory consolidation
        // and polluting long-term memory with debug/test conversations).
        event.setExtra("_debugChat", true);

        // Push to event queue
        this.ctx.eventQueue.put(event);

        // Wait for response with timeout
        const timeout = setTimeout(() => { responseResolve?.(); }, 180000);

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
      } catch (err: unknown) {
        console.error("[DebugWebhook] Error:", err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: safeClientMessage(err) }));
      }
      return;
    }

    // ---- Debug: GET /api/debug/conversation ----
    if (pathname === "/api/debug/conversation" && req.method === "GET") {
      const sessionId = url.searchParams.get("session_id") ?? "debug-session";
      const umo = `debug:webhook:${sessionId}`;
      try {
        const convId = await this.ctx.conversationManager.getCurrConversationId(umo);
        let history: unknown[] = [];
        if (convId) {
          const conv = await this.ctx.conversationManager.getConversation(umo, convId);
          if (conv) history = JSON.parse(conv.history);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ umo, convId, messageCount: history.length, history }));
      } catch (err: unknown) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: safeClientMessage(err) }));
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
      } catch (err: unknown) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: safeClientMessage(err) }));
      }
      return;
    }

    // ── Proxy Management ──

    // GET /api/proxy — get current proxy status
    if (pathname === "/api/proxy" && req.method === "GET") {
      const status = proxyManager.getStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
      return;
    }

    // PUT /api/proxy — set, update, or disable the proxy
    // Body: { "url": "http://127.0.0.1:7890" } to enable,
    //       { "url": null } to disable
    if (pathname === "/api/proxy" && req.method === "PUT") {
      const parsed = await this.readJsonObject(req);
      if (!parsed.ok) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: parsed.error }));
        return;
      }
      const body = parsed.value as { url?: string | null };
      const url = body.url ?? null;

      // Validate URL if non-null
      if (url) {
        try {
          const normalized = /^[a-z][a-z0-9]*:\/\//i.test(url) ? url : `http://${url}`;
          new URL(normalized);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Invalid proxy URL: ${url}` }));
          return;
        }
      }

      await proxyManager.setProxy(url, "runtime");
      const status = proxyManager.getStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, ...status }));
      return;
    }

    // POST /api/proxy/test — test proxy connectivity
    // Body: { "test_url"?: "https://...", "timeout"?: 10 }
    if (pathname === "/api/proxy/test" && req.method === "POST") {
      let testUrl: string | undefined;
      let timeoutSec = 10;
      try {
        const parsed = await this.readJsonObject(req);
        if (parsed.ok) {
          const body = parsed.value as { test_url?: string; timeout?: number };
          testUrl = body.test_url;
          if (typeof body.timeout === "number") {
            timeoutSec = Math.min(Math.max(body.timeout, 1), 60);
          }
        }
      } catch {
        // Body parse failed — use defaults
      }

      const result = await proxyManager.testProxy(testUrl, timeoutSec * 1000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
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
    const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB — reject oversized payloads
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      req.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          req.destroy();
          reject(new Error("Request body exceeds 10 MB limit"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", (err) => reject(err));
    });
  }

  /**
   * Read the request body, parse it as JSON, and validate that the result
   * is a plain object (not array/primitive/null). Returns `{ ok: true, value }`
   * on success, or `{ ok: false, error }` with a client-safe message.
   *
   * Use this instead of `readBody` + `JSON.parse` at handler boundaries
   * to guarantee a structured 400 response for malformed payloads (rather
   * than a 500 from the outer catch).
   */
  private async readJsonObject(
    req: IncomingMessage,
  ): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
    let body: string;
    try {
      body = await this.readBody(req);
    } catch {
      return { ok: false, error: "读取请求体失败" };
    }
    return parseJsonObject(body);
  }

  /**
   * 从提供商获取可用模型列表
   * 按 type 严格匹配接口格式：
   *   - openai / openai_responses → OpenAI 兼容 /v1/models + Bearer auth
   *   - gemini                   → Gemini 原生 /v1beta/models?key=xxx
   *   - anthropic                → Anthropic 原生 /v1/models + x-api-key
   * 若用户使用 OpenAI 兼容代理（如 one-api）代理 Gemini 模型，
   * 应将 Provider 类型选为 openai/openai_responses 以使用对应格式获取列表。
   */
  private async fetchModelsFromProvider(type: string, config: Record<string, unknown>): Promise<string[]> {
    const apiKey = (config.apiKey as string) ?? "";
    const rawBaseUrl = ((config.baseUrl as string | undefined) || "").replace(/\/+$/, "");

    // OpenAI 兼容接口 (openai, openai_responses)
    if (type === "openai" || type === "openai_responses") {
      const url = `${rawBaseUrl || "https://api.openai.com/v1"}/models`;
      console.log(`[Dashboard] OpenAI: fetching models from ${url}`);
      const response = await safeFetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        throw new Error(`获取模型列表失败 (${response.status}): ${errBody.substring(0, 200) || response.statusText}`);
      }

      const data = await response.json() as { data?: Array<{ id?: string }> };
      if (!Array.isArray(data.data)) {
        throw new Error(`模型列表响应格式异常: 期望 data 数组，得到 ${typeof data.data}。可能是 baseUrl 或 type 配置不匹配。`);
      }

      // 过滤出聊天模型，按 id 排序
      return data.data
        .map((m) => m.id || "")
        .filter((id: string) => !!id && !id.startsWith("babbage-") && !id.startsWith("curie-"))
        .sort();
    }

    // Google Gemini — 始终使用 Gemini 原生格式 /v1beta/models
    // 使用 x-goog-api-key header 鉴权（与 gemini-provider.ts 保持一致，避免 key 泄露到 URL/日志）
    // 如需使用 OpenAI 兼容代理获取 Gemini 模型，请将 Provider 类型选为 openai/openai_responses
    if (type === "gemini") {
      let geminiBase: string;
      // Use URL parsing for hostname comparison instead of substring check
      // to prevent bypass via crafted subdomain paths.
      let isGeminiHost = false;
      try {
        const parsed = new URL(rawBaseUrl || "https://generativelanguage.googleapis.com");
        isGeminiHost = parsed.hostname === "generativelanguage.googleapis.com";
      } catch {
        isGeminiHost = false;
      }
      if (!rawBaseUrl || isGeminiHost) {
        geminiBase = "https://generativelanguage.googleapis.com/v1beta";
      } else {
        // 强制使用 /v1beta 路径：剥离任何已有的版本后缀（/v1、/v1beta 等），统一追加 /v1beta
        let stripped = rawBaseUrl;
        const versionSuffixes = ["/v1beta", "/v1", "/v2beta", "/v2"];
        for (const suffix of versionSuffixes) {
          if (stripped.endsWith(suffix)) {
            stripped = stripped.slice(0, -suffix.length);
            break;
          }
        }
        geminiBase = `${stripped}/v1beta`;
      }
      const url = `${geminiBase}/models`;
      console.log(`[Dashboard] Gemini: fetching models from ${url}`);
      const response = await safeFetch(url, {
        headers: { "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(15000),
      });
      const respText = await response.text();

      if (!response.ok) {
        if (respText.startsWith("<")) {
          throw new Error(`端点返回了HTML页面而非JSON (${response.status})。如果是 OpenAI 兼容代理，请将 Provider 类型改为 openai/openai_responses。请求URL: ${url}`);
        }
        throw new Error(`获取模型列表失败 (${response.status}): ${respText.substring(0, 200) || response.statusText}`);
      }
      if (!respText.startsWith("{")) {
        throw new Error(`端点返回了非JSON响应。如果是 OpenAI 兼容代理，请将 Provider 类型改为 openai/openai_responses。请求URL: ${url}`);
      }

      const data = JSON.parse(respText) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
      if (!Array.isArray(data.models)) {
        throw new Error(`模型列表响应格式异常: 期望 models 数组，得到 ${typeof data.models}。可能是 baseUrl 或 type 配置不匹配。`);
      }

      // 只返回支持 generateContent 的模型
      return data.models
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => (m.name || "").replace("models/", ""))
        .sort();
    }

    // Anthropic Claude
    if (type === "anthropic") {
      const url = `${rawBaseUrl || "https://api.anthropic.com"}/v1/models`;
      console.log(`[Dashboard] Anthropic: fetching models from ${url}`);
      const response = await safeFetch(url, {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        throw new Error(`获取模型列表失败 (${response.status}): ${errBody.substring(0, 200) || response.statusText}`);
      }

      const data = await response.json() as { data?: Array<{ id?: string }> };
      if (!Array.isArray(data.data)) {
        throw new Error(`模型列表响应格式异常: 期望 data 数组，得到 ${typeof data.data}。可能是 baseUrl 或 type 配置不匹配。`);
      }

      return data.data.map((m) => m.id || "").sort();
    }

    throw new Error(`不支持的提供商类型: ${type}，暂无法获取模型列表`);
  }

  /**
   * 构建提供商模板配置，用于前端"添加供应商源"对话框
   */
  private buildProviderTemplates(): Record<string, unknown> {
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
    // Cap total upload size to prevent memory exhaustion via oversized bodies.
    // Skill ZIPs are small (<10 MB typical), so 100 MB is a generous ceiling.
    const MAX_MULTIPART_BYTES = 100 * 1024 * 1024;

    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/);
    if (!boundaryMatch) {
      return { files: [], error: "无效的 Content-Type (缺少 boundary)" };
    }
    const boundary = boundaryMatch[1] || boundaryMatch[2];

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_MULTIPART_BYTES) {
        req.destroy();
        return { files: [], error: "上传数据过大 (超过 100 MB 限制)" };
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    const files: Array<{ originalName: string; tempPath: string; size: number }> = [];

    // Parse multipart using Buffer.indexOf() on the raw binary buffer.
    //
    // The previous implementation converted the entire body to a "binary"
    // string via `body.toString("binary")` and used `String.split()` +
    // `String.substring()`. This is fragile because:
    //   1. The boundary delimiter bytes could legitimately appear inside a
    //      binary file (e.g., a ZIP archive), causing false splits.
    //      (Mitigated here by searching for `--boundary\r\n` / `--boundary--`
    //      with proper CRLF framing, but Buffer-level search is still safer.)
    //   2. String operations on large bodies create extra copies, doubling
    //      memory usage.
    //   3. `Buffer.from(fileData, "binary")` is lossy for some edge cases.
    //
    // The Buffer-based approach below operates entirely on raw bytes,
    // avoiding encoding issues and keeping memory usage to a single copy.

    const dashBoundary = Buffer.from("--" + boundary);
    const CRLFCRLF = Buffer.from("\r\n\r\n");

    let pos = 0;
    while (pos < body.length) {
      // Find the next boundary marker.
      const partStart = body.indexOf(dashBoundary, pos);
      if (partStart < 0) break;

      // Skip past the boundary + CRLF (or detect closing boundary `--`)
      let headerStart = partStart + dashBoundary.length;
      // Check for closing boundary: `--boundary--`
      if (body[headerStart] === 0x2d /* '-' */ && body[headerStart + 1] === 0x2d /* '-' */) {
        break; // end of multipart
      }
      // Skip CRLF after boundary (normal case)
      if (body[headerStart] === 0x0d /* \r */ && body[headerStart + 1] === 0x0a /* \n */) {
        headerStart += 2;
      }

      // Find the end of headers (\r\n\r\n)
      const headerEnd = body.indexOf(CRLFCRLF, headerStart);
      if (headerEnd < 0) break;

      const headerBuf = body.subarray(headerStart, headerEnd);
      const headerStr = headerBuf.toString("utf8");

      // Find the next boundary (start of next part or closing)
      const nextBoundary = body.indexOf(dashBoundary, headerEnd + 4);
      if (nextBoundary < 0) break;

      // File data is between headerEnd+4 and nextBoundary, minus the trailing CRLF.
      let dataStart = headerEnd + 4;
      let dataEnd = nextBoundary;
      // The part data is followed by \r\n before the next boundary
      if (dataEnd >= 2 && body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) {
        dataEnd -= 2;
      }

      const dataBuffer = body.subarray(dataStart, dataEnd);

      // Only process parts with a filename header.
      if (!/filename=/i.test(headerStr)) {
        pos = nextBoundary;
        continue;
      }

      const filenameMatch = headerStr.match(/filename="(.+?)"/i);
      if (!filenameMatch) {
        pos = nextBoundary;
        continue;
      }
      const originalName = decodeURIComponent(filenameMatch[1]);

      if (dataBuffer.length === 0) {
        files.push({ originalName, tempPath: "", size: 0 });
        pos = nextBoundary;
        continue;
      }

      const tmpDir = join(tmpdir(), `skill-upload-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });
      const tempPath = join(tmpDir, originalName.replace(/[^a-zA-Z0-9._-]/g, "_"));
      await writeFile(tempPath, dataBuffer);
      files.push({ originalName, tempPath, size: dataBuffer.length });

      pos = nextBoundary;
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
          const rootEntries = entries.filter((e: ZipEntry) => !e.entryName.includes("/"));
          const hasSkillMd = rootEntries.some((e: ZipEntry) =>
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
            const dirEntries = entries.filter((e: ZipEntry) => e.entryName.startsWith(dirPrefix));

            const hasSkillMd = dirEntries.some((e: ZipEntry) => {
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
      } catch (err: unknown) {
        zipResult.skills.push({
          name: file.originalName,
          status: "error",
          message: safeClientMessage(err, "ZIP 解析失败"),
        });
      }

      results.push(zipResult);
    }

    return results;
  }

  private parseZipRootSkills(
    zip: ZipReader,
    entries: ZipEntry[]
  ): Array<{ name: string; description: string; path: string; active: boolean; sourceType: string; sourceLabel: string; localExists: boolean; sandboxExists: boolean; pluginName: string; readonly: boolean }> {
    const results: Array<{ name: string; description: string; path: string; active: boolean; sourceType: string; sourceLabel: string; localExists: boolean; sandboxExists: boolean; pluginName: string; readonly: boolean }> = [];

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
    zip: ZipReader,
    dirPrefix: string,
    _entries: ZipEntry[],
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
