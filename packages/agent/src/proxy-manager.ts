/**
 * ProxyManager — runtime proxy configuration for the agent system.
 *
 * Manages a single proxy URL that is applied to:
 * 1. Global `fetch()` via undici's `setGlobalDispatcher` (affects web_fetch,
 *    http_request, search providers, and all other fetch-based code).
 * 2. Playwright browser launches via the `proxy` option in `chromium.launch()`.
 *
 * The manager is a singleton so that any module can query the current proxy
 * state without threading it through every function call. Listeners can
 * register for proxy-change events (e.g. the browser launcher closes its
 * singleton browser on change so the next launch picks up the new proxy).
 *
 * Usage:
 *   import { proxyManager } from "./proxy-manager.js";
 *   await proxyManager.setProxy("http://127.0.0.1:7890");
 *   const status = proxyManager.getStatus();
 *   await proxyManager.disable();
 */

/** Proxy status snapshot returned by getStatus(). */
export interface ProxyStatus {
  /** Whether a proxy is currently active. */
  enabled: boolean;
  /** The current proxy URL, or null if disabled. */
  url: string | null;
  /** Where the proxy was configured from: "env" | "runtime" | "default". */
  source: "env" | "runtime" | "default";
}

/** Result of a proxy connectivity test. */
export interface ProxyTestResult {
  ok: boolean;
  /** The URL that was tested through the proxy. */
  testUrl: string;
  /** Response status code if the request succeeded, else null. */
  statusCode: number | null;
  /** Round-trip time in milliseconds, or null on failure. */
  elapsedMs: number | null;
  /** Error message if the test failed, or null on success. */
  error: string | null;
}

type ProxyChangeListener = (url: string | null) => void;

/**
 * Redact userinfo (username/password) from a proxy URL for safe logging and
 * for display back to the model. `http://user:pass@host:port` →
 * `http://***@host:port`. Returns the input unchanged if it can't be parsed.
 */
export function redactProxyUrl(url: string | null): string | null {
  if (!url) return url;
  // Preserve the original string when there are no credentials, so callers
  // comparing against the configured value aren't surprised by URL
  // normalization (e.g. an appended trailing slash).
  if (!/\/\/[^/@]*@/.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.username = "***";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // Fall back to a regex strip of any `user:pass@` segment.
    return url.replace(/\/\/[^/@]*@/, "//***@");
  }
}

class ProxyManager {
  private _url: string | null = null;
  private _source: "env" | "runtime" | "default" = "default";
  private _listeners: ProxyChangeListener[] = [];
  /** The ProxyAgent/Agent currently installed as the global dispatcher. */
  private _dispatcher: { close?: () => Promise<void> } | null = null;

  /** Current proxy URL (null = no proxy / direct connection). */
  get url(): string | null {
    return this._url;
  }

  /** Whether a proxy is currently active. */
  get enabled(): boolean {
    return this._url !== null;
  }

  /** Current status snapshot. */
  getStatus(): ProxyStatus {
    return {
      enabled: this._url !== null,
      url: this._url,
      source: this._source,
    };
  }

  /**
   * Set or update the proxy URL. Pass `null` to disable the proxy.
   *
   * This updates the undici global dispatcher so all subsequent `fetch()`
   * calls route through the proxy, and notifies registered listeners (e.g.
   * the Playwright browser launcher) so they can relaunch with the new proxy.
   */
  async setProxy(url: string | null, source: "env" | "runtime" | "default" = "runtime"): Promise<void> {
    const normalized = this.normalizeUrl(url);
    const changed = normalized !== this._url;

    this._url = normalized;
    this._source = normalized ? source : "default";

    // Update the undici global dispatcher.
    await this.applyToGlobalDispatcher(normalized);

    // Notify listeners only when the URL actually changed.
    if (changed) {
      for (const listener of this._listeners) {
        try {
          listener(normalized);
        } catch (e) {
          console.error("[ProxyManager] Listener threw on proxy change:", e);
        }
      }
    }

    if (normalized) {
      console.log(`[ProxyManager] Proxy set to ${redactProxyUrl(normalized)} (source: ${source})`);
    } else {
      console.log(`[ProxyManager] Proxy disabled (source: ${source})`);
    }
  }

