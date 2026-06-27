export class AsyncQueue<T> {
  private queue: T[] = [];
  private waiters: Array<{ resolve: (value: T) => void; reject: (err: Error) => void; onAbort?: () => void }> = [];

  /**
   * Wait for and dequeue the next item.
   *
   * @param abortSignal When provided, the wait is cancelled if the signal
   *                    aborts. The rejected error has `name === "AbortError"`
   *                    so callers can distinguish cancellation from a real
   *                    failure. This prevents the "lost item" problem where
   *                    a waiter is abandoned but a later `put()` resolves a
   *                    promise nobody is awaiting.
   */
  async get(abortSignal?: AbortSignal): Promise<T> {
    if (this.queue.length > 0) return this.queue.shift()!;

    if (abortSignal?.aborted) {
      throw new Error("Aborted");
    }

    return new Promise<T>((resolve, reject) => {
      const waiter = { resolve, reject, onAbort: undefined as (() => void) | undefined };

      if (abortSignal) {
        const onAbort = () => {
          // Remove this waiter from the queue so a future put() doesn't
          // resolve an abandoned promise.
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error("Aborted"));
        };
        waiter.onAbort = onAbort;
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      this.waiters.push(waiter);
    });
  }

  put(item: T): void {
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.resolve(item);
    } else {
      this.queue.push(item);
    }
  }

  get size(): number {
    return this.queue.length;
  }
}
