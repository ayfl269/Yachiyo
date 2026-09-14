const proxyAgentCache = new Map<string, unknown>();

/**
 * Normalizes proxy URL format, prepending http:// if protocol is missing.
 */
export function normalizeProxyUrl(raw?: string | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (!/^[a-z][a-z0-9]*:\/\//i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
}

/**
 * Retrieves or instantiates a cached undici ProxyAgent for the given proxy URL.
 * If url is nullish/empty, returns undefined (which causes fetch to use default/global dispatcher).
 */
export async function getProxyAgent(url?: string | null): Promise<unknown> {
  const normalized = normalizeProxyUrl(url);
  if (!normalized) return undefined;

  if (proxyAgentCache.has(normalized)) {
    return proxyAgentCache.get(normalized);
  }

  try {
    const { ProxyAgent } = await import("undici");
    const agent = new ProxyAgent(normalized);
    proxyAgentCache.set(normalized, agent);
    return agent;
  } catch (e) {
    console.warn(`[ProxyAgent] Failed to create ProxyAgent for ${normalized}:`, e);
    return undefined;
  }
}
