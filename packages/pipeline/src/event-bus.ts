import type { AsyncQueue } from "@yachiyo/common/async-queue.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import type { PipelineScheduler } from "./scheduler.js";

export interface PipelineConfigInfo {
  id: string;
  [key: string]: unknown;
}

export interface ConfigManagerLike {
  getConfInfo(umo: string): PipelineConfigInfo;
}

export class EventBus {
  private eventQueue: AsyncQueue<MessageEvent>;
  private schedulerMapping: Map<string, PipelineScheduler>;
  private configManager: ConfigManagerLike;
  private running: boolean = false;

  constructor(
    eventQueue: AsyncQueue<MessageEvent>,
    schedulerMapping: Map<string, PipelineScheduler>,
    configManager: ConfigManagerLike,
  ) {
    this.eventQueue = eventQueue;
    this.schedulerMapping = schedulerMapping;
    this.configManager = configManager;
  }

  async dispatch(): Promise<void> {
    this.running = true;
    while (this.running) {
      const event = await this.eventQueue.get();
      const confInfo = this.configManager.getConfInfo(event.unifiedMsgOrigin);
      const confId = confInfo.id;
      const scheduler = this.schedulerMapping.get(confId);

      if (!scheduler) {
        console.error(`PipelineScheduler not found for config: ${confId}, event ignored.`);
        continue;
      }

      setTimeout(() => scheduler.execute(event), 0);
    }
  }

  stop(): void {
    this.running = false;
  }
}
