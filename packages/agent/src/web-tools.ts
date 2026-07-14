/**
 * Web tools: URL fetching, web search, and HTTP request tools.
 */

import { createFunctionTool, type FunctionTool } from "./tool.js";
import type { CallToolResult, ImageContent } from "./types.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import TurndownService from "turndown";
import { randomUUID } from "crypto";
import { safeFetch, assertSafeUrl } from "@yachiyo/common/ssrf-guard.js";
import { isDomainAllowed, type SandboxPolicy } from "./sandbox.js";
import { proxyManager } from "./proxy-manager.js";

// ── Unified User-Agent strings ──
// SYSTEM_USER_AGENT: used for direct HTTP requests made by the agent
//   (http_request_tool). Identifies the agent itself.
// BROWSER_USER_AGENT: used for browser emulation (Playwright) and search
//   engine scraping, where a realistic desktop Chrome UA is required.
const SYSTEM_USER_AGENT = "AgentSystem/1.0";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

// ── Proxy helper for Playwright launches ──

/**
 * Build the Playwright `proxy` launch option from the current ProxyManager
 * state. Returns an empty object when no proxy is configured so the browser
 * uses a direct connection.
 */
function getProxyLaunchOption(): { proxy?: { server: string } } {
  const url = proxyManager.url;
  if (url) {
    return { proxy: { server: url } };
  }
  return {};
}

// ── Shared Chromium browser instance ──
//
// Launching Chromium takes 1-3 seconds. Reusing a single browser across
// calls avoids this overhead. The browser is lazily launched on first use
// and closed on process exit.

let sharedBrowser: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

async function getSharedBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  if (browserLaunchPromise) return browserLaunchPromise;
  browserLaunchPromise = (async () => {
    try {
      const browser = await chromium.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
        ...getProxyLaunchOption(),
      });
      sharedBrowser = browser;
      browserLaunchPromise = null;
      // Auto-cleanup on process exit.
      process.once("exit", () => { try { browser.close(); } catch { /* ignore */ } });
      return browser;
    } catch (e) {
      // Reset the promise on failure so subsequent calls can retry instead
      // of caching the rejected promise forever.
      browserLaunchPromise = null;
      throw e;
    }
  })();
  return browserLaunchPromise;
}

/**
 * Close the shared Chromium browser instance if it exists.
 * Useful for tests or graceful shutdown.
 */
export async function closeSharedBrowser(): Promise<void> {
  if (browserLaunchPromise) {
    try { await browserLaunchPromise; } catch { /* ignore */ }
  }
  if (sharedBrowser) {
    try { await sharedBrowser.close(); } catch { /* ignore */ }
    sharedBrowser = null;
  }
}

// ── Proxy change listener ──
//
// When the proxy URL changes (via proxyManager), close all open browser
// instances so the next launch picks up the new proxy setting. This
// affects both the shared browser (used by browser_* tools) and the
// Playwright search provider browsers (used by web_search_tool).
proxyManager.onChange((_url) => {
  // Close the shared browser (fire-and-forget; next getSharedBrowser()
  // call will relaunch with the updated proxy).
  closeSharedBrowser().catch(() => { /* ignore */ });
  // Close search provider browsers.
  closeWebSearchProviders().catch(() => { /* ignore */ });
});

// ── Shared context type ──

export interface WebToolContext {
  event?: {
    unifiedMsgOrigin?: string;
  };
  providerSettings?: {
    web_search_api_url?: string;
    web_search_api_key?: string;
  };
  /** Optional sandbox policy. When present, domain restrictions are enforced. */
  sandboxPolicy?: SandboxPolicy;
}

// ── HTML → Markdown conversion (using turndown) ──
//
// Shared TurndownService instance — stateless after configuration, so a
// single instance can be reused across calls safely.
const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
});
// Let turndown (which uses a real DOM parser) remove non-content elements
// instead of regex pre-filtering. Regex-based HTML stripping is insecure
// (can be bypassed with nested/malformed tags) and triggers CodeQL alerts.
turndownService.remove(["head", "script", "style", "nav", "footer", "noscript"]);

function htmlToMarkdown(html: string): string {
  const md = turndownService.turndown(html);
  // Collapse excessive blank lines and trim trailing whitespace.
  return md.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").trim();
}

/**
 * Strip all HTML tags from a string, looping until stable to prevent
 * bypass via nested constructs (e.g. "<scr<script>ipt>").
 */
function stripHtmlTags(html: string): string {
  let result = html;
  let prev: string;
  do {
    prev = result;
    result = result.replace(/<[^>]*>/g, "");
  } while (result !== prev);
  return result;
}

/**
 * Decode common HTML entities in a single pass to avoid double-unescaping.
 * Handles: &amp; &lt; &gt; &quot; &#39; &#0?39; &nbsp;
 */
function decodeHtmlEntitiesOnce(str: string): string {
  if (!str) return str;
  return str.replace(/&(amp|lt|gt|quot|#0?39|nbsp);/g, (_match, entity: string) => {
    switch (entity) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "39":
      case "039": return "'";
      case "nbsp": return " ";
      default: return _match;
    }
  });
}

// ── Web Fetch Tool ──

export function createWebFetchTool(): FunctionTool<WebToolContext> {
  return createFunctionTool<WebToolContext>({
    name: "web_fetch_tool",
    description: "Fetch content from a URL. Supports HTML-to-Markdown conversion and screenshot capture.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch." },
        method: { type: "string", description: "HTTP method. Default: GET.", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"], default: "GET" },
        headers: { type: "object", description: "Optional HTTP headers.", additionalProperties: { type: "string" }, default: {} },
        body: { type: "string", description: "Optional request body (for POST/PUT/PATCH)." },
        timeout: { type: "integer", description: "Timeout in seconds. Default: 30.", minimum: 1, default: 30 },
        max_length: { type: "integer", description: "Maximum response length in characters. Default: 50000.", minimum: 100, default: 50000 },
        format: { type: "string", description: "Output format. 'raw' returns original content, 'markdown' converts HTML to readable Markdown. Default: markdown.", enum: ["raw", "markdown"], default: "markdown" },
        screenshot: { type: "boolean", description: "If true, also capture a screenshot of the rendered page using a headless browser. Default: false.", default: false },
      },
      required: ["url"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const url = String(args[0] ?? "");
      const method = (args[1] as string) ?? "GET";
      const headers = (args[2] as Record<string, string>) ?? {};
      const body = args[3] != null ? String(args[3]) : undefined;
      const timeout = args[4] != null ? Number(args[4]) : 30;
      const maxLength = args[5] != null ? Number(args[5]) : 50000;
      const format = (args[6] as string) ?? "markdown";
      const screenshot = args[7] === true;

      // Enforce sandbox domain restrictions.
      const webCtx = (_ctx as { context?: WebToolContext } | undefined)?.context;
      if (webCtx?.sandboxPolicy && !isDomainAllowed(url, webCtx.sandboxPolicy)) {
        return { content: [{ type: "text", text: `error: Domain not allowed by sandbox policy for URL: ${url}` }], isError: true };
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

        const fetchOptions: RequestInit = {
          method,
          headers: { "User-Agent": SYSTEM_USER_AGENT, ...headers },
          signal: controller.signal,
        };
        if (body && ["POST", "PUT", "PATCH"].includes(method)) {
          fetchOptions.body = body;
        }

        // safeFetch validates URL scheme to prevent non-HTTP protocols, and limits response
        // size and redirect loops (LAN access is allowed per business requirements).
        const response = await safeFetch(url, fetchOptions);
        clearTimeout(timeoutId);

        let text = await response.text();

        const contentType = response.headers.get("content-type") ?? "unknown";
        const isHtml = /text\/html/i.test(contentType) || /xhtml/i.test(contentType);

        if (isHtml && format === "markdown") {
          text = htmlToMarkdown(text);
        }

        if (text.length > maxLength) {
          text = text.slice(0, maxLength) + `\n\n... (truncated, total ${text.length} characters)`;
        }

        const statusInfo = `HTTP ${response.status} ${response.statusText}`;
        const header = `[${statusInfo}] [Content-Type: ${contentType}]`;

        const contentParts: CallToolResult["content"] = [{ type: "text", text: `${header}\n\n${text}` }];

        if (screenshot) {
          let browserContext: BrowserContext | null = null;
          let page: Page | null = null;
          try {
            // Re-validate the URL before handing it to Playwright, which
            // bypasses safeFetch. Defense-in-depth against DNS rebinding.
            await assertSafeUrl(url);
            // Reuse the shared Chromium instance to avoid 1-3s launch overhead.
            const browser = await getSharedBrowser();
            browserContext = await browser.newContext({
              userAgent: BROWSER_USER_AGENT,
              viewport: { width: 1920, height: 1080 },
            });
            page = await browserContext.newPage();
            await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
            await page.waitForTimeout(1000);
            const screenshotBuffer = await page.screenshot({ fullPage: false, type: "png" });

            contentParts.push({
              type: "image",
              data: screenshotBuffer.toString("base64"),
              mimeType: "image/png",
            } as ImageContent);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            contentParts.push({ type: "text", text: `[Screenshot failed: ${msg}]` });
          } finally {
            // Only close the context/page, not the shared browser.
            try { await page?.close(); } catch { /* ignore */ }
            try { await browserContext?.close(); } catch { /* ignore */ }
          }
        }

        return { content: contentParts };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("abort")) {
          return { content: [{ type: "text", text: `error: Request timed out after ${timeout} seconds.` }], isError: true };
        }
        return { content: [{ type: "text", text: `error: Fetch failed: ${msg}` }], isError: true };
      }
    },
  });
}

