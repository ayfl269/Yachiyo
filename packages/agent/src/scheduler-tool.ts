/**
 * Scheduler tool: lets the agent create, read, update, and delete scheduled
 * tasks, reminders, wake-up events, current task goals, and multi-step
 * execution plans.
 *
 * Actions:
 *   create      Create a new task (reminder/scheduled/recurring/goal/plan)
 *   get         Get a task by id
 *   list        List tasks (filter by type/status/umo)
 *   search      Search tasks by title/description/goal
 *   update      Update a task's mutable fields
 *   delete      Delete a task
 *   set_goal    Create or update the current task goal (shorthand)
 *   get_goal    Get the current active goal for a session
 *   set_plan    Create or replace a multi-step execution plan
 *   update_step Update the status of a single plan step
 *   next_step   Advance current_step to the next pending step
 *   fire_now    Force a task to fire immediately (mark fired + recompute next)
 *   stats       Show scheduler statistics
 */

import { createFunctionTool, type FunctionTool } from "./tool.js";
import type { ContextWrapper, CallToolResult } from "./types.js";
import { generateId } from "@yachiyo/common/id-generator.js";
import type { SqliteSchedulerTaskStore } from "./scheduler-task-store.js";
import {
  computeInitialNextFireAt,
  type TaskType,
  type TaskStatus,
  type PlanStep,
  type StepStatus,
} from "./scheduler-task-store.js";

// ── Context type ──

export interface SchedulerToolContext {
  event?: {
    unifiedMsgOrigin?: string;
    sessionId?: string;
    personaId?: string;
    platformId?: string;
  };
}

function getToolContext(_ctx: unknown): SchedulerToolContext {
  const wrapper = _ctx as ContextWrapper<SchedulerToolContext> | undefined;
  const ctx = wrapper?.context;
  if (!ctx) return {} as SchedulerToolContext;

  // When called from the pipeline, `ctx` is a MessageEvent instance that has
  // `unifiedMsgOrigin` (getter), `sessionId`, and `platformMeta` directly on
  // it — not nested under an `event` key. Normalize both shapes.
  const maybeEvent = ctx as any;
  if (maybeEvent.unifiedMsgOrigin && typeof maybeEvent.unifiedMsgOrigin === "string") {
    return {
      event: {
        unifiedMsgOrigin: maybeEvent.unifiedMsgOrigin,
        sessionId: maybeEvent.sessionId,
        platformId: maybeEvent.platformMeta?.id,
      },
    };
  }
  // Already a SchedulerToolContext (e.g. in tests)
  return ctx as SchedulerToolContext;
}

export interface CreateSchedulerToolOptions {
  sqliteStore?: SqliteSchedulerTaskStore;
}

const VALID_TYPES: TaskType[] = ["reminder", "scheduled", "recurring", "goal", "plan"];
const VALID_STATUSES: TaskStatus[] = ["pending", "active", "completed", "cancelled", "failed"];
const VALID_STEP_STATUSES: StepStatus[] = ["pending", "in_progress", "completed", "skipped"];

