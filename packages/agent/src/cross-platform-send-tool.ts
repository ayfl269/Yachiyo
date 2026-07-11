/**
 * Cross-platform message sending tool.
 *
 * Lets the agent send messages to a different platform session than the one
 * it currently received the message from. For example, an agent running on
 * OneBot11 (QQ) can push a notification to a WeChat session, or vice versa.
 *
 * Actions:
 *   send            Send a text message to a target session
 *   list_platforms  List all available platform adapters and their status
 */

import { createFunctionTool, type FunctionTool } from "./tool.js";
import type { ContextWrapper, CallToolResult } from "./types.js";

// ── Minimal message component type ──
// Avoids a direct dependency on @yachiyo/message (not in agent's package.json).
// Used only for constructing plain-text components locally.

interface PlainMessageComponent {
  type: string;
  text: string;
  toDict(): Record<string, unknown>;
}

// ── Minimal adapter lookup interface ──
// Avoids a direct dependency on @yachiyo/platform (which would create a
// circular import since platform already depends on agent/types).
// The real AdapterRegistry satisfies this interface structurally.
// components is typed as unknown[] to avoid importing MessageComponent
// from @yachiyo/message (the real adapter accepts the concrete type).

export interface AdapterInfo {
  id: string;
  name: string;
  description: string;
  supportProactiveMessage: boolean;
}

export interface AdapterLookup {
  getAllAdapters(): Array<{
    meta(): AdapterInfo;
    isRunning: boolean;
    sendProactiveMessage(
      target: { umo: string; sessionId: string; platformId: string },
      components: unknown[],
    ): Promise<boolean>;
  }>;
  getAdapter(id: string): {
    meta(): AdapterInfo;
    isRunning: boolean;
    sendProactiveMessage(
      target: { umo: string; sessionId: string; platformId: string },
      components: unknown[],
    ): Promise<boolean>;
  } | undefined;
}

// ── Context type ──

export interface CrossPlatformSendToolContext {
  event?: {
    unifiedMsgOrigin?: string;
    sessionId?: string;
    platformId?: string;
  };
}

function getToolContext(_ctx: unknown): CrossPlatformSendToolContext {
  const wrapper = _ctx as ContextWrapper<CrossPlatformSendToolContext> | undefined;
  const ctx = wrapper?.context;
  if (!ctx) return {} as CrossPlatformSendToolContext;

  // When called from the pipeline, `ctx` is a MessageEvent instance that has
  // `unifiedMsgOrigin` (getter), `sessionId`, and `platformMeta` directly on it.
  const maybeEvent = ctx as {
    unifiedMsgOrigin?: string;
    sessionId?: string;
    platformMeta?: { id?: string };
  };
  if (maybeEvent.unifiedMsgOrigin && typeof maybeEvent.unifiedMsgOrigin === "string") {
    return {
      event: {
        unifiedMsgOrigin: maybeEvent.unifiedMsgOrigin,
        sessionId: maybeEvent.sessionId,
        platformId: maybeEvent.platformMeta?.id,
      },
    };
  }
  return ctx as CrossPlatformSendToolContext;
}

export interface CreateCrossPlatformSendToolOptions {
  adapterLookup: AdapterLookup;
}

export function createCrossPlatformSendTool(
  options: CreateCrossPlatformSendToolOptions,
): FunctionTool<CrossPlatformSendToolContext> {
  const lookup = options.adapterLookup;

  return createFunctionTool<CrossPlatformSendToolContext>({
    name: "cross_platform_send",
    description:
      "Send a message to a different platform session or list available platforms. " +
      "Use 'list_platforms' to see all connected adapters and their IDs. " +
      "Use 'send' to deliver a text message to a target session identified by its UMO " +
      "(Unified Message Origin, format: <platform>:<type>:<id>, e.g. onebot11:group:123456).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action to perform.",
          enum: ["send", "list_platforms"],
        },
        target_umo: {
          type: "string",
          description:
            "Target Unified Message Origin (UMO) for 'send' action. " +
            "Format: <platform>:<type>:<id>, e.g. onebot11:group:123456, qqofficial:private:789. " +
            "Use 'list_platforms' first to discover available platforms.",
        },
        platform_id: {
          type: "string",
          description:
            "Adapter ID to use for sending. If omitted, auto-detected from the UMO prefix. " +
            "Required when multiple adapters of the same platform type exist.",
        },
        message: {
          type: "string",
          description: "The message text to send (for 'send' action).",
        },
      },
      required: ["action"],
    },
    handler: async (_ctx: unknown, ...args: unknown[]): Promise<CallToolResult> => {
      const ctx = getToolContext(_ctx);

      const action = args[0] != null ? String(args[0]) : undefined;
      const targetUmo = args[1] != null ? String(args[1]) : undefined;
      const platformId = args[2] != null ? String(args[2]) : undefined;
      const message = args[3] != null ? String(args[3]) : undefined;

      if (!action) {
        return formatError("Missing required parameter: action");
      }

      switch (action) {
        case "send":
          return handleSend(lookup, ctx, { target_umo: targetUmo, platform_id: platformId, message });
        case "list_platforms":
          return handleListPlatforms(lookup, ctx);
        default:
          return formatError(`Unknown action: ${action}. Valid actions: send, list_platforms`);
      }
    },
  });
}

