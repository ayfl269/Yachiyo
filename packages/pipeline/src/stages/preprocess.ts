import { PipelineStage, registerStage } from "../stage.js";
import type { PipelineContext } from "../context.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import { ComponentType, type RecordComponent, type FileComponent, type PlainComponent } from "@yachiyo/message/components.js";

@registerStage
export class PreProcessStage extends PipelineStage {
  private enableEmojiReact: boolean = false;
  private pathMappings: [string, string][] = [];
  private sttEnabled: boolean = false;
  private ctx!: PipelineContext;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.ctx = ctx;
    this.enableEmojiReact = ctx.config.emojiReact ?? false;
    this.pathMappings = ctx.config.pathMappings ?? [];
    this.sttEnabled = ctx.config.sttEnabled ?? false;
  }

  async process(event: MessageEvent): Promise<void> {
    // 1. Emoji react
    if (this.enableEmojiReact) {
      try { await event.react("👀"); } catch { /* ignore */ }
    }

    // 2. Path mapping
    for (const comp of event.messageObj.components) {
      if (comp.type === ComponentType.File && "file" in comp && comp.file) {
        (comp as FileComponent).file = this.applyPathMapping(comp.file as string);
      }
    }

    // 3. STT (speech-to-text)
    if (this.sttEnabled) {
      const sttProvider = this.ctx.providerManager.getUsingSttProvider(event.unifiedMsgOrigin);
      if (sttProvider) {
        const audioComp = this.findAudioComponent(event);
        if (audioComp) {
          const audioUrl = this.getAudioUrl(audioComp);
          if (audioUrl) {
            try {
              const transcribedText = await sttProvider.getText(audioUrl);
              if (transcribedText) {
                event.messageObj.components.push({
                  type: ComponentType.Plain,
                  text: transcribedText,
                  toDict() { return { type: "text", data: { text: transcribedText } }; },
                } as PlainComponent);
                event.messageStr = `${event.messageStr} ${transcribedText}`.trim();
              }
            } catch { /* ignore STT errors */ }
          }
        }
      }
    }
  }

  private findAudioComponent(event: MessageEvent): RecordComponent | null {
    for (const comp of event.messageObj.components) {
      if (comp.type === ComponentType.Record) {
        return comp as RecordComponent;
      }
    }
    const audioUrl = event.getExtra<string>("audio_url");
    if (audioUrl) {
      return { type: ComponentType.Record, url: audioUrl, toDict() { return { type: "record", data: { url: audioUrl } }; } } as RecordComponent;
    }
    return null;
  }

  private getAudioUrl(comp: RecordComponent): string | null {
    return comp.url ?? comp.file ?? comp.path ?? null;
  }

  private applyPathMapping(path: string): string {
    for (const [from, to] of this.pathMappings) {
      if (path.startsWith(from)) {
        return path.replace(from, to);
      }
    }
    return path;
  }
}
