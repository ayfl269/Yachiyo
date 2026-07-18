import type { ToolLoopAgentRunner } from "./runners/tool-loop-agent-runner.js";
import { MAX_STEPS_REACHED_PROMPT } from "./runners/tool-loop-agent-runner.js";
import type { LLMResponse, MessageChain } from "./types.js";
import { createMessageChain } from "./types.js";

export interface RunAgentOptions {
  maxStep?: number;
  showToolUse?: boolean;
  showToolCallResult?: boolean;
  streamToGeneral?: boolean;
  showReasoning?: boolean;
  bufferIntermediateMessages?: boolean;
  shouldStop?: () => boolean;
  onToolCall?: (toolInfo: { id: string; name: string; args: Record<string, unknown> }) => void;
  onToolResult?: (toolInfo: { id: string; name: string; result: string }) => void;
  onStreamingDelta?: (chain: MessageChain) => void;
  onLlmResult?: (chain: MessageChain) => void;
  onError?: (error: string) => void;
  /**
   * Called at the start of each agent step (before `agentRunner.step()`).
   *
   * Used by the pipeline to renew the session lock TTL so the watchdog
   * does not force-release it during long multi-step tool execution.
   * The callback is framework-agnostic so this module stays decoupled
   * from {@link SessionLockManager}.
   */
  onStepStart?: () => void;
}

export interface RunAgentResult {
  finalResponse: LLMResponse | null;
  steps: number;
  wasAborted: boolean;
  chains: MessageChain[];
}

/**
 * High-level agent runner that processes AgentResponse stream and collects results.
 *
 * This is a framework-agnostic version of Python's runAgent().
 * It does not depend on MessageEvent or other framework-specific types.
 */
export async function runAgent<TContext = unknown>(
  agentRunner: ToolLoopAgentRunner<TContext>,
  options: RunAgentOptions = {}
): Promise<RunAgentResult> {
  const {
    maxStep = 30,
    streamToGeneral = false,
    showReasoning = false,
    bufferIntermediateMessages = false,
    shouldStop,
    onToolCall,
    onToolResult,
    onStreamingDelta,
    onLlmResult,
    onError,
    onStepStart,
  } = options;

  const chains: MessageChain[] = [];
  const toolNameByCallId = new Map<string, string>();
  const bufferedLlmChains: MessageChain[] = [];
  const canBuffer = bufferIntermediateMessages && !streamToGeneral && !agentRunner.isStreaming;
  let steps = 0;

  while (steps < maxStep + 1) {
    steps++;

    // Renew session lock TTL at the start of each step so the watchdog
    // does not force-release it during long multi-step tool execution.
    // Mirrors the same logic in runAgentStreaming() (see process.ts).
    try {
      onStepStart?.();
    } catch (e) {
      // Renewal is best-effort; never fail the step because of it.
      console.warn(`[runAgent] onStepStart callback failed: ${e}`);
    }

    // Max steps enforcement
    if (steps === maxStep + 1) {
      console.warn(`Agent reached max steps (${maxStep}), forcing a final response.`);
      if (!agentRunner.done()) {
        const req = agentRunner.currentRequest;
        if (req) req.funcTool = undefined;
        agentRunner.currentRunContext.messages.push({
          role: "user",
          content: MAX_STEPS_REACHED_PROMPT,
        });
      }
    }

    // Check stop signal
    if (shouldStop?.()) {
      agentRunner.requestStop();
    }

    try {
      for await (const resp of agentRunner.step()) {
        if (shouldStop?.()) {
          agentRunner.requestStop();
        }

        // Handle aborted
        if (resp.type === "aborted") {
          if (canBuffer) {
            const merged = mergeBufferedChains(bufferedLlmChains);
            if (merged) chains.push(merged);
          }
          return {
            finalResponse: agentRunner.getFinalLlmResp(),
            steps,
            wasAborted: true,
            chains,
          };
        }

        if (shouldStop?.()) continue;

        // Handle tool_call_result
        if (resp.type === "tool_call_result") {
          const chain = resp.data.chain;
          if (chain) {
            const resultData = extractChainJsonData(chain);
            if (resultData) {
              const toolCallId = String(resultData.id ?? "");
              const toolName = toolNameByCallId.get(toolCallId) ?? "unknown";
              const toolResult = String(resultData.result ?? "");
              onToolResult?.({ id: toolCallId, name: toolName, result: toolResult });
            }
          }
          continue;
        }

        // Handle tool_call
        if (resp.type === "tool_call") {
          const chain = resp.data.chain;
          if (chain) {
            const toolInfo = extractChainJsonData(chain);
            if (toolInfo) {
              const toolCallId = String(toolInfo.id ?? "");
              const toolName = String(toolInfo.name ?? "unknown");
              toolNameByCallId.set(toolCallId, toolName);
              onToolCall?.({
                id: toolCallId,
                name: toolName,
                args: (toolInfo.args as Record<string, unknown>) ?? {},
              });
            }
          }
          continue;
        }

        // Handle llm_result
        if (resp.type === "llm_result") {
          const chain = resp.data.chain;
          if (chain?.type === "reasoning") {
            continue; // Skip reasoning in non-streaming mode
          }
          if (canBuffer) {
            bufferedLlmChains.push(chain);
            continue;
          }
          onLlmResult?.(chain);
          chains.push(chain);
          continue;
        }

        // Handle streaming_delta
        if (resp.type === "streaming_delta") {
          if (streamToGeneral) continue;
          const chain = resp.data.chain;
          if (chain?.type === "reasoning" && !showReasoning) continue;
          onStreamingDelta?.(chain);
          continue;
        }

        // Handle error
        if (resp.type === "err") {
          const errMsg = resp.data.chain?.message ?? "Unknown error";
          onError?.(errMsg);
          chains.push(resp.data.chain);
          continue;
        }
      }

      // Flush buffered chains when agent is done
      if (canBuffer && agentRunner.done()) {
        const merged = mergeBufferedChains(bufferedLlmChains);
        if (merged) {
          onLlmResult?.(merged);
          chains.push(merged);
        }
      }

      if (agentRunner.done()) break;
    } catch (e) {
      const errMsg = `Error during agent execution: ${e instanceof Error ? e.message : String(e)}`;
      console.error(errMsg);
      onError?.(errMsg);

      const errorResponse: LLMResponse = {
        role: "assistant",
        completionText: errMsg,
        isChunk: false,
      };

      chains.push(createMessageChain("assistant", errMsg));

      return {
        finalResponse: errorResponse,
        steps,
        wasAborted: false,
        chains,
      };
    }
  }

  return {
    finalResponse: agentRunner.getFinalLlmResp(),
    steps,
    wasAborted: agentRunner.wasAborted(),
    chains,
  };
}

