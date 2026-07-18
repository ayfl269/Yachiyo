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
    // Per-path FIFO fairness.
    //
    // Previously this method iterated the entire waitQueue and granted any
    // request whose lock could be granted, regardless of position. That meant
    // a later-arriving reader for path A could jump ahead of an earlier
    // blocked writer for the same path A, potentially starving the writer
    // indefinitely under heavy read traffic.
    //
    // Now we track paths that have already been "blocked" earlier in the
    // queue: once a waiter for path P cannot be granted, no later waiter
    // for the same path P is granted in this pass either. This guarantees
    // strict per-path FIFO ordering while still allowing unrelated paths to
    // proceed independently.
    const granted: number[] = [];
    const blockedPaths = new Set<string>();

    for (let i = 0; i < this.waitQueue.length; i++) {
      const waiter = this.waitQueue[i];
      if (blockedPaths.has(waiter.path)) {
        // An earlier waiter for this same path is still blocked; do not
        // jump ahead of it.
        continue;
      }
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
      } else {
        // Block all later waiters on the same path from jumping ahead.
        blockedPaths.add(waiter.path);
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

/** Polling interval (ms) used by `waitForAll` to re-check task completion. */
const WAIT_FOR_ALL_POLL_INTERVAL_MS = 100;

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
    this.maxConcurrency = options?.maxConcurrency ?? 5;
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
   *
   * Event-driven: subscribes to the manager's own `task_completed`,
   * `task_failed`, and `task_cancelled` events and resolves as soon as
   * every task is in a terminal state. Falls back to a periodic timeout
   * re-check (every {@link WAIT_FOR_ALL_POLL_INTERVAL_MS}) only when an
   * explicit `timeoutMs` is provided, so the deadline is still honoured
   * even if no events fire (defensive — should not normally happen).
   */
  async waitForAll(timeoutMs?: number): Promise<SubAgentTask[]> {
    const isAllDone = (): boolean => [...this.tasks.values()].every(
      (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled"
    );

    // Fast path: already done (e.g. empty batch or synchronous failures).
    if (isAllDone()) return [...this.tasks.values()];

    const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;

    // Event-driven wait. Each terminal-status event re-checks `isAllDone`.
    // We attach the listener to `task_completed`/`task_failed`/`task_cancelled`
    // rather than `batch_complete` because `batch_complete` is only emitted
    // from `checkBatchComplete` (which itself runs on the same events), and
    // listening to the terminal events directly makes the wait resolve
    // exactly when the last task transitions.
    await new Promise<void>((resolve) => {
      const onTerminal = (): void => {
        if (isAllDone()) {
          this.removeListener("task_completed", onTerminal);
          this.removeListener("task_failed", onTerminal);
          this.removeListener("task_cancelled", onTerminal);
          resolve();
        }
      };
      this.addListener("task_completed", onTerminal);
      this.addListener("task_failed", onTerminal);
      this.addListener("task_cancelled", onTerminal);

      // Defensive deadline timer. When `timeoutMs` is set, also poll on a
      // long interval so the deadline is enforced even if no events fire
      // (e.g. tasks stuck in `running` because the executor died without
      // calling completeTask/failTask). When `timeoutMs` is unset, the
      // timer never fires (`Infinity` deadline + `unref`).
      const checkDeadline = (): void => {
        if (Date.now() >= deadline) {
          this.removeListener("task_completed", onTerminal);
          this.removeListener("task_failed", onTerminal);
          this.removeListener("task_cancelled", onTerminal);
          resolve();
          return;
        }
        // Re-arm the periodic check. Use unref so the timer doesn't keep
        // the event loop alive on its own — it's only a safety net.
        deadlineTimer = setTimeout(checkDeadline, WAIT_FOR_ALL_POLL_INTERVAL_MS);
        if (deadlineTimer && typeof deadlineTimer === "object" && "unref" in deadlineTimer) {
          deadlineTimer.unref();
        }
      };
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs) {
        deadlineTimer = setTimeout(checkDeadline, WAIT_FOR_ALL_POLL_INTERVAL_MS);
        if (deadlineTimer && typeof deadlineTimer === "object" && "unref" in deadlineTimer) {
          deadlineTimer.unref();
        }
      }
    });

    // Timeout: cancel remaining tasks
    const hasTimeout = timeoutMs !== undefined && Date.now() >= deadline;
    if (hasTimeout) {
      for (const task of this.tasks.values()) {
        if (task.status === "pending" || task.status === "running") {
          task.status = "cancelled";
          task.error = "Timed out waiting for batch completion";
          task.completedAt = Date.now();
        }
      }
      this.runningCount = 0;
    }
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
      //
      // Race-condition fix: multiple waiters wake up simultaneously when a
      // single slot is freed, but only one will succeed in startTask().
      // Previously the losers would `return` and their tasks were silently
      // dropped (never executed, never marked failed). We now loop back and
      // re-wait when startTask() returns false, so every submitted task is
      // eventually either run or explicitly failed.
      while (!manager.startTask(taskId)) {
        // If the task was already picked up by another path (e.g. status
        // changed away from "pending"), startTask returns false permanently.
        // Detect that case and bail out to avoid an infinite loop.
        const current = manager.getTask(taskId);
        if (!current || current.status !== "pending") return;

        // Still pending but at capacity — wait for the next slot.
        if (manager.hasCapacity) continue; // retry immediately if a slot opened

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
