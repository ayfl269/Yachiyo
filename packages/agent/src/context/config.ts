import type { Provider } from "@yachiyo/provider/provider.js";
import type { TokenCounter } from "./token-counter.js";
import type { ContextCompressor } from "./compressor.js";

/**
 * 默认模型上下文窗口（tokens）。
 * 仅在模型元数据完全不可用（provider 未探测到 contextLimit）时的最终回退值，
 * 不是可调的控制参数。
 *
 * 取 200_000 而非 128_000：按"现代主流模型的最低能力"估计。宁可高估——
 * 高估由运行时的 context-overflow 降级重试兜底（见 CONTEXT_WINDOW_LADDER），
 * 低估则会让压缩触发线过低、无谓地丢失上下文且无法恢复。
 */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 200_000;

/**
 * 上下文窗口降级阶梯（tokens，降序）。
 * 运行态收到 context-overflow 错误时按此阶梯逐级下调"假设窗口"并重新压缩。
 * 最低到 4_000：再小基本没有可用对话空间，继续下探只会必然失败。
 * 注意：若 provider 的报错文本里带有真实窗口数字（OpenAI/Anthropic 都带），
 * 应优先采用解析值（见 packages/provider/src/errors.ts 的
 * parseContextOverflowLimit），阶梯只作报错不带数字时的兜底。
 */
export const CONTEXT_WINDOW_LADDER = [
  200_000,
  128_000,
  64_000,
  32_000,
  16_000,
  8_000,
  4_000,
] as const;

/**
 * 返回阶梯中严格小于 `current` 的最大一级；已到最低档时返回 undefined。
 * `parsedLimit` 是从报错文本里解析出的真实窗口（可能不存在）：
 * 只有当它确实小于当前假设窗口时才直接采用，否则仍按阶梯下调——
 * 因为报错里的数字可能恰好等于我们当前假设的窗口（说明问题不在假设，
 * 而在消息本身过长），此时必须继续下调。
 */
export function nextSmallerContextWindow(
  current: number,
  parsedLimit?: number
): number | undefined {
  if (typeof parsedLimit === "number" && Number.isFinite(parsedLimit) && parsedLimit > 0 && parsedLimit < current) {
    return parsedLimit;
  }
  let best: number | undefined;
  for (const level of CONTEXT_WINDOW_LADDER) {
    if (level < current && (best === undefined || level > best)) {
      best = level;
    }
  }
  return best;
}

/**
 * 由模型名称中的显式容量后缀（`-128k`、`_32k`、`-1m` 等）推断上下文窗口。
 *
 * 这不是"模型族清单"——它只识别厂商写进模型名里的容量声明这一通用命名约定，
 * 没有任何会过期的厂商分支。家族分支（claude-3=200k 之类）已删除：
 * 模型族会持续过期，而未识别的模型现在由运行态 200k 默认值 +
 * context-overflow 降级重试兜底，低估的代价远高于高估。
 *
 * 注意换算是二进制（1k = 1024），因此 "-128k" → 131072，与厂商口径的
 * 128_000 不同；这是有意的，不要在别处假定 "128k == 128000"。
 */
export function extractContextLimitFromModelName(modelName: string): number | undefined {
  if (!modelName) return undefined;
  const m = modelName.toLowerCase().match(/(?:[-_]|\b)(\d+)([km])(?:\b|[-_])/);
  if (!m) return undefined;
  const num = parseInt(m[1], 10);
  if (Number.isNaN(num) || num <= 0) return undefined;
  if (m[2] === "k") return num * 1024;
  return num * 1024 * 1024;
}

/**
 * 运行态上下文窗口解析：provider 探测值（由模型 API 元数据写入，未知时为 0）
 * > 模型名容量后缀 > 默认窗口。这是"运行时"的解析——dashboard 侧不允许把
 * 猜测值持久化进 provider 配置，否则这里会把它当成真实元数据，
 * context-overflow 降级重试就永远不会触发。
 */
export function resolveModelContextWindow(
  providerMaxContextTokens: number | undefined,
  modelName?: string
): number {
  if (typeof providerMaxContextTokens === "number" && providerMaxContextTokens > 0) {
    return providerMaxContextTokens;
  }
  const fromName = extractContextLimitFromModelName(modelName ?? "");
  if (fromName !== undefined) return fromName;
  return DEFAULT_MODEL_CONTEXT_WINDOW;
}

/**
 * 默认输出预留（tokens）。
 * 真实约束为 输入 + 输出 ≤ 上下文窗口，压缩触发线须为输出预留空间。
 * 与 anthropic-provider 的 maxTokens 默认值保持一致；provider 配置了
 * maxTokens（> 0）时以配置值为准。
 */
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 4096;

/**
 * 压缩触发比例：在扣除输出预留后的有效输入空间上再乘该比例，
 * 吸收 token 估算误差与 trusted usage 滞后一轮的偏差。
 */
