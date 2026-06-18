import { PipelineStage, registerStage } from "../stage.js";
import type { PipelineContext } from "../context.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import { SINGLE_USER_UMO } from "@yachiyo/message/event.js";
import type { SqliteSessionDisabledStore } from "@yachiyo/config/sqlite-config-extras-store.js";

export class SessionServiceManager {
  private disabled: boolean = false;
  private sqliteStore?: SqliteSessionDisabledStore;

  constructor(sqliteStore?: SqliteSessionDisabledStore) {
    this.sqliteStore = sqliteStore;
  }

  async isSessionEnabled(): Promise<boolean> {
    if (this.sqliteStore) {
      return !this.sqliteStore.isDisabled(SINGLE_USER_UMO);
    }
    return !this.disabled;
  }

  async disableSession(): Promise<void> {
    this.disabled = true;
    if (this.sqliteStore) {
      this.sqliteStore.disable(SINGLE_USER_UMO);
    }
  }

  async enableSession(): Promise<void> {
    this.disabled = false;
    if (this.sqliteStore) {
      this.sqliteStore.enable(SINGLE_USER_UMO);
    }
  }
}

@registerStage
export class SessionStatusCheckStage extends PipelineStage {
  private sessionServiceManager!: SessionServiceManager;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.sessionServiceManager = ctx.sessionServiceManager;
  }

  async process(event: MessageEvent): Promise<void> {
    const isEnabled = await this.sessionServiceManager.isSessionEnabled();
    if (!isEnabled) {
      event.stopEvent();
    }
  }
}
