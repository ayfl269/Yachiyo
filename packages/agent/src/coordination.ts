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

interface Waiter {
  path: string;
  mode: FileLockMode;
  holderId: string;
  resolve: (granted: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Manages file locks across parallel sub-agents.
 * - Multiple readers can hold a read lock simultaneously.
 * - A write lock is exclusive (blocks both reads and writes).
 * - Prevents race conditions when sub-agents access the same files.
 *
 * Data structure: locks and waiters are bucketed by path in Maps, so
 * all per-path operations (canGrant, release, processQueue) are O(k)
 * where k = number of waiters for that path (typically tiny). Global
 * operations like {@link releaseAll} iterate the lock buckets; total
 * work is O(L) where L = number of distinct locked paths (not number
 * of waiters across the whole manager, as in the previous flat-array
 * implementation).
 */
export class FileLockManager {
  /** Locks grouped by path. Each bucket holds all active holders for that path. */
  private locksByPath: Map<string, FileLockEntry[]> = new Map();
  /** Waiters grouped by path. Each bucket is a strict FIFO queue. */
  private waitQueueByPath: Map<string, Waiter[]> = new Map();

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
      this.addLock(path, mode, holderId);
      return true;
    }

    // Otherwise, queue the request
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        // Timeout: remove this waiter from the per-path queue and reject.
        const queue = this.waitQueueByPath.get(path);
        if (queue) {
          const idx = queue.findIndex((w) => w.resolve === resolve);
          if (idx !== -1) {
            queue.splice(idx, 1);
            if (queue.length === 0) {
              this.waitQueueByPath.delete(path);
            }
          }
        }
        resolve(false);
      }, timeoutMs);

      const waiter: Waiter = { path, mode, holderId, resolve, timeout };
      const queue = this.waitQueueByPath.get(path);
      if (queue) {
        queue.push(waiter);
      } else {
        this.waitQueueByPath.set(path, [waiter]);
      }
    });
  }

  /**
   * Release a file lock held by a specific holder.
   *
   * A holder may hold multiple entries for the same path (e.g. a re-entrant
   * read+write pair). `mode` optionally selects which entry to drop so a
   * caller can release a single acquisition instead of all of the holder's
   * entries on that path. When omitted, all of the holder's entries for the
   * path are removed (legacy behaviour, used by `releaseAll`).
   */
  release(path: string, holderId: string, mode?: FileLockMode): void {
    const bucket = this.locksByPath.get(path);
    if (!bucket) return;
    const before = bucket.length;
    let remaining: FileLockEntry[];
    if (mode === undefined) {
      remaining = bucket.filter((l) => l.holderId !== holderId);
    } else {
      // Remove only the FIRST matching (holderId, mode) entry so repeated
      // acquire/release pairs unwind symmetrically.
      let removedOne = false;
      remaining = bucket.filter((l) => {
        if (!removedOne && l.holderId === holderId && l.mode === mode) {
          removedOne = true;
          return false;
        }
        return true;
      });
    }
    if (remaining.length === 0) {
      this.locksByPath.delete(path);
    } else {
      this.locksByPath.set(path, remaining);
    }
    if (remaining.length < before) {
      this.processQueue(path);
    }
  }

  /**
   * Release all locks held by a specific holder (e.g., when a sub-agent finishes).
   */
  releaseAll(holderId: string): void {
    const affectedPaths: string[] = [];
    for (const [path, bucket] of this.locksByPath) {
      const remaining = bucket.filter((l) => l.holderId !== holderId);
      if (remaining.length === 0) {
        this.locksByPath.delete(path);
        affectedPaths.push(path);
      } else if (remaining.length < bucket.length) {
        this.locksByPath.set(path, remaining);
        affectedPaths.push(path);
      }
    }
    // Process queues for each affected path.
    for (const path of affectedPaths) {
      this.processQueue(path);
    }
  }

  /**
   * Clear all locks and resolve all pending waiters with `false` (not
   * granted). Intended for test isolation — the module-level singleton
   * otherwise leaks locks across test runs, causing mysterious deadlocks.
   */
  reset(): void {
    this.locksByPath.clear();
    for (const queue of this.waitQueueByPath.values()) {
      for (const w of queue) {
        clearTimeout(w.timeout);
        w.resolve(false);
      }
    }
    this.waitQueueByPath.clear();
  }

  /**
   * Check if a path is currently locked (by anyone other than the holder).
   */
  isLocked(path: string, holderId?: string): boolean {
    const bucket = this.locksByPath.get(path);
    if (!bucket || bucket.length === 0) return false;
    if (!holderId) return true;
    return bucket.some((l) => l.holderId !== holderId);
  }

  /**
   * Get all locks currently held.
   */
  getLocks(): ReadonlyArray<Readonly<FileLockEntry>> {
    const result: FileLockEntry[] = [];
    for (const bucket of this.locksByPath.values()) {
      result.push(...bucket);
    }
    return result;
  }

  /**
   * Get all locks held by a specific holder.
   */
  getLocksByHolder(holderId: string): ReadonlyArray<Readonly<FileLockEntry>> {
    const result: FileLockEntry[] = [];
    for (const bucket of this.locksByPath.values()) {
      for (const l of bucket) {
        if (l.holderId === holderId) result.push(l);
      }
    }
    return result;
  }

  private addLock(path: string, mode: FileLockMode, holderId: string): void {
    const entry: FileLockEntry = { path, mode, holderId, acquiredAt: Date.now() };
    const bucket = this.locksByPath.get(path);
    if (bucket) {
      bucket.push(entry);
    } else {
      this.locksByPath.set(path, [entry]);
    }
  }

  private canGrant(
    path: string,
    mode: FileLockMode,
    holderId: string,
    options: { ignoreQueue?: boolean } = {}
  ): boolean {
    const existingLocks = this.locksByPath.get(path);
    if (!existingLocks || existingLocks.length === 0) {
      // No existing lock. For a fresh read request, still respect a queued
      // writer (unless we're processing the queue itself, where FIFO order
      // must let the head through): otherwise new readers can perpetually
      // leapfrog a writer that is waiting for readers to drain → starvation.
      if (mode === "read" && !options.ignoreQueue) {
        const queue = this.waitQueueByPath.get(path);
        if (queue && queue.some((w) => w.mode === "write")) {
          return false;
        }
      }
      return true;
    }

    // Same holder can always re-acquire
    if (existingLocks.every((l) => l.holderId === holderId)) return true;

    if (mode === "read") {
      // Read lock: allowed if all existing locks are also read locks. If a
      // writer is queued, block new readers so the writer isn't starved.
      if (!options.ignoreQueue) {
        const queue = this.waitQueueByPath.get(path);
        if (queue && queue.some((w) => w.mode === "write")) {
          return false;
        }
      }
      return existingLocks.every((l) => l.mode === "read");
    }

    // Write lock: exclusive, no other holders allowed
    return false;
  }

  /**
   * Process the wait queue for a single path.
   *
   * Per-path FIFO fairness: walk the queue front-to-back, granting
   * requests whose lock can now be acquired. As soon as a waiter
   * cannot be granted, stop processing further waiters for the same
   * path — they must wait for the head to be granted or removed.
   *
   * This is O(k) where k = number of waiters for this path, since we
   * only touch the per-path bucket (not the whole global queue as in
   * the previous flat-array implementation).
   */
  private processQueue(path: string): void {
    const queue = this.waitQueueByPath.get(path);
    if (!queue || queue.length === 0) return;

    const grantedIdx: number[] = [];
    for (let i = 0; i < queue.length; i++) {
      const waiter = queue[i];
      // ignoreQueue: the queue is already strict FIFO; the head must not be
      // blocked by a writer that is *behind* it (that would deadlock the
      // queue). New external readers are still gated by canGrant's queue
      // check in `acquire`.
      if (this.canGrant(path, waiter.mode, waiter.holderId, { ignoreQueue: true })) {
        this.addLock(path, waiter.mode, waiter.holderId);
        clearTimeout(waiter.timeout);
        waiter.resolve(true);
        grantedIdx.push(i);
      } else {
        // Strict FIFO: once a waiter is blocked, all later waiters
        // for the same path must wait too. Stop processing.
        break;
      }
    }

    if (grantedIdx.length === 0) return;
    // Remove granted entries (reverse order to preserve indices).
    for (let i = grantedIdx.length - 1; i >= 0; i--) {
      queue.splice(grantedIdx[i], 1);
    }
    if (queue.length === 0) {
      this.waitQueueByPath.delete(path);
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

  /**
   * Maximum number of terminal (completed/failed/cancelled) task
   * entries to retain in the tasks map for late lookups. Once exceeded,
   * oldest terminal entries are evicted FIFO. Pending and running
   * tasks are never evicted. Default: 500.
   */
  maxRetainedTasks?: number;

  /**
   * Time-to-live for terminal task entries in milliseconds. Entries
   * older than this are eligible for eviction on the next sweep.
   * Default: 10 minutes. Set to 0 to disable time-based eviction
   * (count-based eviction via {@link maxRetainedTasks} still applies).
   */
  terminalTaskTtlMs?: number;
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
  /**
   * Maximum number of completed/failed/cancelled task entries to retain
   * in {@link tasks} for late {@link getTask} / {@link waitForAll} lookups.
   * Once exceeded, oldest terminal entries are evicted (FIFO). Pending
   * and running tasks are never evicted.
   *
   * Default 500 — generous enough for typical fan-out workloads, bounded
   * enough that a long-lived manager doesn't leak memory if callers
   * submit tasks without polling results.
   */
  private maxRetainedTasks: number;
  /**
   * Total number of terminal tasks evicted since startup. Exposed via
   * the public {@link evictedTaskCount} getter for metrics.
   */
  private _evictedTaskCount: number = 0;
  /**
   * TTL for terminal task entries in milliseconds. Entries older than
   * this are eligible for eviction during {@link pruneTerminalTasks}
   * sweeps (called on every {@link submit}). Default 10 minutes — long
   * enough for late {@link waitForAll} callers, short enough to bound
   * memory in long runs. Set to 0 to disable time-based eviction.
   */
  private terminalTaskTtlMs: number;
  /** Timestamp of the last {@link pruneTerminalTasks} sweep. Used to rate-limit sweeps to one per second. */
  private lastPruneAt: number = 0;

  constructor(options?: SubAgentTaskOptions) {
    super();
    // Each queued task attaches up to 3 listeners (completed/failed/cancelled)
    // while waiting for a slot, so with the default concurrency of 8 the
    // per-batch listener count can exceed EventEmitter's default limit of 10
    // and emit a spurious MaxListenersExceededWarning. Size the cap to the
    // concurrency (plus headroom for external subscribers).
    this.setMaxListeners(Math.max(50, (options?.maxConcurrency ?? 8) * 4));
    this.maxConcurrency = options?.maxConcurrency ?? 8;
    this.defaultTimeoutSeconds = options?.defaultTimeoutSeconds ?? 120;
    this.onTaskComplete = options?.onTaskComplete;
    this.onTaskFailed = options?.onTaskFailed;
    this.onBatchComplete = options?.onBatchComplete;
    this.maxRetainedTasks = options?.maxRetainedTasks ?? 500;
    this.terminalTaskTtlMs = options?.terminalTaskTtlMs ?? 10 * 60 * 1000;
  }

  /**
   * Number of terminal task entries evicted since startup. Useful for
   * metrics: a non-zero count indicates callers are submitting tasks
   * without consuming results, which may indicate a leak in caller
   * code (not in this manager).
   */
  get evictedTaskCount(): number {
    return this._evictedTaskCount;
  }

  /**
   * Remove terminal task entries (completed/failed/cancelled) that are
   * either older than {@link terminalTaskTtlMs} or exceed the
   * {@link maxRetainedTasks} cap. Pending and running tasks are never
   * removed. Sweeps are rate-limited to one per second to amortize
   * cost — callers may invoke freely on every {@link submit}.
   *
   * Returns the number of entries removed.
   */
  private pruneTerminalTasks(): number {
    const now = Date.now();
    // Rate-limit: at most one sweep per second.
    if (now - this.lastPruneAt < 1000) return 0;
    this.lastPruneAt = now;

    let removed = 0;
    // Pass 1: time-based eviction.
    if (this.terminalTaskTtlMs > 0) {
      for (const [id, task] of this.tasks) {
        const isTerminal = task.status === "completed" || task.status === "failed" || task.status === "cancelled";
        if (!isTerminal) continue;
        const settledAt = task.completedAt ?? 0;
        if (settledAt > 0 && now - settledAt > this.terminalTaskTtlMs) {
          this.tasks.delete(id);
          removed++;
        }
      }
    }
    // Pass 2: count-based eviction (FIFO by settle time).
    const terminalEntries: Array<[string, SubAgentTask]> = [];
    for (const [id, task] of this.tasks) {
      const isTerminal = task.status === "completed" || task.status === "failed" || task.status === "cancelled";
      if (isTerminal) terminalEntries.push([id, task]);
    }
    if (terminalEntries.length > this.maxRetainedTasks) {
      terminalEntries.sort((a, b) => (a[1].completedAt ?? 0) - (b[1].completedAt ?? 0));
      const evictCount = terminalEntries.length - this.maxRetainedTasks;
      for (let i = 0; i < evictCount; i++) {
        this.tasks.delete(terminalEntries[i][0]);
        removed++;
      }
    }
    this._evictedTaskCount += removed;
    return removed;
  }

  /**
   * Submit a task for execution.
   * Returns the task ID.
   */
  submit(agentName: string, input: string): string {
    // Opportunistic cleanup of terminal task entries. Rate-limited
    // internally to one sweep per second; safe to call on every submit.
    this.pruneTerminalTasks();

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
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      // Tear down listeners + the deadline timer exactly once, whether the
      // wait resolves via terminal event or via deadline. Previously the
      // event-driven path left the timer re-arming every 100ms until the
      // full deadline.
      const settle = (): void => {
        this.removeListener("task_completed", onTerminal);
        this.removeListener("task_failed", onTerminal);
        this.removeListener("task_cancelled", onTerminal);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        resolve();
      };
      const onTerminal = (): void => {
        if (isAllDone()) settle();
      };
      this.addListener("task_completed", onTerminal);
      this.addListener("task_failed", onTerminal);
      this.addListener("task_cancelled", onTerminal);

      // Defensive deadline timer. When `timeoutMs` is set, also poll on a
      // long interval so the deadline is enforced even if no events fire
      // (e.g. tasks stuck in `running` because the executor died without
      // calling completeTask/failTask). The timer is deliberately REF'd: a
      // caller passing an explicit timeout expects to wait up to that long,
      // and if this were unref'd the process could exit (or the promise never
      // resolve) when nothing else keeps the event loop alive. When
      // `timeoutMs` is unset, no timer is created (Infinity deadline).
      const checkDeadline = (): void => {
        if (Date.now() >= deadline) {
          settle();
          return;
        }
        deadlineTimer = setTimeout(checkDeadline, WAIT_FOR_ALL_POLL_INTERVAL_MS);
      };
      if (timeoutMs) {
        deadlineTimer = setTimeout(checkDeadline, WAIT_FOR_ALL_POLL_INTERVAL_MS);
      }
    });

    // Timeout: cancel remaining tasks.
    //
    // Previously this mutated status silently: no `task_cancelled` event was
    // emitted, so any concurrent event-driven `waitForAll` (one without a
    // timeout) never woke up and hung forever; and `checkBatchComplete` was
    // never called, so `onBatchComplete` / `batch_complete` never fired for a
    // timed-out batch (inconsistent with the normal completion path).
    const hasTimeout = timeoutMs !== undefined && Date.now() >= deadline;
    if (hasTimeout) {
      const cancelledNow: SubAgentTask[] = [];
      for (const task of this.tasks.values()) {
        if (task.status === "pending" || task.status === "running") {
          const wasRunning = task.status === "running";
          task.status = "cancelled";
          task.error = "Timed out waiting for batch completion";
          task.completedAt = Date.now();
          // Decrement per running task instead of zeroing the whole counter,
          // so tasks that already completed normally are not miscounted and
          // concurrent accounting stays consistent.
          if (wasRunning) this.runningCount--;
          cancelledNow.push(task);
        }
      }
      for (const task of cancelledNow) {
        this.emit("task_cancelled", task);
      }
      if (cancelledNow.length > 0) {
        this.checkBatchComplete();
      }
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

/**
 * Race a promise against a timeout. On timeout the returned promise rejects
 * with an Error built from `timeoutMessage`. The timeout timer is unref'd so
 * it never keeps the process alive on its own.
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: () => string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    // Deliberately ref'd: this timer is the only thing that can settle the
    // race when the wrapped promise never does, so unref'ing it would let the
    // process exit before the timeout fires. It is cleared as soon as the
    // promise settles, so it never outlives the operation.
    const timer = setTimeout(() => reject(new Error(timeoutMessage())), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
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

  // Per-task timeout budget. `defaultTimeoutSeconds` was previously stored
  // but never used, so a single executor that never settles would hang
  // `Promise.all` below forever (task stuck in "running"). Default 120s.
  const timeoutSeconds = options?.defaultTimeoutSeconds ?? 120;

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

        // Still pending and at capacity — wait for the next slot. (The
        // previous `if (manager.hasCapacity) continue;` was unreachable:
        // startTask only returns false for a pending task when the manager is
        // at capacity, so hasCapacity was always false here.)
        await new Promise<void>((resolve) => {
          // Also listen for task_cancelled: a cancelled running task frees a
          // slot without emitting completed/failed, so without this a waiter
          // would never wake.
          const onSlotFree = (): void => {
            manager.removeListener("task_completed", onSlotFree);
            manager.removeListener("task_failed", onSlotFree);
            manager.removeListener("task_cancelled", onSlotFree);
            resolve();
          };
          manager.addListener("task_completed", onSlotFree);
          manager.addListener("task_failed", onSlotFree);
          manager.addListener("task_cancelled", onSlotFree);
        });
      }

      try {
        const result = await withTimeout(
          executor(task.agentName, task.input),
          timeoutSeconds * 1000,
          () => `Task '${task.agentName}' timed out after ${timeoutSeconds}s`,
        );
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
