/**
 * MemoryConsolidator: extracts, deduplicates, merges, and ages memories.
 *
 * Consolidation pipeline:
 * 1. Extract memories from conversation history (LLM-assisted)
 * 2. Deduplicate: find and merge similar memories
 * 3. Apply aging: demote/archive low-access long_term memories
 * 4. Delete expired memories
 *
 * Improvements over plugin version:
 * - LLM failure protection: preserves short-term buffer on extraction failure, retries next cycle
 * - Memory length limit: truncates overly long memory values
 * - Structured user profile: {preferences, background, style} fixed schema
 * - Structured history index: {title, topics[]} format
 */

import type { SqliteMemoryStore, MemoryEntry } from "./sqlite-memory-store.js";
import type { Provider } from "./types.js";

// ── Types ──

export interface ConsolidationConfig {
  /** 执行间隔，支持格式如 "12h"、"30m"、"1d6h30m" (默认: "12h") */
  interval: string;
  /** Whether consolidation is enabled */
  enabled: boolean;
  /** Whether the parent memory system is enabled */
  memoryEnabled?: boolean;
  /** Aging: access count threshold below which memories are demoted (default: 1) */
  agingAccessThreshold: number;
  /** Aging: age in days after which rarely-accessed memories are demoted (default: 90) */
  agingMaxAgeDays: number;
  /** Whether to promote short_term to long_term on session end (default: true) */
  promoteOnSessionEnd: boolean;
  /** Max age in ms for short_term memories before they are deleted on archive (default: 7 days) */
  shortTermMaxAgeMs: number;
  /** Max character length for a single memory value (default: 400). Values exceeding this are truncated. */
  maxMemoryLength: number;
  /** Max retry attempts for LLM extraction on failure (default: 3) */
  maxRetries: number;
  /** Min short-term messages required before extraction can proceed (default: 6) */
  bufferMinMessages: number;
  /** Buffer message count that triggers automatic consolidation immediately (default: 30) */
  autoConsolidateBufferCount: number;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  interval: "12h",
  enabled: true,
  memoryEnabled: true,
  agingAccessThreshold: 1,
  agingMaxAgeDays: 90,
  promoteOnSessionEnd: true,
  shortTermMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxMemoryLength: 400,
  maxRetries: 3,
  bufferMinMessages: 6,
  autoConsolidateBufferCount: 30,
};

export interface ConsolidationResult {
  extracted: number;
  merged: number;
  expired: number;
  aged: { demoted: number; archived: number };
  /** Whether extraction was skipped due to LLM failure (buffer preserved for retry) */
  extractionFailed: boolean;
}

// ── Structured Profile Schema ──

export interface UserProfile {
  preferences: string;
  background: string;
  style: string;
}

// ── MemoryConsolidator ──

export class MemoryConsolidator {
  private store: SqliteMemoryStore;
  private provider: Provider | null = null;
  private fallbackProviders: Provider[] = [];
  private config: ConsolidationConfig;
  /** Track consecutive extraction failures for retry logic */
  private consecutiveFailures: number = 0;
  /** 内置定时器句柄 */
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  /** 是否正在执行整理中，防止并发 */
  private consolidating = false;
  /** Active timer configuration to prevent redundant restarts */
  private activeTimerConfig: { interval: string; enabled: boolean; memoryEnabled?: boolean } | null = null;

  constructor(
    store: SqliteMemoryStore,
    config?: Partial<ConsolidationConfig>,
  ) {
    this.store = store;
    this.config = { ...DEFAULT_CONSOLIDATION_CONFIG, ...config };
  }

  setProvider(provider: Provider): void {
    this.provider = provider;
  }

  /** 设置 fallback providers，主 provider 失败时自动切换 */
  setFallbackProviders(providers: Provider[]): void {
    this.fallbackProviders = providers;
  }

