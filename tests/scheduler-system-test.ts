/**
 * Scheduler feature integration test.
 *
 * Validates:
 *  - SqliteSchedulerTaskStore CRUD (save/get/list/search/delete/update)
 *  - Recurrence computation (computeNextFireAt / computeInitialNextFireAt)
 *  - getDueTasks + markFired advancement for one-shot and recurring tasks
 *  - Scheduler tool agent actions (create / set_goal / set_plan / update_step /
 *    next_step / fire_now / stats / list / search / update / delete)
 *  - TaskScheduler.tick() delivers proactive messages via adapter registry
 *
 * Uses an in-memory SQLite database so the test is hermetic and fast.
 */

import Database from "better-sqlite3";
import {
  SCHEDULER_MIGRATIONS,
  SqliteSchedulerTaskStore,
  computeNextFireAt,
  computeInitialNextFireAt,
  createSchedulerTool,
} from "@yachiyo/agent/index.js";
import { TaskScheduler } from "@yachiyo/pipeline/task-scheduler.js";
import type { CallToolResult, FunctionTool } from "@yachiyo/agent/index.js";

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passCount++;
    console.log(`  ✅ ${message}`);
  } else {
    failCount++;
    console.error(`  ❌ ${message}`);
  }
}

function getText(result: CallToolResult): string {
  return result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
}

/**
 * Call the scheduler tool with named parameters, mapping them to the
 * correct positional indices expected by the handler.
 *
 * Handler arg indices:
 *   0 action, 1 id, 2 type, 3 title, 4 description, 5 status,
 *   6 priority, 7 scheduledAt, 8 recurrence, 9 goal, 10 payload,
 *   11 tags, 12 plan, 13 stepIndex, 14 stepStatus, 15 query, 16 limit
 */
