/**
 * Session lock manager with TTL and watchdog.
 *
 * Locks auto-expire after `defaultTtlMs` (default 5 minutes) to prevent
 * permanently stuck sessions when the holder crashes or forgets to call
 * `release()`. A watchdog timer checks for expired locks periodically.
 *
 * Holders of long-running operations (e.g. LLM streaming, multi-step tool
 * execution) should call `renewLock(umo, token)` periodically to push the
 * TTL forward. Without renewal, the watchdog will force-release the lock
 * while the holder is still active, allowing a second consumer to acquire
 * it and causing concurrent writes to the same session.
 *
 * Release identity: every acquired lock carries a unique token. The release
 * closure only deletes the map entry if the token still matches. Without
 * this, a stale holder whose lock expired (watchdog force-release) and was
 * re-acquired by consumer B would — on its own `finally { release() }` —
 * delete B's lock and let consumer C in, producing exactly the concurrent
 * session access the lock exists to prevent.
 */
/**
 * Release handle returned by {@link SessionLockManager.acquireLock}.
 * Callable (releases the lock, identity-bound) and exposes `renew()` which
 * extends only THIS acquisition's TTL — a stale holder cannot extend a lock
 * that expired and was re-acquired by someone else.
 */
export interface SessionLockHandle {
  (): void;
  renew(): boolean;
}

export class SessionLockManager {
  private locks: Map<string, {
    promise: Promise<void>;
    release: () => void;
    acquiredAt: number;
    ttlMs: number;
    watchdog: ReturnType<typeof setInterval>;
    /** Unique per-acquisition identity used to validate release calls. */
    token: object;
  }> = new Map();
  private defaultTtlMs: number;
  private watchdogIntervalMs: number;

  constructor(options?: { defaultTtlMs?: number; watchdogIntervalMs?: number }) {
    this.defaultTtlMs = options?.defaultTtlMs ?? 5 * 60 * 1000; // 5 minutes
    this.watchdogIntervalMs = options?.watchdogIntervalMs ?? 30 * 1000; // check every 30s
  }

  async acquireLock(umo: string): Promise<SessionLockHandle> {
    // Wait for any existing lock to be released.
    while (this.locks.has(umo)) {
      await this.locks.get(umo)!.promise;
    }

    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    const acquiredAt = Date.now();
    const ttlMs = this.defaultTtlMs;
    const token: object = {};

    // Per-lock watchdog: periodically check if the lock has exceeded its
    // TTL and force-release it if so. This handles crashes/forgotten releases.
    // The token check ensures the watchdog only forces out the acquisition
    // it was created for (defensive — the entry is cleared in forceRelease).
    const watchdog = setInterval(() => {
      const entry = this.locks.get(umo);
      if (entry && entry.token === token && Date.now() - entry.acquiredAt > entry.ttlMs) {
        console.warn(`[SessionLockManager] Lock '${umo}' exceeded TTL (${entry.ttlMs}ms), force-releasing.`);
        this.forceRelease(umo, token);
      }
    }, this.watchdogIntervalMs);
    // Don't keep the event loop alive just for the watchdog.
    watchdog.unref();

    this.locks.set(umo, { promise, release, acquiredAt, ttlMs, watchdog, token });

    // Identity-bound release: only removes the entry if this acquisition
    // still owns the lock. A stale holder's release is a no-op (its own
    // lock was already force-released and possibly re-acquired by someone
    // else — deleting the new holder's entry here would be catastrophic).
    const handle = (() => {
      this.forceRelease(umo, token);
    }) as SessionLockHandle;
    // Identity-bound renew: only extends the TTL when this acquisition still
    // owns the lock. Without the token check a stale holder could renew the
    // NEW holder's lock indefinitely, defeating the watchdog.
    handle.renew = () => this.renewLock(umo, token);
    return handle;
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
   * lock exists for the given `umo` (already released or never acquired) or
   * if `token` is supplied and does not match the current holder.
   *
   * Prefer `handle.renew()` from {@link acquireLock}; passing a token here
   * ensures a stale holder cannot extend a lock it no longer owns.
   */
  renewLock(umo: string, token?: object): boolean {
    const entry = this.locks.get(umo);
    if (!entry) return false;
    if (token !== undefined && entry.token !== token) return false;
    entry.acquiredAt = Date.now();
    return true;
  }

  /**
   * Release the lock for `umo` — but only if it is still owned by the
   * acquisition identified by `token`. A mismatch means the original lock
   * expired (watchdog force-release) and was re-acquired by another
   * consumer; the stale release must NOT delete the new holder's entry.
   */
  private forceRelease(umo: string, token?: object): void {
    const entry = this.locks.get(umo);
    if (!entry) return;
    if (token !== undefined && entry.token !== token) {
      console.warn(
        `[SessionLockManager] Stale release for '${umo}' ignored ` +
        `(lock expired and was re-acquired by another consumer).`,
      );
      return;
    }
    clearInterval(entry.watchdog);
    this.locks.delete(umo);
    entry.release();
  }
}