/**
 * Live Mode agent runner with TTS support.
 *
 * This is a framework-agnostic version of Python's runLiveAgent().
 * Instead of directly integrating with a specific TTS provider, it yields
 * text chunks that can be consumed by an external TTS pipeline.
 */
export async function* runLiveAgent<TContext = unknown>(
  agentRunner: ToolLoopAgentRunner<TContext>,
  options: RunAgentOptions = {}
): AsyncGenerator<{ type: "text" | "audio"; text: string; audio?: Buffer }, void, unknown> {
  const textQueue: (string | null)[] = [];
  let done = false;
  let agentError: unknown = null;

  // Run agent in background, feeding text chunks into queue
  const agentPromise = runAgent(agentRunner, {
    ...options,
    onStreamingDelta: (chain) => {
      const text = chain.message ?? "";
      if (text) textQueue.push(text);
    },
    onLlmResult: (chain) => {
      const text = chain.message ?? "";
      if (text) textQueue.push(text);
    },
  });

  agentPromise.then(() => {
    done = true;
    textQueue.push(null); // Signal end
  }).catch((e) => {
    done = true;
    agentError = e;
    textQueue.push(null);
    console.error(`Live agent error: ${e}`);
  });

  // Yield text chunks as they arrive
  while (!done || textQueue.length > 0) {
    const chunk = textQueue.shift();
    if (chunk === null || chunk === undefined) {
      if (done) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    yield { type: "text", text: chunk };
  }

  // Wait for agent to fully complete
  await agentPromise;

  // Propagate agent error to consumer so they can distinguish failure from normal end
  if (agentError) throw agentError;
}

// ---- Helpers ----

function extractChainJsonData(chain: MessageChain): Record<string, unknown> | null {
  if (!chain?.message) return null;
  try {
    return JSON.parse(chain.message) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function mergeBufferedChains(bufferedChains: MessageChain[]): MessageChain | null {
  if (!bufferedChains.length) return null;
  const merged = createMessageChain("llm_result");
  const messages: string[] = [];
  for (const chain of bufferedChains) {
    if (chain.message) messages.push(chain.message);
  }
  merged.message = messages.join("");
  bufferedChains.length = 0;
  return merged;
}