// ── Action handlers ──

function handleListPlatforms(
  lookup: AdapterLookup,
  ctx: CrossPlatformSendToolContext,
): CallToolResult {
  const adapters = lookup.getAllAdapters();
  if (adapters.length === 0) {
    return formatText("No platform adapters are currently registered.");
  }

  const lines: string[] = ["Available platform adapters:", ""];

  for (const adapter of adapters) {
    const meta = adapter.meta();
    const status = adapter.isRunning ? "running" : "stopped";
    const proactive = meta.supportProactiveMessage ? "yes" : "no";
    const isCurrent = meta.id === ctx.event?.platformId;
    const marker = isCurrent ? " (current)" : "";

    lines.push(
      `• ID: ${meta.id}${marker}`,
      `  Platform: ${meta.name}`,
      `  Description: ${meta.description}`,
      `  Status: ${status}`,
      `  Proactive messaging: ${proactive}`,
      "",
    );
  }

  if (ctx.event?.unifiedMsgOrigin) {
    lines.push(`Current session UMO: ${ctx.event.unifiedMsgOrigin}`);
    lines.push(`Current platform ID: ${ctx.event.platformId ?? "unknown"}`);
  }

  return formatText(lines.join("\n"));
}

async function handleSend(
  lookup: AdapterLookup,
  ctx: CrossPlatformSendToolContext,
  params: { target_umo?: string; platform_id?: string; message?: string },
): Promise<CallToolResult> {
  const targetUmo = params.target_umo;
  const message = params.message;

  if (!targetUmo) {
    return formatError("Missing required parameter: target_umo");
  }
  if (!message || !message.trim()) {
    return formatError("Missing required parameter: message (must be non-empty)");
  }

  // Resolve the target adapter
  const platformId = params.platform_id ?? ctx.event?.platformId;
  let adapter: ReturnType<AdapterLookup["getAdapter"]>;

  if (platformId) {
    // Use specified platform_id
    adapter = lookup.getAdapter(platformId);
    if (!adapter) {
      return formatError(`Adapter not found: platform_id "${platformId}"`);
    }
  } else {
    // Auto-detect from UMO prefix
    const platformType = targetUmo.split(":")[0];
    if (!platformType) {
      return formatError(
        `Cannot determine platform type from UMO: "${targetUmo}". ` +
          `Please provide platform_id explicitly.`,
      );
    }

    const candidates = lookup.getAllAdapters().filter((a) => a.meta().name === platformType);
    if (candidates.length === 0) {
      return formatError(
        `No adapter found for platform type "${platformType}" (from UMO prefix). ` +
          `Use 'list_platforms' to see available adapters.`,
      );
    }
    if (candidates.length > 1) {
      const ids = candidates.map((a) => a.meta().id).join(", ");
      return formatError(
        `Multiple adapters found for platform "${platformType}" (IDs: ${ids}). ` +
          `Please specify platform_id to disambiguate.`,
      );
    }
    adapter = candidates[0];
  }

  if (!adapter.isRunning) {
    return formatError(`Adapter "${adapter.meta().id}" is not running.`);
  }

  if (!adapter.meta().supportProactiveMessage) {
    return formatError(
      `Adapter "${adapter.meta().id}" (${adapter.meta().name}) does not support proactive messaging.`,
    );
  }

  // Build message components
  const components: PlainMessageComponent[] = [
    {
      type: "Plain",
      text: message,
      toDict() {
        return { type: "text", data: { text: message } };
      },
    },
  ];

  const target = {
    umo: targetUmo,
    sessionId: targetUmo, // sessionId defaults to UMO if not separately known
    platformId: adapter.meta().id,
  };

  try {
    const delivered = await adapter.sendProactiveMessage(target, components);
    if (delivered) {
      return formatText(
        `Message sent successfully to ${targetUmo} via adapter "${adapter.meta().id}".`,
      );
    }
    return formatError(
      `Failed to deliver message to ${targetUmo} ` +
        `(adapter returned false — session may be inactive).`,
    );
  } catch (e) {
    return formatError(
      `Error sending message to ${targetUmo}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ── Formatting helpers ──

function formatText(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError: false,
  };
}

function formatError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}