  getConfig(): ConsolidationConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<ConsolidationConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /**
   * Run the full consolidation pipeline.
   * On LLM extraction failure, short-term memories are preserved for next cycle.
   */
  async consolidate(options?: { force?: boolean }): Promise<ConsolidationResult> {
    if (!this.config.enabled || this.config.memoryEnabled === false) {
      console.log("[MemoryConsolidator] Memory system or consolidation is disabled. Skipping consolidation.");
      return {
        extracted: 0,
        merged: 0,
        expired: 0,
        aged: { demoted: 0, archived: 0 },
        extractionFailed: false,
      };
    }
    console.log("[MemoryConsolidator] Starting consolidation...");

    const result: ConsolidationResult = {
      extracted: 0,
      merged: 0,
      expired: 0,
      aged: { demoted: 0, archived: 0 },
      extractionFailed: false,
    };

    let extractionSkipped = false;

    // Step 1: Extract memories from recent conversations (if provider available)
    // On failure, skip extraction and preserve short-term buffer for retry
    if (this.provider) {
      const extractionResult = await this.extractFromConversations(options?.force);
      if (extractionResult.failed) {
        result.extractionFailed = true;
        this.consecutiveFailures++;
        console.warn(
          `[MemoryConsolidator] Extraction failed (${this.consecutiveFailures}/${this.config.maxRetries}). ` +
          `Short-term buffer preserved for next cycle.`
        );
        // Only proceed with dedup/aging if we've exceeded max retries
        // (otherwise we want to preserve the buffer untouched)
        if (this.consecutiveFailures < this.config.maxRetries) {
          return result;
        }
        // Max retries exceeded — reset counter and proceed with other steps
        console.warn("[MemoryConsolidator] Max retries exceeded, proceeding with dedup/aging.");
        this.consecutiveFailures = 0;
      } else {
        result.extracted = extractionResult.count;
        extractionSkipped = !!(extractionResult as any).skipped;
        this.consecutiveFailures = 0;
      }
    } else {
      console.warn("[MemoryConsolidator] Skipping extraction: No LLM provider is configured on the consolidator.");
      extractionSkipped = true;
    }

    // Step 2: Deduplicate and merge similar memories
    result.merged = this.deduplicate();

    // Step 3: Delete expired memories
    result.expired = this.store.deleteExpired();

    // Step 4: Apply aging
    result.aged = this.store.applyAging({
      accessThreshold: this.config.agingAccessThreshold,
      maxAgeDays: this.config.agingMaxAgeDays,
    });

    console.log(
      `[MemoryConsolidator] Consolidation complete: extracted=${result.extracted}, merged=${result.merged}, ` +
      `expired=${result.expired}, aged=${result.aged.demoted}d/${result.aged.archived}a` +
      (result.extractionFailed ? " (extraction failed, buffer preserved)" : "")
    );

    if (!result.extractionFailed && !extractionSkipped) {
      try {
        this.store.save("system_last_consolidate_time", Date.now().toString(), [], {
          memoryType: "long_term",
          scope: "global",
          priority: 0,
        });
      } catch (e) {
        console.error("[MemoryConsolidator] Failed to save system_last_consolidate_time:", e);
      }
    }

    return result;
  }

  /**
   * Archive short-term memories for a session (called on session end).
   */
  archiveSession(scopeId: string): { promoted: number; deleted: number } {
    if (!this.config.enabled || this.config.memoryEnabled === false) {
      return { promoted: 0, deleted: 0 };
    }
    return this.store.archiveShortTermMemories(scopeId, {
      promoteToLongTerm: this.config.promoteOnSessionEnd,
      maxAge: this.config.shortTermMaxAgeMs,
    });
  }