export function createSchedulerTool(options?: CreateSchedulerToolOptions): FunctionTool<SchedulerToolContext> {
  const store = options?.sqliteStore;

  return createFunctionTool<SchedulerToolContext>({
    name: "scheduler_tool",
    description:
      "Scheduled task, reminder, and execution plan management. " +
      "Task types: reminder (one-shot), scheduled (one-shot at time), " +
      "recurring (interval: 'Nh'/'Nm'/'daily'/'weekly'), goal (current goal), " +
      "plan (multi-step plan). " +
      "Actions: create, get, list, search, update, delete, set_goal, " +
      "get_goal, set_plan, update_step, next_step, fire_now, stats.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action to perform.",
          enum: [
            "create", "get", "list", "search", "update", "delete",
            "set_goal", "get_goal", "set_plan", "update_step",
            "next_step", "fire_now", "stats",
          ],
        },
        id: { type: "string", description: "Task id (for get/update/delete/set_plan/update_step/next_step/fire_now)." },
        type: {
          type: "string",
          description: "Task type. One of: reminder, scheduled, recurring, goal, plan.",
          enum: ["reminder", "scheduled", "recurring", "goal", "plan"],
        },
        title: { type: "string", description: "Task title." },
        description: { type: "string", description: "Task description / payload." },
        status: {
          type: "string",
          description: "Task status. One of: pending, active, completed, cancelled, failed.",
          enum: ["pending", "active", "completed", "cancelled", "failed"],
        },
        priority: {
          type: "integer",
          description: "Priority 0-10 (higher = more important). Default 0.",
          minimum: 0, maximum: 10,
        },
        scheduled_at: {
          type: "string",
          description: "ISO 8601 timestamp when the task should fire (e.g. '2026-07-08T15:30:00Z').",
          format: "date-time",
        },
        recurrence: {
          type: "string",
          description: "Recurrence pattern for recurring tasks: '1h', '30m', 'daily', 'weekly'.",
        },
        goal: { type: "string", description: "Current task goal text (for goal/plan tasks)." },
        payload: { type: "string", description: "Message/payload delivered when the task fires." },
        tags: { type: "array", description: "Tags for categorization.", items: { type: "string" } },
        plan: {
          type: "array",
          description: "Multi-step execution plan (for plan tasks). Each step: {description, status}.",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "skipped"] },
            },
          },
        },
        step_index: {
          type: "integer",
          description: "Index of the plan step to update (0-based, for update_step).",
          minimum: 0,
        },
        step_status: {
          type: "string",
          description: "New status for the plan step (for update_step).",
          enum: ["pending", "in_progress", "completed", "skipped"],
        },
        query: { type: "string", description: "Search query (for search action)." },
        limit: {
          type: "integer",
          description: "Maximum results for list/search. Default 20.",
          minimum: 1, default: 20,
        },
      },
      required: ["action"],
    },
    active: true,
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      if (!store) {
        return { content: [{ type: "text", text: "error: Scheduler store is not available." }], isError: true };
      }

      const action = String(args[0] ?? "");
      const id = args[1] != null ? String(args[1]) : undefined;
      const type = args[2] != null ? String(args[2]) as TaskType : undefined;
      const title = args[3] != null ? String(args[3]) : undefined;
      const description = args[4] != null ? String(args[4]) : undefined;
      const status = args[5] != null ? String(args[5]) as TaskStatus : undefined;
      const priority = args[6] != null ? Number(args[6]) : undefined;
      const scheduledAt = args[7] != null ? String(args[7]) : undefined;
      const recurrence = args[8] != null ? String(args[8]) : undefined;
      const goal = args[9] != null ? String(args[9]) : undefined;
      const payload = args[10] != null ? String(args[10]) : undefined;
      const tags = (args[11] as string[]) ?? undefined;
      const plan = (args[12] as PlanStep[]) ?? undefined;
      const stepIndex = args[13] != null ? Number(args[13]) : undefined;
      const stepStatus = args[14] != null ? String(args[14]) as StepStatus : undefined;
      const query = args[15] != null ? String(args[15]) : undefined;
      const limit = args[16] != null ? Number(args[16]) : 20;
      const context = getToolContext(_ctx);

      try {
        switch (action) {
          case "create":
            return handleCreate(store, {
              id, type, title, description, status, priority, scheduledAt,
              recurrence, goal, payload, tags, plan, context,
            });
          case "get":
            return handleGet(store, id);
          case "list":
            return handleList(store, { type, status, umo: context.event?.unifiedMsgOrigin, limit });
          case "search":
            return handleSearch(store, { query: query ?? title ?? "", type, status, umo: context.event?.unifiedMsgOrigin, limit });
          case "update":
            return handleUpdate(store, id, {
              type, title, description, status, priority, scheduledAt,
              recurrence, goal, payload, tags, plan,
            });
          case "delete":
            return handleDelete(store, id);
          case "set_goal":
            return handleSetGoal(store, {
              title, goal, description, priority, tags, context,
            });
          case "get_goal":
            return handleGetGoal(store, context.event?.unifiedMsgOrigin);
          case "set_plan":
            return handleSetPlan(store, id, { title, description, goal, plan, priority, tags, context });
          case "update_step":
            return handleUpdateStep(store, id, stepIndex, stepStatus);
          case "next_step":
            return handleNextStep(store, id);
          case "fire_now":
            return handleFireNow(store, id);
          case "stats":
            return handleStats(store);
          default:
            return { content: [{ type: "text", text: `error: Unknown action: "${action}".` }], isError: true };
        }
      } catch (e) {
        return { content: [{ type: "text", text: `error: Scheduler operation failed: ${e}` }], isError: true };
      }
    },
  });
}

