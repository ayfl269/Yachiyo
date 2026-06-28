import { PipelineStage, registerStage } from "../stage.js";
import type { PipelineContext } from "../context.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import { ComponentType, type MessageComponent, type PlainComponent, type RecordComponent, type AtComponent, type ReplyComponent } from "@yachiyo/message/components.js";
import { ResultContentType } from "@yachiyo/message/event-result.js";
import { EventType } from "@yachiyo/plugin/event-type.js";
import type { MessageChain } from "@yachiyo/agent/types.js";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Segmented reply timing. Each component is delayed by a random interval
 * (in ms) to mimic human typing rhythm. `COMP_INTERVAL_MIN_MS` is the
 * floor and `COMP_INTERVAL_SPREAD_MS` is the size of the random range
 * above it, so the effective delay is `[MIN, MIN + SPREAD)` ms.
 */
const COMP_INTERVAL_MIN_MS = 50;
const COMP_INTERVAL_SPREAD_MS = 151;

@registerStage
export class RespondStage extends PipelineStage {
  private replyWithMention: boolean = false;
  private replyWithQuote: boolean = false;
  private enableSegmentedReply: boolean = false;
  private onlyLlmResultSegmented: boolean = false;
  private ctx!: PipelineContext;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.ctx = ctx;
    this.replyWithMention = ctx.config.replyWithMention ?? false;
    this.replyWithQuote = ctx.config.replyWithQuote ?? false;
    this.enableSegmentedReply = ctx.config.segmentedReply ?? false;
    this.onlyLlmResultSegmented = ctx.config.onlyLlmResultSegmented ?? false;
  }

  async process(event: MessageEvent): Promise<void> {
    const result = event.getResult();
    console.log(`[RespondStage] process() called - result: ${result ? 'exists' : 'null'}, contentType: ${result?.resultContentType}`);

    if (!result) {
      console.log(`[RespondStage] No result, returning early`);
      return;
    }

    if (event.getExtra("_streaming_finished", false)) return;
    if (result.resultContentType === ResultContentType.STREAMING_FINISH) {
      event.setExtra("_streaming_finished", true);
      return;
    }

    if (result.resultContentType === ResultContentType.STREAMING_RESULT) {
      if (!result.asyncStream) return;
      const collectedText = await this.collectAndSendStreaming(event, result.asyncStream);
      await this.appendAssistantToHistory(event, collectedText);
      // Cache streaming text for recordConversationToMemory (result will be cleared)
      if (collectedText.trim()) {
        event.setExtra("_cachedAssistantText", collectedText);
      }
      await this.ctx.callEventHook(event, EventType.OnAfterMessageSentEvent);
      return;
    }

    if (result.components.length > 0) {
      if (this.isEmptyMessageChain(result.components)) return;

      result.components = result.components.filter(
        c => !(c.type === ComponentType.Plain && !(c as PlainComponent).text?.trim())
      );

      if (this.onlyLlmResultSegmented) {
        result.components = result.components.filter(
          c => c.type === ComponentType.Plain
        );
      }

      if (!this.onlyLlmResultSegmented) {
        if (this.replyWithMention && !event.isPrivateChat()) {
          const atComp: AtComponent = {
            type: ComponentType.At,
            qq: event.getSenderId(),
            toDict() { return { type: "at", data: { qq: atComp.qq } }; },
          };
          result.components.unshift(atComp as MessageComponent);
        }

        if (this.replyWithQuote) {
          const replyComp: ReplyComponent = {
            type: ComponentType.Reply,
            id: event.messageObj.messageId,
            toDict() { return { type: "reply", data: { id: replyComp.id } }; },
          };
          result.components.unshift(replyComp as MessageComponent);
        }
      }

      if (result.components.every(
        c => c.type === ComponentType.Reply || c.type === ComponentType.At
      )) return;

      const nonRecordComponents = result.components.filter(
        c => c.type !== ComponentType.Record
      );
      const recordComponents = result.components.filter(
        (c): c is RecordComponent => c.type === ComponentType.Record
      );

      try {
        if (nonRecordComponents.length > 0) {
          if (this.enableSegmentedReply && nonRecordComponents.length > 1) {
            for (let i = 0; i < nonRecordComponents.length; i++) {
              await event.send([nonRecordComponents[i]]);
              if (i < nonRecordComponents.length - 1) {
                await sleep(this.calcCompInterval());
              }
            }
          } else {
            await event.send(nonRecordComponents);
          }
        }

        for (const record of recordComponents) {
          await event.send([record]);
        }
      } catch (e) {
        console.error(`发送消息失败: ${e}`);
      }

      await this.ctx.callEventHook(event, EventType.OnAfterMessageSentEvent);
    }

    event.clearResult();
  }

  private isEmptyMessageChain(components: any[]): boolean {
    if (!components.length) return true;
    return !components.some(c => {
      if (c.type === ComponentType.Plain) return Boolean((c as PlainComponent).text?.trim());
      return true;
    });
  }

  private calcCompInterval(): number {
    return Math.floor(Math.random() * COMP_INTERVAL_SPREAD_MS) + COMP_INTERVAL_MIN_MS;
  }

  private async collectAndSendStreaming(
    event: MessageEvent,
    generator: AsyncGenerator<MessageChain, void>
  ): Promise<string> {
    const parts: string[] = [];
    async function* teeGenerator(): AsyncGenerator<MessageChain, void> {
      for await (const chunk of generator) {
        // Skip reasoning/thinking chunks — only send text content to user
        if (chunk.type === "reasoning") continue;
        if (chunk.type === "err") {
          yield chunk;
          continue;
        }
        if (chunk.message) parts.push(chunk.message);
        yield chunk;
      }
    }
    await event.sendStreaming(teeGenerator());
    return parts.join("");
  }

  private async appendAssistantToHistory(event: MessageEvent, assistantText: string): Promise<void> {
    if (!assistantText.trim()) return;
    const convId = event.getExtra<string>("_saveHistory_convId");
    const umo = event.getExtra<string>("_saveHistory_umo");
    if (!convId || !umo) return;

    try {
      const conv = await this.ctx.conversationManager.getConversation(umo, convId);
      if (!conv) return;
      const parsed = JSON.parse(conv.history);
      if (!Array.isArray(parsed)) {
        console.warn(`[RespondStage] Conversation ${convId} history corrupted (not an array), reinitializing.`);
      }
      const history: Array<{ role: string; content: string }> = Array.isArray(parsed) ? parsed : [];
      history.push({ role: "assistant", content: assistantText });

      // Truncate history to prevent unbounded growth
      const maxHistoryMessages = this.ctx.config.maxHistoryMessages ?? 200;
      if (history.length > maxHistoryMessages) {
        history.splice(0, history.length - maxHistoryMessages);
      }

      await this.ctx.conversationManager.updateConversation(umo, convId, {
        history: JSON.stringify(history),
      });
      console.log(`[RespondStage] Saved streaming response to history (${assistantText.length} chars)`);
    } catch (e) {
      console.error("[RespondStage] Failed to save streaming history:", e);
    }
  }
}
