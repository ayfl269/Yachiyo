export class Condition {
  private waiters: (() => void)[] = [];

  async wait(): Promise<void> {
    return new Promise<void>(resolve => {
      this.waiters.push(resolve);
    });
  }

  notifyAll(): void {
    const waiters = this.waiters.splice(0);
    waiters.forEach(resolve => resolve());
  }

  notify(): void {
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift()!;
      resolve();
    }
  }
}
