/**
 * Provider-agnostic reasoning/thinking effort mapping.
 *
 * `ReasoningEffort` is a coarse scale ("off" | "minimal" | "low" | "medium" |
 * "high"). Each provider exposes a different native knob, and sending a
 * reasoning field to a model that does not support it typically yields a 400.
 * These helpers centralize both the mapping and the capability gating so every
 * provider behaves consistently and a non-reasoning model is never sent an
 * unsupported field.
 */

import type { ReasoningEffort } from "@yachiyo/common/llm-types.js";

export type { ReasoningEffort };

/** Ordered scale used for comparisons (e.g. clamping an auto controller). */
export const REASONING_EFFORT_ORDER: readonly ReasoningEffort[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
];

/** Resolve the effective effort from a request value, falling back to config. */
export function resolveReasoningEffort(
  requestEffort: ReasoningEffort | undefined,
  configEffort: unknown,
): ReasoningEffort | undefined {
  const normalized = normalizeReasoningEffort(requestEffort) ?? normalizeReasoningEffort(configEffort);
  return normalized;
}

/** Validate/coerce an arbitrary value to a `ReasoningEffort`, else undefined. */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.toLowerCase();
  return (REASONING_EFFORT_ORDER as readonly string[]).includes(v)
    ? (v as ReasoningEffort)
    : undefined;
}

/** Numeric rank for an effort (higher = more thinking). Unknown → -1. */
export function reasoningEffortRank(effort: ReasoningEffort | undefined): number {
  if (!effort) return -1;
  return REASONING_EFFORT_ORDER.indexOf(effort);
}

/**
 * Split a model id into lowercase tokens on the separators vendors use
 * (`-`, `.`, `_`, `/`). Tokenizing once and inspecting the resulting array is
 * linear in the id length, avoiding the polynomial-backtracking risk that
 * CodeQL flags on regexes with quantifiers applied to an untrusted model id.
 */
function tokenizeModelId(modelId: string): string[] {
  return modelId.toLowerCase().split(/[-._/]+/).filter((t) => t.length > 0);
}

/** Parse a non-negative integer token, or NaN. */
function tokenToInt(token: string | undefined): number {
  if (token === undefined) return Number.NaN;
  if (!/^[0-9]+$/.test(token)) return Number.NaN;
  return Number.parseInt(token, 10);
}

/**
 * Find the index of the first token equal to `name`, or -1.
 */
function indexOfToken(tokens: string[], name: string): number {
  return tokens.indexOf(name);
}

/**
 * Heuristic: does this model id look like a reasoning-capable model?
 *
 * Vendor id conventions change over time, so this is intentionally broad and
 * errs toward enabling when a provider has explicitly configured a reasoning
 * effort (the operator opted in). It is used only to *gate* sending a native
 * reasoning field, never to force one on.
 *
 * Implemented via tokenization (see {@link tokenizeModelId}) rather than
 * regexes over the raw id to keep matching linear in the input length.
 */
export function modelSupportsReasoning(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const tokens = tokenizeModelId(modelId);
  if (tokens.length === 0) return false;

  // OpenAI: o-series (o1/o3/o4-mini/…). A standalone `o1`..`o9` token.
  for (const t of tokens) {
    if (t.length === 2 && t[0] === "o" && t[1] >= "1" && t[1] <= "9") return true;
  }
  // OpenAI: gpt-5 family (substring, no quantifier).
  if (modelId.toLowerCase().includes("gpt-5")) return true;

  // Anthropic: Claude 3.7+/3.8/3.9 or major >= 4. Ids look like
  // `claude-3-7-sonnet-…`, `claude-sonnet-4-5`, `claude-opus-4-1`. Only the
  // FIRST numeric token after `claude` is the major version — scanning further
  // would misread the minor `5` in `claude-3-5-sonnet` as major 5.
  const claudeIdx = indexOfToken(tokens, "claude");
  if (claudeIdx !== -1) {
    for (let i = claudeIdx + 1; i < tokens.length; i++) {
      const major = tokenToInt(tokens[i]);
      if (Number.isNaN(major)) continue; // skip family words (sonnet/opus/…)
      if (major >= 4) return true;
      if (major === 3) {
        const minor = tokenToInt(tokens[i + 1]);
        if (minor === 7 || minor === 8 || minor === 9) return true;
      }
      break; // first numeric token was the major version
    }
  }

  // Gemini: 2.5+ and 3.x+. Find `gemini` and inspect the following tokens.
  const geminiIdx = indexOfToken(tokens, "gemini");
  if (geminiIdx !== -1) {
    const major = tokenToInt(tokens[geminiIdx + 1]);
    if (!Number.isNaN(major)) {
      if (major >= 3) return true;
      if (major === 2) {
        const minor = tokenToInt(tokens[geminiIdx + 2]);
        if (minor >= 5) return true;
      }
    }
  }

  return false;
}

/**
 * Map a `ReasoningEffort` to Anthropic's `thinking` body field.
 *
 * Anthropic requires `budget_tokens >= 1024` and `budget_tokens < max_tokens`.
 * Thinking is opt-in, so `"off"` returns `undefined` — omitting the field is
 * the documented way to disable it (there is no valid `{ type: "disabled" }`
 * value).
 *
 * Returns `undefined` when the effort is undefined or the model is not
 * reasoning-capable.
 */