async function call(
  tool: FunctionTool,
  ctx: unknown,
  opts: {
    action: string;
    id?: string;
    type?: string;
    title?: string;
    description?: string;
    status?: string;
    priority?: number;
    scheduledAt?: string;
    recurrence?: string;
    goal?: string;
    payload?: string;
    tags?: string[];
    plan?: Array<{ description: string; status: string }>;
    stepIndex?: number;
    stepStatus?: string;
    query?: string;
    limit?: number;
  },
): Promise<CallToolResult> {
  // Build positional args array, padding undefined slots up to index 16.
  const args: unknown[] = new Array(17).fill(undefined);
  args[0] = opts.action;
  if (opts.id !== undefined) args[1] = opts.id;
  if (opts.type !== undefined) args[2] = opts.type;
  if (opts.title !== undefined) args[3] = opts.title;
  if (opts.description !== undefined) args[4] = opts.description;
  if (opts.status !== undefined) args[5] = opts.status;
  if (opts.priority !== undefined) args[6] = opts.priority;
  if (opts.scheduledAt !== undefined) args[7] = opts.scheduledAt;
  if (opts.recurrence !== undefined) args[8] = opts.recurrence;
  if (opts.goal !== undefined) args[9] = opts.goal;
  if (opts.payload !== undefined) args[10] = opts.payload;
  if (opts.tags !== undefined) args[11] = opts.tags;
  if (opts.plan !== undefined) args[12] = opts.plan;
  if (opts.stepIndex !== undefined) args[13] = opts.stepIndex;
  if (opts.stepStatus !== undefined) args[14] = opts.stepStatus;
  if (opts.query !== undefined) args[15] = opts.query;
  if (opts.limit !== undefined) args[16] = opts.limit;

  return await tool.handler!(ctx, ...args) as CallToolResult;
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   Scheduler 定时任务功能测试              ║");
  console.log("╚══════════════════════════════════════════╝");

  // In-memory SQLite (shared across the store + tool)
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const m of SCHEDULER_MIGRATIONS) {
    db.exec(m.up);
  }

  const store = new SqliteSchedulerTaskStore(db);
  const schedulerTool = createSchedulerTool({ sqliteStore: store });

  // ── Test: Store CRUD ──
  console.log("\n=== 测试: Store CRUD ===");

  // save + get
  store.save({
    id: "task-1",
    type: "reminder",
    title: "开会提醒",
    description: "下午3点开会",
    status: "pending",
    priority: 5,
    scheduledAt: "2026-07-08T15:00:00Z",
    recurrence: null,
    goal: null,
    plan: [],
    currentStep: -1,
    tags: ["meeting", "urgent"],
    umo: "test:umo",
    sessionId: "sess-1",
    platformId: "test-platform",
    payload: "别忘了开会!",
    lastFiredAt: null,
    nextFireAt: "2026-07-08T15:00:00Z",
  });

  const got = store.get("task-1");
  assert(got !== null, "get 返回任务");
  assert(got?.title === "开会提醒", "get 标题正确");
  assert(got?.priority === 5, "get 优先级正确");
  assert(got?.tags.length === 2 && got.tags.includes("urgent"), "get tags 正确");
  assert(got?.umo === "test:umo", "get umo 正确");

  // list
  const listed = store.list(10);
  assert(listed.length === 1, "list 返回 1 个任务");

  // search by title
  const searched = store.search("开会", 10);
  assert(searched.length === 1, "search '开会' 找到 1 个");
  const noResults = store.search("不存在的关键词", 10);
  assert(noResults.length === 0, "search 无结果返回空数组");

  // count + stats
  assert(store.count() === 1, "count 返回 1");
  const stats = store.stats();
  assert(stats.total === 1, "stats.total = 1");
  assert(stats.byType.reminder === 1, "stats.byType.reminder = 1");
  assert(stats.byStatus.pending === 1, "stats.byStatus.pending = 1");

  // update (mutable fields only)
  store.update("task-1", { title: "重要会议提醒", priority: 10 });
  const updated = store.get("task-1");
  assert(updated?.title === "重要会议提醒", "update 修改标题");
  assert(updated?.priority === 10, "update 修改优先级");
  // original fields unchanged
  assert(updated?.description === "下午3点开会", "update 保留 description");
  assert(updated?.createdAt === got?.createdAt, "update 保留 createdAt");

  // delete
  const deleted = store.delete("task-1");
  assert(deleted, "delete 返回 true");
  assert(store.get("task-1") === null, "get 返回 null after delete");
  assert(store.count() === 0, "count 返回 0 after delete");

  console.log("  ✅ Store CRUD 测试通过");

  // ── Test: Recurrence computation ──
  console.log("\n=== 测试: Recurrence 计算 ===");

  const base = new Date("2026-07-08T12:00:00Z");
  const next1h = computeNextFireAt("1h", base);
  assert(next1h?.getTime() === base.getTime() + 3600_000, "1h → +1 小时");

  const next30m = computeNextFireAt("30m", base);
  assert(next30m?.getTime() === base.getTime() + 30 * 60_000, "30m → +30 分钟");

  const next45s = computeNextFireAt("45s", base);
  assert(next45s?.getTime() === base.getTime() + 45_000, "45s → +45 秒");

  const nextDaily = computeNextFireAt("daily", base);
  assert(nextDaily?.getTime() === base.getTime() + 24 * 3600_000, "daily → +24 小时");

  const nextWeekly = computeNextFireAt("weekly", base);
  assert(nextWeekly?.getTime() === base.getTime() + 7 * 24 * 3600_000, "weekly → +7 天");

  const invalid = computeNextFireAt("invalid", base);
  assert(invalid === null, "无效 recurrence 返回 null");

  const empty = computeNextFireAt("", base);
  assert(empty === null, "空 recurrence 返回 null");

  console.log("  ✅ Recurrence 计算测试通过");

  // ── Test: computeInitialNextFireAt ──
  console.log("\n=== 测试: computeInitialNextFireAt ===");

  const now = new Date();
  // scheduled_at in the future
  const future = new Date(now.getTime() + 3600_000).toISOString();
  const futureFire = computeInitialNextFireAt(future, null, now);
  assert(futureFire === future, "未来时间 → 用 scheduled_at");

  // scheduled_at in the past + recurring → compute next from now
  const past = new Date(now.getTime() - 3600_000).toISOString();
  const pastRecurring = computeInitialNextFireAt(past, "1h", now);
  assert(pastRecurring !== null && new Date(pastRecurring).getTime() > now.getTime(), "过去时间 + recurring → 计算未来 next");

  // no scheduled_at but recurring
  const recurringOnly = computeInitialNextFireAt(null, "1h", now);
  assert(recurringOnly !== null, "仅 recurring → 计算未来 next");

  // neither → null
  const nothing = computeInitialNextFireAt(null, null, now);
  assert(nothing === null, "无 scheduled_at 也无 recurrence → null");

  console.log("  ✅ computeInitialNextFireAt 测试通过");

  // ── Test: getDueTasks + markFired ──
  console.log("\n=== 测试: getDueTasks + markFired ===");

  // Clear store first
  store.clear();
  assert(store.count() === 0, "clear 后 count = 0");

  // Task A: one-shot reminder already due
  const pastDate = new Date(Date.now() - 60_000);
  store.save({
    id: "due-oneshot",
    type: "reminder",
    title: "已到期的提醒",
    description: "",
    status: "pending",
    priority: 5,
    scheduledAt: pastDate.toISOString(),
    recurrence: null,
    goal: null,
    plan: [],
    currentStep: -1,
    tags: [],
    umo: "test:umo",
    sessionId: "sess",
    platformId: "p",
    payload: null,
    lastFiredAt: null,
    nextFireAt: pastDate.toISOString(),
  });

  // Task B: recurring task already due
  store.save({
    id: "due-recurring",
    type: "recurring",
    title: "周期任务",
    description: "",
    status: "pending",
    priority: 5,
    scheduledAt: null,
    recurrence: "1h",
    goal: null,
    plan: [],
    currentStep: -1,
    tags: [],
    umo: "test:umo",
    sessionId: "sess",
    platformId: "p",
    payload: null,
    lastFiredAt: null,
    nextFireAt: pastDate.toISOString(),
  });

  // Task C: future task, not due
  const futureDate2 = new Date(Date.now() + 3600_000);
  store.save({
    id: "future-task",
    type: "reminder",
    title: "未来任务",
    description: "",
    status: "pending",
    priority: 5,
    scheduledAt: futureDate2.toISOString(),
    recurrence: null,
    goal: null,
    plan: [],
    currentStep: -1,
    tags: [],
    umo: "test:umo",
    sessionId: "sess",
    platformId: "p",
    payload: null,
    lastFiredAt: null,
    nextFireAt: futureDate2.toISOString(),
  });

  // Task D: completed task, should not be due even if nextFireAt passed
  store.save({
    id: "completed-task",
    type: "reminder",
    title: "已完成任务",
    description: "",
    status: "completed",
    priority: 5,
    scheduledAt: pastDate.toISOString(),
    recurrence: null,
    goal: null,
    plan: [],
    currentStep: -1,
    tags: [],
    umo: "test:umo",
    sessionId: "sess",
    platformId: "p",
    payload: null,
    lastFiredAt: null,
    nextFireAt: pastDate.toISOString(),
  });

  const dueTasks = store.getDueTasks(now);
  const dueIds = dueTasks.map(t => t.id).sort();
  assert(dueIds.length === 2, "getDueTasks 返回 2 个到期任务");
  assert(dueIds.includes("due-oneshot"), "getDueTasks 包含 due-oneshot");
  assert(dueIds.includes("due-recurring"), "getDueTasks 包含 due-recurring");
  assert(!dueIds.includes("future-task"), "getDueTasks 不包含 future-task");
  assert(!dueIds.includes("completed-task"), "getDueTasks 不包含 completed-task");

  // markFired: one-shot → completed
  store.markFired("due-oneshot", now);
  const firedOneShot = store.get("due-oneshot");
  assert(firedOneShot?.status === "completed", "markFired: 一次性任务 → completed");
  assert(firedOneShot?.nextFireAt === null, "markFired: 一次性任务 nextFireAt → null");
  assert(firedOneShot?.lastFiredAt !== null, "markFired: lastFiredAt 已设置");

  // markFired: recurring → recompute nextFireAt
  store.markFired("due-recurring", now);
  const firedRecurring = store.get("due-recurring");
  assert(firedRecurring?.status === "pending", "markFired: 周期任务 status 保持 pending");
  assert(firedRecurring?.nextFireAt !== null, "markFired: 周期任务 nextFireAt 已重算");
  const nextFire = new Date(firedRecurring!.nextFireAt!);
  assert(nextFire.getTime() > now.getTime(), "markFired: 周期任务 nextFireAt 在未来");
  assert(nextFire.getTime() <= now.getTime() + 3600_000 + 1000, "markFired: 周期任务 nextFireAt 不超过 1h 后");

  console.log("  ✅ getDueTasks + markFired 测试通过");

  // ── Test: Scheduler Tool actions ──
  console.log("\n=== 测试: Scheduler Tool (agent 操作) ===");

  store.clear();
  const adminCtx = {
    context: {
      event: {
        unifiedMsgOrigin: "test:umo",
        sessionId: "sess-1",
        personaId: "p1",
        platformId: "test-platform",
      },
    },
    messages: [],
    toolCallTimeout: 30,
  };

  // ─ create ─
  const createResult = await call(schedulerTool, adminCtx, {
    action: "create",
    type: "reminder",
    title: "测试提醒",
    description: "这是一个测试",
    payload: "payload-content",
    tags: ["tag1", "tag2"],
  });
  const createText = getText(createResult);
  assert(createText.includes("Task created"), "create: 返回成功");
  assert(createText.includes("reminder"), "create: 类型为 reminder");
  // 提取创建的 id
  const createdIdMatch = createText.match(/id: ([^,]+)/);
  assert(createdIdMatch !== null, "create: 包含 id");
  const createdTaskId = createdIdMatch![1].trim();
  const createdTask = store.get(createdTaskId);
  assert(createdTask !== null, "create: store 中可查到");
  assert(createdTask?.umo === "test:umo", "create: umo 自动绑定");
  assert(createdTask?.sessionId === "sess-1", "create: sessionId 自动绑定");
  assert(createdTask?.tags.length === 2, "create: tags 已保存");

  // ─ get ─
  const getResult = await call(schedulerTool, adminCtx, { action: "get", id: createdTaskId });
  const getTextResult = getText(getResult);
  assert(getTextResult.includes(createdTaskId), "get: 返回任务 id");
  assert(getTextResult.includes("测试提醒"), "get: 返回任务标题");
  assert(getTextResult.includes("tag1"), "get: 返回 tags");

  // ─ create without title → error ─
  const errResult = await call(schedulerTool, adminCtx, { action: "create", type: "reminder" });
  assert(getText(errResult).includes("error:"), "create 无 title 返回错误");

  // ─ create with invalid type → error ─
  const errTypeResult = await call(schedulerTool, adminCtx, {
    action: "create",
    type: "invalid_type" as any,
    title: "title",
  });
  assert(getText(errTypeResult).includes("error:"), "create 无效 type 返回错误");

  // ─ list ─
  const listResult = await call(schedulerTool, adminCtx, { action: "list", limit: 10 });
  const listText = getText(listResult);
  assert(listText.includes("1 task"), "list: 返回 1 个任务");
  assert(listText.includes("测试提醒"), "list: 包含任务标题");

  // ─ search ─
  const searchResult = await call(schedulerTool, adminCtx, { action: "search", query: "测试", limit: 10 });
  assert(getText(searchResult).includes("1 task"), "search: 找到 1 个结果");

  const noMatchResult = await call(schedulerTool, adminCtx, { action: "search", query: "不存在的词", limit: 10 });
  assert(getText(noMatchResult).includes("No tasks"), "search: 无结果返回 No tasks");

  // ─ update ─
  const updateResult = await call(schedulerTool, adminCtx, {
    action: "update",
    id: createdTaskId,
    title: "已更新标题",
    description: "已更新描述",
    status: "active",
    priority: 8,
  });
  assert(getText(updateResult).includes("Task updated"), "update: 返回成功");
  const updatedTask = store.get(createdTaskId);
  assert(updatedTask?.title === "已更新标题", "update: 标题已修改");
  assert(updatedTask?.description === "已更新描述", "update: 描述已修改");
  assert(updatedTask?.status === "active", "update: status 已修改");
  assert(updatedTask?.priority === 8, "update: priority 已修改");

  // ─ set_goal ─
  const setGoalResult = await call(schedulerTool, adminCtx, {
    action: "set_goal",
    goal: "完成定时任务功能",
  });
  const setGoalText = getText(setGoalResult);
  assert(setGoalText.includes("Goal set"), "set_goal: 返回成功");
  const goalIdMatch = setGoalText.match(/id: ([^,)]+)/);
  assert(goalIdMatch !== null, "set_goal: 返回 id");
  const goalId = goalIdMatch![1].trim();
  const goalTask = store.get(goalId);
  assert(goalTask?.type === "goal", "set_goal: 类型为 goal");
  assert(goalTask?.goal === "完成定时任务功能", "set_goal: goal 内容正确");
  assert(goalTask?.status === "active", "set_goal: status 为 active");

  // ─ get_goal ─
  const getGoalResult = await call(schedulerTool, adminCtx, { action: "get_goal" });
  assert(getText(getGoalResult).includes("完成定时任务功能"), "get_goal: 返回目标内容");

  // ─ set_plan ─
  const planSteps = [
    { description: "设计存储", status: "completed" },
    { description: "实现工具", status: "in_progress" },
    { description: "测试验证", status: "pending" },
  ];
  const setPlanResult = await call(schedulerTool, adminCtx, {
    action: "set_plan",
    goal: "实现定时任务",
    plan: planSteps,
  });
  const setPlanText = getText(setPlanResult);
  assert(setPlanText.includes("Plan set"), "set_plan: 返回成功");
  assert(setPlanText.includes("3 steps"), "set_plan: 3 个步骤");
  const planIdMatch = setPlanText.match(/id: ([^,)]+)/);
  assert(planIdMatch !== null, "set_plan: 返回 id");
  const planId = planIdMatch![1].trim();
  const planTask = store.get(planId);
  assert(planTask?.type === "plan", "set_plan: 类型为 plan");
  assert(planTask?.plan.length === 3, "set_plan: 3 个步骤");
  assert(planTask?.currentStep === 0, "set_plan: currentStep = 0");

  // ─ update_step: 完成第 1 步 (index 0) ─
  const updateStepResult = await call(schedulerTool, adminCtx, {
    action: "update_step",
    id: planId,
    stepIndex: 0,
    stepStatus: "completed",
  });
  const updateStepText = getText(updateStepResult);
  assert(updateStepText.includes("Step 0 -> completed"), "update_step: 第 0 步完成");
  // step 0 completed → currentStep 自动推进到 1
  const planTaskAfterStep = store.get(planId);
  assert(planTaskAfterStep?.plan[0].status === "completed", "update_step: step 0 status = completed");
  assert(planTaskAfterStep?.currentStep === 1, "update_step: currentStep 自动推进到 1");

  // ─ update_step: 设置第 2 步为 in_progress ─
  await call(schedulerTool, adminCtx, {
    action: "update_step",
    id: planId,
    stepIndex: 1,
    stepStatus: "in_progress",
  });
  const planTaskAfterStep2 = store.get(planId);
  assert(planTaskAfterStep2?.plan[1].status === "in_progress", "update_step: step 1 status = in_progress");

  // ─ next_step: 推进到下一步 ─
  const nextStepResult = await call(schedulerTool, adminCtx, { action: "next_step", id: planId });
  const nextStepText = getText(nextStepResult);
  // After: step 0 completed, step 1 in_progress → next_step should mark step 2 as in_progress
  const planTaskAfterNext = store.get(planId);
  assert(planTaskAfterNext?.plan[2].status === "in_progress", "next_step: step 2 标记为 in_progress");
  assert(planTaskAfterNext?.currentStep === 2, "next_step: currentStep = 2");
  assert(nextStepText.includes("Advanced to step 2"), "next_step: 返回推进消息");

  // ─ 完成所有步骤 → plan 自动标记 completed ─
  await call(schedulerTool, adminCtx, {
    action: "update_step",
    id: planId,
    stepIndex: 2,
    stepStatus: "completed",
  });
  // step 1 was in_progress, now needs to be marked completed too
  await call(schedulerTool, adminCtx, {
    action: "update_step",
    id: planId,
    stepIndex: 1,
    stepStatus: "completed",
  });
  const planTaskAllDone = store.get(planId);
  assert(planTaskAllDone?.status === "completed", "update_step: 全部步骤完成 → plan status = completed");

  // ─ fire_now ─
  // Create a fresh task for fire_now
  const fireNowCreate = await call(schedulerTool, adminCtx, {
    action: "create",
    id: "fire-test",
    type: "reminder",
    title: "fire_now 测试",
  });
  assert(getText(fireNowCreate).includes("Task created"), "fire_now: 创建任务成功");

  const fireNowResult = await call(schedulerTool, adminCtx, { action: "fire_now", id: "fire-test" });
  const fireNowText = getText(fireNowResult);
  assert(fireNowText.includes("fired"), "fire_now: 返回 fired");
  assert(fireNowText.includes("none"), "fire_now: 一次性任务 next = none");
  const firedTask = store.get("fire-test");
  assert(firedTask?.status === "completed", "fire_now: 一次性任务 → completed");
  assert(firedTask?.lastFiredAt !== null, "fire_now: lastFiredAt 已设置");

  // ─ stats ─
  const statsResult = await call(schedulerTool, adminCtx, { action: "stats" });
  const statsText = getText(statsResult);
  assert(statsText.includes("Total tasks:"), "stats: 返回总数");
  assert(statsText.includes("By Type:"), "stats: 返回类型分布");
  assert(statsText.includes("By Status:"), "stats: 返回状态分布");

  // ─ delete ─
  const deleteResult = await call(schedulerTool, adminCtx, { action: "delete", id: createdTaskId });
  assert(getText(deleteResult).includes("Task deleted"), "delete: 返回成功");
  assert(store.get(createdTaskId) === null, "delete: store 中已删除");

  // delete non-existent → error
  const deleteNotFoundResult = await call(schedulerTool, adminCtx, { action: "delete", id: "non-existent-id" });
  assert(getText(deleteNotFoundResult).includes("not found"), "delete 不存在的 id → not found");

  console.log("  ✅ Scheduler Tool 测试通过");

  // ── Test: TaskScheduler.tick() delivers via adapter ──
  console.log("\n=== 测试: TaskScheduler.tick() ===");

  // Mock adapter to capture proactive messages
  const deliveredMessages: Array<{ target: any; text: string }> = [];
  const mockAdapter = {
    meta: () => ({ name: "mock", description: "Mock", id: "p", supportStreamingMessage: false, supportProactiveMessage: true }),
    sendProactiveMessage: async (target: any, components: any[]): Promise<boolean> => {
      const text = components.filter((c: any) => c.type === "text" || c.text).map((c: any) => c.text ?? "").join("");
      deliveredMessages.push({ target, text });
      return true;
    },
  };
  const mockRegistry = {
    getAdapter: (id: string) => (id === "p" ? mockAdapter : undefined),
  } as any;

  // Fresh store for this test
  const db2 = new Database(":memory:");
  db2.pragma("foreign_keys = ON");
  for (const m of SCHEDULER_MIGRATIONS) {
    db2.exec(m.up);
  }
  const store2 = new SqliteSchedulerTaskStore(db2);
  const taskScheduler = new TaskScheduler(store2, { interval: 60000 });
  taskScheduler.setAdapterRegistry(mockRegistry);

  // No tasks → tick does nothing
  await taskScheduler.tick();

  // Add a due task with routing info
  store2.save({
    id: "fire-me",
    type: "reminder",
    title: "到期任务",
    description: "应触发",
    status: "pending",
    priority: 5,
    scheduledAt: pastDate.toISOString(),
    recurrence: null,
    goal: null,
    plan: [],
    currentStep: -1,
    tags: [],
    umo: "test:fire:umo",
    sessionId: "sess-fire",
    platformId: "p",
    payload: "触发 payload",
    lastFiredAt: null,
    nextFireAt: pastDate.toISOString(),
  });

  await taskScheduler.tick();

  // Proactive message should be delivered via adapter
  assert(deliveredMessages.length === 1, "tick: 到期任务通过 adapter 推送 (1 条消息)");
  assert(deliveredMessages[0]?.target.umo === "test:fire:umo", "tick: 推送目标 umo 正确");
  assert(deliveredMessages[0]?.text.includes("到期任务"), "tick: 推送消息包含任务标题");
  assert(deliveredMessages[0]?.text.includes("触发 payload"), "tick: 推送消息包含 payload");

  // Task should be marked fired + completed
  const firedTask2 = store2.get("fire-me");
  assert(firedTask2?.status === "completed", "tick: 触发后任务 → completed");
  assert(firedTask2?.lastFiredAt !== null, "tick: 触发后 lastFiredAt 已设置");

  // Add a due task WITHOUT routing info (no umo) → skipped, still marked fired
  store2.save({
    id: "no-rumo",
    type: "reminder",
    title: "无路由任务",
    description: "",
    status: "pending",
    priority: 5,
    scheduledAt: pastDate.toISOString(),
    recurrence: null,
    goal: null,
    plan: [],
    currentStep: -1,
    tags: [],
    umo: null,
    sessionId: null,
    platformId: null,
    payload: null,
    lastFiredAt: null,
    nextFireAt: pastDate.toISOString(),
  });
  const deliveredBefore = deliveredMessages.length;
  await taskScheduler.tick();
  assert(deliveredMessages.length === deliveredBefore, "tick: 无 umo 任务不推送");
  const noUmoTask = store2.get("no-rumo");
  assert(noUmoTask?.status === "completed", "tick: 无 umo 任务仍被标记 completed");

  // Recurring task with umo: should deliver and recompute next
  store2.save({
    id: "recurring-fire",
    type: "recurring",
    title: "周期触发",
    description: "",
    status: "pending",
    priority: 5,
    scheduledAt: null,
    recurrence: "1h",
    goal: null,
    plan: [],
    currentStep: -1,
    tags: [],
    umo: "test:recurring:umo",
    sessionId: "sess-r",
    platformId: "p",
    payload: null,
    lastFiredAt: null,
    nextFireAt: pastDate.toISOString(),
  });
  await taskScheduler.tick();
  assert(deliveredMessages.length === deliveredBefore + 1, "tick: 周期任务被推送");
  const recurringTaskAfter = store2.get("recurring-fire");
  assert(recurringTaskAfter?.status === "pending", "tick: 周期任务保持 pending");
  assert(recurringTaskAfter?.nextFireAt !== null, "tick: 周期任务 nextFireAt 已重算");
  assert(new Date(recurringTaskAfter!.nextFireAt!).getTime() > now.getTime(), "tick: 周期任务 nextFireAt 在未来");

  // start/stop should not throw
  taskScheduler.start();
  taskScheduler.stop();
  taskScheduler.stop(); // double stop is safe

  console.log("  ✅ TaskScheduler.tick() 测试通过");

  // ── Final summary ──
  console.log("\n╔══════════════════════════════════════════╗");
  console.log(`║   通过: ${passCount}  失败: ${failCount}`.padEnd(46) + "║");
  console.log("╚══════════════════════════════════════════╝");

  if (failCount > 0) {
    console.error(`❌ ${failCount} 项测试失败`);
    process.exit(1);
  }
  console.log("🎉 所有定时任务功能测试通过!");
  process.exit(0);
}

main().catch((e) => {
  console.error("测试执行失败:", e);
  process.exit(1);
});