  /**
   * Extract memories from conversation history using LLM.
   * Returns extraction count and failure status.
   * On failure, short-term memories are NOT cleared (preserved for retry).
   */
  private async extractFromConversations(force = false): Promise<{ count: number; failed: boolean; skipped?: boolean }> {
    if (!this.provider) {
      console.warn("[MemoryConsolidator] Skipping extraction: No LLM provider is configured on the consolidator.");
      return { count: 0, failed: false, skipped: true };
    }

    // Get existing memories for dedup context
    const existingLongTerm = this.store.list(50, { memoryType: "long_term" });
    const existingProfileEntry = this.store.recall("user_profile");
    let existingProfileStr = "(空)";
    if (existingProfileEntry) {
      try {
        const p = JSON.parse(existingProfileEntry.value) as UserProfile;
        existingProfileStr = `偏好(preferences): ${p.preferences ?? ""}\n背景(background): ${p.background ?? ""}\n语言风格(style): ${p.style ?? ""}`;
      } catch {
        existingProfileStr = existingProfileEntry.value;
      }
    }
    const existingSummary = [
      ...existingLongTerm.map(m => `- [${m.key}] ${m.value.slice(0, 100)}`),
      ...(existingProfileEntry ? [`- [profile:user_profile] ${existingProfileEntry.value.slice(0, 100)}`] : []),
    ].join("\n");

    // Get recent short-term conversation buffer
    const shortTermMemories = this.store.list(50, { memoryType: "short_term" });
    const bufferTexts = shortTermMemories
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(m => {
        const role = m.key.endsWith("_user") ? "用户" : "AI";
        return `${role}：${m.value}`;
      });

    const minMessages = force ? 1 : this.config.bufferMinMessages;
    if (bufferTexts.length < minMessages) {
      console.log(`[MemoryConsolidator] Conversation buffer has insufficient messages (${bufferTexts.length}/${minMessages}). Skipping extraction.`);
      return { count: 0, failed: false, skipped: true };
    }

    console.log(`[MemoryConsolidator] Processing memory extraction on ${bufferTexts.length} short-term messages (force=${force}).`);

    const extractionPrompt = `【任务：深度记忆整理】
请根据以下对话记录，执行四项任务：
1. 提取/更新【用户画像】：包含用户的偏好(preferences)、背景信息(background)、语言风格(style)，每项简洁描述。
2. 提炼【长期记忆】：提取对话中重要的偏好、事实、决策、进展，每条记忆用 key-value 表示。
3. 生成【历史索引】：提取对话涉及的 3-5 个核心关键词(topics)和一段简短检索标题(title)。

【当前数据】
当前画像：
${existingProfileStr}
当前长期记忆：
${existingSummary || "(空)"}

【最近对话】
${bufferTexts.join("\n")}

请严格以 JSON 格式输出结果，包含：
{
  "profile": {
    "preferences": "用户偏好描述",
    "background": "用户背景描述",
    "style": "用户语言风格描述"
  },
  "memories": [
    {
      "key": "snake_case标识符",
      "value": "记忆内容（简洁但完整）",
      "tags": ["标签1", "标签2"],
      "priority": 0-10
    }
  ],
  "index": {
    "title": "简短的检索标题",
    "topics": ["关键词1", "关键词2"]
  }
}

注意：
- 画像应该是增量更新的，保留之前已有的信息
- memories 中的 key 不要与已有记忆重复，如有更新请合并到已有 key
- 如果没有重要信息，memories 可为空数组
- 仅输出 JSON，不要有其他解释`;

    // 尝试主 provider 和所有 fallback providers
    const candidates = this.provider ? [this.provider, ...this.fallbackProviders] : [];
    let lastError: Error | null = null;

    for (const prov of candidates) {
      try {
        const response = await prov.textChat({
          contexts: [
            { role: "system", content: extractionPrompt },
            { role: "user", content: "请从上述对话中提取记忆、更新画像、生成索引。" },
          ],
          enableCaching: true,
        });

        const text = (response.completionText ?? "").trim();
        if (!text) return { count: 0, failed: true };

        // Parse JSON from response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { count: 0, failed: true };

        const parsed = JSON.parse(jsonMatch[0]);

        let extracted = 0;

        // 1. Update user profile (structured: preferences, background, style)
        if (parsed.profile && typeof parsed.profile === "object") {
          const profile = parsed.profile as UserProfile;
          const cleanProfile: UserProfile = {
            preferences: this.truncateValue(profile.preferences ?? ""),
            background: this.truncateValue(profile.background ?? ""),
            style: this.truncateValue(profile.style ?? ""),
          };
          this.store.save("user_profile", JSON.stringify(cleanProfile), ["profile", "user_profile"], {
            memoryType: "user_profile",
            scope: "global",
            priority: 8,
          });
          extracted++;
        }

        // 2. Save extracted memories as long_term
        const memories = parsed.memories as Array<{
          key: string;
          value: string;
          tags: string[];
          priority: number;
        }>;

        if (Array.isArray(memories)) {
          for (const mem of memories) {
            if (!mem.key || !mem.value) continue;
            this.store.save(mem.key, this.truncateValue(mem.value), mem.tags ?? [], {
              memoryType: "long_term",
              scope: "global",
              priority: mem.priority ?? 0,
            });
            extracted++;
          }
        }

        // 3. Save history index to conversation_indices table (structured: title + topics)
        if (parsed.index) {
          const indexData = parsed.index as { title: string; topics: string[] };
          if (indexData.title || (indexData.topics && indexData.topics.length > 0)) {
            this.store.addConversationIndex({
              title: indexData.title || "",
              topics: indexData.topics ?? [],
            });
            extracted++;
          }
        }

        // 4. On success, clear the short-term conversation buffer (only the processed keys)
        const processedKeys = shortTermMemories.map(m => m.key);
        this.clearShortTermBuffer(processedKeys);

        return { count: extracted, failed: false };
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        console.warn(`[MemoryConsolidator] Provider ${prov.providerConfig?.id ?? "?"} 提取记忆失败，尝试下一个: ${lastError.message}`);
      }
    }

    // 所有 provider 均失败
    console.error("[MemoryConsolidator] 所有 provider 均无法提取记忆:", lastError?.message);
    return { count: 0, failed: true };
  }

