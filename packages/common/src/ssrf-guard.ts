/**
 * SSRF protection helpers.
 *
 * Shared guard used by knowledge-base URL upload, web_fetch_tool and
 * http_request_tool. Validates URL scheme and resolves the hostname via DNS
 * to ensure no resolved IP falls into private / reserved / loopback /
 * link-local ranges (including cloud metadata endpoints like 169.254.169.254).
 *
 * This is defense-in-depth. A residual DNS-rebinding risk remains because
 * Node's `fetch` performs its own resolution after we validate; for strict
 * DNS pinning a custom undici dispatcher would be required. The guard is
 * sufficient to block naive SSRF attempts (localhost, RFC-1918, cloud
 * metadata).
 */

import { BlockList } from "net";
import { promises as dnsPromises } from "dns";

// IPv4 private / reserved / special-use ranges
const SSRF_BLOCKLIST = new BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  SSRF_BLOCKLIST.addSubnet(addr, prefix, "ipv4");
}
// IPv6 loopback / link-local / unique-local / multicast
SSRF_BLOCKLIST.addSubnet("::1", 128, "ipv6");
SSRF_BLOCKLIST.addSubnet("fc00::", 7, "ipv6");
SSRF_BLOCKLIST.addSubnet("fe80::", 10, "ipv6");
SSRF_BLOCKLIST.addSubnet("ff00::", 8, "ipv6");

/** Maximum number of HTTP redirects to follow manually. */
export const MAX_REDIRECTS = 5;

/** Allowed URL schemes for outbound fetches. */
export const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Default per-fetch response size cap (bytes) to mitigate DoS. */
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Validate that a URL is safe to fetch: scheme must be http/https and all
 * resolved IP addresses must fall outside private/reserved ranges.
 *
 * @param rawUrl URL to validate
 * @throws Error on violation (caller decides how to surface to users)
 */
export async function assertSafeUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(`URL scheme '${parsed.protocol}' is not allowed (only http/https)`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (!hostname) {
    throw new Error("URL has no hostname");
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsPromises.lookup(hostname, { all: true });
  } catch (err) {
    throw new Error(`DNS resolution failed for '${hostname}': ${err}`);
  }

  if (addresses.length === 0) {
    throw new Error(`No DNS records found for '${hostname}'`);
  }

  for (const { address, family } of addresses) {
    const fam = family === 6 ? "ipv6" : "ipv4";
    if (SSRF_BLOCKLIST.check(address, fam)) {
      throw new Error(
        `URL resolves to a blocked private/reserved IP address (${address}). SSRF attempt prevented.`,
      );
    }
  }
}

/**
 * Fetch a URL with SSRF protection applied to the initial URL and every
 * redirect hop. Uses `redirect: "manual"` internally and re-validates each
 * `Location` header via `assertSafeUrl`.
 *
 * @param url Initial URL
 * @param init Fetch init (without `redirect`; signal preserved)
 * @param maxRedirects Maximum redirect hops, default 5
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  maxRedirects: number = MAX_REDIRECTS,
): Promise<Response> {
  await assertSafeUrl(url);

  const { redirect: _omit, ...rest } = init;
  const fetchInit: RequestInit = { ...rest, redirect: "manual" };

  let response = await fetch(url, fetchInit);
  let currentUrl = url;
  let redirectCount = 0;

  while (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
    if (++redirectCount > maxRedirects) {
      throw new Error(`Too many redirects (>${maxRedirects}) when fetching ${url}`);
    }
    const location = response.headers.get("location")!;
    currentUrl = new URL(location, currentUrl).toString(); // resolve relative redirects
    await assertSafeUrl(currentUrl);
    response = await fetch(currentUrl, fetchInit);
  }

  return response;
}
