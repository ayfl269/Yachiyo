import type { ContextWrapper, CallToolResult } from "./types.js";
import { ToolTimeoutError } from "./types.js";
import type { FunctionTool } from "./tool.js";
import type { HandoffTool } from "./handoff.js";
import type { MCPToolInstance } from "./mcp-tool.js";
import { ToolSet } from "./tool.js";
import type { Provider } from "./types.js";
import { createContextWrapper } from "./types.js";
import { EmptyAgentHooks } from "./hooks.js";
import { validateMessage } from "./message.js";
import type { Message } from "./message.js";
import { collectAndValidateImageUrls } from "./image-ref-utils.js";
import {
  applySandboxPolicyToToolSet,
  DEFAULT_DYNAMIC_SUBAGENT_POLICY,
  DEFAULT_PRECONFIGURED_SUBAGENT_POLICY,
  type SandboxPolicy,
} from "./sandbox.js";
import { fileLockManager } from "./coordination.js";
import { EventEmitter } from "events";

// ── Background Task Wake-up Infrastructure ──

export interface BackgroundTaskResult {
  taskId: string;
  toolName: string;
  resultText: string;
  toolArgs: Record<string, unknown>;
  note: string;
  summaryName: string;
}

/**
 * Interface for waking the main agent when a background task completes.
 * Framework-specific code should implement this interface and register it
 * via `BackgroundTaskBus.setWaker()`.
 *
 * Example implementation:
 * ```ts
 * const waker: BackgroundTaskWaker = {
 *   async wake(result) {
 *     // Create a mechanism to re-trigger the main agent with the background result
 *     await platform.sendMessage(result.taskId, result.resultText);
 *   }
 * };
 * backgroundTaskBus.setWaker(waker);
 * ```
 */
export interface BackgroundTaskWaker {
  wake(result: BackgroundTaskResult): Promise<void>;
}

/**
 * Singleton event bus for background task completion notifications.
 *
 * Provides two mechanisms for handling background task results:
 * 1. **Event-based**: Subscribe to "task_completed" events via `onTaskCompleted()`
 * 2. **Waker-based**: Register a `BackgroundTaskWaker` via `setWaker()` —
 *    this is the recommended approach for framework integration.
 *
 * When a background task completes, the bus:
 * 1. Emits a "task_completed" event
 * 2. Calls the registered waker (if any)
 * 3. Logs the result
 */
class BackgroundTaskEventBus extends EventEmitter {
  private static instance: BackgroundTaskEventBus | null = null;
  private waker: BackgroundTaskWaker | null = null;

  static getInstance(): BackgroundTaskEventBus {
    if (!BackgroundTaskEventBus.instance) {
      BackgroundTaskEventBus.instance = new BackgroundTaskEventBus();
      BackgroundTaskEventBus.instance.setMaxListeners(50);
    }
    return BackgroundTaskEventBus.instance;
  }

  /** Register a waker that will be called when any background task completes. */
  setWaker(waker: BackgroundTaskWaker | null): void {
    this.waker = waker;
  }

  /** Get the currently registered waker, if any. */
  getWaker(): BackgroundTaskWaker | null {
    return this.waker;
  }

  /**
   * Notify that a background task has completed.
   * Emits event, calls waker, and logs.
   */
  async notifyCompleted(result: BackgroundTaskResult): Promise<void> {
    // 1. Emit event for subscribers
    this.emit("task_completed", result);

    // 2. Call waker if registered
    if (this.waker) {
      try {
        await this.waker.wake(result);
      } catch (e) {
        console.error(`[BackgroundTask] Waker failed for task ${result.taskId}:`, e);
      }
    }

    // 3. Log
    console.info(
      `[BackgroundTask] ${result.summaryName} (task_id=${result.taskId}) finished. ` +
      `Result: ${result.resultText || "no content"}`
    );
  }

  /** Subscribe to task_completed events. Returns an unsubscribe function. */
  onTaskCompleted(listener: (result: BackgroundTaskResult) => void): () => void {
    this.on("task_completed", listener);
    return () => { this.off("task_completed", listener); };
  }

