import { PipelineStage, registerStage } from "../stage.js";
import type { PipelineContext } from "../context.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import { ComponentType, type AtComponent } from "@yachiyo/message/components.js";
import { EventType } from "@yachiyo/plugin/event-type.js";
import type { StarHandlerMetadata } from "@yachiyo/plugin/handler.js";
import type { PluginManager } from "@yachiyo/plugin/manager.js";

@registerStage
export class WakingCheckStage extends PipelineStage {
  private wakePrefix: string = "";
  private friendMessageNeedsWakePrefix: boolean = false;
  private pluginManager!: PluginManager;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.wakePrefix = ctx.config.wakePrefix ?? "";
    this.friendMessageNeedsWakePrefix = ctx.config.friendMessageNeedsWakePrefix ?? false;
    this.pluginManager = ctx.pluginManager;
  }

  async process(event: MessageEvent): Promise<void> {
    // System-generated events (e.g. proactive reminders) bypass all
    // wake checks — they are always processed by the pipeline.
    if (event.isSystem) {
      event.isWake = true;
      event.isAtOrWakeCommand = true;
      return;
    }

    // Adapters may pre-set isWake for events that inherently require a
    // response (e.g. QQ Official GROUP_AT_MESSAGE_CREATE is always @'ed).
    if (event.isWake) {
      return;
    }

    if (event.getSenderId() === event.getSelfId()) {
      event.stopEvent();
      return;
    }

    let isWake = false;
    const messageStr = event.getMessageStr();

    if (this.wakePrefix && messageStr.startsWith(this.wakePrefix)) {
      isWake = true;
      event.messageStr = messageStr.slice(this.wakePrefix.length).trim();
    }

    const hasAtBot = event.messageObj.components.some(
      c => c.type === ComponentType.At && String((c as AtComponent).qq) === event.getSelfId()
    );
    if (hasAtBot) isWake = true;

    const hasAtAll = event.messageObj.components.some(
      c => c.type === ComponentType.AtAll
    );
    if (hasAtAll) isWake = true;

    if (event.isPrivateChat() && !this.friendMessageNeedsWakePrefix) {
      isWake = true;
    }

    const activatedHandlers = this.matchHandlers(event);
    if (activatedHandlers.length > 0) {
      isWake = true;
      event.setExtra("activated_handlers", activatedHandlers);
    }

    event.isWake = isWake;
    event.isAtOrWakeCommand = isWake;

    if (!isWake) {
      event.stopEvent();
    }
  }

  private matchHandlers(event: MessageEvent): StarHandlerMetadata[] {
    const registry = this.pluginManager.getHandlerRegistry();
    const handlers = registry.getHandlersByEventType(EventType.AdapterMessageEvent);
    return handlers.filter(h => {
      if (!h.enabled) return false;
      return h.eventFilters.every(f => f.filter(event, h.extrasConfigs));
    });
  }
}
