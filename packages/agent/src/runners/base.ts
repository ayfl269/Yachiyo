import { AgentState } from "../types.js";
import type { AgentResponse, LLMResponse, ContextWrapper } from "../types.js";
import type { BaseAgentRunHooks } from "../hooks.js";

export abstract class BaseAgentRunner<TContext = unknown> {
  protected state: AgentState = AgentState.IDLE;

  abstract reset(
    runContext: ContextWrapper<TContext>,
    agentHooks: BaseAgentRunHooks<TContext>,
    ...args: unknown[]
  ): Promise<void>;

  abstract step(): AsyncGenerator<AgentResponse, void, unknown>;

  abstract stepUntilDone(maxStep: number): AsyncGenerator<AgentResponse, void, unknown>;

  abstract done(): boolean;

  abstract getFinalLlmResp(): LLMResponse | null;

  protected transitionState(newState: AgentState): void {
    if (this.state !== newState) {
      this.state = newState;
    }
  }
}
