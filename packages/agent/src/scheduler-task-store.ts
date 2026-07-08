/**
 * SQLite-backed scheduled task store.
 *
 * Supports five task kinds:
 * - reminder:   one-shot reminder that fires at a specific time
 * - scheduled:  one-shot scheduled task that fires at a specific time
 * - recurring:  recurring task that fires on an interval (e.g. "1h", "daily")
 * - goal:       current task goal tracking (no auto-fire; informational)
 * - plan:       multi-step execution plan with step statuses
 *
 * Each task optionally records the session context (unifiedMsgOrigin,
 * sessionId, platformId) so the TaskScheduler can route a fired event back
 * to the originating conversation.
 */

import type Database from "better-sqlite3";
import { escapeLike, type Migration } from "@yachiyo/common/database.js";

// ── Types ──

export type TaskType = "reminder" | "scheduled" | "recurring" | "goal" | "plan";
export type TaskStatus = "pending" | "active" | "completed" | "cancelled" | "failed";
export type StepStatus = "pending" | "in_progress" | "completed" | "skipped";

export interface PlanStep {
  description: string;
  status: StepStatus;
}

export interface SchedulerTask {
  id: string;
  type: TaskType;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  /** ISO timestamp when the task should fire (null for goals/plans). */
  scheduledAt: string | null;
  /** Recurrence pattern: "1h", "30m", "daily", "weekly", or null. */
  recurrence: string | null;
  /** Current task goal text (for goal/plan tasks). */
  goal: string | null;
  /** JSON-encoded array of PlanStep objects (for plan tasks). */
  plan: PlanStep[];
  /** Index of the current step in the plan (0-based, -1 = not started). */
  currentStep: number;
  /** Tags for categorization. */
  tags: string[];
  /** Session routing: unified message origin. */
  umo: string | null;
  /** Session routing: session id. */
  sessionId: string | null;
  /** Session routing: platform id. */
  platformId: string | null;
  /** Payload/message to deliver when the task fires. */
  payload: string | null;
  /** ISO timestamp of the last time the task fired. */
  lastFiredAt: string | null;
  /** ISO timestamp of the next time the task should fire. */
  nextFireAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulerStats {
  total: number;
  byType: Record<TaskType, number>;
  byStatus: Record<TaskStatus, number>;
}

// ── Migrations ──

export const SCHEDULER_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "scheduler_initial",
    up: `
      CREATE TABLE IF NOT EXISTS scheduler_tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'reminder',
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 0,
        scheduled_at TEXT,
        recurrence TEXT,
        goal TEXT,
        plan TEXT NOT NULL DEFAULT '[]',
        current_step INTEGER NOT NULL DEFAULT -1,
        umo TEXT,
        session_id TEXT,
        platform_id TEXT,
        payload TEXT,
        last_fired_at TEXT,
        next_fire_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scheduler_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES scheduler_tasks(id) ON DELETE CASCADE,
        UNIQUE(task_id, tag)
      );

      CREATE INDEX IF NOT EXISTS idx_scheduler_status ON scheduler_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_scheduler_type ON scheduler_tasks(type);
      CREATE INDEX IF NOT EXISTS idx_scheduler_next_fire ON scheduler_tasks(next_fire_at) WHERE next_fire_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_scheduler_umo ON scheduler_tasks(umo) WHERE umo IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_scheduler_tags_tag ON scheduler_tags(tag);
      CREATE INDEX IF NOT EXISTS idx_scheduler_tags_task ON scheduler_tags(task_id);
    `,
  },
];

// ── Row Types ──

interface SchedulerTaskRow {
  id: string;
  type: TaskType;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  scheduled_at: string | null;
  recurrence: string | null;
  goal: string | null;
  plan: string;
  current_step: number;
  umo: string | null;
  session_id: string | null;
  platform_id: string | null;
  payload: string | null;
  last_fired_at: string | null;
  next_fire_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SchedulerTagRow {
  tag: string;
}

interface SchedulerIdRow {
  id: string;
}

interface CountRow {
  cnt: number;
}

// ── SqliteSchedulerTaskStore ──

export class SqliteSchedulerTaskStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ── Core CRUD ──

