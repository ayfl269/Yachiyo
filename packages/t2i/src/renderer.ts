/**
 * Text-to-Image (T2I) Renderer
 *
 * Converts model's markdown reply into an image by:
 * 1. Rendering markdown → HTML using a styled template
 * 2. Screenshotting the HTML via Playwright (local headless browser)
 * 3. Saving the result as an image file
 */

import { chromium, type Browser, type Page, type Route } from "playwright";
import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { lookup } from "dns";
import { assertSafeUrl } from "@yachiyo/common/ssrf-guard.js";

// ── Types ──

export interface T2IConfig {
  /** Enable T2I rendering */
  enabled: boolean;
  /** Render width in pixels */
  width: number;
  /** Image quality (jpeg: 1-100, png: ignored) */
  quality: number;
  /** Image format: 'png' or 'jpeg' */
  format: "png" | "jpeg";
  /** Template name */
  template: string;
}

export interface T2IResult {
  /** File path of the rendered image */
  filePath: string;
  /** Image width */
  width: number;
  /** Image height */
  height: number;
}

// ── Default Config ──

export const DEFAULT_T2I_CONFIG: T2IConfig = {
  enabled: false,
  width: 800,
  quality: 85,
  format: "png",
  template: "default",
};

// ── HTML Templates ──

