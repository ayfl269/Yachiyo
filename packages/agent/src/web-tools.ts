/**
 * Web tools: URL fetching, web search, and HTTP request tools.
 */

import { createFunctionTool, type FunctionTool } from "./tool.js";
import type { CallToolResult, ImageContent } from "./types.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import TurndownService from "turndown";
import { safeFetch, assertSafeUrl } from "@yachiyo/common/ssrf-guard.js";

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
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    });
    sharedBrowser = browser;
    browserLaunchPromise = null;
    // Auto-cleanup on process exit.
    process.once("exit", () => { try { browser.close(); } catch { /* ignore */ } });
    return browser;
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

// ── Shared context type ──

export interface WebToolContext {
  event?: {
    unifiedMsgOrigin?: string;
  };
  providerSettings?: {
    web_search_api_url?: string;
    web_search_api_key?: string;
  };
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

function htmlToMarkdown(html: string): string {
  // Strip non-content elements before conversion.
  let cleaned = html;
  cleaned = cleaned.replace(/<head[\s\S]*?<\/head>/gi, "");
  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, "");
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, "");
  cleaned = cleaned.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  cleaned = cleaned.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  cleaned = cleaned.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  const md = turndownService.turndown(cleaned);
  // Collapse excessive blank lines and trim trailing whitespace.
  return md.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").trim();
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

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

        const fetchOptions: RequestInit = {
          method,
          headers: { "User-Agent": "AgentSystem/1.0", ...headers },
          signal: controller.signal,
        };
        if (body && ["POST", "PUT", "PATCH"].includes(method)) {
          fetchOptions.body = body;
        }

        // safeFetch validates URL scheme + DNS-resolved IPs against private
        // ranges and follows redirects manually, re-validating each hop.
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
              userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
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
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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

      const resultUrl = titleMatch[1].replace(/&amp;/g, "&");
      const title = titleMatch[2].replace(/<[^>]*>/g, "").trim();

      // Skip Bing internal links
      if (!resultUrl || resultUrl.startsWith("/") || resultUrl.includes("bing.com/search")) continue;

      // Extract snippet: try multiple patterns
      let snippet = "";

      // Pattern 1: <p class="b_lineclamp...">
      const snippet1 = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
      if (snippet1) {
        snippet = snippet1[1].replace(/<[^>]*>/g, "").trim();
      }

      // Pattern 2: <div class="b_caption"><p>...</p></div>
      if (!snippet) {
        const snippet2 = /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
        if (snippet2) {
          snippet = snippet2[1].replace(/<[^>]*>/g, "").trim();
        }
      }

      // Pattern 3: any <p> inside b_caption
      if (!snippet) {
        const snippet3 = /class="[^"]*b_caption[^"]*"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
        if (snippet3) {
          snippet = snippet3[1].replace(/<[^>]*>/g, "").trim();
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
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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
      const title = titleMatch[2].replace(/<[^>]*>/g, "").trim();

      // Extract snippet
      let snippet = "";
      const snippetRegex = /<div[^>]*class="[^"]*(?:VwiC3b|IsZvec)[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
      const snippetMatch = snippetRegex.exec(block);
      if (snippetMatch) {
        snippet = snippetMatch[1].replace(/<[^>]*>/g, "").trim();
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
      const browser = await chromium.launch({
        headless: true,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-infobars",
          "--no-sandbox",
          "--disable-dev-shm-usage",
        ],
      });
      this._browser = browser;
      this._launchPromise = null;
      return browser;
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
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
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
                // safeFetch re-validates each result URL (and redirect hop)
                // against private/reserved IP ranges. Search result URLs are
                // attacker-influencable and could otherwise be used for SSRF.
                const resp = await safeFetch(r.url, {
                  headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
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

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

        const requestHeaders: Record<string, string> = {
          "User-Agent": "AgentSystem/1.0",
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

        // safeFetch validates URL scheme + DNS-resolved IPs against private
        // ranges and follows redirects manually, re-validating each hop.
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

// ── Tool assembly ──

/**
 * Get the set of web tools.
 */
export function getWebTools(engine: SearchEngine = "bing", customSearchProvider?: WebSearchProvider): FunctionTool<WebToolContext>[] {
  return [
    createWebFetchTool(),
    createWebSearchTool(customSearchProvider, engine),
    createHttpRequestTool(),
  ];
}