  /**
   * Clear short-term conversation buffer memories after successful extraction.
   */
  private clearShortTermBuffer(keys: string[]): void {
    for (const key of keys) {
      this.store.delete(key);
    }
  }

  /**
   * Truncate a memory value if it exceeds maxMemoryLength.
   */
  private truncateValue(value: string): string {
    const maxLen = this.config.maxMemoryLength;
    if (maxLen > 0 && value.length > maxLen) {
      return value.slice(0, maxLen - 3) + "...";
    }
    return value;
  }

  /**
   * Deduplicate similar memories by finding and merging them.
   * Skips user_profile type (fixed schema fields should not be merged).
   */
  private deduplicate(): number {
    let merged = 0;
    const allMemories = this.store.list(500);

    for (const memory of allMemories) {
      // Skip user_profile — each field (preferences/background/style) is distinct
      if (memory.memoryType === "user_profile") continue;

      const similar = this.store.findSimilar(memory.key, memory.tags, 3);
      for (const candidate of similar) {
        // Skip if already processed or different type
        if (candidate.memoryType !== memory.memoryType) continue;
        if (candidate.key <= memory.key) continue; // Process each pair once

        // Check if values are similar enough to merge
        if (this.shouldMerge(memory, candidate)) {
          const mergedValue = this.truncateValue(this.mergeValues(memory, candidate));
          if (this.store.merge(memory.key, candidate.key, mergedValue)) {
            merged++;
          }
        }
      }
    }

    return merged;
  }

  /**
   * Determine if two memories should be merged.
   */
  private shouldMerge(a: MemoryEntry, b: MemoryEntry): boolean {
    const normalizeToken = (t: string) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);
    const aTokens = a.key.toLowerCase().split("_").filter(Boolean).map(normalizeToken);
    const bTokens = b.key.toLowerCase().split("_").filter(Boolean).map(normalizeToken);

