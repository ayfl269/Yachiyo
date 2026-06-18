export class AsyncQueue<T> {
  private queue: T[] = [];
  private waiters: ((value: T) => void)[] = [];

  async get(): Promise<T> {
    if (this.queue.length > 0) return this.queue.shift()!;
    return new Promise<T>(resolve => this.waiters.push(resolve));
  }

  put(item: T): void {
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift()!;
      resolve(item);
    } else {
      this.queue.push(item);
    }
  }

  get size(): number {
    return this.queue.length;
  }
}