// ── Action Handlers ──

interface CreateParams {
  id?: string;
  type?: TaskType;
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  scheduledAt?: string;
  recurrence?: string;
  goal?: string;
  payload?: string;
  tags?: string[];
  plan?: PlanStep[];
  context: SchedulerToolContext;
}

function handleCreate(store: SqliteSchedulerTaskStore, p: CreateParams): CallToolResult {
  const taskType = p.type ?? "reminder";
  if (!VALID_TYPES.includes(taskType)) {
    return { content: [{ type: "text", text: `error: Invalid type '${p.type}'. Valid: ${VALID_TYPES.join(", ")}.` }], isError: true };
  }
  if (!p.title) {
    return { content: [{ type: "text", text: "error: 'title' is required for create action." }], isError: true };
  }
  if (p.status && !VALID_STATUSES.includes(p.status)) {
    return { content: [{ type: "text", text: `error: Invalid status '${p.status}'. Valid: ${VALID_STATUSES.join(", ")}.` }], isError: true };
  }

  // Validate scheduled_at for one-shot tasks
  if ((taskType === "reminder" || taskType === "scheduled") && p.scheduledAt) {
    const d = new Date(p.scheduledAt);
    if (isNaN(d.getTime())) {
      return { content: [{ type: "text", text: `error: Invalid scheduled_at timestamp: '${p.scheduledAt}'.` }], isError: true };
    }
  }

  // Validate recurrence for recurring tasks
  if (taskType === "recurring" && !p.recurrence && !p.scheduledAt) {
    return { content: [{ type: "text", text: "error: 'recurrence' is required for recurring tasks (e.g. '1h', 'daily')." }], isError: true };
  }

  const now = new Date();
  const taskId = p.id || generateId();
  const status: TaskStatus = p.status ?? "pending";
  const priority = p.priority ?? 0;
  const nextFireAt = computeInitialNextFireAt(p.scheduledAt ?? null, p.recurrence ?? null, now);

  store.save({
    id: taskId,
    type: taskType,
    title: p.title,
    description: p.description ?? "",
    status,
    priority,
    scheduledAt: p.scheduledAt ?? null,
    recurrence: p.recurrence ?? null,
    goal: p.goal ?? null,
    plan: p.plan ?? [],
    currentStep: p.plan && p.plan.length > 0 ? 0 : -1,
    tags: p.tags ?? [],
    umo: p.context.event?.unifiedMsgOrigin ?? null,
    sessionId: p.context.event?.sessionId ?? null,
    platformId: p.context.event?.platformId ?? null,
    payload: p.payload ?? null,
    lastFiredAt: null,
    nextFireAt,
  });

  return { content: [{ type: "text", text: formatCreateResult(taskId, taskType, p.title, nextFireAt, status) }] };
}

function handleGet(store: SqliteSchedulerTaskStore, id?: string): CallToolResult {
  if (!id) return { content: [{ type: "text", text: "error: 'id' is required for get action." }], isError: true };
  const task = store.get(id);
  if (!task) return { content: [{ type: "text", text: `Task not found: "${id}"` }] };
  return { content: [{ type: "text", text: formatTask(task) }] };
}

