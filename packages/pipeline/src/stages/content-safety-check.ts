import { PipelineStage, registerStage } from "../stage.js";
import type { PipelineContext } from "../context.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import { ComponentType, type PlainComponent } from "@yachiyo/message/components.js";
import { EventResult } from "@yachiyo/message/event-result.js";

export interface ContentSafetyCheckResult {
  passed: boolean;
  reason: string;
}

export abstract class ContentSafetyStrategy {
  abstract check(content: string): ContentSafetyCheckResult;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class KeywordsStrategy extends ContentSafetyStrategy {
  private keywords: RegExp[];
  constructor(keywords: string[]) {
    super();
    this.keywords = keywords.map(kw => new RegExp(escapeRegExp(kw), "i"));
  }
  check(content: string): ContentSafetyCheckResult {
    for (const regex of this.keywords) {
      if (regex.test(content)) {
        return { passed: false, reason: "内容包含敏感关键词" };
      }
    }
    return { passed: true, reason: "" };
  }
}

export class ContentSafetyStrategySelector {
  private strategies: ContentSafetyStrategy[] = [];
  checkResponse: boolean = false;

  constructor(config: Record<string, unknown>) {
    if (config.safetyKeywords) {
      this.strategies.push(new KeywordsStrategy(config.safetyKeywords as string[]));
    }
    this.checkResponse = (config.safetyCheckResponse as boolean) ?? false;
  }

  check(content: string): ContentSafetyCheckResult {
    for (const strategy of this.strategies) {
      const result = strategy.check(content);
      if (!result.passed) return result;
    }
    return { passed: true, reason: "" };
  }
}

@registerStage
export class ContentSafetyCheckStage extends PipelineStage {
  private strategySelector!: ContentSafetyStrategySelector;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.strategySelector = new ContentSafetyStrategySelector(ctx.config as unknown as Record<string, unknown>);
  }

  async *process(event: MessageEvent): AsyncGenerator<void, void> {
    // Pre-check: input message safety
    const inputCheck = this.strategySelector.check(event.getMessageStr());
    if (!inputCheck.passed) {
      if (event.isWakeUp()) {
        await event.send([
          { type: ComponentType.Plain, text: `消息内容不安全: ${inputCheck.reason}`, toDict() { return { type: "text", data: { text: inputCheck.reason } }; } } as PlainComponent
        ]);
      }
      event.stopEvent();
      return;
    }

    yield; // Let subsequent stages execute

    // Post-check: response safety
    // For non-streaming: result.getPlainText() holds the response text.
    // For streaming: result may be cleared by RespondStage; fall back to
    // the cached assistant text. The streaming filter in RespondStage
    // provides real-time interception; this post-check is a second line
    // of defense for non-streaming responses and edge cases.
    if (this.strategySelector.checkResponse) {
      const result = event.getResult();
      const outputText = result?.getPlainText()?.trim()
        || event.getExtra<string>("_cachedAssistantText")?.trim()
        || "";
      if (outputText) {
        const outputCheck = this.strategySelector.check(outputText);
        if (!outputCheck.passed) {
          if (result) {
            event.setResult(new EventResult().plain("回复内容未通过安全检查"));
          }
          // If result is null (streaming path already cleared it), the
          // streaming filter in RespondStage should have handled it.
        }
      }
    }
  }
}