// ── Web Search Tool ──

export interface WebSearchProvider {
  search(query: string, maxResults: number): Promise<{ title: string; url: string; snippet: string }[]>;
}

/**
 * Bing search provider (default, works in China).
 */
class BingSearchProvider implements WebSearchProvider {
  async search(query: string, maxResults: number): Promise<{ title: string; url: string; snippet: string }[]> {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
    // Use safeFetch (already imported at module top) instead of native fetch
    // so that the search request is subject to the same SSRF protections
    // (scheme validation, response-size cap, redirect limits, Content-Type
    // checks) as the web_fetch_tool. Native fetch would bypass all of these.
    const response = await safeFetch(url, {
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });

    const html = await response.text();
    const results: { title: string; url: string; snippet: string }[] = [];

    // Strategy: find all <h2> tags that contain links within b_algo sections.
    // Bing's HTML structure has <li class="b_algo"> with nested <link> tags
    // that break simple </li> matching, so we parse by finding h2+link pairs directly.

    // Find positions of all b_algo markers
    const algoPositions: number[] = [];
    const algoMarker = '<li class="b_algo"';
    let pos = 0;
    while ((pos = html.indexOf(algoMarker, pos)) !== -1) {
      algoPositions.push(pos);
      pos += algoMarker.length;
    }

    for (let i = 0; i < algoPositions.length && results.length < maxResults; i++) {
      const start = algoPositions[i];
      // End boundary: next b_algo or 5000 chars (whichever comes first)
      const end = i + 1 < algoPositions.length
        ? Math.min(algoPositions[i + 1], start + 5000)
        : start + 5000;
      const block = html.slice(start, end);

      // Extract title and URL from <h2><a href="...">title</a></h2>
      // The h2 may have attributes, e.g. <h2 style="...">
      const titleRegex = /<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a><\/h2>/i;
      const titleMatch = titleRegex.exec(block);
      if (!titleMatch) continue;

      const resultUrl = decodeHtmlEntitiesOnce(titleMatch[1]);
      const title = stripHtmlTags(titleMatch[2]).trim();

      // Skip Bing internal links
      if (!resultUrl || resultUrl.startsWith("/") || resultUrl.includes("bing.com/search")) continue;

      // Extract snippet: try multiple patterns
      let snippet = "";

      // Pattern 1: <p class="b_lineclamp...">
      const snippet1 = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
      if (snippet1) {
        snippet = stripHtmlTags(snippet1[1]).trim();
      }

      // Pattern 2: <div class="b_caption"><p>...</p></div>
      if (!snippet) {
        const snippet2 = /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
        if (snippet2) {
          snippet = stripHtmlTags(snippet2[1]).trim();
        }
      }

      // Pattern 3: any <p> inside b_caption
      if (!snippet) {
        const snippet3 = /class="[^"]*b_caption[^"]*"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
        if (snippet3) {
          snippet = stripHtmlTags(snippet3[1]).trim();
        }
      }

      if (title && resultUrl) {
        results.push({ title, url: resultUrl, snippet });
      }
    }

    return results;
  }
}

/**
 * Google search provider (works in most regions, may be restricted in China).
 */
