/**
 * Coordination layer for parallel sub-agent execution.
 * Provides file locks, task queue, and result merging.
 */

import { EventEmitter } from "events";

// ── File Lock Manager ──

export type FileLockMode = "read" | "write";

interface FileLockEntry {
  path: string;
  mode: FileLockMode;
  holderId: string; // sub-agent name
  acquiredAt: number;
}

/**
 * Manages file locks across parallel sub-agents.
 * - Multiple readers can hold a read lock simultaneously.
 * - A write lock is exclusive (blocks both reads and writes).
 * - Prevents race conditions when sub-agents access the same files.
 */
export class FileLockManager {
  private locks: FileLockEntry[] = [];
  private waitQueue: Array<{
    path: string;
    mode: FileLockMode;
    holderId: string;
    resolve: (granted: boolean) => void;
    timeout: NodeJS.Timeout;
  }> = [];

  /**
   * Try to acquire a file lock.
   * Returns true if the lock was granted immediately, false if queued.
   */
  async acquire(
    path: string,
    mode: FileLockMode,
    holderId: string,
    timeoutMs: number = 30000
  ): Promise<boolean> {
    // Check if lock can be granted immediately
    if (this.canGrant(path, mode, holderId)) {
      this.locks.push({ path, mode, holderId, acquiredAt: Date.now() });
      return true;
    }

    // Otherwise, queue the request
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        // Timeout: remove from queue and reject
        const idx = this.waitQueue.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.waitQueue.splice(idx, 1);
        resolve(false);
      }, timeoutMs);

      this.waitQueue.push({ path, mode, holderId, resolve, timeout });
    });
  }

  /**
   * Release a file lock held by a specific holder.
   */
  release(path: string, holderId: string): void {
    const before = this.locks.length;
    this.locks = this.locks.filter(
      (l) => !(l.path === path && l.holderId === holderId)
    );

    if (this.locks.length < before) {
      // Try to grant queued requests
      this.processQueue();
    }
  }

  /**
   * Release all locks held by a specific holder (e.g., when a sub-agent finishes).
   */
  releaseAll(holderId: string): void {
    this.locks = this.locks.filter((l) => l.holderId !== holderId);
    this.processQueue();
  }

  /**
   * Clear all locks and resolve all pending waiters with `false` (not
   * granted). Intended for test isolation — the module-level singleton
   * otherwise leaks locks across test runs, causing mysterious deadlocks.
   */
  reset(): void {
    this.locks = [];
    const queue = this.waitQueue.splice(0);
    queue.forEach((w) => {
      clearTimeout(w.timeout);
      w.resolve(false);
    });
  }

  /**
   * Check if a path is currently locked (by anyone other than the holder).
   */
  isLocked(path: string, holderId?: string): boolean {
    return this.locks.some(
      (l) => l.path === path && (!holderId || l.holderId !== holderId)
    );
  }

  /**
   * Get all locks currently held.
   */
  getLocks(): ReadonlyArray<Readonly<FileLockEntry>> {
    return [...this.locks];
  }

  /**
   * Get all locks held by a specific holder.
   */
  getLocksByHolder(holderId: string): ReadonlyArray<Readonly<FileLockEntry>> {
    return this.locks.filter((l) => l.holderId === holderId);
  }

  private canGrant(path: string, mode: FileLockMode, holderId: string): boolean {
    const existingLocks = this.locks.filter((l) => l.path === path);

    if (existingLocks.length === 0) return true;

    // Same holder can always re-acquire
    if (existingLocks.every((l) => l.holderId === holderId)) return true;

    if (mode === "read") {
      // Read lock: allowed if all existing locks are also read locks
      return existingLocks.every((l) => l.mode === "read");
    }

    // Write lock: exclusive, no other holders allowed
    return false;
  }

  private processQueue(): void {
    const granted: number[] = [];

    for (let i = 0; i < this.waitQueue.length; i++) {
      const waiter = this.waitQueue[i];
      if (this.canGrant(waiter.path, waiter.mode, waiter.holderId)) {
        this.locks.push({
          path: waiter.path,
          mode: waiter.mode,
          holderId: waiter.holderId,
          acquiredAt: Date.now(),
        });
        clearTimeout(waiter.timeout);
        waiter.resolve(true);
        granted.push(i);
      }
    }

    // Remove granted entries from queue (reverse order to preserve indices)
    for (let i = granted.length - 1; i >= 0; i--) {
      this.waitQueue.splice(granted[i], 1);
    }
  }
}