    const setA = new Set(aTokens);
    const setB = new Set(bTokens);

    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);

    if (union.size === 0) return false;
    const keySimilarity = intersection.size / union.size;

    // We only merge if the keys are extremely similar (similarity >= 0.7)
    if (keySimilarity >= 0.7) {
      if (a.tags.length > 0 && b.tags.length > 0) {
        const tagIntersection = a.tags.filter(t => b.tags.includes(t));
        return tagIntersection.length > 0;
      }
      return true;
    }

    return false;
  }

  /**
   * Merge two memory values into one.
   */
  private mergeValues(a: MemoryEntry, b: MemoryEntry): string {
    // If one value contains the other, use the longer one
    if (a.value.includes(b.value)) return a.value;
    if (b.value.includes(a.value)) return b.value;

    // Otherwise concatenate with separator
    return `${a.value}\n---\n${b.value}`;
  }

  // ── 周期定时器 ──

  /**
   * 解析间隔字符串或数字为毫秒数。
   * 支持格式: "12h"、"30m"、"1d6h30m"、"2h30m15s" 以及纯数字或纯数字字符串（代表秒数）
   */
  static parseInterval(interval: string | number): number {
    const defaultMs = 12 * 60 * 60 * 1000; // 12 hours default
    if (interval === undefined || interval === null) {
      console.warn(`[MemoryConsolidator] Received null or undefined interval, falling back to default 12h.`);
      return defaultMs;
    }

    if (typeof interval === "number") {
      if (interval <= 0) {
        console.warn(`[MemoryConsolidator] Invalid numeric interval: ${interval}, falling back to default 12h.`);
        return defaultMs;
      }
      return interval * 1000;
    }

    const trimmed = String(interval).trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const val = parseFloat(trimmed);
      if (val <= 0) {
        console.warn(`[MemoryConsolidator] Invalid numeric interval string: "${interval}", falling back to default 12h.`);
        return defaultMs;
      }
      return val * 1000;
    }

    const regex = /(\d+)\s*(d|h|m|s)/gi;
    let totalMs = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(trimmed)) !== null) {
      const value = parseInt(match[1], 10);
      const unit = match[2].toLowerCase();
      switch (unit) {
        case "d": totalMs += value * 24 * 60 * 60 * 1000; break;
        case "h": totalMs += value * 60 * 60 * 1000; break;
        case "m": totalMs += value * 60 * 1000; break;
        case "s": totalMs += value * 1000; break;
      }
    }

    if (totalMs <= 0) {
      console.warn(`[MemoryConsolidator] 无效的间隔格式: "${interval}"，使用默认间隔 12h。示例: "12h", "30m", "1d6h"`);
      return defaultMs;
    }
    return totalMs;
  }

  /**
   * 动态调度下一次整理检查
   */
  private scheduleNextCheck(customDelay?: number): void {
    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }

    if (!this.config.enabled || this.config.memoryEnabled === false) return;

    let delay = customDelay;
    if (delay === undefined) {
      const intervalMs = MemoryConsolidator.parseInterval(this.config.interval);
      try {
        const lastTimeEntry = this.store.recall("system_last_consolidate_time");
        const lastTimeMs = lastTimeEntry ? parseInt(lastTimeEntry.value, 10) : 0;
        const now = Date.now();
        if (lastTimeMs === 0) {
          // 首次启动，未曾有整理时间戳，以当前配置间隔作为下次检查时间
          delay = intervalMs;
        } else {
          const timeSinceLast = now - lastTimeMs;
          delay = Math.max(0, intervalMs - timeSinceLast);
          if (delay === 0) {
            // 如果已经到期但没有成功推进时间戳（例如 buffer 还没够数导致跳过，或者整理失败），
            // 此时应避免死循环，使用 intervalMs 作为下一次检查间隔，或在此之前由用户新消息对话触发 checkAndConsolidate()
            delay = intervalMs;
          }
        }
      } catch (e) {
        console.warn("[MemoryConsolidator] 计算下一次检查延迟失败，退化为默认间隔:", e);
        delay = intervalMs;
      }
    }

    console.log(`[MemoryConsolidator] 下一次定时整理检查将在 ${delay / 1000} 秒后触发`);
    this.timerHandle = setTimeout(() => {
      this.runConsolidateSafe();
    }, delay);
  }

  /** 启动周期性记忆整理，使用 config.interval 控制频率（幂等，重复调用安全） */
  startPeriodic(): void {
    const wasRunning = this.isRunning();
    const currentTimerConfig = {
      interval: this.config.interval,
      enabled: this.config.enabled,
      memoryEnabled: this.config.memoryEnabled,
    };

    if (wasRunning &&
        this.activeTimerConfig?.interval === currentTimerConfig.interval &&
        this.activeTimerConfig?.enabled === currentTimerConfig.enabled &&
        this.activeTimerConfig?.memoryEnabled === currentTimerConfig.memoryEnabled) {
      return;
    }

    this.stop();
    this.activeTimerConfig = currentTimerConfig;

    if (!this.config.enabled || this.config.memoryEnabled === false) return;

    const ms = MemoryConsolidator.parseInterval(this.config.interval);
    console.log(`[MemoryConsolidator] 启动周期整理，配置间隔: ${this.config.interval} (${ms}ms)`);
    this.scheduleNextCheck();
  }

  /** 停止周期性记忆整理 */
  stop(): void {
    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    this.activeTimerConfig = null;
  }

  /** 安全执行 consolidate，捕获异常不影响定时器，防止并发 */
  private async runConsolidateSafe(): Promise<void> {
    if (this.consolidating) {
      this.scheduleNextCheck(60000); // 忙碌中，1 分钟后再试
      return;
    }

    this.consolidating = true;
    try {
      const lastTimeEntry = this.store.recall("system_last_consolidate_time");
      const lastTimeMs = lastTimeEntry ? parseInt(lastTimeEntry.value, 10) : 0;
      const now = Date.now();
      const intervalMs = MemoryConsolidator.parseInterval(this.config.interval);
      if (lastTimeMs > 0 && (now - lastTimeMs) < intervalMs) {
        console.log(`[MemoryConsolidator] 周期触发：距离上一次整理仅过去 ${(now - lastTimeMs) / 1000}s，小于间隔 ${intervalMs / 1000}s，跳过。`);
        return;
      }

      console.log("[MemoryConsolidator] 周期触发：开始整理...");
      const result = await this.consolidate();
      console.log(`[MemoryConsolidator] 整理完成: 提取=${result.extracted}, 合并=${result.merged}, 过期=${result.expired}`);
    } catch (e) {
      console.error("[MemoryConsolidator] 整理异常:", e);
    } finally {
      this.consolidating = false;
      this.scheduleNextCheck();
    }
  }

  /** 获取当前定时器状态（是否运行中） */
  isRunning(): boolean {
    return this.timerHandle !== null;
  }

  /**
   * Check if consolidation thresholds are met and run consolidation if needed.
   * Typically called after a conversation turn is recorded.
   */
  async checkAndConsolidate(): Promise<ConsolidationResult | null> {
    if (!this.config.enabled || this.config.memoryEnabled === false) {
      return null;
    }

    // 1. Get the current short-term buffer size
    const shortTermMemories = this.store.list(500, { memoryType: "short_term" });
    const bufferLen = shortTermMemories.length;

    // 2. Get last consolidate time
    let lastTimeMs = 0;
    try {
      const lastTimeEntry = this.store.recall("system_last_consolidate_time");
      lastTimeMs = lastTimeEntry ? parseInt(lastTimeEntry.value, 10) : 0;
    } catch (e) {
      console.warn("[MemoryConsolidator] Failed to retrieve or parse system_last_consolidate_time in checkAndConsolidate:", e);
    }
    
    const now = Date.now();
    const intervalMs = MemoryConsolidator.parseInterval(this.config.interval);
    const timeSinceLast = now - lastTimeMs;

    let shouldConsolidate = false;

    // Condition 1: Time interval met AND buffer has at least min messages
    if (intervalMs > 0 && timeSinceLast >= intervalMs && bufferLen >= this.config.bufferMinMessages) {
      shouldConsolidate = true;
      console.log(`[MemoryConsolidator] Time-based threshold met: timeSinceLast=${timeSinceLast}ms >= ${intervalMs}ms, bufferLen=${bufferLen} >= ${this.config.bufferMinMessages}. Triggering consolidation.`);
    }
    // Condition 2: Buffer length exceeds autoConsolidateBufferCount threshold
    else if (bufferLen >= this.config.autoConsolidateBufferCount) {
      shouldConsolidate = true;
      console.log(`[MemoryConsolidator] Buffer count threshold met: bufferLen=${bufferLen} >= ${this.config.autoConsolidateBufferCount}. Triggering consolidation.`);
    }

    if (shouldConsolidate) {
      if (this.consolidating) {
        console.log("[MemoryConsolidator] Consolidation already in progress, skipping checkAndConsolidate execution.");
        return null;
      }
      this.consolidating = true;
      try {
        return await this.consolidate();
      } finally {
        this.consolidating = false;
      }
    }

    return null;
  }
}
