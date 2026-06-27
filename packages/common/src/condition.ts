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

      const entry = {
        resolve: () => {
          if (settled) return;
          settled = true;
          if (timerId) clearTimeout(timerId);
          if (onAbort && options?.abortSignal) options.abortSignal.removeEventListener("abort", onAbort);
          resolve();
        },
      };

      if (options?.timeoutMs !== undefined) {
        timerId = setTimeout(() => {
          const idx = this.waiters.indexOf(entry);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error(`Condition.wait timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
      }

      if (options?.abortSignal) {
        onAbort = () => {
          const idx = this.waiters.indexOf(entry);
          if (idx >= 0) this.waiters.splice(idx, 1);
          if (timerId) clearTimeout(timerId);
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