  save(task: Omit<SchedulerTask, "createdAt" | "updatedAt"> & {
    createdAt?: string; updatedAt?: string;
  }): void {
    const now = new Date().toISOString();
    const createdAt = task.createdAt ?? now;
    const updatedAt = task.updatedAt ?? now;

    this.db.transaction(() => {
      const existing = this.db.prepare(
        "SELECT created_at FROM scheduler_tasks WHERE id = ?"
      ).get(task.id) as { created_at: string } | undefined;
      const finalCreatedAt = existing?.created_at ?? createdAt;

      this.db.prepare(`
        INSERT OR REPLACE INTO scheduler_tasks
        (id, type, title, description, status, priority, scheduled_at, recurrence,
         goal, plan, current_step, umo, session_id, platform_id, payload,
         last_fired_at, next_fire_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id, task.type, task.title, task.description, task.status, task.priority,
        task.scheduledAt, task.recurrence, task.goal, JSON.stringify(task.plan),
        task.currentStep, task.umo, task.sessionId, task.platformId, task.payload,
        task.lastFiredAt, task.nextFireAt, finalCreatedAt, updatedAt,
      );

      if (task.tags !== undefined) {
        this.db.prepare("DELETE FROM scheduler_tags WHERE task_id = ?").run(task.id);
        const insertTag = this.db.prepare(
          "INSERT OR IGNORE INTO scheduler_tags (task_id, tag) VALUES (?, ?)"
        );
        for (const tag of task.tags) {
          insertTag.run(task.id, tag);
        }
      }
    })();
  }

  get(id: string): SchedulerTask | null {
    const row = this.db.prepare("SELECT * FROM scheduler_tasks WHERE id = ?").get(id) as SchedulerTaskRow | undefined;
    if (!row) return null;
    return this.rowToTask(row);
  }

  delete(id: string): boolean {
    const result = this.db.transaction(() => {
      this.db.prepare("DELETE FROM scheduler_tags WHERE task_id = ?").run(id);
      return this.db.prepare("DELETE FROM scheduler_tasks WHERE id = ?").run(id);
    })();
    return result.changes > 0;
  }

  list(limit: number = 50, options?: {
    type?: TaskType;
    status?: TaskStatus;
    umo?: string;
  }): SchedulerTask[] {
    let whereClause = " WHERE 1=1";
    const params: unknown[] = [];

    if (options?.type) {
      whereClause += " AND type = ?";
      params.push(options.type);
    }
    if (options?.status) {
      whereClause += " AND status = ?";
      params.push(options.status);
    }
    if (options?.umo) {
      whereClause += " AND umo = ?";
      params.push(options.umo);
    }

    const rows = this.db.prepare(
      `SELECT * FROM scheduler_tasks${whereClause} ORDER BY priority DESC, created_at DESC LIMIT ?`
    ).all(...params, limit) as SchedulerTaskRow[];

    return rows.map((r) => this.rowToTask(r));
  }

  search(query: string, limit: number = 20, options?: {
    type?: TaskType;
    status?: TaskStatus;
    umo?: string;
  }): SchedulerTask[] {
    const escapedQuery = escapeLike(query);
    const likePattern = `%${escapedQuery}%`;
    let whereClause = " WHERE (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR goal LIKE ? ESCAPE '\\')";
    const params: unknown[] = [likePattern, likePattern, likePattern];

    if (options?.type) {
      whereClause += " AND type = ?";
      params.push(options.type);
    }
    if (options?.status) {
      whereClause += " AND status = ?";
      params.push(options.status);
    }
    if (options?.umo) {
      whereClause += " AND umo = ?";
      params.push(options.umo);
    }

    const rows = this.db.prepare(
      `SELECT * FROM scheduler_tasks${whereClause} ORDER BY priority DESC, updated_at DESC LIMIT ?`
    ).all(...params, limit) as SchedulerTaskRow[];

    return rows.map((r) => this.rowToTask(r));
  }

  /**
   * Return all tasks that are due to fire at or before `now`.
   * A task is due when next_fire_at <= now AND status is pending or active.
   */
  getDueTasks(now: Date): SchedulerTask[] {
    const nowIso = now.toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM scheduler_tasks
      WHERE next_fire_at IS NOT NULL
        AND next_fire_at <= ?
        AND status IN ('pending', 'active')
    `).all(nowIso) as SchedulerTaskRow[];
    return rows.map((r) => this.rowToTask(r));
  }

  /**
   * Mark a task as fired: update last_fired_at, compute next_fire_at for
   * recurring tasks (or mark one-shot tasks as completed).
   */
  markFired(id: string, now: Date): void {
    const task = this.get(id);
    if (!task) return;
    const nowIso = now.toISOString();

    let nextFireAt: string | null = null;
    let newStatus: TaskStatus = task.status;

    if (task.type === "recurring" && task.recurrence) {
      nextFireAt = computeNextFireAt(task.recurrence, now)?.toISOString() ?? null;
      if (!nextFireAt) {
        // Could not parse recurrence → mark completed to avoid infinite re-fire
        newStatus = "completed";
      }
    } else {
      // One-shot reminder/scheduled → mark completed after firing
      newStatus = "completed";
    }

    this.db.prepare(`
      UPDATE scheduler_tasks
      SET last_fired_at = ?, next_fire_at = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(nowIso, nextFireAt, newStatus, nowIso, id);
  }

  /**
   * Update only mutable fields of a task.
   */
  update(id: string, updates: Partial<Omit<SchedulerTask, "id" | "createdAt">>): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    const now = new Date().toISOString();

    const merged: SchedulerTask = { ...existing, ...updates, updatedAt: now, createdAt: existing.createdAt };

    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE scheduler_tasks SET
          type = ?, title = ?, description = ?, status = ?, priority = ?,
          scheduled_at = ?, recurrence = ?, goal = ?, plan = ?, current_step = ?,
          umo = ?, session_id = ?, platform_id = ?, payload = ?,
          last_fired_at = ?, next_fire_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        merged.type, merged.title, merged.description, merged.status, merged.priority,
        merged.scheduledAt, merged.recurrence, merged.goal, JSON.stringify(merged.plan),
        merged.currentStep, merged.umo, merged.sessionId, merged.platformId, merged.payload,
        merged.lastFiredAt, merged.nextFireAt, now, id,
      );

      if (updates.tags !== undefined) {
        this.db.prepare("DELETE FROM scheduler_tags WHERE task_id = ?").run(id);
        const insertTag = this.db.prepare(
          "INSERT OR IGNORE INTO scheduler_tags (task_id, tag) VALUES (?, ?)"
        );
        for (const tag of merged.tags) {
          insertTag.run(id, tag);
        }
      }
    })();

    return true;
  }

  count(options?: { type?: TaskType; status?: TaskStatus; umo?: string }): number {
    let whereClause = " WHERE 1=1";
    const params: unknown[] = [];
    if (options?.type) { whereClause += " AND type = ?"; params.push(options.type); }
    if (options?.status) { whereClause += " AND status = ?"; params.push(options.status); }
    if (options?.umo) { whereClause += " AND umo = ?"; params.push(options.umo); }

    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM scheduler_tasks${whereClause}`
    ).get(...params) as CountRow;
    return row?.cnt ?? 0;
  }

  clear(): number {
    const countBefore = this.count();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM scheduler_tags").run();
      this.db.prepare("DELETE FROM scheduler_tasks").run();
    })();
    return countBefore;
  }