export const COMPRESS_TRIGGER_RATIO = 0.85;

/** 单条工具结果最大 tokens 占上下文窗口的比例。 */
export const TOOL_RESULT_MAX_WINDOW_RATIO = 0.2;

/** 工具结果预览 tokens 占工具结果上限的比例。 */
export const TOOL_RESULT_PREVIEW_RATIO = 0.25;

export interface ContextConfig {
  /**
   * 模型上下文窗口大小（tokens）。<= 0 表示未知（不启用 token 维度控制）。
   *
   * 该值应来自模型 API 元数据的自动探测（如 OpenRouter context_length、
   * Gemini inputTokenLimit），不再支持手动指定作为控制手段。
   */
  maxContextTokens: number;
  /**
   * 压缩触发阈值（tokens）。由 createContextConfig 按
   * maxContextTokens × COMPRESS_TRIGGER_RATIO 自动派生，不接受外部指定。
   */
  compressTriggerTokens: number;
  /**
   * 输出预留（tokens）。由 runner 按 provider 的 maxTokens 配置自动传入
   * （未配置时取 DEFAULT_RESERVED_OUTPUT_TOKENS），不作为独立可调参数。
   * 压缩触发阈值 = (maxContextTokens - reservedOutputTokens) × COMPRESS_TRIGGER_RATIO，
   * 且输出预留最多占用窗口的一半（小窗口下保证控制仍然生效）。
   */
  reservedOutputTokens: number;
  /** Maximum number of conversation turns to keep. -1 means no limit. */
  enforceMaxTurns: number;
  /** Number of turns to discard at once when truncation is triggered. */
  truncateTurns: number;
  /** Instruction prompt for LLM-based compression. */
  llmCompressInstruction?: string;
  /** Number of recent messages to keep during LLM-based compression. */
  llmCompressKeepRecent: number;
  /** Ratio of recent context tokens to keep during LLM-based compression (0-0.3). Overrides llmCompressKeepRecent if > 0. */
  llmCompressKeepRecentRatio?: number;
  /** LLM provider used for compression tasks. */
  llmCompressProvider?: Provider;
  /** Custom token counting method. */
  customTokenCounter?: TokenCounter;
  /** Custom context compression method. */
  customCompressor?: ContextCompressor;
}

/**
 * 由窗口与输出预留派生压缩触发阈值（tokens）。
 *
 *   触发阈值 = (窗口 - 输出预留) × 触发比例，仅自动派生，不暴露为可配置项。
 *   输出预留最多占用窗口的一半，避免小窗口下阈值被扣成 0 而失去控制。
 *
 * 独立导出是因为运行态 context-overflow 降级需要按"下调后的窗口"重算阈值
 * （见 ContextManager.process 的 overrides 参数），而不是只在构造 config 时算一次。
 */
export function deriveCompressTriggerTokens(
  maxContextTokens: number,
  reservedOutputTokens: number
): number {
  if (maxContextTokens <= 0) return 0;
  return Math.floor(
    Math.max(maxContextTokens - reservedOutputTokens, maxContextTokens / 2) *
      COMPRESS_TRIGGER_RATIO
  );
}

/**
 * Build a ContextConfig from optional overrides.
 *
 * `compressTriggerTokens` is deliberately **excluded** from the override type:
 * it is a derived value (see `deriveCompressTriggerTokens`) and must not be
 * settable from the outside. The `Partial<Omit<...>>` in the signature makes
 * that a compile error rather than a doc-only promise — previously
 * `...overrides` was spread last, so a caller could still force the value.
 */
export function createContextConfig(
  overrides?: Partial<Omit<ContextConfig, "compressTriggerTokens">>
): ContextConfig {
  const maxContextTokens = overrides?.maxContextTokens ?? 0;
  const reservedOutputTokens =
    overrides?.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
  return {
    maxContextTokens,
    reservedOutputTokens,
    compressTriggerTokens: deriveCompressTriggerTokens(maxContextTokens, reservedOutputTokens),
    enforceMaxTurns: -1,
    truncateTurns: 1,
    llmCompressKeepRecent: 0,
    llmCompressKeepRecentRatio: 0.15,
    ...overrides,
  };
}

/**
 * 由模型上下文窗口派生单条工具结果的落盘阈值（tokens）。
 */
export function deriveToolResultMaxTokens(contextWindow: number): number {
  return Math.floor(contextWindow * TOOL_RESULT_MAX_WINDOW_RATIO);
}

/**
 * 由工具结果落盘阈值派生预览保留量（tokens）。
 */
export function deriveToolResultPreviewTokens(toolResultMaxTokens: number): number {
  return Math.floor(toolResultMaxTokens * TOOL_RESULT_PREVIEW_RATIO);
}