function handleList(store: SqliteSchedulerTaskStore, opts: {
  type?: TaskType; status?: TaskStatus; umo?: string; limit: number;
}): CallToolResult {
  const tasks = store.list(opts.limit, { type: opts.type, status: opts.status, umo: opts.umo });
  if (tasks.length === 0) return { content: [{ type: "text", text: "No tasks found." }] };
  const formatted = tasks.map((t, i) => `${i + 1}. ${formatTaskBrief(t)}`).join("\n");
  return { content: [{ type: "text", text: `${tasks.length} task(s):\n\n${formatted}` }] };
}

function handleSearch(store: SqliteSchedulerTaskStore, opts: {
  query: string; type?: TaskType; status?: TaskStatus; umo?: string; limit: number;
}): CallToolResult {
  if (!opts.query) return { content: [{ type: "text", text: "error: 'query' is required for search action." }], isError: true };
  const tasks = store.search(opts.query, opts.limit, { type: opts.type, status: opts.status, umo: opts.umo });
  if (tasks.length === 0) return { content: [{ type: "text", text: `No tasks matching "${opts.query}".` }] };
  const formatted = tasks.map((t, i) => `${i + 1}. ${formatTaskBrief(t)}`).join("\n");
  return { content: [{ type: "text", text: `Found ${tasks.length} task(s):\n\n${formatted}` }] };
}

function handleUpdate(store: SqliteSchedulerTaskStore, id: string | undefined, updates: {
  type?: TaskType; title?: string; description?: string; status?: TaskStatus;
  priority?: number; scheduledAt?: string; recurrence?: string; goal?: string;
  payload?: string; tags?: string[]; plan?: PlanStep[];
}): CallToolResult {
  if (!id) return { content: [{ type: "text", text: "error: 'id' is required for update action." }], isError: true };

  const existing = store.get(id);
  if (!existing) return { content: [{ type: "text", text: `Task not found: "${id}"` }], isError: true };

  // Validate enums
  if (updates.type && !VALID_TYPES.includes(updates.type)) {
    return { content: [{ type: "text", text: `error: Invalid type '${updates.type}'.` }], isError: true };
  }
  if (updates.status && !VALID_STATUSES.includes(updates.status)) {
    return { content: [{ type: "text", text: `error: Invalid status '${updates.status}'.` }], isError: true };
  }

  // Recompute next_fire_at if scheduling fields change
  const mergedScheduledAt = updates.scheduledAt !== undefined ? updates.scheduledAt : existing.scheduledAt;
  const mergedRecurrence = updates.recurrence !== undefined ? updates.recurrence : existing.recurrence;
  let nextFireAt = existing.nextFireAt;
  if (updates.scheduledAt !== undefined || updates.recurrence !== undefined) {
    nextFireAt = computeInitialNextFireAt(mergedScheduledAt ?? null, mergedRecurrence ?? null, new Date());
  }

  const updatePayload: Record<string, unknown> = {};
  if (updates.type !== undefined) updatePayload.type = updates.type;
  if (updates.title !== undefined) updatePayload.title = updates.title;
  if (updates.description !== undefined) updatePayload.description = updates.description;
  if (updates.status !== undefined) updatePayload.status = updates.status;
  if (updates.priority !== undefined) updatePayload.priority = updates.priority;
  if (updates.scheduledAt !== undefined) updatePayload.scheduledAt = updates.scheduledAt ?? null;
  if (updates.recurrence !== undefined) updatePayload.recurrence = updates.recurrence ?? null;
  if (updates.goal !== undefined) updatePayload.goal = updates.goal;
  if (updates.payload !== undefined) updatePayload.payload = updates.payload;
  if (updates.tags !== undefined) updatePayload.tags = updates.tags;
  if (updates.plan !== undefined) updatePayload.plan = updates.plan;
  if (nextFireAt !== existing.nextFireAt) updatePayload.nextFireAt = nextFireAt;

  const ok = store.update(id, updatePayload);
  if (!ok) return { content: [{ type: "text", text: `Failed to update task: "${id}"` }], isError: true };
  return { content: [{ type: "text", text: `Task updated: "${id}"` }] };
}

