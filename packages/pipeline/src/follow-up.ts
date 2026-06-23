import { Condition } from "@yachiyo/common/condition.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import type { MessageChain } from "@yachiyo/agent/types.js";
import type { ToolLoopAgentRunner } from "@yachiyo/agent/runners/tool-loop-agent-runner.js";

const ACTIVE_AGENT_RUNNERS = new Map<string, ToolLoopAgentRunner>();

interface FollowUpOrderState {
  condition: Condition;
  statuses: Map<number, "pending" | "active" | "consumed" | "finished">;
  nextOrder: number;
  nextTurn: number;
}

const FOLLOW_UP_ORDER_STATE = new Map<string, FollowUpOrderState>();

// Stale entry cleanup: periodically remove entries whose runner is gone
// and no activity has occurred for a while.
const STALE_FOLLOW_UP_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startFollowUpCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [umo, state] of FOLLOW_UP_ORDER_STATE) {
      // If the runner is gone and all statuses are resolved, clean up immediately
      if (!ACTIVE_AGENT_RUNNERS.has(umo) && state.statuses.size === 0) {
        FOLLOW_UP_ORDER_STATE.delete(umo);
        continue;
      }
      // If the runner is gone and the entry has been idle too long, force-clean
      if (!ACTIVE_AGENT_RUNNERS.has(umo)) {
        const oldestPending = Math.min(
          ...Array.from(state.statuses.values()).map((_, i) => i), // no timestamps, use size heuristic
        );
        // If runner is gone but statuses remain, notifyAll to unblock waiters then delete
        state.condition.notifyAll();
        state.statuses.clear();
        FOLLOW_UP_ORDER_STATE.delete(umo);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }
}

// Auto-start cleanup on first use
startFollowUpCleanup();

export interface FollowUpTicket {
  resolved: Promise<void>;
  consumed: boolean;
}

export interface FollowUpCapture {
  umo: string;
  ticket: FollowUpTicket;
  orderSeq: number;
}

export function registerActiveRunner(umo: string, runner: ToolLoopAgentRunner): void {
  ACTIVE_AGENT_RUNNERS.set(umo, runner);
}

export function unregisterActiveRunner(umo: string, runner: ToolLoopAgentRunner): void {
  if (ACTIVE_AGENT_RUNNERS.get(umo) === runner) {
    ACTIVE_AGENT_RUNNERS.delete(umo);
  }
}

export function tryCaptureFollowUp(event: MessageEvent): FollowUpCapture | null {
  const runner = ACTIVE_AGENT_RUNNERS.get(event.unifiedMsgOrigin);
  if (!runner) return null;

  const runnerEvent = runner.currentRunContext?.context as MessageEvent | undefined;
  if (!runnerEvent) return null;
  if (runnerEvent.getExtra("agent_stop_requested")) return null;

  const ticket = runner.followUp?.((event.getMessageStr() ?? "").trim());
  if (!ticket) return null;

  const orderSeq = allocateFollowUpOrder(event.unifiedMsgOrigin);

  return { umo: event.unifiedMsgOrigin, ticket, orderSeq };
}

export async function prepareFollowUpCapture(capture: FollowUpCapture): Promise<[boolean, boolean]> {
  await capture.ticket.resolved;
  if (capture.ticket.consumed) {
    await markFollowUpConsumed(capture.umo, capture.orderSeq);
    return [true, false];
  }
  await activateAndWaitFollowUpTurn(capture.umo, capture.orderSeq);
  return [false, true];
}

function allocateFollowUpOrder(umo: string): number {
  let state = FOLLOW_UP_ORDER_STATE.get(umo);
  if (!state) {
    state = { condition: new Condition(), statuses: new Map(), nextOrder: 0, nextTurn: 0 };
    FOLLOW_UP_ORDER_STATE.set(umo, state);
  }
  const seq = state.nextOrder++;
  state.statuses.set(seq, "pending");
  return seq;
}

async function activateAndWaitFollowUpTurn(umo: string, seq: number): Promise<void> {
  const state = FOLLOW_UP_ORDER_STATE.get(umo);
  if (!state) return;
  state.statuses.set(seq, "active");

  while (state.nextTurn !== seq) {
    await state.condition.wait();
  }
}

async function markFollowUpConsumed(umo: string, seq: number): Promise<void> {
  const state = FOLLOW_UP_ORDER_STATE.get(umo);
  if (!state) return;
  state.statuses.set(seq, "consumed");
  advanceFollowUpTurn(state);
  state.condition.notifyAll();
}

export async function finishFollowUpTurn(umo: string, seq: number): Promise<void> {
  const state = FOLLOW_UP_ORDER_STATE.get(umo);
  if (!state) return;
  state.statuses.set(seq, "finished");
  advanceFollowUpTurn(state);
  state.condition.notifyAll();

  if (state.statuses.size === 0 && !ACTIVE_AGENT_RUNNERS.has(umo)) {
    FOLLOW_UP_ORDER_STATE.delete(umo);
  }
}

function advanceFollowUpTurn(state: FollowUpOrderState): void {
  while (true) {
    const curr = state.statuses.get(state.nextTurn);
    if (curr === "consumed" || curr === "finished") {
      state.statuses.delete(state.nextTurn);
      state.nextTurn++;
      continue;
    }
    break;
  }
}
