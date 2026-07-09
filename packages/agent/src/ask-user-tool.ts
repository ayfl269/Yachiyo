/**
 * Ask user question tool: allows the agent to ask the user a clarifying question
 * and present multiple-choice options.
 *
 * The tool sends the question to the user via the platform adapter's `send()`
 * method (accessed through the MessageEvent in the tool context). It returns a
 * tool result indicating the question was sent, and the agent should end its
 * current turn. The user's reply will arrive as a new message event, naturally
 * continuing the conversation with full context.
 *
 * This is a non-blocking design: the tool does NOT wait for the user's reply.
 * Instead, it sends the question and returns immediately. The LLM should
 * interpret the tool result as "question sent, stop generating and wait for
 * the user's response."
 */

import { createFunctionTool, type FunctionTool } from "./tool.js";
import type { CallToolResult } from "./types.js";
import type { PlainComponent } from "@yachiyo/message/components.js";
import { ComponentType } from "@yachiyo/message/components.js";

// ── Context type ──

/**
 * Minimal interface for the message event capabilities the tool needs.
 * At runtime, the full MessageEvent is passed as the context (see
 * ProcessStage.buildAgent → buildMainAgent({ context: event })).
 */
export interface AskUserToolContext {
  /** Send message components to the user. */
  send?: (components: PlainComponent[]) => Promise<void>;
  /** The unified message origin (session identifier). */
  unifiedMsgOrigin?: string;
}

// ── Helpers ──

function plainText(text: string): PlainComponent {
  return { type: ComponentType.Plain, text, toDict: () => ({ type: "text", data: { text } }) };
}

// ── Tool factory ──

/**
 * Create the ask_user_question tool.
 *
 * This tool does not require any external dependencies — it uses the
 * MessageEvent from the tool context to send messages to the user.
 */
export function createAskUserTool(): FunctionTool<AskUserToolContext> {
  return createFunctionTool<AskUserToolContext>({
    name: "ask_user_question",
    description:
      "Ask the user a clarifying question to gather more information or confirm a decision. " +
      "The question is sent directly to the user as a chat message. " +
      "After calling this tool, you should stop generating and wait for the user's reply — " +
      "the user's response will arrive as a new message in the next turn. " +
      "Use this tool when you need to: (1) clarify ambiguous requirements, " +
      "(2) confirm a decision before proceeding, (3) offer choices between approaches, " +
      "(4) request missing information needed to complete a task. " +
      "Do NOT use this tool for rhetorical questions or questions you can answer yourself.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The question to ask the user. Should be clear, specific, and end with a question mark. " +
            "Include enough context for the user to understand what is being asked.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: list of predefined choices for the user to select from. " +
            "Each option should be concise (1-5 words). " +
            "If omitted, the user will be asked to provide a free-text answer. " +
            "Provide 2-4 options for multiple-choice questions.",
          minItems: 2,
          maxItems: 6,
        },
        header: {
          type: "string",
          description:
            "Optional: a short label (max 20 chars) summarizing the question topic. " +
            "Displayed before the question for quick context. e.g. 'Auth method', 'Output format'.",
          maxLength: 20,
        },
      },
      required: ["question"],
    },
    active: true,
    handler: async (...args: unknown[]): Promise<CallToolResult> => {
      // The first argument is the ContextWrapper, followed by ordered args
      // extracted from the tool parameters (question, options?, header?)
      const wrapper = args[0] as { context?: AskUserToolContext } | undefined;
      const ctx = wrapper?.context;
      const question = String(args[1] ?? "").trim();
      const options = args[2] as string[] | undefined;
      const header = args[3] != null ? String(args[3]).trim() : undefined;

      if (!question) {
        return {
          content: [{ type: "text", text: "error: 'question' parameter is required and must not be empty." }],
          isError: true,
        };
      }

      // Build the formatted message
      const lines: string[] = [];
      if (header) {
        lines.push(`【${header}】`);
      }
      lines.push(question);

      if (options && Array.isArray(options) && options.length >= 2) {
        lines.push("");
        for (let i = 0; i < options.length; i++) {
          lines.push(`${i + 1}. ${options[i]}`);
        }
        lines.push("");
        lines.push(`(请回复选项编号 1-${options.length}，或直接输入您的答案)`);
      }

      const formattedMessage = lines.join("\n");

      // Send the question to the user
      if (ctx?.send) {
        try {
          await ctx.send([plainText(formattedMessage)]);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `error: Failed to send question to user: ${msg}` }],
            isError: true,
          };
        }
      }

      // Return a result for the LLM — it should stop and wait for the user's reply
      const resultLines: string[] = [];
      resultLines.push("Question sent to user successfully.");
      resultLines.push(`Question: ${question}`);
      if (options && options.length >= 2) {
        resultLines.push(`Options: ${options.map((o, i) => `${i + 1}. ${o}`).join(", ")}`);
      }
      resultLines.push("");
      resultLines.push("IMPORTANT: The question has been sent to the user. You should now END your response and wait for the user's reply. The user's answer will arrive as a new message in the next conversation turn. Do not call any more tools — simply provide a brief closing statement (or no statement) and stop.");

      return {
        content: [{ type: "text", text: resultLines.join("\n") }],
      };
    },
  });
}