function handleDelete(store: SqliteSchedulerTaskStore, id: string | undefined): CallToolResult {
  if (!id) return { content: [{ type: "text", text: "error: 'id' is required for delete action." }], isError: true };
  const deleted = store.delete(id);
  if (!deleted) return { content: [{ type: "text", text: `Task not found: "${id}"` }], isError: true };
  return { content: [{ type: "text", text: `Task deleted: "${id}"` }] };
}

function handleSetGoal(store: SqliteSchedulerTaskStore, p: {
  title?: string; goal?: string; description?: string; priority?: number;
  tags?: string[]; context: SchedulerToolContext;
}): CallToolResult {
  if (!p.goal) return { content: [{ type: "text", text: "error: 'goal' is required for set_goal action." }], isError: true };

  // Deactivate any existing active goal for this session
  const umo = p.context.event?.unifiedMsgOrigin;
  if (umo) {
    const existingGoals = store.list(50, { type: "goal", status: "active", umo });
    for (const g of existingGoals) {
      store.update(g.id, { status: "completed" });
    }
  }

  const now = new Date();
  const taskId = generateId();
  store.save({
    id: taskId,
    type: "goal",
    title: p.title ?? "Current Goal",
    description: p.description ?? "",
    status: "active",
    priority: p.priority ?? 5,
    scheduledAt: null,
    recurrence: null,
    goal: p.goal,
    plan: [],
    currentStep: -1,
    tags: p.tags ?? [],
    umo: umo ?? null,
    sessionId: p.context.event?.sessionId ?? null,
    platformId: p.context.event?.platformId ?? null,
    payload: null,
    lastFiredAt: null,
    nextFireAt: null,
  });

  return { content: [{ type: "text", text: `Goal set (id: ${taskId}): "${p.goal}"` }] };
}

function handleGetGoal(store: SqliteSchedulerTaskStore, umo?: string): CallToolResult {
  if (!umo) return { content: [{ type: "text", text: "error: No session context available for get_goal." }], isError: true };
  const goals = store.list(5, { type: "goal", status: "active", umo });
  if (goals.length === 0) return { content: [{ type: "text", text: "No active goal for current session." }] };
  const g = goals[0];
  return { content: [{ type: "text", text: `Current goal (id: ${g.id}): "${g.goal}"\nPriority: ${g.priority}` }] };
}

function handleSetPlan(store: SqliteSchedulerTaskStore, id: string | undefined, p: {
  title?: string; description?: string; goal?: string; plan?: PlanStep[];
  priority?: number; tags?: string[]; context: SchedulerToolContext;
}): CallToolResult {
  if (!p.plan || !Array.isArray(p.plan) || p.plan.length === 0) {
    return { content: [{ type: "text", text: "error: 'plan' (non-empty array) is required for set_plan action." }], isError: true };
  }
  // Normalize steps: ensure each has description and status
  const normalizedPlan: PlanStep[] = p.plan.map((s) => ({
    description: s.description ?? "",
    status: s.status ?? "pending",
  }));

  const now = new Date();
  const taskId = id ?? generateId();
  const existing = id ? store.get(id) : null;

  store.save({
    id: taskId,
    type: "plan",
    title: p.title ?? existing?.title ?? "Execution Plan",
    description: p.description ?? existing?.description ?? "",
    status: "active",
    priority: p.priority ?? existing?.priority ?? 5,
    scheduledAt: null,
    recurrence: null,
    goal: p.goal ?? existing?.goal ?? null,
    plan: normalizedPlan,
    currentStep: 0,
    tags: p.tags ?? existing?.tags ?? [],
    umo: p.context.event?.unifiedMsgOrigin ?? existing?.umo ?? null,
    sessionId: p.context.event?.sessionId ?? existing?.sessionId ?? null,
    platformId: p.context.event?.platformId ?? existing?.platformId ?? null,
    payload: null,
    lastFiredAt: null,
    nextFireAt: null,
  });

  const stepsText = normalizedPlan.map((s, i) =>
    `  ${i}. [${s.status}] ${s.description}`
  ).join("\n");
  return { content: [{ type: "text", text: `Plan set (id: ${taskId}, ${normalizedPlan.length} steps):\n${stepsText}` }] };
}

