export class SessionLockManager {
  private locks: Map<string, Promise<void>> = new Map();

  async acquireLock(umo: string): Promise<() => void> {
    while (this.locks.has(umo)) {
      await this.locks.get(umo);
    }
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(umo, promise);
    return () => {
      this.locks.delete(umo);
      release();
    };
  }
}
