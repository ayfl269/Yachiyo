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
      if (!config.retryableStatusCodes.includes(statusCode)) {
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

      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }

  throw lastError!;
}