class GoogleSearchProvider implements WebSearchProvider {
  async search(query: string, maxResults: number): Promise<{ title: string; url: string; snippet: string }[]> {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${maxResults}`;
    // Use safeFetch for the same SSRF-protection reasons as BingSearchProvider.
    const response = await safeFetch(url, {
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });

    const html = await response.text();
    const results: { title: string; url: string; snippet: string }[] = [];

    // Parse Google search results from <div class="g">
    const blockRegex = /<div[^>]*class="[^"]*g[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
    let blockMatch;

    while ((blockMatch = blockRegex.exec(html)) !== null && results.length < maxResults) {
      const block = blockMatch[1];

      // Extract title and URL from <h3> inside <a href="...">
      const titleRegex = /<a[^>]*href="\/url\?q=([^&"]*)[^"]*"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/i;
      const titleMatch = titleRegex.exec(block);
      if (!titleMatch) continue;

      let resultUrl: string;
      try {
        resultUrl = decodeURIComponent(titleMatch[1]);
      } catch {
        resultUrl = titleMatch[1];
      }
      const title = stripHtmlTags(titleMatch[2]).trim();

      // Extract snippet
      let snippet = "";
      const snippetRegex = /<div[^>]*class="[^"]*(?:VwiC3b|IsZvec)[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
      const snippetMatch = snippetRegex.exec(block);
      if (snippetMatch) {
        snippet = stripHtmlTags(snippetMatch[1]).trim();
      }

      if (title && resultUrl && !resultUrl.startsWith("/")) {
        results.push({ title, url: resultUrl, snippet });
      }
    }

    return results;
  }
}

/**
 * Playwright-based Google search provider.
 * Uses a headless Chromium browser to bypass JavaScript challenges (consent walls, CAPTCHAs, etc.).
 */
class PlaywrightSearchProviderBase implements WebSearchProvider {
  private _browser: Browser | null = null;
  private _launchPromise: Promise<Browser> | null = null;

  protected async ensureBrowser(): Promise<Browser> {
    if (this._browser && this._browser.isConnected()) return this._browser;
    if (this._launchPromise) return this._launchPromise;

    this._launchPromise = (async () => {
      try {
        const browser = await chromium.launch({
          headless: true,
          args: [
            "--disable-blink-features=AutomationControlled",
            "--disable-features=IsolateOrigins,site-per-process",
            "--disable-infobars",
            "--no-sandbox",
            "--disable-dev-shm-usage",
          ],
          ...getProxyLaunchOption(),
        });
        this._browser = browser;
        this._launchPromise = null;
        return browser;
      } catch (e) {
        this._launchPromise = null;
        throw e;
      }
    })();

    return this._launchPromise;
  }

  /** Close the singleton browser instance. Called during shutdown. */
  async close(): Promise<void> {
    if (this._launchPromise) {
      try { await this._launchPromise; } catch { /* ignore launch errors */ }
    }
    if (this._browser) {
      try { await this._browser.close(); } catch { /* ignore */ }
      this._browser = null;
    }
  }

  protected async createContext(): Promise<BrowserContext> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      userAgent:
        BROWSER_USER_AGENT,
      locale: "en-US",
      viewport: { width: 1920, height: 1080 },
      colorScheme: "light",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    return context;
  }

  protected async injectStealthScripts(page: Page): Promise<void> {
    const stealthScript = `
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      const origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
      Object.defineProperty(window.navigator.permissions, 'query', {
        value: (params) => params.name === 'notifications'
          ? Promise.resolve({ state: 'default' })
          : origQuery(params),
      });
    `;
    await page.addInitScript(stealthScript);
  }

  protected async handleGoogleConsent(page: Page): Promise<void> {
    const consentSelectors = [
      'button[id="L2AGLb"]',
      'button[id="W0wltc"]',
      'div[role="none"] button:nth-of-type(2)',
      'button[aria-label*="Reject"]',
      'button[aria-label*="拒绝"]',
      'button[aria-label*="Decline"]',
      'form[action="/consent"] button',
    ];

    for (const selector of consentSelectors) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          await page.waitForTimeout(1500);
          return;
        }
      } catch {
        // selector not found, try next
      }
    }
  }

  async search(_query: string, _maxResults: number): Promise<{ title: string; url: string; snippet: string }[]> {
    throw new Error("Not implemented");
  }

  async dispose(): Promise<void> {
    if (this._browser) {
      await this._browser.close();
      this._browser = null;
    }
  }
}

class PlaywrightGoogleSearchProvider extends PlaywrightSearchProviderBase {
  override async search(query: string, maxResults: number): Promise<{ title: string; url: string; snippet: string }[]> {
    const context = await this.createContext();
    const page = await context.newPage();
    await this.injectStealthScripts(page);

    try {
      await page.goto("https://www.google.com/", {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await page.waitForTimeout(1500);
      await this.handleGoogleConsent(page);

      await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=${maxResults}&hl=en`, {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await this.handleGoogleConsent(page);

      await page.waitForSelector("#search", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);

      const isCaptcha = await page.locator("#captcha-form, .g-recaptcha, iframe[src*='recaptcha']").count() > 0;
      if (isCaptcha) {
        return [];
      }

      const results: { title: string; url: string; snippet: string }[] = [];

      const searchBlocks = await page.locator("#search .g").all();
      if (searchBlocks.length > 0) {
        for (const block of searchBlocks) {
          if (results.length >= maxResults) break;
          try {
            const titleEl = block.locator("h3").first();
            const linkEl = block.locator("a").first();
            const snippetEl = block.locator('[data-sncf], .VwiC3b, .IsZvec, [style*="-webkit-line-clamp"]').first();

            const title = (await titleEl.textContent())?.trim() ?? "";
            const href = (await linkEl.getAttribute("href")) ?? "";
            const snippet = (await snippetEl.textContent())?.trim() ?? "";

            if (title && href && !href.startsWith("/search") && !href.startsWith("/")) {
              results.push({ title, url: href, snippet });
            }
          } catch {
            // skip malformed block
          }
        }
      }

      if (results.length === 0) {
        const allH3 = await page.locator("h3").all();
        for (const h3 of allH3) {
          if (results.length >= maxResults) break;
          try {
            const title = (await h3.textContent())?.trim() ?? "";
            const parentLink = h3.locator("xpath=ancestor::a").first();
            const href = (await parentLink.getAttribute("href")) ?? "";
            if (title && href && !href.startsWith("/search") && !href.startsWith("/")) {
              const block = h3.locator("xpath=ancestor::div[contains(@class,'g') or parent::div[@id='rso']/div]").first();
              const snippetEl = block.locator('[data-sncf], .VwiC3b, .IsZvec, [style*="-webkit-line-clamp"]').first();
              const snippet = (await snippetEl.textContent().catch(() => ""))?.trim() ?? "";
              results.push({ title, url: href, snippet });
            }
          } catch {
            // skip
          }
        }
      }

      return results;
    } finally {
      await page.close();
      await context.close();
    }
  }
}

class PlaywrightBingSearchProvider extends PlaywrightSearchProviderBase {
  override async search(query: string, maxResults: number): Promise<{ title: string; url: string; snippet: string }[]> {
    const context = await this.createContext();
    const page = await context.newPage();

    try {
      await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}&setlang=en-US`, {
        waitUntil: "networkidle",
        timeout: 30000,
      });

      const hasCaptcha = await page.locator(".captcha, .turnstile").count() > 0;
      if (hasCaptcha) {
        try {
          await page.waitForSelector("#b_results", { timeout: 30000 });
        } catch {
          return [];
        }
      }

      const hasResults = await page.locator("#b_results").count() > 0;
      if (!hasResults) return [];

      const results: { title: string; url: string; snippet: string }[] = [];
      const searchBlocks = await page.locator("#b_results > li.b_algo").all();

      for (const block of searchBlocks) {
        if (results.length >= maxResults) break;
        try {
          const titleEl = block.locator("h2 a").first();
          const snippetEl = block.locator(".b_caption p, p.b_lineclamp").first();

          const title = (await titleEl.textContent())?.trim() ?? "";
          const href = (await titleEl.getAttribute("href")) ?? "";
          const snippet = (await snippetEl.textContent())?.trim() ?? "";

          if (title && href && !href.startsWith("/")) {
            let cleanUrl = href;
            try {
              const urlParam = new URL(href).searchParams.get("u");
              if (urlParam) {
                const decoded = Buffer.from(urlParam, "base64").toString("utf-8");
                if (decoded.startsWith("http")) cleanUrl = decoded;
              }
            } catch {
              // href is already a direct URL
            }
            results.push({ title, url: cleanUrl, snippet });
          }
        } catch {
          // skip malformed block
        }
      }

      return results;
    } finally {
      await page.close();
      await context.close();
    }
  }
}

/**
 * Search engine type for the built-in providers.
 */
export type SearchEngine = "bing" | "google" | "google_playwright" | "bing_playwright";

let _playwrightGoogleProvider: PlaywrightGoogleSearchProvider | null = null;
let _playwrightBingProvider: PlaywrightBingSearchProvider | null = null;

export function getSearchProvider(engine: SearchEngine): WebSearchProvider {
  switch (engine) {
    case "google": return new GoogleSearchProvider();
    case "google_playwright":
      if (!_playwrightGoogleProvider) {
        _playwrightGoogleProvider = new PlaywrightGoogleSearchProvider();
      }
      return _playwrightGoogleProvider;
    case "bing_playwright":
      if (!_playwrightBingProvider) {
        _playwrightBingProvider = new PlaywrightBingSearchProvider();
      }
      return _playwrightBingProvider;
    case "bing":
    default: return new BingSearchProvider();
  }
}

/**
 * Release the singleton Playwright browser instances held by the search
 * providers. Call during shutdown to prevent Chromium process leaks.
 */
export async function closeWebSearchProviders(): Promise<void> {
  if (_playwrightGoogleProvider) {
    await _playwrightGoogleProvider.close?.();
    _playwrightGoogleProvider = null;
  }
  if (_playwrightBingProvider) {
    await _playwrightBingProvider.close?.();
    _playwrightBingProvider = null;
  }
}

export function createWebSearchTool(customProvider?: WebSearchProvider, engine: SearchEngine = "bing"): FunctionTool<WebToolContext> {
  const provider = customProvider ?? getSearchProvider(engine);

  return createFunctionTool<WebToolContext>({
    name: "web_search_tool",
    description: "Search the web for information. Returns a list of results with titles, URLs, and snippets. Optionally fetches page content for deeper results.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        max_results: { type: "integer", description: "Maximum number of results. Default: 5.", minimum: 1, maximum: 20, default: 5 },
        fetch_content: { type: "boolean", description: "If true, fetch and extract the main content from each result page. Slower but provides full page text. Default: false.", default: false },
      },
      required: ["query"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const query = String(args[0] ?? "");
      const maxResults = args[1] != null ? Number(args[1]) : 5;
      const fetchContent = args[2] === true;

      // Enforce sandbox domain restrictions on fetched result URLs.
      const webCtx = (_ctx as { context?: WebToolContext } | undefined)?.context;
      const domainPolicy = webCtx?.sandboxPolicy;

      try {
        const rawResults = await provider.search(query, maxResults);

        // Deduplicate by normalized URL (strip trailing slash, lowercase host).
        const seen = new Set<string>();
        const results = rawResults.filter((r) => {
          const normalized = r.url
            .replace(/^https?:\/\//, "")
            .replace(/\/$/, "")
            .toLowerCase();
          if (seen.has(normalized)) return false;
          seen.add(normalized);
          return true;
        });

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No search results found." }] };
        }

        if (fetchContent) {
          const enrichedResults = await Promise.all(
            results.map(async (r) => {
              try {
                // Enforce sandbox domain restrictions on each result URL.
                if (domainPolicy && !isDomainAllowed(r.url, domainPolicy)) {
                  return { ...r, content: "[Domain not allowed by sandbox policy]" };
                }
                // safeFetch re-validates each result URL (and redirect hop)
                // against private/reserved IP ranges. Search result URLs are
                // attacker-influencable and could otherwise be used for SSRF.
                const resp = await safeFetch(r.url, {
                  headers: { "User-Agent": BROWSER_USER_AGENT },
                  signal: AbortSignal.timeout(10000),
                });
                const contentType = resp.headers.get("content-type") ?? "";
                if (!/text\/html/i.test(contentType)) {
                  return { ...r, content: "[Non-HTML content, skipped]" };
                }
                const html = await resp.text();
                const md = htmlToMarkdown(html);
                const truncated = md.length > 3000 ? md.slice(0, 3000) + "\n... (truncated)" : md;
                return { ...r, content: truncated };
              } catch {
                return { ...r, content: "[Failed to fetch page content]" };
              }
            }),
          );

          const formatted = enrichedResults
            .map((r, i) => {
              let entry = `${i + 1}. ${r.title}\n   URL: ${r.url}`;
              if (r.snippet) entry += `\n   Snippet: ${r.snippet}`;
              if (r.content) entry += `\n   Content:\n   ${r.content.split("\n").join("\n   ")}`;
              return entry;
            })
            .join("\n\n");

          return { content: [{ type: "text", text: formatted }] };
        }

        const formatted = results
          .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
          .join("\n\n");

        return { content: [{ type: "text", text: formatted }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: Search failed: ${e}` }], isError: true };
      }
    },
  });
}