const TEMPLATES: Record<string, string> = {
  default: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>T2I Render</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
    font-size: 16px;
    line-height: 1.75;
    color: #e4e4e7;
    background-color: #18181b;
    word-break: break-word;
    padding: 2rem 2.5rem;
    max-width: {{WIDTH}}px;
  }
  h1, h2, h3, h4, h5, h6 {
    line-height: 1.5;
    margin-top: 1.5em;
    margin-bottom: 0.6em;
    font-weight: 600;
    color: #fafafa;
  }
  h1 { font-size: 2em; border-bottom: 1px solid #3f3f46; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #27272a; padding-bottom: 0.25em; }
  h3 { font-size: 1.25em; }
  h4 { font-size: 1.1em; }
  p { margin-top: 0.8em; margin-bottom: 0.8em; }
  strong { color: #fafafa; font-weight: 600; }
  em { font-style: italic; }
  a { color: #818cf8; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code {
    font-family: "Menlo", "Consolas", "Monaco", monospace;
    font-size: 0.875em;
    background: #27272a;
    padding: 0.2em 0.4em;
    border-radius: 4px;
    color: #a78bfa;
  }
  pre {
    background: #27272a;
    border: 1px solid #3f3f46;
    border-radius: 8px;
    padding: 1em;
    overflow-x: auto;
    margin: 1em 0;
  }
  pre code {
    background: none;
    padding: 0;
    color: #e4e4e7;
    font-size: 0.85em;
  }
  blockquote {
    border-left: 4px solid #818cf8;
    padding: 0.5em 1em;
    margin: 1em 0;
    color: #a1a1aa;
    background: rgba(39, 39, 42, 0.5);
    border-radius: 0 8px 8px 0;
  }
  ul, ol { padding-left: 1.5em; margin: 0.8em 0; }
  li { margin: 0.3em 0; }
  li::marker { color: #71717a; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #3f3f46; padding: 0.5em 0.8em; text-align: left; }
  th { background: #27272a; font-weight: 600; }
  tr:nth-child(even) { background: rgba(39, 39, 42, 0.3); }
  hr { border: none; border-top: 1px solid #3f3f46; margin: 2em 0; }
  img { max-width: 100%; border-radius: 8px; margin: 1em 0; }
</style>
</head>
<body><div id="content">{{CONTENT}}</div>
<!-- NOTE (supply chain): marked is loaded from a public CDN without SRI pinning.
       This is a deliberate, accepted dependency: the script executes in a throwaway
       headless page whose only input is HTML-escaped text, and all page network
       requests are SSRF-filtered (see ssrfGuardRoute). A CDN compromise could still
       alter the rendered output, so pin/unvendor marked if this ever renders
       security-sensitive content. -->
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script>
  const el = document.getElementById('content');
  el.innerHTML = marked.parse(el.textContent || el.innerText);
</script>
</body></html>`,

  light: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>T2I Render</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
    font-size: 16px;
    line-height: 1.75;
    color: #333;
    background-color: #fff;
    word-break: break-word;
    padding: 2rem 2.5rem;
    max-width: {{WIDTH}}px;
  }
  h1, h2, h3, h4, h5, h6 {
    line-height: 1.5;
    margin-top: 1.5em;
    margin-bottom: 0.6em;
    font-weight: 600;
  }
  h1 { font-size: 2em; border-bottom: 2px solid #3eaf7c; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #ececec; padding-bottom: 0.25em; }
  h3 { font-size: 1.25em; }
  h4 { font-size: 1.1em; }
  p { margin-top: 0.8em; margin-bottom: 0.8em; }
  strong { color: #3eaf7c; font-weight: 600; }
  a { color: #3eaf7c; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code {
    font-family: "Menlo", "Consolas", "Monaco", monospace;
    font-size: 0.875em;
    background: rgba(27,31,35,0.05);
    padding: 0.2em 0.4em;
    border-radius: 3px;
    color: #3eaf7c;
  }
  pre {
    background: #f8f8f8;
    border: 1px solid #ddd;
    border-radius: 6px;
    padding: 1em;
    overflow-x: auto;
    margin: 1em 0;
  }
  pre code { background: none; padding: 0; color: #333; }
  blockquote {
    border-left: 0.5rem solid #3eaf7c;
    padding: 0.5em 1em;
    margin: 1em 0;
    color: #666;
    background: #f8f8f8;
  }
  ul, ol { padding-left: 1.5em; margin: 0.8em 0; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: 0.5em 0.8em; }
  th { background: #3eaf7c; color: #fff; }
  hr { border-top: 1px solid #3eaf7c; margin: 2em 0; }
  img { max-width: 100%; border-radius: 4px; margin: 1em 0; }
</style>
</head>
<body><div id="content">{{CONTENT}}</div>
<!-- NOTE (supply chain): marked is loaded from a public CDN without SRI pinning.
       This is a deliberate, accepted dependency: the script executes in a throwaway
       headless page whose only input is HTML-escaped text, and all page network
       requests are SSRF-filtered (see ssrfGuardRoute). A CDN compromise could still
       alter the rendered output, so pin/unvendor marked if this ever renders
       security-sensitive content. -->
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script>
  const el = document.getElementById('content');
  el.innerHTML = marked.parse(el.textContent || el.innerText);
</script>
</body></html>`,
};

// ── MarkdownRenderer ──

/**
 * Private / reserved IP ranges blocked for page-initiated subresource loads.
 * The headless browser fetches arbitrary external links embedded in model
 * output (markdown images etc.), which would otherwise bypass the project's
 * unified safeFetch SSRF protections. Unlike safeFetch (LAN allowed for
 * business reasons), browser rendering has no such requirement, so ALL
 * private/reserved ranges are blocked, in addition to the cloud metadata
 * hosts covered by `assertSafeUrl` from ssrf-guard.
 */
function isPrivateOrReservedIp(ip: string): boolean {
  // IPv4 (including IPv4-mapped IPv6 ::ffff:a.b.c.d)
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (ip.includes(".") || mapped) {
    const v4 = mapped ? mapped[1] : ip;
    const parts = v4.split(".").map(Number);
    // Malformed addresses fail closed.
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;            // this-network, private, loopback
    if (a === 100 && b >= 64 && b <= 127) return true;            // CGNAT 100.64/10 (incl. Aliyun metadata)
    if (a === 169 && b === 254) return true;                      // link-local (incl. 169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true;             // private
    if (a === 192 && b === 168) return true;                      // private
    if (a === 192 && b === 0) return true;                        // 192.0.0.0/24 + TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true;         // benchmarking
    if (a === 198 && b === 51) return true;                       // TEST-NET-2
    if (a === 203 && b === 0) return true;                        // TEST-NET-3
    if (a >= 224) return true;                                    // multicast + reserved
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;             // unspecified, loopback
  if (lower.startsWith("fe80:")) return true;                     // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  if (lower.startsWith("::ffff:")) return true;                   // other v4-mapped forms
  return false;
}

/**
 * SSRF guard for page-initiated requests. Blocks non-http(s) schemes and
 * cloud metadata hosts (via assertSafeUrl), then resolves the hostname via
 * DNS and blocks when ANY resolved address falls into a private/reserved
 * range (DNS-rebinding resistant: we check the actual resolved addresses,
 * matching how Chromium will connect). Fails closed on DNS errors.
 */
async function ssrfGuardRoute(route: Route): Promise<void> {
  const url = route.request().url();
  try {
    await assertSafeUrl(url); // scheme allowlist + cloud metadata hosts
    const hostname = new URL(url).hostname;
    const addresses = await new Promise<{ address: string }[] | null>((resolvePromise) => {
      lookup(hostname, { all: true }, (err, result) => {
        resolvePromise(err ? null : result as { address: string }[]);
      });
    });
    if (!addresses || addresses.length === 0) {
      await route.abort("addressunreachable");
      return;
    }
    if (addresses.some((a) => isPrivateOrReservedIp(a.address))) {
      console.warn(`[T2I] Blocked request to private/reserved address: ${url}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  } catch (e) {
    console.warn(`[T2I] Blocked unsafe page request: ${url} (${e instanceof Error ? e.message : e})`);
    await route.abort("blockedbyclient");
  }
}

/** TTL for rendered images in the t2i output directory (process-local temp). */
const T2I_FILE_TTL_MS = 60 * 60 * 1000; // 1 hour — send happens within seconds
const T2I_SWEEP_INTERVAL_MS = 60 * 1000;

export class MarkdownToImageRenderer {
  private browser: Browser | null = null;
  /** Shared launch promise so concurrent initialize()/render() calls start exactly one browser. */
  private launchPromise: Promise<Browser> | null = null;
  private config: T2IConfig;
  private lastSweepAt = 0;
  private exitHookInstalled = false;

  constructor(config?: Partial<T2IConfig>) {
    this.config = { ...DEFAULT_T2I_CONFIG, ...config };
  }

  updateConfig(config: Partial<T2IConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): T2IConfig {
    return { ...this.config };
  }

  /**
   * Initialize Playwright browser instance.
   * Call once during startup.
   *
   * Concurrency-safe: concurrent callers share a single launch promise
   * (same pattern as getSharedBrowser in web-tools.ts). The previous
   * check-then-launch implementation started two browsers when two
   * requests raced between the `if (this.browser)` check and the launch,
   * leaking one of them.
   */
  async initialize(): Promise<void> {
    try {
      await this.ensureBrowser();
      console.info("[T2I] Playwright browser initialized.");
    } catch (error) {
      console.error("[T2I] Failed to launch Playwright browser:", error);
      throw error;
    }
  }

  private ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return Promise.resolve(this.browser);
    if (this.launchPromise) return this.launchPromise;
    const launch = (async () => {
      const browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-gpu",
          "--font-render-hinting=none",
        ],
      });
      this.browser = browser;
      return browser;
    })();
    this.launchPromise = launch;
    // Clear the shared promise once it settles (success or failure) so a later
    // browser disconnect triggers a fresh launch. Previously the resolved
    // promise was retained forever, so after a disconnect every call returned
    // the stale promise pointing at the dead browser and rendering never
    // recovered until close() was called explicitly.
    launch.then(
      () => { if (this.launchPromise === launch) this.launchPromise = null; },
      () => { if (this.launchPromise === launch) this.launchPromise = null; },
    );
    return launch;
  }

  /**
   * Close the browser instance.
   */
  async close(): Promise<void> {
    if (this.launchPromise) {
      try { await this.launchPromise; } catch { /* ignore */ }
      this.launchPromise = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      console.info("[T2I] Browser closed.");
    }
  }

  /**
   * Best-effort cleanup of stale rendered images in the t2i output
   * directory (files whose delivery/consumption already fell outside the
   * TTL). Throttled; also removes the whole directory on process exit.
   */
  private sweepTempImages(outputDir: string): void {
    const now = Date.now();
    if (now - this.lastSweepAt < T2I_SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    try {
      if (!existsSync(outputDir)) return;
      for (const name of readdirSync(outputDir)) {
        const p = join(outputDir, name);
        try {
          if (now - statSync(p).mtimeMs >= T2I_FILE_TTL_MS) unlinkSync(p);
        } catch { /* ignore individual failures */ }
      }
    } catch { /* ignore */ }
    if (!this.exitHookInstalled) {
      this.exitHookInstalled = true;
      process.once("exit", () => {
        try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
      });
    }
  }

  /**
   * Render markdown text to an image file.
   *
   * @param markdownText - The raw markdown content from model reply
   * @returns Object with file path and dimensions
   */
  async render(markdownText: string): Promise<T2IResult | null> {
    if (!this.config.enabled) return null;
    if (!markdownText.trim()) return null;

    // Ensure browser is ready (concurrency-safe shared launch)
    let browser: Browser;
    try {
      browser = await this.ensureBrowser();
    } catch {
      console.error("[T2I] Cannot render: browser not available.");
      return null;
    }

    const template = TEMPLATES[this.config.template] ?? TEMPLATES.default;
    const html = template
      .replace("{{WIDTH}}", String(this.config.width))
      .replace("{{CONTENT}}", escapeHtml(markdownText));

    // Ensure output directory exists
    const outputDir = join(tmpdir(), "yachiyo-t2i");
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
    this.sweepTempImages(outputDir);

    let page: Page | null = null;
    try {
      page = await browser.newPage();
      await page.setViewportSize({ width: this.config.width + 60, height: 800 });

      // SSRF protection: model-controlled markdown may contain external
      // links/images that the headless browser would fetch directly,
      // bypassing the project-wide safeFetch. Intercept every request and
      // block private/reserved addresses and cloud metadata endpoints.
      await page.route("**/*", (route) => ssrfGuardRoute(route));

      await page.setContent(html, { waitUntil: "networkidle" });

      // Wait for marked.js to finish parsing
      await page.waitForFunction(`() => {
        const el = document.getElementById("content");
        return el && el.innerHTML !== "" && !el.textContent?.startsWith("{{");
      }`, { timeout: 10000 }).catch(() => {
        // If marked doesn't load, raw text is still visible
      });

      // Auto-height: measure actual content height
      const bodyHeight = await page.evaluate("document.body.scrollHeight") as number;
      await page.setViewportSize({
        width: this.config.width + 60,
        height: Math.max(bodyHeight + 20, 100),
      });

      const fileName = `t2i_${randomUUID()}.${this.config.format}`;
      const filePath = join(outputDir, fileName);

      await page.screenshot({
        path: filePath,
        type: this.config.format,
        quality: this.config.format === "jpeg" ? this.config.quality : undefined,
        omitBackground: false,
        fullPage: true,
      });

      // Get final image dimensions (approximate from viewport)
      const finalHeight = await page.evaluate("document.body.scrollHeight") as number;

      return {
        filePath,
        width: this.config.width,
        height: finalHeight,
      };
    } catch (error) {
      console.error("[T2I] Render error:", error);
      return null;
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }
}

// ── Helpers ──

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