/** Global file lock manager singleton. */
export const fileLockManager = new FileLockManager();

/**
 * Reset the global file lock manager. Call in test setup/teardown to
 * prevent lock state from leaking between test runs.
 */
export function resetFileLockManager(): void {
  fileLockManager.reset();
}

// ── Parallel Sub-Agent Task Manager ──

export interface SubAgentTask {
  id: string;
  agentName: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  input: string;
  result?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface SubAgentTaskOptions {
  /** Maximum number of concurrent sub-agents. Default: 3. */
  maxConcurrency?: number;

  /** Default timeout per task in seconds. Default: 120. */
  defaultTimeoutSeconds?: number;

  /** Callback when a task completes. */
  onTaskComplete?: (task: SubAgentTask) => void;

  /** Callback when a task fails. */
  onTaskFailed?: (task: SubAgentTask) => void;

  /** Callback when all tasks in a batch are done. */
  onBatchComplete?: (tasks: SubAgentTask[]) => void;
}

/**
 * Manages parallel execution of sub-agent tasks.
 * Provides concurrency control, timeout management, and result collection.
 */
export class SubAgentTaskManager extends EventEmitter {
  private tasks: Map<string, SubAgentTask> = new Map();
  private runningCount: number = 0;
  private maxConcurrency: number;
  private defaultTimeoutSeconds: number;
  private onTaskComplete?: (task: SubAgentTask) => void;
  private onTaskFailed?: (task: SubAgentTask) => void;
  private onBatchComplete?: (tasks: SubAgentTask[]) => void;

  constructor(options?: SubAgentTaskOptions) {
    super();
    this.maxConcurrency = options?.maxConcurrency ?? 3;
    this.defaultTimeoutSeconds = options?.defaultTimeoutSeconds ?? 120;
    this.onTaskComplete = options?.onTaskComplete;
    this.onTaskFailed = options?.onTaskFailed;
    this.onBatchComplete = options?.onBatchComplete;
  }

  /**
   * Submit a task for execution.
   * Returns the task ID.
   */
  submit(agentName: string, input: string): string {
    const id = crypto.randomUUID();
    const task: SubAgentTask = {
      id,
      agentName,
      status: "pending",
      input,
    };
    this.tasks.set(id, task);
    this.emit("task_submitted", task);
    return id;
  }

  /**
   * Mark a task as running.
   */
  startTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "pending") return false;

    if (this.runningCount >= this.maxConcurrency) {
      return false; // At capacity
    }