export function anthropicThinkingConfig(
  effort: ReasoningEffort | undefined,
  modelId: string | undefined,
  maxTokens: number,
): { type: "enabled"; budget_tokens: number } | undefined {
  if (!effort) return undefined;
  // Opt-in feature: omitting the field disables thinking.
  if (effort === "off") return undefined;
  if (!modelSupportsReasoning(modelId)) return undefined;
  const budget = ANTHROPIC_BUDGET_TOKENS[effort];
  if (budget === undefined) return undefined;
  // budget_tokens must be strictly less than max_tokens; clamp to leave room
  // for the answer, and skip entirely if max_tokens is too small to allow the
  // 1024-token minimum.
  const cappedBudget = Math.min(budget, maxTokens - 1024);
  if (cappedBudget < 1024) return undefined;
  return { type: "enabled", budget_tokens: cappedBudget };
}

/** Anthropic thinking budgets per effort level (tokens). */
const ANTHROPIC_BUDGET_TOKENS: Partial<Record<ReasoningEffort, number>> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 24576,
};

/**
 * Whether an OpenAI model accepts `reasoning_effort: "none"` to disable
 * reasoning. Only newer models (gpt-5.1+) accept it; o-series (o1/o3/o4-mini)
 * and base gpt-5 reject "none" with a 400, so for those we omit the field
 * entirely (leaving the model default) rather than send an invalid value.
 */
export function openaiSupportsReasoningNone(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return /gpt-5\.[1-9]/.test(id) || /gpt-[6-9]/.test(id);
}

/**
 * Map a `ReasoningEffort` to OpenAI's `reasoning_effort` value (Chat
 * Completions). `"off"` → `"none"` only on models that accept it (gpt-5.1+);
 * otherwise `undefined` so the field is omitted and no 400 is triggered.
 */
export function openaiReasoningEffort(
  effort: ReasoningEffort | undefined,
  modelId: string | undefined,
): string | undefined {
  if (!effort) return undefined;
  if (!modelSupportsReasoning(modelId)) return undefined;
  if (effort === "off") {
    return openaiSupportsReasoningNone(modelId) ? "none" : undefined;
  }
  // OpenAI's documented values are minimal/low/medium/high.
  return effort;
}

/**
 * Map a `ReasoningEffort` to OpenAI Responses' `reasoning.effort` value.
 * Responses uses low/medium/high; "minimal" is not accepted by all models, so
 * it is mapped to "low". `"off"` → `"none"` only on models that accept it.
 */
export function responsesReasoningEffort(
  effort: ReasoningEffort | undefined,
  modelId: string | undefined,
): string | undefined {
  if (!effort) return undefined;
  if (!modelSupportsReasoning(modelId)) return undefined;
  if (effort === "off") {
    return openaiSupportsReasoningNone(modelId) ? "none" : undefined;
  }
  if (effort === "minimal") return "low";
  return effort;
}

/** Gemini Flash thinking budgets per effort level (tokens); 0 disables. */
const GEMINI_FLASH_BUDGET: Record<ReasoningEffort, number> = {
  off: 0,
  minimal: 1024,
  low: 4096,
  medium: 12288,
  high: 24576,
};

/**
 * Gemini Pro thinking budgets. Pro CANNOT disable thinking — sending
 * `thinkingBudget: 0` returns a 400 — and its minimum budget is 128. `"off"`
 * therefore maps to the 128-token minimum (the closest achievable to "off")
 * rather than 0.
 */
const GEMINI_PRO_BUDGET: Record<ReasoningEffort, number> = {
  off: 128,
  minimal: 128,
  low: 1024,
  medium: 8192,
  high: 24576,
};

/** Gemini 3.x thinking level. Gemini 3 uses `thinkingLevel`, not a budget. */
type GeminiThinkingConfig =
  | { thinkingBudget: number; includeThoughts: boolean }
  | { thinkingLevel: "low" | "high"; includeThoughts: boolean };

/**
 * True for Gemini 3.x and later (major version >= 3). Tokenized rather than
 * regex-matched to keep it linear in the input length.
 */
function isGemini3(id: string): boolean {
  const tokens = tokenizeModelId(id);
  const idx = indexOfToken(tokens, "gemini");
  if (idx === -1) return false;
  const major = tokenToInt(tokens[idx + 1]);
  return !Number.isNaN(major) && major >= 3;
}

/**
 * True for a Gemini Pro model (thinking cannot be disabled; min budget 128).
 * Uses token equality on the `pro` token rather than a regex with a `[^/]*`
 * quantifier over untrusted input.
 */
function isGeminiPro(id: string): boolean {
  return indexOfToken(tokenizeModelId(id), "pro") !== -1;
}

/**
 * Map a `ReasoningEffort` to Gemini's `generationConfig.thinkingConfig`.
 *
 * Model-family differences:
 * - Gemini 3.x uses `thinkingLevel` ("low"/"high"), not a token budget. Thinking
 *   cannot be fully disabled, so "off"/"minimal"/"low"/"medium" → "low" and
 *   "high" → "high".
 * - Gemini 2.5 Pro cannot disable thinking (`thinkingBudget: 0` → 400); its
 *   minimum is 128, so all levels are clamped to >= 128.
 * - Gemini 2.5 Flash supports `thinkingBudget: 0` to disable.
 *
 * `includeThoughts: true` so the thought parts (and their signatures) are
 * returned for replay.
 */
export function geminiThinkingConfig(
  effort: ReasoningEffort | undefined,
  modelId: string | undefined,
): GeminiThinkingConfig | undefined {
  if (!effort) return undefined;
  if (!modelSupportsReasoning(modelId)) return undefined;
  const id = modelId!.toLowerCase();

  if (isGemini3(id)) {
    const level: "low" | "high" = effort === "high" || effort === "medium" ? "high" : "low";
    return { thinkingLevel: level, includeThoughts: true };
  }

  if (isGeminiPro(id)) {
    return { thinkingBudget: GEMINI_PRO_BUDGET[effort], includeThoughts: true };
  }

  return { thinkingBudget: GEMINI_FLASH_BUDGET[effort], includeThoughts: true };
}