  /** Wait for a specific task to complete. Returns a promise that resolves with the result.
   *  Rejects with an error if the task doesn't complete within the specified timeout.
   */
  waitForTask(taskId: string, timeoutMs: number = 30 * 60 * 1000): Promise<BackgroundTaskResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const listener = (result: BackgroundTaskResult) => {
        if (result.taskId === taskId) {
          if (timer) clearTimeout(timer);
          this.off("task_completed", listener);
          settled = true;
          resolve(result);
        }
      };

      this.on("task_completed", listener);

      timer = setTimeout(() => {
        if (!settled) {
          this.off("task_completed", listener);
          reject(new Error(`waitForTask timed out after ${timeoutMs}ms for task ${taskId}`));
        }
      }, timeoutMs);

      // Don't prevent process exit
      if (timer && typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
    });
  }
}

export const backgroundTaskBus = BackgroundTaskEventBus.getInstance();

export abstract class BaseFunctionToolExecutor<TContext = unknown> {
  abstract execute(
    tool: FunctionTool<TContext>,
    runContext: ContextWrapper<TContext>,
    toolArgs: Record<string, unknown>
  ): AsyncGenerator<CallToolResult | null, void, unknown>;
}

/**
 * FunctionToolExecutor - dispatches tool execution based on tool type.
 * - HandoffTool → delegate to sub-agent
 * - MCPTool → call via MCP protocol
 * - Background task → return task_id immediately, execute async
 * - Local tool → execute handler
 */
/**
 * Extract tool arguments in the order defined by the tool's parameter schema.
 * This preserves parameter-name mapping instead of using Object.values()
 * which can produce misordered arguments.
 */
function extractOrderedArgs(
  tool: FunctionTool,
  toolArgs: Record<string, unknown>
): unknown[] {
  const params = tool.parameters as Record<string, unknown> | undefined;
  if (!params?.properties || typeof params.properties !== "object") {
    // No schema to order by; fall back to values in declaration order
    return Object.values(toolArgs);
  }
  const propOrder = Object.keys(params.properties as Record<string, unknown>);
  const result: unknown[] = [];
  for (const key of propOrder) {
    if (key in toolArgs) {
      result.push(toolArgs[key]);
    }
  }
  // Include any extra args not in the schema
  for (const [key, value] of Object.entries(toolArgs)) {
    if (!propOrder.includes(key)) {
      result.push(value);
    }
  }
  return result;
}

export class FunctionToolExecutor<TContext = unknown> extends BaseFunctionToolExecutor<TContext> {
  async *execute(
    tool: FunctionTool<TContext>,
    runContext: ContextWrapper<TContext>,
    toolArgs: Record<string, unknown>
  ): AsyncGenerator<CallToolResult | null, void, unknown> {
    console.log(`[ToolExecutor] execute() called for tool: ${tool.name}, args keys: [${Object.keys(toolArgs).join(', ')}]`);

    // Check for HandoffTool
    if ("agent" in tool && tool.agent != null) {
      console.log(`[ToolExecutor] ${tool.name} -> HandoffTool (agent=${(tool as any).agent?.name})`);
      const isBg = Boolean(toolArgs.background_task);
      delete toolArgs.background_task;
      if (isBg) {
        yield* this.executeHandoffBackground(tool as HandoffTool<TContext>, runContext, toolArgs);
      } else {
        yield* this.executeHandoff(tool as HandoffTool<TContext>, runContext, toolArgs);
      }
      return;
    }

    if ("mcpClient" in tool && tool.mcpClient != null) {
      console.log(`[ToolExecutor] ${tool.name} -> MCPTool`);
      yield* this.executeMcp(tool as MCPToolInstance<TContext>, runContext, toolArgs);
      return;
    }

    // Check for background task
    if (tool.isBackgroundTask) {
      const taskId = crypto.randomUUID();
      console.log(`[ToolExecutor] ${tool.name} -> Background task (taskId=${taskId})`);
      this.executeBackground(tool, runContext, taskId, toolArgs).catch(console.error);
      yield {
        content: [{ type: "text" as const, text: `Background task submitted. task_id=${taskId}` }],
      };
      return;
    }

    // Local tool execution
    console.log(`[ToolExecutor] ${tool.name} -> Local execution`);
    yield* this.executeLocal(tool, runContext, toolArgs);
  }

