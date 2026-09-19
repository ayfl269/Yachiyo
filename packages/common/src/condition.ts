export class Condition {
  private waiters: Array<{ resolve: () => void }> = [];

  /**
   * Wait until `notify()` / `notifyAll()` is called.
   *
   * @param options.timeoutMs  If set, the wait rejects with a timeout error
   *                           after this many milliseconds.
   * @param options.abortSignal  If set, the wait is cancelled when the signal
   *                             aborts.
   */
  async wait(options?: { timeoutMs?: number; abortSignal?: AbortSignal }): Promise<void> {
    if (options?.abortSignal?.aborted) {
      throw new Error("Aborted");
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timerId: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;

      // Detach from the waiters list, clear the timer and remove the abort
      // listener exactly once. The timeout/abort paths previously rejected
      // without removing the listener, leaking one listener per timed-out wait
      // on a long-lived AbortSignal.
      const cleanup = (): void => {
        const idx = this.waiters.indexOf(entry);
        if (idx >= 0) this.waiters.splice(idx, 1);
        if (timerId) clearTimeout(timerId);
        if (onAbort && options?.abortSignal) options.abortSignal.removeEventListener("abort", onAbort);
      };

      const entry = {
        resolve: () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        },
      };

      if (options?.timeoutMs !== undefined) {
        timerId = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`Condition.wait timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
      }

      if (options?.abortSignal) {
        onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error("Aborted"));
        };
        options.abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      this.waiters.push(entry);
    });
  }

  notifyAll(): void {
    const waiters = this.waiters.splice(0);
    waiters.forEach(w => w.resolve());
  }

  notify(): void {
    if (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w.resolve();
    }
  }
}