function handleUpdateStep(store: SqliteSchedulerTaskStore, id: string | undefined, stepIndex: number | undefined, stepStatus: StepStatus | undefined): CallToolResult {
  if (!id) return { content: [{ type: "text", text: "error: 'id' is required for update_step action." }], isError: true };
  if (stepIndex == null || stepIndex < 0) return { content: [{ type: "text", text: "error: 'step_index' (>= 0) is required for update_step action." }], isError: true };
  if (!stepStatus || !VALID_STEP_STATUSES.includes(stepStatus)) {
    return { content: [{ type: "text", text: `error: 'step_status' must be one of: ${VALID_STEP_STATUSES.join(", ")}.` }], isError: true };
  }

  const task = store.get(id);
  if (!task) return { content: [{ type: "text", text: `Task not found: "${id}"` }], isError: true };
  if (task.type !== "plan") return { content: [{ type: "text", text: `error: Task "${id}" is not a plan task.` }], isError: true };
  if (stepIndex >= task.plan.length) return { content: [{ type: "text", text: `error: step_index ${stepIndex} out of range (plan has ${task.plan.length} steps).` }], isError: true };

  const newPlan = [...task.plan];
  newPlan[stepIndex] = { ...newPlan[stepIndex], status: stepStatus };

  // Auto-advance current_step if this step was completed
  let currentStep = task.currentStep;
  if (stepStatus === "completed" && currentStep === stepIndex) {
    currentStep = findNextPendingStep(newPlan, stepIndex);
  }

  store.update(id, { plan: newPlan, currentStep });

  // Check if all steps completed
  const allDone = newPlan.every((s) => s.status === "completed" || s.status === "skipped");
  if (allDone) {
    store.update(id, { status: "completed" });
    return { content: [{ type: "text", text: `Step ${stepIndex} -> ${stepStatus}. All steps done! Plan "${id}" marked completed.` }] };
  }

  return { content: [{ type: "text", text: `Step ${stepIndex} -> ${stepStatus} (current: ${currentStep}).` }] };
}

function handleNextStep(store: SqliteSchedulerTaskStore, id: string | undefined): CallToolResult {
  if (!id) return { content: [{ type: "text", text: "error: 'id' is required for next_step action." }], isError: true };
  const task = store.get(id);
  if (!task) return { content: [{ type: "text", text: `Task not found: "${id}"` }], isError: true };
  if (task.type !== "plan") return { content: [{ type: "text", text: `error: Task "${id}" is not a plan task.` }], isError: true };

  const next = findNextPendingStep(task.plan, task.currentStep);
  if (next < 0 || next >= task.plan.length) {
    store.update(id, { status: "completed" });
    return { content: [{ type: "text", text: `No more pending steps. Plan "${id}" marked completed.` }] };
  }

  const newPlan = [...task.plan];
  newPlan[next] = { ...newPlan[next], status: "in_progress" };
  store.update(id, { plan: newPlan, currentStep: next });

  return { content: [{ type: "text", text: `Advanced to step ${next}: "${newPlan[next].description}"` }] };
}