  protected async *executeHandoff(
    tool: HandoffTool<TContext>,
    runContext: ContextWrapper<TContext>,
    toolArgs: Record<string, unknown>
  ): AsyncGenerator<CallToolResult, void, unknown> {
    const input = String(toolArgs.input ?? "");
    const agentName = tool.agent?.name ?? "unknown";

    // Collect, deduplicate, and validate image URLs from both tool args and message event
    const fromMessage = this.collectImageUrlsFromMessage(runContext);
    const imageUrls = collectAndValidateImageUrls(
      toolArgs.image_urls,
      fromMessage,
    );
    // Update toolArgs with validated URLs
    toolArgs.image_urls = imageUrls;

    // ── Determine sandbox policy ──
    const isDynamic = Boolean(tool.agent?.dynamic);
    const sandboxPolicy: SandboxPolicy = tool.agent?.sandboxPolicy
      ?? (isDynamic ? DEFAULT_DYNAMIC_SUBAGENT_POLICY : DEFAULT_PRECONFIGURED_SUBAGENT_POLICY);

    // Build toolset for sub-agent with sandbox filtering
    const agentTools = tool.agent?.tools;
    let toolset: ToolSet | undefined;
    if (agentTools != null) {
      toolset = new ToolSet();
      if (Array.isArray(agentTools)) {
        for (const t of agentTools) {
          if (typeof t === "string") {
            const found = runContext._toolMgr?.getFunc(t);
            if (found && found.active) toolset.addTool(found);
          } else if (t && typeof t === "object" && "name" in t) {
            toolset.addTool(t as FunctionTool);
          }
        }
      }
      if (toolset.empty()) toolset = undefined;
    } else {
      toolset = runContext._funcToolSet ?? undefined;
    }

    // Apply sandbox policy to toolset
    if (toolset) {
      const allTools = [...toolset];
      const filtered = applySandboxPolicyToToolSet(allTools, sandboxPolicy);
      toolset = new ToolSet(filtered);
      if (toolset.empty()) toolset = undefined;
    }

    // Prepare begin dialogs
    let contexts: Message[] | undefined;
    const dialogs = tool.agent?.beginDialogs;
    if (Array.isArray(dialogs) && dialogs.length > 0) {
      contexts = [];
      for (const dialog of dialogs) {
        try {
          if ("role" in (dialog as Record<string, unknown>)) {
            contexts.push(validateMessage(dialog as Record<string, unknown>));
          }
        } catch { continue; }
      }
      if (!contexts.length) contexts = undefined;
    }

    // Resolve provider for sub-agent
    let provider: Provider | undefined;
    if (tool.providerId && runContext._toolMgr) {
      provider = runContext._toolMgr.getProviderById?.(tool.providerId) ?? undefined;
    }
    if (!provider && runContext._provider) {
      provider = runContext._provider;
    }
    if (!provider) {
      yield {
        content: [{ type: "text" as const, text: `error: No provider available for sub-agent '${tool.agent?.name}'.` }],
        isError: true,
      };
      return;
    }

    // Create and run sub-agent
    const { ToolLoopAgentRunner } = await import("./runners/tool-loop-agent-runner.js");
    const subRunner = new ToolLoopAgentRunner<TContext>();
    const subContext = createContextWrapper(runContext.context, {
      toolCallTimeout: runContext.toolCallTimeout,
    });

    await subRunner.reset(subContext, new EmptyAgentHooks(), {
      provider,
      request: {
        prompt: input,
        imageUrls,
        audioUrls: [],
        contexts: contexts ?? [],
        systemPrompt: tool.agent?.instructions,
        funcTool: toolset,
        extraUserContentParts: [],
      },
      toolExecutor: this,
      agentHooks: new EmptyAgentHooks(),
      streaming: false,
    });

    // ── Sub-agent loop detection ──
    const LOOP_DETECTION_MAX_SAME_TOOL = 5;       // Same tool called N times consecutively
    const LOOP_DETECTION_MAX_SAME_ARGS = 3;       // Same tool + same args called N times
    const LOOP_DETECTION_MAX_TOTAL_STEPS = sandboxPolicy.maxToolCalls ?? 30;    // Use sandbox policy limit

    let lastToolName: string | null = null;
    let sameToolStreak = 0;
    const argFingerprints: Map<string, number> = new Map();
    let loopDetected = false;
    let loopReason = "";

    // Execution timeout
    const executionTimeoutMs = (sandboxPolicy.maxExecutionTimeSeconds ?? 120) * 1000;
    const executionDeadline = Date.now() + executionTimeoutMs;
    let timedOut = false;

    // Run sub-agent to completion with loop detection and timeout
    let stepCount = 0;
    for await (const response of subRunner.stepUntilDone(LOOP_DETECTION_MAX_TOTAL_STEPS)) {
      stepCount++;

      // Check execution timeout
      if (Date.now() > executionDeadline) {
        timedOut = true;
        break;
      }

      // Inspect tool_call and tool_call_result events for loop detection
      if (response.type === "tool_call") {
        try {
          const data = JSON.parse(response.data?.chain?.message ?? "{}");
          const toolName = data.name as string | undefined;
          const toolArgs = data.args as Record<string, unknown> | undefined;

          if (toolName) {
            // Check 1: Same tool streak
            if (toolName === lastToolName) {
              sameToolStreak++;
            } else {
              lastToolName = toolName;
              sameToolStreak = 1;
            }

            if (sameToolStreak >= LOOP_DETECTION_MAX_SAME_TOOL) {
              loopDetected = true;
              loopReason = `Sub-agent called tool "${toolName}" ${sameToolStreak} times consecutively without progress.`;
              break;
            }

            // Check 2: Same tool + same args fingerprint
            if (toolArgs) {
              const fingerprint = `${toolName}:${stableStringify(toolArgs)}`;
              const count = (argFingerprints.get(fingerprint) ?? 0) + 1;
              argFingerprints.set(fingerprint, count);

              if (count >= LOOP_DETECTION_MAX_SAME_ARGS) {
                loopDetected = true;
                loopReason = `Sub-agent called tool "${toolName}" with identical arguments ${count} times.`;
                break;
              }
            }
          }
        } catch {
          // Ignore parse errors in loop detection
        }
      }
    }

    if (loopDetected) {
      // Force-stop the sub-agent
      subRunner.requestStop();
      // Release file locks held by this sub-agent
      fileLockManager.releaseAll(agentName);
      console.warn(`[SubAgent Loop Detection] Agent "${agentName}" loop detected: ${loopReason}`);

      const finalResp = subRunner.getFinalLlmResp();
      const partialResult = finalResp?.completionText?.trim();

      yield {
        content: [{
          type: "text" as const,
          text:
            `[Loop Detection] Sub-agent "${agentName}" was terminated due to a detected loop.\n` +
            `Reason: ${loopReason}\n` +
            `Steps taken: ${stepCount}\n` +
            (partialResult
              ? `Partial result before termination:\n${partialResult}`
              : "No partial result was produced before termination."),
        }],
        isError: true,
      };
      return;
    }

    if (timedOut) {
      // Force-stop the sub-agent
      subRunner.requestStop();
      // Release file locks held by this sub-agent
      fileLockManager.releaseAll(agentName);
      console.warn(`[SubAgent Timeout] Agent "${agentName}" exceeded execution time limit of ${executionTimeoutMs / 1000}s`);

      const finalResp = subRunner.getFinalLlmResp();
      const partialResult = finalResp?.completionText?.trim();

      yield {
        content: [{
          type: "text" as const,
          text:
            `[Timeout] Sub-agent "${agentName}" was terminated after exceeding the execution time limit (${executionTimeoutMs / 1000}s).\n` +
            `Steps taken: ${stepCount}\n` +
            (partialResult
              ? `Partial result before termination:\n${partialResult}`
              : "No partial result was produced before termination."),
        }],
        isError: true,
      };
      return;
    }

    // Release file locks held by this sub-agent
    fileLockManager.releaseAll(agentName);

    const finalResp = subRunner.getFinalLlmResp();
    const resultText = finalResp?.completionText ?? "Sub-agent completed with no text output.";

    yield {
      content: [{ type: "text" as const, text: resultText }],
    };
  }