// ── HTTP Request Tool ──

export function createHttpRequestTool(): FunctionTool<WebToolContext> {
  return createFunctionTool<WebToolContext>({
    name: "http_request_tool",
    description: "Make an HTTP request with full control over method, headers, and body. Returns status, headers, and response body.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to request." },
        method: { type: "string", description: "HTTP method. Default: GET.", enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"], default: "GET" },
        headers: { type: "object", description: "HTTP headers.", additionalProperties: { type: "string" }, default: {} },
        body: { type: "string", description: "Request body (for POST/PUT/PATCH). Can be JSON string or plain text." },
        content_type: { type: "string", description: "Content-Type header shortcut. Default: application/json for POST/PUT/PATCH.", default: "application/json" },
        timeout: { type: "integer", description: "Timeout in seconds. Default: 30.", minimum: 1, default: 30 },
        follow_redirects: { type: "boolean", description: "Follow HTTP redirects. Default: true.", default: true },
      },
      required: ["url"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const url = String(args[0] ?? "");
      const method = (args[1] as string) ?? "GET";
      const headers = (args[2] as Record<string, string>) ?? {};
      const body = args[3] != null ? String(args[3]) : undefined;
      const contentType = (args[4] as string) ?? "application/json";
      const timeout = args[5] != null ? Number(args[5]) : 30;
      const followRedirects = args[6] !== false;

      // Enforce sandbox domain restrictions.
      const webCtx = (_ctx as { context?: WebToolContext } | undefined)?.context;
      if (webCtx?.sandboxPolicy && !isDomainAllowed(url, webCtx.sandboxPolicy)) {
        return { content: [{ type: "text", text: `error: Domain not allowed by sandbox policy for URL: ${url}` }], isError: true };
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

        const requestHeaders: Record<string, string> = {
          "User-Agent": SYSTEM_USER_AGENT,
          ...headers,
        };

        // Auto-set Content-Type for methods with body
        if (body && ["POST", "PUT", "PATCH"].includes(method) && !headers["Content-Type"] && !headers["content-type"]) {
          requestHeaders["Content-Type"] = contentType;
        }

        const fetchOptions: RequestInit = {
          method,
          headers: requestHeaders,
          signal: controller.signal,
        };

        if (body && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
          fetchOptions.body = body;
        }

        // safeFetch validates URL scheme to prevent non-HTTP protocols, and limits response
        // size and redirect loops (LAN access is allowed per business requirements).
        // When the caller disabled redirect following, pass maxRedirects=0
        // so the initial URL is still validated but no hops occur.
        const response = await safeFetch(url, fetchOptions, followRedirects ? 5 : 0);
        clearTimeout(timeoutId);

        // Collect response headers
        const respHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          respHeaders[key] = value;
        });

        // Determine if response is binary
        const respContentType = response.headers.get("content-type") ?? "";
        const isBinary = /image|audio|video|octet-stream|zip|pdf/.test(respContentType);

        let bodyText: string;
        if (isBinary) {
          const contentLength = response.headers.get("content-length");
          bodyText = `[Binary content, Content-Type: ${respContentType}, Size: ${contentLength ?? "unknown"} bytes]`;
        } else {
          bodyText = await response.text();
          // Truncate very long responses
          if (bodyText.length > 100000) {
            bodyText = bodyText.slice(0, 100000) + "\n\n... (truncated)";
          }
        }

        const result = {
          status: response.status,
          statusText: response.statusText,
          headers: respHeaders,
          body: bodyText,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("abort")) {
          return { content: [{ type: "text", text: `error: Request timed out after ${timeout} seconds.` }], isError: true };
        }
        return { content: [{ type: "text", text: `error: HTTP request failed: ${msg}` }], isError: true };
      }
    },
  });
}

// ── Browser Automation Tools ──
//
// A stateful set of tools that share a Chromium instance and track open
// pages in a registry. Unlike web_fetch_tool (one-shot fetch + screenshot),
// these tools let the agent navigate, interact, and inspect pages across
// multiple turns: click buttons, fill forms, take screenshots, extract
// text, run scripts, etc.
//
// Page lifecycle:
//   browser_navigate → returns pageId
//   browser_click / browser_type / browser_screenshot / … use pageId
//   browser_close_page → closes the page and removes it from the registry

/** Registry of open browser pages, keyed by a short id. */
interface PageEntry {
  page: Page;
  context: BrowserContext;
  /** ISO timestamp when the page was opened. */
  openedAt: string;
  /** Last navigated URL (for list_pages display). */
  url: string;
  /** Optional human-friendly title. */
  title: string;
}

const pageRegistry = new Map<string, PageEntry>();

/** Maximum concurrent pages to prevent unbounded memory growth. */
const MAX_BROWSER_PAGES = 10;

/**
 * Generate a short, unique page id. Uses crypto.randomUUID() truncated to
 * 8 chars for readability while keeping a vanishingly small collision risk
 * across the small (≤10) set of live pages.
 */
function generatePageId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Get the sandbox policy from the tool context, if present.
 * Used to enforce domain restrictions on navigation URLs.
 */
function getSandboxPolicy(_ctx: unknown): SandboxPolicy | undefined {
  const webCtx = (_ctx as { context?: WebToolContext } | undefined)?.context;
  return webCtx?.sandboxPolicy;
}

/**
 * Resolve a page from the registry. Returns null if not found, and includes
 * the page id in the error message when missing so the agent can recover.
 */
function getPage(pageId: string): PageEntry | null {
  return pageRegistry.get(pageId) ?? null;
}

// ── Browser Navigate Tool ──

