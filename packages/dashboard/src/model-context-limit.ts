/**
 * Context-window detection helpers for the model-list API.
 *
 * These helpers ONLY read what the provider's API actually reports. They never
 * guess: an unknown model yields `undefined`, and the *runtime* (agent package)
 * applies the default window + context-overflow downgrade there. Guessing here
 * would persist a fabricated value into the provider config, where the runtime
 * would trust it as real metadata and the downgrade retry could never trigger.
 *
 * The former name-based family heuristic (claude-3 → 200k, gpt-4o → 128k, …)
 * was removed for exactly that reason, and because such lists go stale — the
 * runtime's `CONTEXT_WINDOW_LADDER` + overflow retry now covers unknown models.
 * These live in their own module (instead of inside server.ts) so they can be
 * unit-tested without booting the dashboard HTTP server.
 */

/**
 * Minimal plausible context window (tokens). Anything below this is assumed to
 * be an output cap (`max_tokens` in the OpenAI-compatible `/models` payload
 * means "max completion tokens" on most servers), not a context window.
 */
export const MIN_PLAUSIBLE_CONTEXT_WINDOW = 32_000;

/**
 * Extract the context window from an official provider metadata field.
 *
 * Reads, in order: `context_length` / `context_window` / `max_context_length` /
 * `inputTokenLimit` / `max_input_tokens` (OpenRouter, One-API, Gemini-style
 * fields).
 *
 * `max_tokens` is only consulted as a **last resort and only when it is
 * plausibly a window** (≥ MIN_PLAUSIBLE_CONTEXT_WINDOW). Many OpenAI-compatible
 * servers report `max_tokens: 4096` (or 8192) for every model meaning the
 * maximum *completion* length; treating that as the context window would derive
 * a compression trigger of a few thousand tokens and make the agent compress on
 * essentially every turn.
 *
 * Returns `undefined` when nothing plausible is present — the caller must NOT
 * substitute a default here; `undefined` is what keeps "unknown" unknown
 * end-to-end so the runtime downgrade can do its job.
 */
export function pickContextLimit(model: Record<string, unknown>): number | undefined {
  const official =
    model.context_length ??
    model.context_window ??
    model.max_context_length ??
    model.inputTokenLimit ??
    model.max_input_tokens;
  if (typeof official === "number" && official > 1000) {
    return official;
  }

  const maxTokens = model.max_tokens;
  if (
    typeof maxTokens === "number" &&
    maxTokens >= MIN_PLAUSIBLE_CONTEXT_WINDOW
  ) {
    return maxTokens;
  }

  return undefined;
}