  /** Convenience: enable proxy with the given URL. */
  async enable(url: string): Promise<void> {
    await this.setProxy(url, "runtime");
  }

  /** Convenience: disable the proxy (direct connection). */
  async disable(): Promise<void> {
    await this.setProxy(null, "runtime");
  }

  /**
   * Test connectivity through the current proxy by fetching a test URL.
   * If no proxy is active, tests the direct connection instead.
   *
   * @param testUrl URL to fetch. Defaults to https://httpbin.org/get.
   * @param timeoutMs Timeout in milliseconds. Default 10000.
   */
  async testProxy(testUrl?: string, timeoutMs: number = 10000): Promise<ProxyTestResult> {
    const target = testUrl ?? "https://httpbin.org/get";
    const start = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(target, {
        signal: controller.signal,
        redirect: "follow",
      });

      // Consume the body so the connection is returned to the pool rather
      // than left open until GC.
      try { await response.body?.cancel(); } catch { /* ignore */ }

      const elapsedMs = Date.now() - start;
      return {
        ok: response.ok,
        testUrl: target,
        statusCode: response.status,
        elapsedMs,
        error: response.ok ? null : `HTTP ${response.status} ${response.statusText}`,
      };
    } catch (e) {
      const elapsedMs = Date.now() - start;
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        testUrl: target,
        statusCode: null,
        elapsedMs,
        error: msg,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Register a listener that is called whenever the proxy URL changes.
   * The listener receives the new URL (or null if disabled).
   * Returns an unsubscribe function.
   */
  onChange(listener: ProxyChangeListener): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  }

  // ── Internal helpers ──

  /** Normalize a proxy URL. Returns null for empty/invalid input. */
  private normalizeUrl(url: string | null): string | null {
    if (!url) return null;
    const trimmed = url.trim();
    if (!trimmed) return null;
    // Accept http://, https://, socks5://, socks4://, socks4a://, socks5h:// schemes.
    // If no scheme is provided, assume http://.
    // The scheme regex allows digits (e.g. socks5, socks4) and letters.
    if (!/^[a-z][a-z0-9]*:\/\//i.test(trimmed)) {
      return `http://${trimmed}`;
    }
    return trimmed;
  }

  /** Apply the proxy (or direct connection) to undici's global dispatcher. */
  private async applyToGlobalDispatcher(url: string | null): Promise<void> {
    try {
      const { setGlobalDispatcher, Agent, ProxyAgent } = await import("undici");
      let next: { close?: () => Promise<void> };
      if (url) {
        // undici's ProxyAgent only supports http:// and https:// proxy URLs.
        // SOCKS proxies (socks5://, socks4://) are not supported by undici —
        // they will still work for Playwright browser launches, but fetch()
        // calls cannot be routed through a SOCKS proxy. Reset to a direct
        // Agent (rather than leaving the previous proxy installed) so the
        // reported state matches the actual fetch behaviour; the URL remains
        // recorded for Playwright.
        if (/^socks/i.test(url)) {
          console.warn(
            `[ProxyManager] SOCKS proxy '${url}' is not supported by undici (fetch). ` +
            `It will be used for Playwright browser launches only. ` +
            `fetch() falls back to a direct connection. ` +
            `Use an http:// or https:// proxy if you need fetch() to go through the proxy.`
          );
          next = new Agent();
        } else {
          next = new ProxyAgent(url);
        }
      } else {
        // Reset to the default Agent (direct connection, no proxy).
        next = new Agent();
      }
      setGlobalDispatcher(next as unknown as import("undici").Dispatcher);

      // Close the previously installed dispatcher so its keep-alive
      // connection pool is released instead of lingering until GC. Without
      // this, repeatedly changing the proxy leaked one pool per change.
      const prev = this._dispatcher;
      this._dispatcher = next;
      if (prev && prev !== next && typeof prev.close === "function") {
        try { await prev.close(); } catch { /* ignore */ }
      }
    } catch (e) {
      // undici is a Node.js built-in (available since Node 18+). If the
      // dynamic import fails, the global fetch will continue using whatever
      // dispatcher was previously set. Log the error but don't throw —
      // the proxy URL is still recorded for Playwright use.
      console.warn("[ProxyManager] Failed to update undici global dispatcher:", e);
    }
  }
}

/** Singleton instance shared across the application. */
export const proxyManager = new ProxyManager();