export function createBrowserNavigateTool(): FunctionTool<WebToolContext> {
  return createFunctionTool<WebToolContext>({
    name: "browser_navigate",
    description: "Open a URL in a new headless browser tab and return a page_id for further interaction (click, type, screenshot, etc.). Each call opens a fresh page.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to navigate to." },
        wait_until: { type: "string", description: "When to consider navigation done. 'load' waits for the load event, 'domcontentloaded' for DOM ready, 'networkidle' for no network activity. Default: load.", enum: ["load", "domcontentloaded", "networkidle"], default: "load" },
        timeout: { type: "integer", description: "Navigation timeout in seconds. Default: 30.", minimum: 1, default: 30 },
      },
      required: ["url"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const url = String(args[0] ?? "");
      const waitUntil = (args[1] as "load" | "domcontentloaded" | "networkidle") ?? "load";
      const timeout = args[2] != null ? Number(args[2]) : 30;
      const policy = getSandboxPolicy(_ctx);

      if (policy && !isDomainAllowed(url, policy)) {
        return { content: [{ type: "text", text: `error: Domain not allowed by sandbox policy for URL: ${url}` }], isError: true };
      }

      // Enforce a maximum number of concurrent pages to prevent resource
      // exhaustion. Clean up closed pages first before refusing.
      if (pageRegistry.size >= MAX_BROWSER_PAGES) {
        for (const [id, entry] of pageRegistry) {
          if (entry.page.isClosed()) {
            try { await entry.context.close(); } catch { /* ignore */ }
            pageRegistry.delete(id);
          }
        }
        if (pageRegistry.size >= MAX_BROWSER_PAGES) {
          return {
            content: [{ type: "text", text: `error: Maximum number of open pages (${MAX_BROWSER_PAGES}) reached. Use browser_close_page to close unused pages, or browser_list_pages to inspect.` }],
            isError: true,
          };
        }
      }

      try {
        await assertSafeUrl(url);
        const browser = await getSharedBrowser();
        const context = await browser.newContext({
          userAgent: BROWSER_USER_AGENT,
          viewport: { width: 1280, height: 720 },
          locale: "en-US",
        });
        const page = await context.newPage();
        await page.goto(url, { waitUntil, timeout: timeout * 1000 });

        const pageId = generatePageId();
        const title = await page.title().catch(() => "");
        pageRegistry.set(pageId, {
          page,
          context,
          openedAt: new Date().toISOString(),
          url,
          title,
        });

        // Auto-remove from registry when the page is closed externally.
        page.on("close", () => {
          pageRegistry.delete(pageId);
          // Context is closed with the page; no separate cleanup needed.
          try { context.close(); } catch { /* ignore */ }
        });

        return {
          content: [{
            type: "text",
            text: `Navigated to ${url}\npage_id: ${pageId}\ntitle: ${title}\nUse this page_id with browser_click / browser_type / browser_screenshot / etc.`,
          }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `error: Navigation failed: ${msg}` }], isError: true };
      }
    },
  });
}

// ── Browser Click Tool ──

export function createBrowserClickTool(): FunctionTool<WebToolContext> {
  return createFunctionTool<WebToolContext>({
    name: "browser_click",
    description: "Click an element on a browser page identified by a CSS selector. If multiple elements match, clicks the first one.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page_id returned by browser_navigate." },
        selector: { type: "string", description: "CSS selector of the element to click (e.g. 'button#submit', 'a[href=\"/about\"]', 'input[name=\"q\"]')." },
        timeout: { type: "integer", description: "Time to wait for the element to appear, in seconds. Default: 10.", minimum: 1, default: 10 },
      },
      required: ["page_id", "selector"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const pageId = String(args[0] ?? "");
      const selector = String(args[1] ?? "");
      const timeout = args[2] != null ? Number(args[2]) : 10;
      const entry = getPage(pageId);
      if (!entry) {
        return { content: [{ type: "text", text: `error: Page not found: ${pageId}. Use browser_list_pages to see open pages, or browser_navigate to open a new one.` }], isError: true };
      }
      if (entry.page.isClosed()) {
        pageRegistry.delete(pageId);
        return { content: [{ type: "text", text: `error: Page ${pageId} has been closed.` }], isError: true };
      }
      try {
        await entry.page.locator(selector).first().click({ timeout: timeout * 1000 });
        return { content: [{ type: "text", text: `Clicked element: ${selector}` }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `error: Click failed for selector '${selector}': ${msg}` }], isError: true };
      }
    },
  });
}

// ── Browser Type Tool ──

export function createBrowserTypeTool(): FunctionTool<WebToolContext> {
  return createFunctionTool<WebToolContext>({
    name: "browser_type",
    description: "Type text into an input element on a browser page. Clears the field first by default. Useful for filling forms and search boxes.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page_id returned by browser_navigate." },
        selector: { type: "string", description: "CSS selector of the input element." },
        text: { type: "string", description: "The text to type into the field." },
        clear: { type: "boolean", description: "Clear the field before typing. Default: true.", default: true },
        delay: { type: "integer", description: "Delay between keystrokes in milliseconds. Default: 0.", minimum: 0, default: 0 },
        press_enter: { type: "boolean", description: "Press Enter after typing. Default: false.", default: false },
      },
      required: ["page_id", "selector", "text"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const pageId = String(args[0] ?? "");
      const selector = String(args[1] ?? "");
      const text = String(args[2] ?? "");
      const clear = args[3] !== false;
      const delay = args[4] != null ? Number(args[4]) : 0;
      const pressEnter = args[5] === true;
      const entry = getPage(pageId);
      if (!entry) {
        return { content: [{ type: "text", text: `error: Page not found: ${pageId}.` }], isError: true };
      }
      if (entry.page.isClosed()) {
        pageRegistry.delete(pageId);
        return { content: [{ type: "text", text: `error: Page ${pageId} has been closed.` }], isError: true };
      }
      try {
        const locator = entry.page.locator(selector).first();
        if (clear) {
          await locator.fill("");
        }
        await locator.type(text, { delay });
        if (pressEnter) {
          await locator.press("Enter");
        }
        return { content: [{ type: "text", text: `Typed "${text}" into ${selector}${pressEnter ? " and pressed Enter" : ""}` }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `error: Type failed for selector '${selector}': ${msg}` }], isError: true };
      }
    },
  });
}

// ── Browser Screenshot Tool ──

export function createBrowserScreenshotTool(): FunctionTool<WebToolContext> {
  return createFunctionTool<WebToolContext>({
    name: "browser_screenshot",
    description: "Capture a screenshot of a browser page or a specific element. Returns a PNG image as base64. Useful for visual inspection.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page_id returned by browser_navigate." },
        full_page: { type: "boolean", description: "Capture the full scrollable page. Default: false (viewport only).", default: false },
        selector: { type: "string", description: "Optional CSS selector. If provided, captures only that element." },
      },
      required: ["page_id"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const pageId = String(args[0] ?? "");
      const fullPage = args[1] === true;
      const selector = args[2] != null ? String(args[2]) : undefined;
      const entry = getPage(pageId);
      if (!entry) {
        return { content: [{ type: "text", text: `error: Page not found: ${pageId}.` }], isError: true };
      }
      if (entry.page.isClosed()) {
        pageRegistry.delete(pageId);
        return { content: [{ type: "text", text: `error: Page ${pageId} has been closed.` }], isError: true };
      }
      try {
        let buffer: Buffer;
        if (selector) {
          buffer = await entry.page.locator(selector).first().screenshot({ type: "png" });
        } else {
          buffer = await entry.page.screenshot({ fullPage, type: "png" });
        }
        return {
          content: [
            { type: "text", text: `Screenshot captured (${buffer.length} bytes, ${fullPage ? "full page" : "viewport"}${selector ? ` of ${selector}` : ""}).` },
            { type: "image", data: buffer.toString("base64"), mimeType: "image/png" } as ImageContent,
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `error: Screenshot failed: ${msg}` }], isError: true };
      }
    },
  });
}

// ── Browser Snapshot Tool ──

