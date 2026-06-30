import { PipelineStage, registerStage } from "../stage.js";
import type { PipelineContext } from "../context.js";
import type { MessageEvent } from "@yachiyo/message/event.js";
import { SINGLE_USER_UMO } from "@yachiyo/message/event.js";
import type { SqliteSessionDisabledStore, SqliteSessionWhitelistStore } from "@yachiyo/config/sqlite-config-extras-store.js";

/**
 * Manages session-level access control:
 *
 * 1. **Blacklist** (disabled_sessions): A globally disabled session or a
 *    specific UMO in the blacklist is always rejected.
 * 2. **Whitelist** (whitelisted_sessions): When whitelist mode is enabled,
 *    only UMOs present in the whitelist are allowed; all others are rejected.
 *
 * The whitelist-mode toggle is read from `AgentConfig.sessionWhitelistEnabled`
 * by the pipeline stage (not stored here) so that Dashboard config changes
 * take effect immediately without restart.
 */
export class SessionServiceManager {
  private disabled: boolean = false;
  private sqliteDisabledStore?: SqliteSessionDisabledStore;
  private sqliteWhitelistStore?: SqliteSessionWhitelistStore;

  constructor(
    sqliteDisabledStore?: SqliteSessionDisabledStore,
    sqliteWhitelistStore?: SqliteSessionWhitelistStore,
  ) {
    this.sqliteDisabledStore = sqliteDisabledStore;
    this.sqliteWhitelistStore = sqliteWhitelistStore;
  }

  /**
   * Check whether a session should be allowed to proceed.
   *
   * @param umo The unified message origin identifying the session.
   * @param whitelistEnabled Whether whitelist mode is active (from config).
   * @returns `true` if the session is allowed, `false` if it should be blocked.
   */
  async isSessionEnabled(umo: string, whitelistEnabled: boolean = false): Promise<boolean> {
    // 1. Global disable (blacklist) — check both the specific UMO and the
    //    global SINGLE_USER_UMO toggle.
    if (this.sqliteDisabledStore) {
      if (this.sqliteDisabledStore.isDisabled(SINGLE_USER_UMO)) return false;
      if (this.sqliteDisabledStore.isDisabled(umo)) return false;
    } else if (this.disabled) {
      return false;
    }

    // 2. Whitelist mode — when enabled, only whitelisted UMOs pass.
    if (whitelistEnabled && this.sqliteWhitelistStore) {
      return this.sqliteWhitelistStore.isWhitelisted(umo);
    }

    return true;
  }

  // ── Blacklist management (existing, preserved for backward compat) ──

  async disableSession(): Promise<void> {
    this.disabled = true;
    if (this.sqliteDisabledStore) {
      this.sqliteDisabledStore.disable(SINGLE_USER_UMO);
    }
  }

  async enableSession(): Promise<void> {
    this.disabled = false;
    if (this.sqliteDisabledStore) {
      this.sqliteDisabledStore.enable(SINGLE_USER_UMO);
    }
  }

  // ── Whitelist management ──

  isWhitelisted(umo: string): boolean {
    return this.sqliteWhitelistStore?.isWhitelisted(umo) ?? false;
  }

  addWhitelist(umo: string): void {
    this.sqliteWhitelistStore?.add(umo);
  }

  removeWhitelist(umo: string): void {
    this.sqliteWhitelistStore?.remove(umo);
  }

  listWhitelist(): Array<{ unified_msg_origin: string; added_at: string }> {
    return this.sqliteWhitelistStore?.listAll() ?? [];
  }
}

@registerStage
export class SessionStatusCheckStage extends PipelineStage {
  private sessionServiceManager!: SessionServiceManager;
  private ctx: PipelineContext | null = null;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.sessionServiceManager = ctx.sessionServiceManager;
    this.ctx = ctx;
  }

  async process(event: MessageEvent): Promise<void> {
    // Read whitelist mode dynamically from config so Dashboard changes
    // take effect immediately without restart.
    const whitelistEnabled = this.ctx?.config.sessionWhitelistEnabled ?? false;
    const umo = event.unifiedMsgOrigin;

    const isEnabled = await this.sessionServiceManager.isSessionEnabled(umo, whitelistEnabled);
    if (!isEnabled) {
      console.info(
        `[SessionStatusCheckStage] Blocked session '${umo}' (whitelist mode: ${whitelistEnabled}).`,
      );
      event.stopEvent();
    }
  }
}