  protected async *executeHandoffBackground(
    tool: HandoffTool<TContext>,
    runContext: ContextWrapper<TContext>,
    toolArgs: Record<string, unknown>
  ): AsyncGenerator<CallToolResult, void, unknown> {
    const taskId = crypto.randomUUID();

    // Run handoff in background and wake main agent when done
    this.runHandoffBackground(tool, runContext, toolArgs, taskId).catch((e) => {
      console.error(`Background handoff ${taskId} failed: ${e}`);
    });

    yield {
      content: [{
        type: "text" as const,
        text: `Background task dedicated to subagent '${tool.agent?.name}' submitted. task_id=${taskId}. The subagent is working on the task on your behalf. You will be notified when it finishes.`,
      }],
    };
  }

  private async runHandoffBackground(
    tool: HandoffTool<TContext>,
    runContext: ContextWrapper<TContext>,
    toolArgs: Record<string, unknown>,
    taskId: string
  ): Promise<void> {
    let resultText = "";
    try {
      for await (const r of this.executeHandoff(tool, runContext, toolArgs)) {
        if (r && r.content) {
          for (const c of r.content) {
            if (c.type === "text") resultText += (c as import("./types.js").TextContent).text + "\n";
          }
        }
      }
    } catch (e) {
      resultText = `error: Background task execution failed: ${e}`;
    }

    // Wake main agent with background task result
    await this.wakeMainAgentForBackgroundResult(runContext, {
      taskId,
      toolName: `transfer_to_${tool.agent?.name}`,
      resultText,
      toolArgs,
      note: `Background task for subagent '${tool.agent?.name}' finished.`,
      summaryName: `Dedicated to subagent \`${tool.agent?.name}\``,
    });
  }