export function createBrowserSnapshotTool(): FunctionTool<WebToolContext> {
  return createFunctionTool<WebToolContext>({
    name: "browser_snapshot",
    description: "Get a text snapshot of a browser page's structure. Returns the accessibility tree or the visible text content of the page body. Useful for understanding page layout without a screenshot.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page_id returned by browser_navigate." },
        format: { type: "string", description: "Snapshot format. 'text' returns visible body text, 'html' returns cleaned outer HTML of the body, 'accessibility' returns the accessibility tree. Default: text.", enum: ["text", "html", "accessibility"], default: "text" },
        max_length: { type: "integer", description: "Maximum length of the returned text in characters. Default: 20000.", minimum: 100, default: 20000 },
      },
      required: ["page_id"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const pageId = String(args[0] ?? "");
      const format = (args[1] as "text" | "html" | "accessibility") ?? "text";
      const maxLength = args[2] != null ? Number(args[2]) : 20000;
      const entry = getPage(pageId);
      if (!entry) {
        return { content: [{ type: "text", text: `error: Page not found: ${pageId}.` }], isError: true };
      }
      if (entry.page.isClosed()) {
        pageRegistry.delete(pageId);
        return { content: [{ type: "text", text: `error: Page ${pageId} has been closed.` }], isError: true };
      }
      try {
        let result = "";
        if (format === "accessibility") {
          // page.accessibility was removed from Playwright's public types in
          // newer versions; access it via a dynamic property lookup so we keep
          // working across versions without importing private types.
          const accessibility = (entry.page as unknown as { accessibility?: { snapshot: () => Promise<unknown> } }).accessibility;
          if (accessibility) {
            const snapshot = await accessibility.snapshot();
            result = JSON.stringify(snapshot, null, 2);
          } else {
            // Fallback: extract a semantic outline via the DOM.
            result = await entry.page.evaluate("(() => { const els = document.querySelectorAll('h1,h2,h3,h4,a,button,input,nav,main,article,section'); const out = []; els.forEach((el) => { const tag = el.tagName.toLowerCase(); const text = (el.textContent || '').trim().slice(0, 80); const role = el.getAttribute('role') || ''; const href = el.getAttribute('href') || ''; out.push(`<${tag}${role ? ' role=' + role : ''}${href ? ' href=' + href : ''}> ${text}`); }); return out.join('\\n'); })()");
          }
        } else if (format === "html") {
          const html = (await entry.page.evaluate("document.body ? document.body.outerHTML : ''")) as string;
          result = htmlToMarkdown(html);
        } else {
          result = (await entry.page.evaluate("document.body ? document.body.innerText : ''")) as string;
        }
        if (result.length > maxLength) {
          result = result.slice(0, maxLength) + `\n\n... (truncated, total ${result.length} characters)`;
        }
        return { content: [{ type: "text", text: result || "(empty page)" }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `error: Snapshot failed: ${msg}` }], isError: true };
      }
    },
  });
}

// ── Browser Get Text Tool ──

export function createBrowserGetTextTool(): FunctionTool<WebToolContext> {
  return createFunctionTool<WebToolContext>({
    name: "browser_get_text",
    description: "Extract text content from elements matching a CSS selector on a browser page. Returns one text entry per matching element.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page_id returned by browser_navigate." },
        selector: { type: "string", description: "CSS selector to match elements (e.g. 'h1', '.title', 'article p')." },
        attribute: { type: "string", description: "If provided, return this attribute value instead of text content (e.g. 'href', 'src')." },
        max_results: { type: "integer", description: "Maximum number of elements to return. Default: 50.", minimum: 1, default: 50 },
      },
      required: ["page_id", "selector"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const pageId = String(args[0] ?? "");
      const selector = String(args[1] ?? "");
      const attribute = args[2] != null ? String(args[2]) : undefined;
      const maxResults = args[3] != null ? Number(args[3]) : 50;
      const entry = getPage(pageId);
      if (!entry) {
        return { content: [{ type: "text", text: `error: Page not found: ${pageId}.` }], isError: true };
      }
      if (entry.page.isClosed()) {
        pageRegistry.delete(pageId);
        return { content: [{ type: "text", text: `error: Page ${pageId} has been closed.` }], isError: true };
      }
      try {
        const elements = await entry.page.locator(selector).all();
        const items: string[] = [];
        for (const el of elements) {
          if (items.length >= maxResults) break;
          if (attribute) {
            const val = await el.getAttribute(attribute);
            if (val != null) items.push(val);
          } else {
            const text = await el.textContent();
            const trimmed = text?.trim();
            if (trimmed) items.push(trimmed);
          }
        }
        if (items.length === 0) {
          return { content: [{ type: "text", text: `No matching elements found for selector '${selector}'.` }] };
        }
        const formatted = items.map((t, i) => `${i + 1}. ${t}`).join("\n");
        return { content: [{ type: "text", text: `${items.length} match(es) for '${selector}':\n\n${formatted}` }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `error: Get text failed: ${msg}` }], isError: true };
      }
    },
  });
}

// ── Browser Execute Script Tool ──

export function createBrowserExecuteScriptTool(): FunctionTool<WebToolContext> {
  return createFunctionTool<WebToolContext>({
    name: "browser_execute_script",
    description: "Execute JavaScript code in the context of a browser page and return the result. The script runs in the page (has access to document/window). Must return a JSON-serializable value.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page_id returned by browser_navigate." },
        script: { type: "string", description: "JavaScript code to execute. The code is wrapped and its return value (if any) is serialized. Use 'return' to return a value, e.g. 'return document.title;'." },
      },
      required: ["page_id", "script"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const pageId = String(args[0] ?? "");
      const script = String(args[1] ?? "");
      const entry = getPage(pageId);
      if (!entry) {
        return { content: [{ type: "text", text: `error: Page not found: ${pageId}.` }], isError: true };
      }
      if (entry.page.isClosed()) {
        pageRegistry.delete(pageId);
        return { content: [{ type: "text", text: `error: Page ${pageId} has been closed.` }], isError: true };
      }
      try {
        // Wrap the script so that bare 'return' statements work as expected.
        // Playwright's page.evaluate treats the function body as the script.
        const wrapped = `(async () => { ${script} })()`;
        const result = await entry.page.evaluate(wrapped);
        const text = result === undefined ? "(undefined)" : typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: "text", text }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `error: Script execution failed: ${msg}` }], isError: true };
      }
    },
  });
}

// ── Browser Press Key Tool ──

export function createBrowserPressKeyTool(): FunctionTool<WebToolContext> {
  return createFunctionTool<WebToolContext>({
    name: "browser_press_key",
    description: "Press a keyboard key on a browser page. Useful for submitting forms, dismissing dialogs, scrolling, etc.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page_id returned by browser_navigate." },
        key: { type: "string", description: "Key to press (e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown', 'Control+a'). See Playwright key names." },
      },
      required: ["page_id", "key"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const pageId = String(args[0] ?? "");
      const key = String(args[1] ?? "");
      const entry = getPage(pageId);
      if (!entry) {
        return { content: [{ type: "text", text: `error: Page not found: ${pageId}.` }], isError: true };
      }
      if (entry.page.isClosed()) {
        pageRegistry.delete(pageId);
        return { content: [{ type: "text", text: `error: Page ${pageId} has been closed.` }], isError: true };
      }
      try {
        await entry.page.keyboard.press(key);
        return { content: [{ type: "text", text: `Pressed key: ${key}` }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `error: Key press failed: ${msg}` }], isError: true };
      }
    },
  });
}

// ── Browser Wait For Tool ──