  stats(): SchedulerStats {
    const total = this.count();
    const byType = {} as Record<TaskType, number>;
    const types: TaskType[] = ["reminder", "scheduled", "recurring", "goal", "plan"];
    for (const t of types) byType[t] = this.count({ type: t });

    const byStatus = {} as Record<TaskStatus, number>;
    const statuses: TaskStatus[] = ["pending", "active", "completed", "cancelled", "failed"];
    for (const s of statuses) byStatus[s] = this.count({ status: s });

    return { total, byType, byStatus };
  }

  // ── Helpers ──

  private rowToTask(row: SchedulerTaskRow): SchedulerTask {
    const tagRows = this.db.prepare(
      "SELECT tag FROM scheduler_tags WHERE task_id = ?"
    ).all(row.id) as SchedulerTagRow[];

    let plan: PlanStep[] = [];
    try {
      plan = JSON.parse(row.plan ?? "[]");
    } catch { /* keep empty */ }

    return {
      id: row.id,
      type: row.type ?? "reminder",
      title: row.title ?? "",
      description: row.description ?? "",
      status: row.status ?? "pending",
      priority: row.priority ?? 0,
      scheduledAt: row.scheduled_at ?? null,
      recurrence: row.recurrence ?? null,
      goal: row.goal ?? null,
      plan,
      currentStep: row.current_step ?? -1,
      tags: tagRows.map((t) => t.tag),
      umo: row.umo ?? null,
      sessionId: row.session_id ?? null,
      platformId: row.platform_id ?? null,
      payload: row.payload ?? null,
      lastFiredAt: row.last_fired_at ?? null,
      nextFireAt: row.next_fire_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// ── Recurrence Parsing ──

/**
 * Parse a recurrence pattern and compute the next fire time after `from`.
 * Supported patterns:
 *   - "Nh" / "Nm" / "Ns": N hours/minutes/seconds
 *   - "daily": every 24 hours
 *   - "weekly": every 7 days
 */
export function computeNextFireAt(recurrence: string, from: Date): Date | null {
  const trimmed = recurrence.trim().toLowerCase();
  if (!trimmed) return null;

  const intervalMatch = trimmed.match(/^(\d+)([hms])$/);
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2];
    const multiplier = unit === "h" ? 3600_000 : unit === "m" ? 60_000 : 1000;
    return new Date(from.getTime() + value * multiplier);
  }

  if (trimmed === "daily") {
    return new Date(from.getTime() + 24 * 3600_000);
  }
  if (trimmed === "weekly") {
    return new Date(from.getTime() + 7 * 24 * 3600_000);
  }

  return null;
}

/**
 * Given a task's scheduledAt and recurrence, compute the initial
 * next_fire_at (the time the task should first fire).
 */
export function computeInitialNextFireAt(
  scheduledAt: string | null,
  recurrence: string | null,
  now: Date,
): string | null {
  if (scheduledAt) {
    // If scheduled time has already passed and it's recurring, compute next
    if (recurrence && new Date(scheduledAt).getTime() < now.getTime()) {
      const next = computeNextFireAt(recurrence, now);
      return next?.toISOString() ?? scheduledAt;
    }
    return scheduledAt;
  }
  if (recurrence) {
    return computeNextFireAt(recurrence, now)?.toISOString() ?? null;
  }
  return null;
}
