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
 * Heuristic: does this model id look like a reasoning-capable model?
 *
 * Vendor id conventions change over time, so this is intentionally broad and
 * errs toward enabling when a provider has explicitly configured a reasoning
 * effort (the operator opted in). It is used only to *gate* sending a native
 * reasoning field, never to force one on.
 */
export function modelSupportsReasoning(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  // OpenAI: o-series (o1/o3/o4-mini/…), gpt-5 family.
  if (/^o[1-9]/.test(id) || /(^|[/_-])o[1-9]($|[-._/])/.test(id)) return true;
  if (/gpt-5/.test(id)) return true;
  // Anthropic: Claude 3.7+ / 4.x+ extended thinking. Model ids can be
  // `claude-3-7-sonnet-…`, `claude-sonnet-4-5`, `claude-opus-4-1`, etc. Match
  // an optional family word (`sonnet`/`opus`/`haiku`) followed by a version
  // token that is 3.7/3.8/3.9 or major 4+. This deliberately does NOT match
  // minor versions of major 3 (e.g. `claude-3-5-sonnet`), which lack thinking.
  if (/claude(?:[-.][a-z]+)*[-.](?:3[.-][789]|[4-9])(?:[-.]|$)/.test(id)) return true;
  // Gemini: 2.5+ and 3.x support thinking.
  if (/gemini-2[.-]5/.test(id)) return true;
  if (/gemini-[3-9]/.test(id)) return true;
  return false;
}

/**
 * Map a `ReasoningEffort` to Anthropic's `thinking` body field.
 *
 * Anthropic requires `budget_tokens >= 1024` and `budget_tokens < max_tokens`.
 * `"off"` → `{ type: "disabled" }` (only sent when the caller explicitly wants
 * thinking off; otherwise `undefined` leaves the model default).
 *
 * Returns `undefined` when the effort is undefined or the model is not
 * reasoning-capable.
 */
export function anthropicThinkingConfig(
  effort: ReasoningEffort | undefined,
  modelId: string | undefined,
  maxTokens: number,
): { type: "enabled"; budget_tokens: number } | { type: "disabled" } | undefined {
  if (!effort) return undefined;
  if (effort === "off") {
    return modelSupportsReasoning(modelId) ? { type: "disabled" } : undefined;
  }
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
 * Map a `ReasoningEffort` to OpenAI's `reasoning_effort` value (Chat
 * Completions). `"off"` → `"none"` on models that accept it, else undefined.
 */
export function openaiReasoningEffort(
  effort: ReasoningEffort | undefined,
  modelId: string | undefined,
): string | undefined {
  if (!effort) return undefined;
  if (!modelSupportsReasoning(modelId)) return undefined;
  // OpenAI's documented values are minimal/low/medium/high; "none" disables on
  // supported models. Map "off" to "none".
  return effort === "off" ? "none" : effort;
}

/**
 * Map a `ReasoningEffort` to OpenAI Responses' `reasoning.effort` value.
 * Responses uses low/medium/high; "minimal" is not accepted by all models, so
 * it is mapped to "low".
 */
export function responsesReasoningEffort(
  effort: ReasoningEffort | undefined,
  modelId: string | undefined,
): string | undefined {
  if (!effort) return undefined;
  if (!modelSupportsReasoning(modelId)) return undefined;
  if (effort === "off") return "none";
  if (effort === "minimal") return "low";
  return effort;
}

/** Gemini thinking budgets per effort level (tokens); 0 disables on Flash. */
const GEMINI_BUDGET_TOKENS: Record<ReasoningEffort, number> = {
  off: 0,
  minimal: 1024,
  low: 4096,
  medium: 12288,
  high: 24576,
};

/**
 * Map a `ReasoningEffort` to Gemini's `generationConfig.thinkingConfig`.
 * `includeThoughts: true` so the thought parts (and their signatures) are
 * returned for replay.
 */
export function geminiThinkingConfig(
  effort: ReasoningEffort | undefined,
  modelId: string | undefined,
): { thinkingBudget: number; includeThoughts: boolean } | undefined {
  if (!effort) return undefined;
  if (!modelSupportsReasoning(modelId)) return undefined;
  const budget = GEMINI_BUDGET_TOKENS[effort];
  if (budget === undefined) return undefined;
  return { thinkingBudget: budget, includeThoughts: true };
}