export function createBrowserWaitForTool(): FunctionTool<WebToolContext> {
  return createFunctionTool<WebToolContext>({
    name: "browser_wait_for",
    description: "Wait for an element to appear on a browser page, or for a fixed duration. Useful for pages with dynamic content that loads after navigation.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page_id returned by browser_navigate." },
        selector: { type: "string", description: "CSS selector to wait for. If omitted, waits for a fixed duration instead." },
        timeout: { type: "integer", description: "Maximum wait time in seconds. Default: 10.", minimum: 1, default: 10 },
        state: { type: "string", description: "Wait for the element to reach this state. 'attached' = present in DOM, 'visible' = rendered, 'hidden' = not visible. Default: visible.", enum: ["attached", "visible", "hidden"], default: "visible" },
      },
      required: ["page_id"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const pageId = String(args[0] ?? "");
      const selector = args[1] != null ? String(args[1]) : undefined;
      const timeout = args[2] != null ? Number(args[2]) : 10;
      const state = (args[3] as "attached" | "visible" | "hidden") ?? "visible";
      const entry = getPage(pageId);
      if (!entry) {
        return { content: [{ type: "text", text: `error: Page not found: ${pageId}.` }], isError: true };
      }
      if (entry.page.isClosed()) {
        pageRegistry.delete(pageId);
        return { content: [{ type: "text", text: `error: Page ${pageId} has been closed.` }], isError: true };
      }
      try {
        if (selector) {
          await entry.page.locator(selector).first().waitFor({ state, timeout: timeout * 1000 });
          return { content: [{ type: "text", text: `Element '${selector}' reached state '${state}'.` }] };
        } else {
          await entry.page.waitForTimeout(timeout * 1000);
          return { content: [{ type: "text", text: `Waited ${timeout} seconds.` }] };
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `error: Wait failed: ${msg}` }], isError: true };
      }
    },
  });
}

// ── Browser List Pages Tool ──