  protected async wakeMainAgentForBackgroundResult(
    _runContext: ContextWrapper<TContext>,
    params: BackgroundTaskResult
  ): Promise<void> {
    // Delegate to the background task bus which handles:
    // 1. Emitting "task_completed" event
    // 2. Calling the registered BackgroundTaskWaker (if any)
    // 3. Logging the result
    await backgroundTaskBus.notifyCompleted(params);
  }

  /**
   * Extract image URLs from the current message event in the run context.
   * Walks the context's event message chain, finds Image components,
   * and resolves them to local file paths.
   *
   * This default implementation looks for a `messageImages` array on the context.
   * Framework-specific subclasses should override this to extract from their
   * actual message event structure.
   */
  protected collectImageUrlsFromMessage(
    runContext: ContextWrapper<TContext>
  ): string[] {
    const ctx = runContext.context as Record<string, unknown>;
    const event = ctx.event as Record<string, unknown> | undefined;
    if (!event) return [];

    // Try to get image URLs from message_obj.message Image components
    const messageObj = event.message_obj as Record<string, unknown> | undefined;
    const message = messageObj?.message;
    if (!Array.isArray(message)) return [];

    const urls: string[] = [];
    for (const component of message) {
      if (typeof component !== "object" || component == null) continue;
      const comp = component as Record<string, unknown>;
      // Check for Image-like component with url or file property
      if (comp.url && typeof comp.url === "string") {
        urls.push(comp.url);
      } else if (comp.file && typeof comp.file === "string") {
        urls.push(comp.file);
      }
    }
    return urls;
  }

  protected async *executeMcp(
    tool: MCPToolInstance<TContext>,
    _runContext: ContextWrapper<TContext>,
    toolArgs: Record<string, unknown>
  ): AsyncGenerator<CallToolResult, void, unknown> {
    try {
      const result = await tool.mcpClient.callToolWithReconnect(
        tool.mcpTool.name,
        toolArgs,
        _runContext.toolCallTimeout
      );
      yield result;
    } catch (e) {
      yield {
        content: [{ type: "text" as const, text: `MCP tool error: ${e}` }],
        isError: true,
      };
    }
  }

  protected async executeBackground(
    tool: FunctionTool<TContext>,
    runContext: ContextWrapper<TContext>,
    _taskId: string,
    toolArgs: Record<string, unknown>
  ): Promise<void> {
    // Background tasks use a longer timeout (3600s) than regular tool calls.
    // Create a shallow copy of the runContext with the extended timeout so
    // the shared context is NOT mutated — otherwise a concurrent foreground
    // tool could inherit the 3600s timeout.
    const backgroundContext: ContextWrapper<TContext> = {
      ...runContext,
      toolCallTimeout: 3600,
    };
    try {
      const iter = this.executeLocal(tool, backgroundContext, toolArgs);
      while (!(await iter.next()).done) {
        // Consume results silently for background tasks
      }
    } catch (e) {
      console.error(`Background task error: ${e}`);
    }
  }

