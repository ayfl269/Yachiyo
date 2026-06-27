import { PipelineStage, registerStage } from "../stage.js";
import type { PipelineContext } from "../context.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import { ComponentType, type MessageComponent, type PlainComponent, type ImageComponent } from "@yachiyo/message/components.js";
import { ResultContentType } from "@yachiyo/message/event-result.js";
import { EventType } from "@yachiyo/plugin/event-type.js";
import { MarkdownToImageRenderer } from "@yachiyo/t2i/renderer.js";

@registerStage
export class ResultDecorateStage extends PipelineStage {
  private replyPrefix: string = "";
  private enableSegmentedReply: boolean = false;
  private enableTts: boolean = false;
  private t2iRenderer!: MarkdownToImageRenderer;
  private displayReasoningText: boolean = false;
  private ctx!: PipelineContext;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.ctx = ctx;
    this.replyPrefix = ctx.config.replyPrefix ?? "";
    this.enableSegmentedReply = ctx.config.segmentedReply ?? false;
    this.enableTts = ctx.config.ttsEnabled ?? false;
    this.t2iRenderer = new MarkdownToImageRenderer({
      enabled: ctx.config.t2iEnabled ?? false,
      width: ctx.config.t2iWidth ?? 800,
      quality: ctx.config.t2iQuality ?? 85,
      format: ctx.config.t2iFormat ?? "png",
      template: ctx.config.t2iTemplate ?? "default",
    });
    this.displayReasoningText = ctx.config.displayReasoningText ?? false;

    // Initialize the renderer browser
    if (this.t2iRenderer.getConfig().enabled) {
      this.t2iRenderer.initialize().catch((e) => {
        console.error("[ResultDecorateStage] Failed to initialize T2I renderer:", e);
      });
    }
  }

  async process(event: MessageEvent): Promise<void> {
    const result = event.getResult();
    if (!result) return;

    if (result.resultContentType === ResultContentType.STREAMING_RESULT) return;

    if (this.replyPrefix) {
      const firstPlain = result.components.find(
        c => c.type === ComponentType.Plain
      ) as PlainComponent | undefined;
      if (firstPlain) {
        firstPlain.text = `${this.replyPrefix}${firstPlain.text}`;
      }
    }

    if (this.displayReasoningText) {
      const reasoningContent = event.getExtra<string>("reasoning_content");
      if (reasoningContent) {
        result.components.unshift({
          type: ComponentType.Plain,
          text: `[思考过程]\n${reasoningContent}\n\n[回复]`,
          toDict() { return { type: "text", data: { text: this.text } }; },
        } as PlainComponent);
      }
    }

    if (this.enableSegmentedReply) {
      const newComponents: MessageComponent[] = [];
      for (const comp of result.components) {
        if (comp.type === ComponentType.Plain) {
          const plainComp = comp as PlainComponent;
          const segments = this.splitTextToSegments(plainComp.text);
          for (const seg of segments) {
            newComponents.push({
              type: ComponentType.Plain,
              text: seg,
              toDict() { return { type: "text", data: { text: seg } }; },
            } as MessageComponent);
          }
        } else {
          newComponents.push(comp);
        }
      }
      result.components = newComponents;
    }

    // TTS: convert plain text to audio
    if (this.enableTts) {
      const ttsProvider = this.ctx.providerManager.getUsingTtsProvider(event.unifiedMsgOrigin);
      if (ttsProvider) {
        const plainText = result.getPlainText();
        if (plainText) {
          try {
            const audioFilePath = await ttsProvider.getAudio(plainText);
            result.components.push({
              type: ComponentType.Record,
              file: audioFilePath,
              toDict() { return { type: "record", data: { file: audioFilePath } }; },
            } as MessageComponent);
            event.trackTemporaryLocalFile(audioFilePath);
          } catch { /* ignore TTS errors */ }
        }
      }
    }

    // T2I: render markdown reply as image
    if (this.t2iRenderer.getConfig().enabled) {
      const plainText = result.getPlainText();
      if (plainText && plainText.trim()) {
        try {
          const imageResult = await this.t2iRenderer.render(plainText);
          if (imageResult) {
            result.components.push({
              type: ComponentType.Image,
              url: imageResult.filePath,
              toDict() { return { type: "image", data: { url: imageResult.filePath } }; },
            } as ImageComponent);
            event.trackTemporaryLocalFile(imageResult.filePath);
          }
        } catch { /* ignore T2I render errors */ }
      }
    }

    await this.ctx.callEventHook(event, EventType.OnDecoratingResultEvent);
  }

  private splitTextToSegments(text: string): string[] {
    if (text.length <= 300) return [text];

    const segments: string[] = [];
    const sentencePattern = /[。！？!?\n]/;
    let current = "";

    for (const char of text) {
      current += char;
      if (sentencePattern.test(char) || current.length >= 300) {
        if (current.trim()) {
          segments.push(current);
        }
        current = "";
      }
    }

    if (current.trim()) {
      segments.push(current);
    }

    return segments.length > 0 ? segments : [text];
  }
}
