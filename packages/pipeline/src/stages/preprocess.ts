import { PipelineStage, registerStage } from "../stage.js";
import type { PipelineContext } from "../context.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import { ComponentType, type RecordComponent, type FileComponent, type PlainComponent, type ImageComponent, type VideoComponent } from "@yachiyo/message/components.js";

export interface ReceivedFile {
  type: "file" | "image" | "record" | "video";
  url?: string;
  name?: string;
  file?: string;
}

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

    // 3. Annotate message with received file/image/video info
    //    This lets the agent know about files and their URLs so it can
    //    save them using the save_platform_file tool.
    //    If file URLs are missing, try to resolve them via platform API (e.g. getFile).
    await this.annotateReceivedFiles(event);

    // 4. STT (speech-to-text)
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

  /**
   * Collect file/image/record/video components and:
   * 1. Store them in event extra as "received_files" (structured data for tools)
   * 2. Append a text annotation to messageStr so the agent is aware of the files
   *
   * If file URLs are missing (common for OneBot11 group files), attempt to
   * resolve them via platform-specific APIs (getFile/getImage/getRecord)
   * using duck typing on the event object.
   */
  private async annotateReceivedFiles(event: MessageEvent): Promise<void> {
    const receivedFiles: ReceivedFile[] = [];

    // Duck-type check for OneBot11 API methods on the event
    const eventWithApi = event as unknown as {
      getFile?: (fileId: string) => Promise<{ url?: string; file_name?: string }>;
      getImage?: (file: string) => Promise<{ url?: string }>;
      getRecord?: (file: string) => Promise<{ url?: string; file?: string }>;
    };

    for (const comp of event.messageObj.components) {
      switch (comp.type) {
        case ComponentType.File: {
          const fc = comp as FileComponent;
          let url = fc.url ?? fc.file;
          const fileId = fc.file;

          // If no direct URL but has file_id, try to resolve via getFile API
          if (!url && fileId && typeof eventWithApi.getFile === "function") {
            try {
              const result = await eventWithApi.getFile(fileId);
              if (result?.url) {
                url = result.url;
                (fc as { url?: string }).url = url;
              }
              if (result?.file_name && !fc.name) {
                fc.name = result.file_name;
              }
            } catch { /* ignore resolution errors */ }
          }

          if (url) {
            receivedFiles.push({ type: "file", url, name: fc.name, file: fc.file });
          }
          break;
        }
        case ComponentType.Image: {
          const ic = comp as ImageComponent;
          let url = ic.url ?? ic.file;
          const fileId = ic.file;

          // If no direct URL but has file_id, try to resolve via getImage API
          if (!url && fileId && typeof eventWithApi.getImage === "function") {
            try {
              const result = await eventWithApi.getImage(fileId);
              if (result?.url) {
                url = result.url;
                (ic as { url?: string }).url = url;
              }
            } catch { /* ignore resolution errors */ }
          }

          if (url) {
            receivedFiles.push({ type: "image", url, file: ic.file });
          }
          break;
        }
        case ComponentType.Record: {
          const rc = comp as RecordComponent;
          let url = rc.url ?? rc.file;
          const fileId = rc.file;

          // If no direct URL but has file_id, try to resolve via getRecord API
          if (!url && fileId && typeof eventWithApi.getRecord === "function") {
            try {
              const result = await eventWithApi.getRecord(fileId);
              if (result?.url) {
                url = result.url;
              } else if (result?.file) {
                url = result.file;
              }
            } catch { /* ignore resolution errors */ }
          }

          if (url) {
            receivedFiles.push({ type: "record", url, file: rc.file });
          }
          break;
        }
        case ComponentType.Video: {
          const vc = comp as VideoComponent;
          const url = vc.file || vc.path;
          if (url) {
            receivedFiles.push({ type: "video", url, file: vc.file });
          }
          break;
        }
      }
    }

    if (receivedFiles.length === 0) return;

    // Store structured data for tools to access
    event.setExtra("received_files", receivedFiles);

    // Append text annotation so the agent knows about the files
    const annotations: string[] = [];
    for (const f of receivedFiles) {
      const label =
        f.type === "file" ? "文件" :
        f.type === "image" ? "图片" :
        f.type === "record" ? "语音" :
        "视频";
      const namePart = f.name ? ` ${f.name}` : "";
      annotations.push(`[收到${label}${namePart} (URL: ${f.url})]`);
    }
    const annotationText = annotations.join(" ");
    if (annotationText) {
      event.messageStr = `${event.messageStr} ${annotationText}`.trim();
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