  protected async *executeLocal(
    tool: FunctionTool<TContext>,
    runContext: ContextWrapper<TContext>,
    toolArgs: Record<string, unknown>
  ): AsyncGenerator<CallToolResult | null, void, unknown> {
    let awaitable: ((...args: unknown[]) => unknown) | undefined;
    let methodName: string;

    if (tool.handler) {
      awaitable = tool.handler as (...args: unknown[]) => unknown;
      methodName = "decorator_handler";
    } else if (tool.call) {
      awaitable = tool.call.bind(tool) as (...args: unknown[]) => unknown;
      methodName = "call";
    } else {
      console.error(`[ToolExecutor] ${tool.name} has no handler or call method!`);
      throw new Error("Tool must have a valid handler or override 'call' method.");
    }

    const timeout = runContext.toolCallTimeout;
    console.log(`[ToolExecutor] ${tool.name} executing via ${methodName}, timeout=${timeout}s`);

    try {
      let readyToCall: unknown;
      if (methodName === "decorator_handler") {
        const orderedArgs = extractOrderedArgs(tool, toolArgs);
        readyToCall = awaitable!(runContext, ...orderedArgs);
      } else {
        // For call() method, pass runContext + toolArgs as a single object
        readyToCall = awaitable!(runContext, toolArgs);
      }

      if (!readyToCall) {
        console.log(`[ToolExecutor] ${tool.name} returned null/undefined`);
        yield null;
        return;
      }

      // Handle async generator
      if (isAsyncGenerator(readyToCall)) {
        let resultCount = 0;
        for await (const ret of readyToCall) {
          resultCount++;
          if (ret != null) {
            if (isCallToolResult(ret)) {
              yield ret;
              const textContent = ret.content?.filter(c => c.type === 'text').map(c => c.text).join('') ?? '';
              console.log(`[ToolExecutor] ${tool.name} generator result #${resultCount}: text length=${textContent.length}`);
            } else {
              yield { content: [{ type: "text" as const, text: String(ret) }] };
              console.log(`[ToolExecutor] ${tool.name} generator result #${resultCount}: raw text length=${String(ret).length}`);
            }
          } else {
            yield null;
          }
        }
        console.log(`[ToolExecutor] ${tool.name} generator done (${resultCount} results)`);
      }
      // Handle promise (regular async function)
      else if (isPromise(readyToCall)) {
        const ret = await readyToCall;
        if (ret != null) {
          if (isCallToolResult(ret)) {
            yield ret;
            const textContent = ret.content?.filter(c => c.type === 'text').map(c => c.text).join('') ?? '';
            console.log(`[ToolExecutor] ${tool.name} promise result: CallToolResult, text length=${textContent.length}`);
          } else {
            yield { content: [{ type: "text" as const, text: String(ret) }] };
            console.log(`[ToolExecutor] ${tool.name} promise result: raw text length=${String(ret).length}`);
          }
        } else {
          console.log(`[ToolExecutor] ${tool.name} promise resolved to null`);
          yield null;
        }
      }
    } catch (e: unknown) {
      if (e instanceof ToolTimeoutError) {
        throw new Error(`tool ${tool.name} execution timeout after ${timeout} seconds.`);
      }
      console.error(`[ToolExecutor] ${tool.name} execution error:`, e);
      throw e;
    }
  }
}

function isAsyncGenerator(obj: unknown): obj is AsyncGenerator<unknown> {
  return obj != null && typeof obj === "object" && Symbol.asyncIterator in obj && "next" in obj && typeof (obj as AsyncGenerator<unknown>).next === "function";
}

function isPromise(obj: unknown): obj is Promise<unknown> {
  return obj != null && typeof obj === "object" && "then" in obj && typeof (obj as Promise<unknown>).then === "function";
}

function isCallToolResult(obj: unknown): obj is CallToolResult {
  return obj != null && typeof obj === "object" && "content" in (obj as Record<string, unknown>);
}

/**
 * Deterministic JSON stringification for loop detection fingerprinting.
 * Sorts object keys recursively so that {a:1,b:2} and {b:2,a:1} produce
 * the same fingerprint.
 */
function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k])).join(",") + "}";
}
