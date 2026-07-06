/**
 * Session lock manager with TTL and watchdog.
 *
 * Locks auto-expire after `defaultTtlMs` (default 5 minutes) to prevent
 * permanently stuck sessions when the holder crashes or forgets to call
 * `release()`. A watchdog timer checks for expired locks periodically.
 *
 * Holders of long-running operations (e.g. LLM streaming, multi-step tool
 * execution) should call `renewLock(umo)` periodically to push the TTL
 * forward. Without renewal, the watchdog will force-release the lock while
 * the holder is still active, allowing a second consumer to acquire it and
 * causing concurrent writes to the same session.
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

  /**
   * Renew (extend) the TTL of a currently held lock.
   *
   * This resets `acquiredAt` to the current time so the watchdog does not
   * force-release the lock while the holder is still actively working.
   * Long-running operations (LLM streaming, multi-step tool execution)
   * should call this periodically — e.g. once per agent step or every
   * 30 seconds — to prevent the lock from expiring mid-operation.
   *
   * Returns `true` if the lock was successfully renewed, `false` if no
   * lock exists for the given `umo` (already released or never acquired).
   */
  renewLock(umo: string): boolean {
    const entry = this.locks.get(umo);
    if (!entry) return false;
    entry.acquiredAt = Date.now();
    return true;
  }

  private forceRelease(umo: string): void {
    const entry = this.locks.get(umo);
    if (!entry) return;
    clearInterval(entry.watchdog);
    this.locks.delete(umo);
    entry.release();
  }
}
