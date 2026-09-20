/**
 * SSRF protection: LAN access allowed per business requirements, but other
 * safety measures are enforced (URL scheme validation, response size cap,
 * redirect loop limits).
 */

export interface SafeFetchOptions extends RequestInit {
  allowedContentTypes?: string[];
  dispatcher?: any;
}

/** Maximum number of HTTP redirects to follow manually. */
export const MAX_REDIRECTS = 5;

/** Allowed URL schemes for outbound fetches. */
export const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Default per-fetch response size cap (bytes) to mitigate DoS. */
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Hosts that must never be fetched even though LAN access is allowed by
 * business requirements: cloud instance-metadata endpoints are reachable
 * from any VM and leaking their response would hand out credentials.
 */
const BLOCKED_METADATA_HOSTS = new Set([
  "169.254.169.254", // AWS/GCP/Azure/... instance metadata
  "metadata.google.internal", // GCP metadata
  "100.100.100.200", // Alibaba Cloud ECS metadata
]);

export async function assertSafeUrl(rawUrl: string): Promise<void> {
  const parsed = new URL(rawUrl);
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Disallowed URL scheme: ${parsed.protocol}`);
  }
  // Strip a single trailing dot: DNS treats "host." as the same name as "host",
  // so without normalization "169.254.169.254." / "metadata.google.internal."
  // bypass the exact-match blocklist below.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_METADATA_HOSTS.has(host)) {
    throw new Error(`Blocked metadata host: ${parsed.hostname}`);
  }
}

export async function safeFetch(
  url: string,
  init: SafeFetchOptions = {},
  maxRedirects: number = MAX_REDIRECTS,
): Promise<Response> {
  let currentUrl = url;
  let redirects = 0;
  let currentInit = { ...init };

  while (true) {
    await assertSafeUrl(currentUrl);

    // Fetch with manual redirect mode to intercept and count hops
    const fetchInit: RequestInit & { allowedContentTypes?: unknown } = { ...currentInit, redirect: "manual" };
    delete fetchInit.allowedContentTypes;

    const response = await fetch(currentUrl, fetchInit);

    const status = response.status;
    if (status >= 300 && status < 400 && response.headers.has("location")) {
      if (redirects >= maxRedirects) {
        // Cancel the un-consumed redirect body before throwing so the
        // underlying keep-alive socket is released rather than leaked.
        try { await response.body?.cancel(); } catch { /* ignore */ }
        throw new Error(`Too many redirects (max: ${maxRedirects})`);
      }
      redirects++;
      const location = response.headers.get("location")!;
      const nextUrl = new URL(location, currentUrl);

      // Drain/cancel the 3xx response body. Without this the undici keep-alive
      // socket stays checked out (never returned to the pool) on every
      // redirect — a slow connection leak.
      try { await response.body?.cancel(); } catch { /* ignore */ }

      // Strip credential-bearing headers when the redirect crosses origin, so
      // an Authorization/Cookie header set by the caller isn't forwarded to a
      // third-party host. Same-origin redirects keep them.
      if (nextUrl.origin !== new URL(currentUrl).origin) {
        const stripped = { ...(currentInit.headers as Record<string, string> | undefined) };
        for (const key of Object.keys(stripped)) {
          if (/^(authorization|cookie|proxy-authorization)$/i.test(key)) {
            delete stripped[key];
          }
        }
        currentInit = { ...currentInit, headers: stripped };
      }

      currentUrl = nextUrl.toString();

      // For typical redirects, POST might become GET, body should be removed
      if (status === 303 || ((status === 301 || status === 302) && currentInit.method === "POST")) {
        currentInit = {
          ...currentInit,
          method: "GET",
        };
        delete currentInit.body;
      }
      continue;
    }

    // Check size limit from content-length header
    const contentLengthStr = response.headers.get("content-length");
    if (contentLengthStr) {
      const contentLength = parseInt(contentLengthStr, 10);
      if (!isNaN(contentLength) && contentLength > DEFAULT_MAX_RESPONSE_BYTES) {
        throw new Error(`Response size exceeds limit of ${DEFAULT_MAX_RESPONSE_BYTES} bytes`);
      }
    }

    // Check content-type
    if (init.allowedContentTypes && init.allowedContentTypes.length > 0) {
      const contentType = response.headers.get("content-type") || "";
      const matched = init.allowedContentTypes.some(allowedType => {
        if (allowedType.endsWith("/*")) {
          const prefix = allowedType.slice(0, -2);
          return contentType.startsWith(prefix);
        }
        return contentType.split(";")[0].trim() === allowedType;
      });
      if (!matched) {
        throw new Error(`Disallowed content-type: ${contentType}`);
      }
    }

    // Intercept/wrap response body stream to count read bytes (for DoS prevention)
    if (response.body) {
      const reader = response.body.getReader();
      let bytesRead = 0;
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            bytesRead += value.length;
            if (bytesRead > DEFAULT_MAX_RESPONSE_BYTES) {
              controller.error(new Error(`Response size limit exceeded: ${DEFAULT_MAX_RESPONSE_BYTES} bytes`));
              try { await reader.cancel(); } catch {}
              return;
            }
            controller.enqueue(value);
          } catch (e) {
            controller.error(e);
          }
        },
        async cancel(reason) {
          await reader.cancel(reason);
        }
      });

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    return response;
  }
}
