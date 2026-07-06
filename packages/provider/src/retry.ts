export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableStatusCodes: number[];
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableStatusCodes: [429, 500, 503],
};

/**
 * Transient network errno codes surfaced by Node's http/https stack and
 * undici. These have no HTTP status code (the request never completed)
 * but represent exactly the kind of transient failure retry was designed
 * for.
 */
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Determine whether an error represents a transient network-level failure
 * that should be retried even though it carries no HTTP status code.
 *
 * - Browser `fetch` surfaces DNS failures, connection resets, and TLS
 *   handshake failures as `TypeError: fetch failed` / `Failed to fetch`.
 * - Node surfaces the same conditions via `err.code` (errno).
 */
function isTransientNetworkError(err: any): boolean {
  if (err instanceof TypeError) return true;
  if (typeof err.code === "string" && TRANSIENT_NETWORK_CODES.has(err.code)) {
    return true;
  }
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  abortSignal?: AbortSignal,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (abortSignal?.aborted) throw new Error("Aborted");

    try {
      return await fn();
    } catch (err: any) {
      lastError = err;

      const statusCode = err.statusCode ?? err.status;
      const isRetryableStatus =
        statusCode != null && config.retryableStatusCodes.includes(statusCode);
      // Network errors (DNS failures, connection resets, TLS handshake
      // failures, etc.) carry no status code and would otherwise bypass
      // retry entirely — even though they are the most transient errors.
      const isNetworkError = isTransientNetworkError(err);

      if (!isRetryableStatus && !isNetworkError) {
        throw err;
      }

      if (attempt === config.maxRetries) throw err;

      const delay = Math.min(
        config.baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000,
        config.maxDelayMs,
      );

      let waitMs = delay;
      if (statusCode === 429 && err.retryAfterMs) {
        waitMs = err.retryAfterMs;
      }

      // Abortable sleep: reject immediately if the caller signals abort
      // during the backoff window instead of waiting the full delay.
      await new Promise<void>((resolve, reject) => {
        if (abortSignal?.aborted) {
          reject(new Error("Aborted"));
          return;
        }
        const timerId = setTimeout(() => {
          abortSignal?.removeEventListener("abort", onAbort);
          resolve();
        }, waitMs);
        const onAbort = () => {
          clearTimeout(timerId);
          reject(new Error("Aborted"));
        };
        abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  throw lastError!;
}
