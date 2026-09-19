/**
 * Provider-agnostic support for the user-configured `custom_extra_body`.
 *
 * Some OpenAI-compatible gateways and self-hosted proxies accept extra
 * parameters that are not part of the standard schema (e.g. `top_k`,
 * `repetition_penalty`, `thinking`, `min_p`, vendor-specific flags). The
 * dashboard has always stored such a map on the provider config, but nothing
 * ever read it — the field was dead. `applyCustomExtraBody` merges it into the
 * outgoing request body.
 *
 * Precedence: fields the provider itself manages (model, messages/input,
 * stream, tools, temperature, …) always win. `custom_extra_body` can only add
 * NEW keys, never override a value the provider computed. This keeps a bad
 * extra-body entry from corrupting the core request (e.g. dropping the
 * conversation by overriding `messages`).
 */

/** Keys that must never be written from user input (prototype pollution). */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Merge `custom_extra_body` into a request body.
 *
 * Returns the original `body` object when there is nothing to merge, otherwise
 * a new object containing the provider's fields plus any extra keys.
 *
 * `reservedKeys` lists provider-managed fields that must never be supplied from
 * user input even when they are absent from `body`. This matters when a
 * provider deliberately removes a field for a request (Gemini drops
 * `systemInstruction`/`tools` when sending `cachedContent`); without the
 * reserved list the "already set wins" guard would not fire and user config
 * could re-add them, breaking the request.
 */
export function applyCustomExtraBody(
  body: Record<string, unknown>,
  customExtraBody: unknown,
  reservedKeys: readonly string[] = [],
): Record<string, unknown> {
  if (
    customExtraBody === null ||
    typeof customExtraBody !== "object" ||
    Array.isArray(customExtraBody)
  ) {
    return body;
  }

  const extras = customExtraBody as Record<string, unknown>;
  const reserved = new Set(reservedKeys);
  const merged: Record<string, unknown> = { ...body };
  for (const [key, value] of Object.entries(extras)) {
    if (FORBIDDEN_KEYS.has(key)) {
      console.warn(`[Provider] Ignoring forbidden custom_extra_body key: ${key}`);
      continue;
    }
    // Provider-managed fields take precedence.
    if (merged[key] === undefined && !reserved.has(key)) {
      merged[key] = value;
    }
  }
  return merged;
}
