/**
 * Session lock manager with TTL and watchdog.
 *
 * Locks auto-expire after `defaultTtlMs` (default 5 minutes) to prevent
 * permanently stuck sessions when the holder crashes or forgets to call
 * `release()`. A watchdog timer checks for expired locks periodically.
 */
export class SessionLockManager {
  private locks: Map<string, { promise: Promise<void>; release: () => void; acquiredAt: number; ttlMs: number; watchdog: ReturnType<typeof setInterval> }> = new Map();
  private defaultTtlMs: number;
  private watchdogIntervalMs: number;

  constructor(options?: { defaultTtlMs?: number; watchdogIntervalMs?: number }) {
    this.defaultTtlMs = options?.defaultTtlMs ?? 5 * 60 * 1000; // 5 minutes
    this.watchdogIntervalMs = options?.watchdogIntervalMs ?? 30 * 1000; // check every 30s
  }

  async acquireLock(umo: string): Promise<() => void> {
    // Wait for any existing lock to be released.
    while (this.locks.has(umo)) {
      await this.locks.get(umo)!.promise;
    }

    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    const acquiredAt = Date.now();
    const ttlMs = this.defaultTtlMs;

    // Per-lock watchdog: periodically check if the lock has exceeded its
    // TTL and force-release it if so. This handles crashes/forgotten releases.
    const watchdog = setInterval(() => {
      const entry = this.locks.get(umo);
      if (entry && Date.now() - entry.acquiredAt > entry.ttlMs) {
        console.warn(`[SessionLockManager] Lock '${umo}' exceeded TTL (${entry.ttlMs}ms), force-releasing.`);
        this.forceRelease(umo);
      }
    }, this.watchdogIntervalMs);
    // Don't keep the event loop alive just for the watchdog.
    watchdog.unref();

    this.locks.set(umo, { promise, release, acquiredAt, ttlMs, watchdog });

    return () => {
      this.forceRelease(umo);
    };
  }

  private forceRelease(umo: string): void {
    const entry = this.locks.get(umo);
    if (!entry) return;
    clearInterval(entry.watchdog);
    this.locks.delete(umo);
    entry.release();
  }
}
