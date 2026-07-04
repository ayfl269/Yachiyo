/**
 * SSRF protection removed — LAN access restrictions disabled.
 */

/** Maximum number of HTTP redirects to follow manually. */
export const MAX_REDIRECTS = 5;

/** Allowed URL schemes for outbound fetches. */
export const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Default per-fetch response size cap (bytes) to mitigate DoS. */
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

export async function assertSafeUrl(_rawUrl: string): Promise<void> {
  // no-op: LAN access restriction removed
}

export async function safeFetch(
  url: string,
  init: RequestInit = {},
  _maxRedirects: number = MAX_REDIRECTS,
): Promise<Response> {
  return fetch(url, init);
}