    task.status = "running";
    task.startedAt = Date.now();
    this.runningCount++;
    this.emit("task_started", task);
    return true;
  }

  /**
   * Mark a task as completed with a result.
   */
  completeTask(taskId: string, result: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "running") return;

    task.status = "completed";
    task.result = result;
    task.completedAt = Date.now();
    this.runningCount--;

    this.onTaskComplete?.(task);
    this.emit("task_completed", task);
    this.checkBatchComplete();
  }

  /**
   * Mark a task as failed with an error.
   */
  failTask(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "running") return;

    task.status = "failed";
    task.error = error;
    task.completedAt = Date.now();
    this.runningCount--;

    this.onTaskFailed?.(task);
    this.emit("task_failed", task);
    this.checkBatchComplete();
  }

  /**
   * Cancel a pending task.
   */
  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || (task.status !== "pending" && task.status !== "running")) return false;

    const wasRunning = task.status === "running";
    task.status = "cancelled";
    task.completedAt = Date.now();
    if (wasRunning) {
      this.runningCount--;
    }

    this.emit("task_cancelled", task);
    return true;
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): SubAgentTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks.
   */
  getAllTasks(): SubAgentTask[] {
    return [...this.tasks.values()];
  }

  /**
   * Get tasks by status.
   */
  getTasksByStatus(status: SubAgentTask["status"]): SubAgentTask[] {
    return [...this.tasks.values()].filter((t) => t.status === status);
  }

  /**
   * Check if more tasks can be started.
   */
  get hasCapacity(): boolean {
    return this.runningCount < this.maxConcurrency;
  }

  /**
   * Get the number of currently running tasks.
   */
  get runningTaskCount(): number {
    return this.runningCount;
  }

  /**
   * Wait for all tasks to complete (pending + running).
   * Returns all tasks once all are in a terminal state.
   */
  async waitForAll(timeoutMs?: number): Promise<SubAgentTask[]> {
    const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;

    while (Date.now() < deadline) {
      const allDone = [...this.tasks.values()].every(
        (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled"
      );
      if (allDone) return [...this.tasks.values()];

      await new Promise((r) => setTimeout(r, 100));
    }

    // Timeout: cancel remaining tasks
    for (const task of this.tasks.values()) {
      if (task.status === "pending" || task.status === "running") {
        task.status = "cancelled";
        task.error = "Timed out waiting for batch completion";
        task.completedAt = Date.now();
      }
    }
    this.runningCount = 0;
    return [...this.tasks.values()];
  }

  /**
   * Merge results from completed tasks into a single summary.
   */
  mergeResults(tasks?: SubAgentTask[]): string {
    const targetTasks = tasks ?? [...this.tasks.values()];
    const completed = targetTasks.filter((t) => t.status === "completed");

    if (completed.length === 0) {
      const failed = targetTasks.filter((t) => t.status === "failed");
      if (failed.length > 0) {
        return `All tasks failed. Errors:\n${failed.map((t) => `- ${t.agentName}: ${t.error}`).join("\n")}`;
      }
      return "No tasks completed.";
    }

    const parts = completed.map((t) => {
      const duration = t.completedAt && t.startedAt
        ? ` (${((t.completedAt - t.startedAt) / 1000).toFixed(1)}s)`
        : "";
      return `**${t.agentName}**${duration}:\n${t.result ?? "(no result)"}`;
    });

    // Include failed tasks summary
    const failed = targetTasks.filter((t) => t.status === "failed");
    if (failed.length > 0) {
      parts.push(
        `\nFailed tasks (${failed.length}):\n` +
        failed.map((t) => `- ${t.agentName}: ${t.error}`).join("\n")
      );
    }

    return parts.join("\n\n");
  }

  /**
   * Clear all tasks (for cleanup between batches).
   */
  clear(): void {
    this.tasks.clear();
    this.runningCount = 0;
  }

  private checkBatchComplete(): void {
    const allDone = [...this.tasks.values()].every(
      (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled"
    );
    if (allDone && this.tasks.size > 0) {
      const tasks = [...this.tasks.values()];
      this.onBatchComplete?.(tasks);
      this.emit("batch_complete", tasks);
    }
  }
}

// ── Convenience: Create a managed parallel execution ──

/**
 * Execute multiple sub-agent tasks in parallel with concurrency control.
 *
 * @param tasks - Array of { agentName, input } objects
 * @param executor - Function that executes a single sub-agent task
 * @param options - Concurrency and timeout options
 * @returns Array of completed SubAgentTasks
 */
export async function executeParallelSubAgents(
  tasks: Array<{ agentName: string; input: string }>,
  executor: (agentName: string, input: string) => Promise<string>,
  options?: SubAgentTaskOptions
): Promise<SubAgentTask[]> {
  const manager = new SubAgentTaskManager(options);

  // Submit all tasks
  const taskIds = tasks.map((t) => manager.submit(t.agentName, t.input));

  // Execute with concurrency control
  const executionPromises: Promise<void>[] = [];

  for (const taskId of taskIds) {
    const task = manager.getTask(taskId)!;

    const executeWhenReady = async (): Promise<void> => {
      // Wait for capacity using event-driven notification instead of
      // 50ms busy-wait polling. The manager emits "task_completed" and
      // "task_failed" when a slot frees up.
      while (!manager.hasCapacity) {
        await new Promise<void>((resolve) => {
          const onSlotFree = (): void => {
            manager.removeListener("task_completed", onSlotFree);
            manager.removeListener("task_failed", onSlotFree);
            resolve();
          };
          manager.addListener("task_completed", onSlotFree);
          manager.addListener("task_failed", onSlotFree);
        });
      }

      if (!manager.startTask(taskId)) return;

      try {
        const result = await executor(task.agentName, task.input);
        manager.completeTask(taskId, result);
      } catch (e) {
        manager.failTask(taskId, (e as Error).message ?? String(e));
      } finally {
        // Release file locks held by this sub-agent
        fileLockManager.releaseAll(task.agentName);
      }
    };

    executionPromises.push(executeWhenReady());
  }

  await Promise.all(executionPromises);
  return manager.getAllTasks();
}