export function createBrowserListPagesTool(): FunctionTool<WebToolContext> {
  return createFunctionTool<WebToolContext>({
    name: "browser_list_pages",
    description: "List all currently open browser pages with their page_id, URL, title, and open time. Useful for tracking which pages are available for interaction.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    active: true,
    handler: async (): Promise<CallToolResult> => {
      if (pageRegistry.size === 0) {
        return { content: [{ type: "text", text: "No open browser pages. Use browser_navigate to open one." }] };
      }
      // Clean up closed pages before listing.
      const closed: string[] = [];
      for (const [id, entry] of pageRegistry) {
        if (entry.page.isClosed()) {
          try { await entry.context.close(); } catch { /* ignore */ }
          closed.push(id);
        }
      }
      for (const id of closed) pageRegistry.delete(id);

      if (pageRegistry.size === 0) {
        return { content: [{ type: "text", text: "No open browser pages (all were closed). Use browser_navigate to open one." }] };
      }

      const lines: string[] = [`Open browser pages (${pageRegistry.size}/${MAX_BROWSER_PAGES}):`];
      for (const [id, entry] of pageRegistry) {
        const title = entry.title || "(untitled)";
        const url = entry.url || "(no url)";
        lines.push(`- page_id: ${id} | ${title} | ${url} | opened: ${entry.openedAt}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}

// ── Browser Close Page Tool ──

export function createBrowserClosePageTool(): FunctionTool<WebToolContext> {
  return createFunctionTool<WebToolContext>({
    name: "browser_close_page",
    description: "Close a browser page and free its resources. The page_id becomes invalid after this call.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page_id returned by browser_navigate. If omitted, closes all open pages." },
      },
      required: [],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const pageId = args[0] != null ? String(args[0]) : undefined;

      if (!pageId) {
        // Close all pages.
        const count = pageRegistry.size;
        if (count === 0) {
          return { content: [{ type: "text", text: "No open browser pages to close." }] };
        }
        for (const [id, entry] of pageRegistry) {
          try { await entry.context.close(); } catch { /* ignore */ }
          pageRegistry.delete(id);
        }
        return { content: [{ type: "text", text: `Closed all ${count} browser page(s).` }] };
      }

      const entry = getPage(pageId);
      if (!entry) {
        return { content: [{ type: "text", text: `error: Page not found: ${pageId}.` }], isError: true };
      }
      try {
        await entry.context.close();
      } catch { /* ignore */ }
      pageRegistry.delete(pageId);
      return { content: [{ type: "text", text: `Closed page ${pageId}.` }] };
    },
  });
}

/**
 * Close all open browser pages and clear the registry. Call during shutdown
 * to prevent Chromium process/context leaks.
 */
export async function closeAllBrowserPages(): Promise<void> {
  for (const [id, entry] of pageRegistry) {
    try { await entry.context.close(); } catch { /* ignore */ }
    pageRegistry.delete(id);
  }
}

// ── Browser Select Tool ──

export function createBrowserSelectTool(): FunctionTool<WebToolContext> {
  return createFunctionTool<WebToolContext>({
    name: "browser_select",
    description:
      "Select one or more options in a <select> element on a browser page. " +
      "Options can be specified by value, label (visible text), or index. " +
      "For multi-select elements, pass an array to select multiple options.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page_id returned by browser_navigate." },
        selector: { type: "string", description: "CSS selector of the <select> element (e.g. 'select#country', 'select[name=\"lang\"]')." },
        values: {
          description: "Option value(s) to select. Can be a single string or an array of strings for multi-select. Matches the <option value=\"...\"> attribute.",
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        labels: {
          description: "Alternatively, select by visible text label(s) instead of value. Can be a single string or an array. Matches the text content of <option>.",
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        index: {
          type: "integer",
          description: "Alternatively, select by zero-based index of the option.",
          minimum: 0,
        },
        timeout: { type: "integer", description: "Time to wait for the element to appear, in seconds. Default: 10.", minimum: 1, default: 10 },
      },
      required: ["page_id", "selector"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const pageId = String(args[0] ?? "");
      const selector = String(args[1] ?? "");
      const values = args[2];
      const labels = args[3];
      const index = args[4] != null ? Number(args[4]) : undefined;
      const timeout = args[5] != null ? Number(args[5]) : 10;

      const entry = getPage(pageId);
      if (!entry) {
        return { content: [{ type: "text", text: `error: Page not found: ${pageId}.` }], isError: true };
      }
      if (entry.page.isClosed()) {
        pageRegistry.delete(pageId);
        return { content: [{ type: "text", text: `error: Page ${pageId} has been closed.` }], isError: true };
      }

      // At least one selection criterion must be provided.
      if (values == null && labels == null && index == null) {
        return {
          content: [{ type: "text", text: "error: At least one of 'values', 'labels', or 'index' must be provided." }],
          isError: true,
        };
      }

      try {
        const locator = entry.page.locator(selector).first();
        await locator.waitFor({ state: "visible", timeout: timeout * 1000 });

        const selectedLabels: string[] = [];

        if (values != null) {
          const valArray = Array.isArray(values) ? values : [values];
          await locator.selectOption(valArray as string[]);
          for (const v of valArray) selectedLabels.push(`value="${v}"`);
        } else if (labels != null) {
          const labelArray = Array.isArray(labels) ? labels : [labels];
          await locator.selectOption(labelArray.map((l: string) => ({ label: l })));
          for (const l of labelArray) selectedLabels.push(`label="${l}"`);
        } else if (index != null) {
          await locator.selectOption({ index });
          selectedLabels.push(`index=${index}`);
        }

        // Read back the currently selected option text for confirmation.
        const selectedTexts = await locator.locator("option:checked").allTextContents();
        const confirmation = selectedTexts.length > 0
          ? `Selected: ${selectedTexts.join(", ")}`
          : "Selection applied.";

        return {
          content: [{ type: "text", text: `Selected option(s) in ${selector} — ${selectedLabels.join(", ")}.\n${confirmation}` }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `error: Select failed for selector '${selector}': ${msg}` }], isError: true };
      }
    },
  });
}

// ── Browser Upload Tool ──

export function createBrowserUploadTool(): FunctionTool<WebToolContext> {
  return createFunctionTool<WebToolContext>({
    name: "browser_upload",
    description:
      "Upload one or more files to an <input type=\"file\"> element on a browser page. " +
      "The file path(s) must be accessible from the local filesystem. " +
      "If the page uses a custom file dialog (hidden input), provide the selector for the hidden input.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page_id returned by browser_navigate." },
        selector: { type: "string", description: "CSS selector of the file input element (e.g. 'input[type=\"file\"]')." },
        files: {
          description: "Absolute or relative path(s) to the file(s) to upload. Can be a single string or an array of strings for multiple files.",
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        timeout: { type: "integer", description: "Time to wait for the element to appear, in seconds. Default: 10.", minimum: 1, default: 10 },
      },
      required: ["page_id", "selector", "files"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const pageId = String(args[0] ?? "");
      const selector = String(args[1] ?? "");
      const files = args[2];
      const timeout = args[3] != null ? Number(args[3]) : 10;

      const entry = getPage(pageId);
      if (!entry) {
        return { content: [{ type: "text", text: `error: Page not found: ${pageId}.` }], isError: true };
      }
      if (entry.page.isClosed()) {
        pageRegistry.delete(pageId);
        return { content: [{ type: "text", text: `error: Page ${pageId} has been closed.` }], isError: true };
      }

      if (files == null) {
        return { content: [{ type: "text", text: "error: 'files' parameter is required." }], isError: true };
      }

      const fileList = Array.isArray(files) ? files : [files];

      try {
        const locator = entry.page.locator(selector).first();
        await locator.waitFor({ state: "attached", timeout: timeout * 1000 });
        await locator.setInputFiles(fileList as string[]);

        return {
          content: [{ type: "text", text: `Uploaded ${fileList.length} file(s) to ${selector}: ${fileList.join(", ")}` }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `error: Upload failed for selector '${selector}': ${msg}` }], isError: true };
      }
    },
  });
}

// ── Browser Hover Tool ──

export function createBrowserHoverTool(): FunctionTool<WebToolContext> {
  return createFunctionTool<WebToolContext>({
    name: "browser_hover",
    description:
      "Hover the mouse over an element on a browser page. Triggers CSS :hover state, " +
      "JavaScript mouseover/mouseenter events, and is useful for revealing dropdown menus, " +
      "tooltips, or other hover-activated UI elements.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page_id returned by browser_navigate." },
        selector: { type: "string", description: "CSS selector of the element to hover over." },
        timeout: { type: "integer", description: "Time to wait for the element to appear, in seconds. Default: 10.", minimum: 1, default: 10 },
      },
      required: ["page_id", "selector"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const pageId = String(args[0] ?? "");
      const selector = String(args[1] ?? "");
      const timeout = args[2] != null ? Number(args[2]) : 10;

      const entry = getPage(pageId);
      if (!entry) {
        return { content: [{ type: "text", text: `error: Page not found: ${pageId}.` }], isError: true };
      }
      if (entry.page.isClosed()) {
        pageRegistry.delete(pageId);
        return { content: [{ type: "text", text: `error: Page ${pageId} has been closed.` }], isError: true };
      }

      try {
        const locator = entry.page.locator(selector).first();
        await locator.waitFor({ state: "visible", timeout: timeout * 1000 });
        await locator.hover();
        return { content: [{ type: "text", text: `Hovered over element: ${selector}` }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `error: Hover failed for selector '${selector}': ${msg}` }], isError: true };
      }
    },
  });
}

// ── Browser Drag and Drop Tool ──

export function createBrowserDragAndDropTool(): FunctionTool<WebToolContext> {
  return createFunctionTool<WebToolContext>({
    name: "browser_drag_and_drop",
    description:
      "Drag an element from a source selector and drop it onto a target element on a browser page. " +
      "Useful for drag-and-drop interactions like reordering list items, moving kanban cards, or adjusting sliders. " +
      "Works with HTML5 drag-and-drop API and standard mouse events.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page_id returned by browser_navigate." },
        source_selector: { type: "string", description: "CSS selector of the element to drag (source)." },
        target_selector: { type: "string", description: "CSS selector of the element to drop onto (target)." },
        timeout: { type: "integer", description: "Time to wait for the elements to appear, in seconds. Default: 10.", minimum: 1, default: 10 },
      },
      required: ["page_id", "source_selector", "target_selector"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const pageId = String(args[0] ?? "");
      const sourceSelector = String(args[1] ?? "");
      const targetSelector = String(args[2] ?? "");
      const timeout = args[3] != null ? Number(args[3]) : 10;

      const entry = getPage(pageId);
      if (!entry) {
        return { content: [{ type: "text", text: `error: Page not found: ${pageId}.` }], isError: true };
      }
      if (entry.page.isClosed()) {
        pageRegistry.delete(pageId);
        return { content: [{ type: "text", text: `error: Page ${pageId} has been closed.` }], isError: true };
      }

      try {
        const sourceLocator = entry.page.locator(sourceSelector).first();
        const targetLocator = entry.page.locator(targetSelector).first();
        await sourceLocator.waitFor({ state: "visible", timeout: timeout * 1000 });
        await targetLocator.waitFor({ state: "visible", timeout: timeout * 1000 });

        // Try the native HTML5 drag-and-drop API first (dragTo). This dispatches
        // the full dragstart → dragenter → dragover → drop event sequence.
        // If that doesn't trigger the expected behavior (some custom UIs listen
        // to mouse events instead), fall back to a manual mouse-based drag.
        try {
          await sourceLocator.dragTo(targetLocator, { timeout: timeout * 1000 });
        } catch {
          // Fallback: manual mouse drag via down/move/up
          const sourceBox = await sourceLocator.boundingBox();
          const targetBox = await targetLocator.boundingBox();
          if (!sourceBox || !targetBox) {
            throw new Error("Could not determine element bounding boxes for manual drag.");
          }
          const sourceX = sourceBox.x + sourceBox.width / 2;
          const sourceY = sourceBox.y + sourceBox.height / 2;
          const targetX = targetBox.x + targetBox.width / 2;
          const targetY = targetBox.y + targetBox.height / 2;

          await entry.page.mouse.move(sourceX, sourceY);
          await entry.page.mouse.down();
          // Move in a few steps to trigger intermediate dragover events.
          const steps = 5;
          for (let i = 1; i <= steps; i++) {
            await entry.page.mouse.move(
              sourceX + (targetX - sourceX) * (i / steps),
              sourceY + (targetY - sourceY) * (i / steps)
            );
            await entry.page.waitForTimeout(50);
          }
          await entry.page.mouse.up();
        }

        return {
          content: [{
            type: "text",
            text: `Dragged ${sourceSelector} → ${targetSelector}`,
          }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `error: Drag and drop failed: ${msg}` }], isError: true };
      }
    },
  });
}

// ── Tool assembly ──

/**
 * Get the set of web tools.
 */
export function getWebTools(engine: SearchEngine = "bing", customSearchProvider?: WebSearchProvider): FunctionTool<WebToolContext>[] {
  return [
    createWebFetchTool(),
    createWebSearchTool(customSearchProvider, engine),
    createHttpRequestTool(),
    // Browser automation tools (full headless browser control)
    createBrowserNavigateTool(),
    createBrowserClickTool(),
    createBrowserTypeTool(),
    createBrowserSelectTool(),
    createBrowserUploadTool(),
    createBrowserHoverTool(),
    createBrowserDragAndDropTool(),
    createBrowserScreenshotTool(),
    createBrowserSnapshotTool(),
    createBrowserGetTextTool(),
    createBrowserExecuteScriptTool(),
    createBrowserPressKeyTool(),
    createBrowserWaitForTool(),
    createBrowserListPagesTool(),
    createBrowserClosePageTool(),
  ];
}

/**
 * Get only the browser automation tools. Useful when you want to add
 * interactive browser control to a tool set without the fetch/search/http tools.
 */
export function getBrowserAutomationTools(): FunctionTool<WebToolContext>[] {
  return [
    createBrowserNavigateTool(),
    createBrowserClickTool(),
    createBrowserTypeTool(),
    createBrowserSelectTool(),
    createBrowserUploadTool(),
    createBrowserHoverTool(),
    createBrowserDragAndDropTool(),
    createBrowserScreenshotTool(),
    createBrowserSnapshotTool(),
    createBrowserGetTextTool(),
    createBrowserExecuteScriptTool(),
    createBrowserPressKeyTool(),
    createBrowserWaitForTool(),
    createBrowserListPagesTool(),
    createBrowserClosePageTool(),
  ];
}