function handleFireNow(store: SqliteSchedulerTaskStore, id: string | undefined): CallToolResult {
  if (!id) return { content: [{ type: "text", text: "error: 'id' is required for fire_now action." }], isError: true };
  const task = store.get(id);
  if (!task) return { content: [{ type: "text", text: `Task not found: "${id}"` }], isError: true };

  const now = new Date();
  store.markFired(id, now);
  const updated = store.get(id);
  return { content: [{ type: "text", text: `Task "${id}" fired at ${now.toISOString()}. Next fire: ${updated?.nextFireAt ?? "none"} (status: ${updated?.status}).` }] };
}

function handleStats(store: SqliteSchedulerTaskStore): CallToolResult {
  const stats = store.stats();
  const lines = [
    `Total tasks: ${stats.total}`,
    ``,
    `By Type:`,
    ...Object.entries(stats.byType).map(([type, count]) => `  ${type}: ${count}`),
    ``,
    `By Status:`,
    ...Object.entries(stats.byStatus).map(([status, count]) => `  ${status}: ${count}`),
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ── Formatting Helpers ──

function formatTaskBrief(t: { id: string; type: TaskType; title: string; status: TaskStatus; priority: number; nextFireAt: string | null; scheduledAt: string | null }): string {
  const fire = t.nextFireAt ?? t.scheduledAt ?? "-";
  return `[${t.id}] (${t.type}/${t.status}) "${t.title}" | priority: ${t.priority} | fire: ${fire}`;
}

function formatTask(t: { id: string; type: TaskType; title: string; description: string; status: TaskStatus; priority: number; scheduledAt: string | null; recurrence: string | null; goal: string | null; plan: PlanStep[]; currentStep: number; tags: string[]; payload: string | null; nextFireAt: string | null; lastFiredAt: string | null; createdAt: string; updatedAt: string; }): string {
  const lines = [
    `Id: ${t.id}`,
    `Type: ${t.type}`,
    `Title: ${t.title}`,
    `Status: ${t.status}`,
    `Priority: ${t.priority}`,
  ];
  if (t.description) lines.push(`Description: ${t.description}`);
  if (t.goal) lines.push(`Goal: ${t.goal}`);
  if (t.scheduledAt) lines.push(`ScheduledAt: ${t.scheduledAt}`);
  if (t.recurrence) lines.push(`Recurrence: ${t.recurrence}`);
  if (t.nextFireAt) lines.push(`NextFireAt: ${t.nextFireAt}`);
  if (t.lastFiredAt) lines.push(`LastFiredAt: ${t.lastFiredAt}`);
  if (t.payload) lines.push(`Payload: ${t.payload}`);
  lines.push(`Tags: ${t.tags.join(", ") || "(none)"}`);
  if (t.plan.length > 0) {
    lines.push(`Plan (current step: ${t.currentStep}):`);
    for (let i = 0; i < t.plan.length; i++) {
      const marker = i === t.currentStep ? "*" : " ";
      lines.push(`  ${marker}${i}. [${t.plan[i].status}] ${t.plan[i].description}`);
    }
  }
  lines.push(`Created: ${t.createdAt}`);
  lines.push(`Updated: ${t.updatedAt}`);
  return lines.join("\n");
}

function formatCreateResult(id: string, type: TaskType, title: string, nextFireAt: string | null, status: TaskStatus): string {
  const fire = nextFireAt ? ` | fires at: ${nextFireAt}` : "";
  return `Task created (id: ${id}, type: ${type}, status: ${status})${fire}\nTitle: "${title}"`;
}

// ── Helpers ──

function findNextPendingStep(plan: PlanStep[], from: number): number {
  // Find the next step that is still actionable (pending or in_progress).
  for (let i = from + 1; i < plan.length; i++) {
    if (plan[i].status === "pending" || plan[i].status === "in_progress") return i;
  }
  // If nothing after, check from start
  for (let i = 0; i <= from && i < plan.length; i++) {
    if (plan[i].status === "pending" || plan[i].status === "in_progress") return i;
  }
  return -1;
}
