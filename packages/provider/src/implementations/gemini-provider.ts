import type { Provider, ProviderChatParams } from "../provider.js";
import type { LLMResponse, ProviderConfig, TokenUsage } from "@yachiyo/common/llm-types.js";
import type { Message } from "@yachiyo/common/llm-message.js";
import { messageToGemini } from "../converters/gemini-converter.js";
import { parseGeminiStream } from "../parsers/gemini-stream-parser.js";
import { sanitizeContextsByModalities } from "../modalities.js";
import { withRetry } from "../retry.js";
import { ProviderAPIError, RateLimitError, safeParseJsonResponse } from "../errors.js";
import { EstimateTokenCounter } from "@yachiyo/common/token-counter.js";
import { safeFetch } from "@yachiyo/common/ssrf-guard.js";
import { resolveImageToDataUrl, resolveAudioToDataUrl } from "@yachiyo/common/download-utils.js";
import { getProxyAgent } from "@yachiyo/common";

async function resolveRemoteMediaInContexts(
  contexts: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
  const resolvedContexts: Record<string, unknown>[] = [];

  for (const msg of contexts) {
    const content = msg.content;
    if (Array.isArray(content)) {
      const newContent: unknown[] = [];
      let modified = false;

      for (const part of content) {
        if (typeof part === "object" && part !== null && "type" in part) {
          const p = part as Record<string, unknown>;
          if (p.type === "image_url" && p.image_url && typeof p.image_url === "object") {
            const imgUrlObj = p.image_url as Record<string, unknown>;
            const url = imgUrlObj.url;
            if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
              const dataUrl = await resolveImageToDataUrl(url);
              if (dataUrl) {
                newContent.push({
                  ...p,
                  image_url: {
                    ...imgUrlObj,
                    url: dataUrl,
                  },
                });
                modified = true;
                continue;
              }
            }
          } else if (p.type === "audio_url" && p.audio_url && typeof p.audio_url === "object") {
            const audioUrlObj = p.audio_url as Record<string, unknown>;
            const url = audioUrlObj.url;
            if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
              const dataUrl = await resolveAudioToDataUrl(url);
              if (dataUrl) {
                newContent.push({
                  ...p,
                  audio_url: {
                    ...audioUrlObj,
                    url: dataUrl,
                  },
                });
                modified = true;
                continue;
              }
            }
          }
        }
        newContent.push(part);
      }

      if (modified) {
        resolvedContexts.push({
          ...msg,
          content: newContent,
        });
        continue;
      }
    }
    resolvedContexts.push(msg);
  }

  return resolvedContexts;
}

export interface GeminiProviderConfig extends ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  proxy?: string;
}

export class GeminiProvider implements Provider {
  readonly type = "gemini";
  providerConfig: ProviderConfig;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private proxy?: string;

  constructor(config: GeminiProviderConfig) {
    this.providerConfig = config;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.model = config.model;
    this.proxy = config.proxy;
  }

  // Map to store active context caches
  private activeCaches = new Map<string, {
    cacheName: string;
    cachedContents: unknown[];
    cachedSystemInstruction?: unknown;
    cachedTools?: unknown;
    expireTime: number; // timestamp in ms
  }>();

  private async cleanExpiredCaches(): Promise<void> {
    const now = Date.now();
    const expired: string[] = [];
    for (const [key, cache] of this.activeCaches.entries()) {
      if (now >= cache.expireTime) {
        this.activeCaches.delete(key);
        expired.push(cache.cacheName);
      }
    }
    // Deleting only the local entry would leak the server-side object until the
    // remote TTL elapses; delete it explicitly as well.
    await Promise.all(expired.map((name) => this.deleteContextCache(name)));
  }

  /**
   * Delete a server-side cachedContents object to prevent resource leakage.
   * Best-effort: errors are logged but not thrown.
   */
  private async deleteContextCache(cacheName: string): Promise<void> {
    try {
      const url = `${this.baseUrl}/${cacheName}`;
      const dispatcher = await getProxyAgent(this.proxy);
      const res = await safeFetch(url, {
        method: "DELETE",
        headers: { "x-goog-api-key": this.apiKey },
        signal: AbortSignal.timeout(10000),
        ...(dispatcher ? { dispatcher } : {}),
      } as any);
      if (!res.ok) {
        console.warn(`[GeminiProvider] Failed to delete context cache ${cacheName}: ${res.status}`);
      }
    } catch (e) {
      console.warn(`[GeminiProvider] Error deleting context cache ${cacheName}:`, e);
    }
  }

  /**
   * Release all server-side cachedContents objects held by this provider.
   * Called by ProviderManager when terminating or deleting a provider.
   */
  async dispose(): Promise<void> {
    const entries = Array.from(this.activeCaches.values());
    this.activeCaches.clear();
    await Promise.all(entries.map((c) => this.deleteContextCache(c.cacheName)));
  }

  private static sameJson(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /**
   * Whether an existing server-side cache may still be reused for this request.
   *
   * A cache is created from the request's *prefix* (`contents.slice(0, -1)`) at
   * the time it was built. On a later turn the request has grown, so the cache
   * only covers the older, shorter prefix. Reuse is valid only when the current
   * `contents` still begins with the cached prefix and the cacheable metadata
   * (system instruction, tools) is unchanged — otherwise the request must not
   * point at the stale cache, or everything between the cached prefix and the
   * last message would be silently dropped from the model's view.
   */
  private isCacheReusable(
    existing: {
      cachedContents: unknown[];
      cachedSystemInstruction?: unknown;
      cachedTools?: unknown;
    },
    contents: readonly unknown[],
    systemInstruction: unknown,
    tools: unknown[] | undefined
  ): boolean {
    // The cache must cover a *proper* prefix so at least one message (the delta)
    // is sent alongside `cachedContent`.
    if (existing.cachedContents.length >= contents.length) return false;
    for (let i = 0; i < existing.cachedContents.length; i++) {
      if (!GeminiProvider.sameJson(existing.cachedContents[i], contents[i])) return false;
    }
    if (!GeminiProvider.sameJson(existing.cachedSystemInstruction, systemInstruction)) return false;
    if (!GeminiProvider.sameJson(existing.cachedTools, tools)) return false;
    return true;
  }

  private async createContextCache(
    useModel: string,
    contents: unknown[],
    systemInstruction: unknown,
    tools: unknown[] | undefined,
    ttlStr: string
  ): Promise<{ name: string; expireTime: string } | null> {
    const modelName = useModel.startsWith("models/") ? useModel : `models/${useModel}`;
    const url = `${this.baseUrl}/cachedContents`;

    const body: Record<string, unknown> = {
      model: modelName,
      contents,
      ttl: ttlStr,
    };
    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }
    if (tools) {
      body.tools = tools;
    }

    const dispatcher = await getProxyAgent(this.proxy);
    const response = await safeFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
      ...(dispatcher ? { dispatcher } : {}),
    } as any);

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[GeminiProvider] Create context cache failed: Status ${response.status}. Response: ${errText}`);
      return null;
    }

    const resData = (await response.json()) as { name?: string; expireTime?: string };
    if (resData.name && resData.expireTime) {
      return { name: resData.name, expireTime: resData.expireTime };
    }
    return null;
  }

  private async prepareRequest(
    params: ProviderChatParams,
    isStream: boolean
  ): Promise<{ body: Record<string, unknown>; url: string; sanitized: unknown[] }> {
    const { contexts, funcTool, model } = params;
    const useModel = model ?? this.model;

    const [sanitized] = sanitizeContextsByModalities(
      contexts,
      this.providerConfig.modalities,
    );
    const resolvedContexts = await resolveRemoteMediaInContexts(
      sanitized as Record<string, unknown>[]
    );
    const { contents, systemInstruction } = messageToGemini(
      resolvedContexts as unknown as Message[]
    );

    const body: Record<string, unknown> = {};

    const generationConfig: Record<string, unknown> = {};
    if (params.temperature !== undefined) {
      generationConfig.temperature = params.temperature;
    } else if (this.providerConfig.temperature !== undefined) {
      generationConfig.temperature = Number(this.providerConfig.temperature);
    }
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    let tools: unknown[] | undefined;
    if (funcTool && !funcTool.empty()) {
      tools = [funcTool.googleSchema()];
    }

    const applyUncachedBody = () => {
      body.contents = contents;
      if (systemInstruction) body.systemInstruction = systemInstruction;
      if (tools) body.tools = tools;
    };

    // Context caching logic
    const enableCaching = params.enableCaching ?? (this.providerConfig.enableCaching as boolean | undefined) ?? false;
    const sessionKey = params.sessionId ?? "default";

    await this.cleanExpiredCaches();

    if (enableCaching && contents.length > 1) {
      const ttl = (this.providerConfig.cacheTtlSeconds as number | undefined) ?? 300;
      const ttlStr = `${ttl}s`;

      const prefixContents = contents.slice(0, -1);
      const lastMessage = contents[contents.length - 1];

      if (prefixContents.length > 0) {
        const existing = this.activeCaches.get(sessionKey);
        const reusable =
          existing !== undefined &&
          existing.expireTime > Date.now() &&
          this.isCacheReusable(existing, contents, systemInstruction, tools);

        if (reusable && existing) {
          // The cache only covers the older prefix; send every message after it
          // so nothing between the cached prefix and the latest turn is dropped.
          // `systemInstruction`/`tools` are baked into the cache, so the request
          // must not repeat them — Gemini rejects that combination.
          body.cachedContent = existing.cacheName;
          body.contents = contents.slice(existing.cachedContents.length);
          delete body.systemInstruction;
          delete body.tools;
        } else {
          // A cache that can no longer serve this session is dead weight: drop
          // the local entry and delete the server-side object now, otherwise it
          // lingers until its remote TTL elapses.
          if (existing) {
            this.activeCaches.delete(sessionKey);
            await this.deleteContextCache(existing.cacheName);
          }

          const tokenCounter = new EstimateTokenCounter();
          const prefixMessages = prefixContents.map((c) => ({
            role: "assistant",
            content: (c.parts ?? []).map((p): Record<string, unknown> => {
              if (typeof p.text === "string") {
                return { type: "text", text: p.text };
              }
              if (p.inlineData) {
                return p.inlineData.mimeType.startsWith("audio/")
                  ? { type: "audio_url", audio_url: { url: "" } }
                  : { type: "image_url", image_url: { url: "" } };
              }
              if (p.functionCall || p.functionResponse) {
                return { type: "text", text: JSON.stringify(p.functionCall ?? p.functionResponse) };
              }
              return { type: "text", text: "" };
            }),
          })) as unknown as Message[];
          const estimatedTokens = tokenCounter.countTokens(prefixMessages);

          const rawThreshold = this.providerConfig.cacheThreshold as number | undefined;
          const cacheThreshold = rawThreshold ?? 32768;

          if (estimatedTokens >= cacheThreshold) {
            try {
              console.info(`[GeminiProvider] Creating context cache for session ${sessionKey} (estimated tokens: ${estimatedTokens})...`);
              const cacheResult = await this.createContextCache(useModel, prefixContents, systemInstruction, tools, ttlStr);
              if (cacheResult) {
                this.activeCaches.set(sessionKey, {
                  cacheName: cacheResult.name,
                  cachedContents: prefixContents,
                  cachedSystemInstruction: systemInstruction,
                  cachedTools: tools,
                  expireTime: Date.now() + ttl * 1000,
                });
                body.cachedContent = cacheResult.name;
                body.contents = [lastMessage];
                delete body.systemInstruction;
                delete body.tools;
              } else {
                applyUncachedBody();
              }
            } catch (cacheErr) {
              console.warn("[GeminiProvider] Context caching failed, falling back to standard prompt:", cacheErr);
              applyUncachedBody();
            }
          } else {
            applyUncachedBody();
          }
        }
      } else {
        applyUncachedBody();
      }
    } else {
      applyUncachedBody();
    }

    const action = isStream ? "streamGenerateContent?alt=sse" : "generateContent";
    const url = `${this.baseUrl}/models/${useModel}:${action}`;

    return { body, url, sanitized };
  }

  async textChat(params: ProviderChatParams): Promise<LLMResponse> {
    const { abortSignal } = params;
    const { body, url, sanitized } = await this.prepareRequest(params, false);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-goog-api-key": this.apiKey,
    };
    const dispatcher = await getProxyAgent(this.proxy);

    const response = await withRetry(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: abortSignal,
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit);
        await this.checkResponse(res);
        return res;
      },
      undefined,
      abortSignal,
    );

    const data = await safeParseJsonResponse(response, "gemini");
    return this.parseResponse(data, sanitized as unknown as Message[]);
  }

  async *textChatStream(
    params: ProviderChatParams,
  ): AsyncGenerator<LLMResponse, void, unknown> {
    const { abortSignal } = params;
    const { body, url } = await this.prepareRequest(params, true);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-goog-api-key": this.apiKey,
    };
    const dispatcher = await getProxyAgent(this.proxy);

    const response = await withRetry(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: abortSignal,
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit);
        await this.checkResponse(res);
        return res;
      },
      undefined,
      abortSignal,
    );

    yield* parseGeminiStream(response, abortSignal);
  }

  // ─── 响应处理 ───

  private async checkResponse(res: Response): Promise<void> {
    if (res.ok) return;

    const statusCode = res.status;
    let errorMessage: string;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      const error = body?.error as Record<string, unknown> | undefined;
      errorMessage =
        (error?.message as string) ?? (body?.message as string) ?? res.statusText;
    } catch {
      errorMessage = res.statusText;
    }

    if (statusCode === 429) {
      const retryAfter = res.headers.get("retry-after");
      throw new RateLimitError("gemini", retryAfter ?? undefined);
    }

    throw new ProviderAPIError("gemini", statusCode, undefined, errorMessage);
  }

  private parseResponse(data: Record<string, unknown>, inputMessages?: Message[]): LLMResponse {
    const result: LLMResponse = { role: "assistant", isChunk: false };

    const candidates = data.candidates as Array<Record<string, unknown>> | undefined;
    const candidate = candidates?.[0];
    const content = candidate?.content as Record<string, unknown> | undefined;
    const parts = content?.parts as Array<Record<string, unknown>> | undefined;

    // Diagnostic: log raw response structure for empty content debugging.
    // Downgraded to console.debug: this block dumps raw API response content
    // (potentially full conversation payloads) and must not pollute the
    // default warn-level output where it would leak session content into logs.
    if (!Array.isArray(parts) || parts.length === 0) {
      const promptFeedback = data.promptFeedback as Record<string, unknown> | undefined;
      const safetyRatings = candidate?.safetyRatings as Array<Record<string, unknown>> | undefined;
      console.debug(
        `[GeminiProvider] Empty/missing parts in response. ` +
        `candidates=${candidates?.length ?? 0}, ` +
        `content keys=${content ? Object.keys(content).join(",") : "none"}, ` +
        `parts=${Array.isArray(parts) ? `array[${parts.length}]` : typeof parts}, ` +
        `finishReason=${candidate?.finishReason ?? "none"}` +
        (promptFeedback ? `, promptFeedback=${JSON.stringify(promptFeedback).slice(0, 300)}` : "") +
        (safetyRatings ? `, safetyRatings=${JSON.stringify(safetyRatings).slice(0, 300)}` : "")
      );
      if (candidate) {
        console.debug(`[GeminiProvider] candidate=`, JSON.stringify(candidate).slice(0, 500));
      }
      // Dump full response body (truncated) to see proxy-level errors
      const fullRespStr = JSON.stringify(data);
      console.debug(`[GeminiProvider] <<< FULL RAW RESPONSE (length=${fullRespStr.length}):`);
      console.debug(fullRespStr.length > 2000
        ? fullRespStr.slice(0, 1500) + "\n... [TRUNCATED] ...\n" + fullRespStr.slice(-500)
        : fullRespStr);
    }

    if (Array.isArray(parts)) {
      const textParts: string[] = [];
      const reasoningParts: string[] = [];
      const toolCallIds: string[] = [];
      const toolCallNames: string[] = [];
      const toolCallArgs: Record<string, unknown>[] = [];
      const toolCallExtra: (Record<string, unknown> | undefined)[] = [];
      let reasoningSignature: string | undefined;

      for (const part of parts) {
        const signature = typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined;

        if (part.functionCall) {
          const fc = part.functionCall as Record<string, unknown>;
          toolCallIds.push(`gemini_fc_${fc.name}`);
          toolCallNames.push(fc.name as string);
          toolCallArgs.push((fc.args as Record<string, unknown>) ?? {});
          // A functionCall part may carry its own thoughtSignature which must
          // be replayed alongside the call.
          toolCallExtra.push(signature ? { thoughtSignature: signature } : undefined);
          continue;
        }

        if (part.thought) {
          if (typeof part.thought === "string") {
            reasoningParts.push(part.thought);
          } else if (typeof part.text === "string") {
            reasoningParts.push(part.text);
          }
        } else if (typeof part.text === "string") {
          textParts.push(part.text);
        }

        // Thinking models return an opaque signature that must be echoed back
        // verbatim when the turn is replayed. It rides on the thought part (or
        // its own part); keep the value.
        if (signature) {
          reasoningSignature = signature;
        }
      }

      if (textParts.length > 0) {
        result.completionText = textParts.join("");
      }
      if (reasoningParts.length > 0) {
        result.reasoningContent = reasoningParts.join("");
      }
      if (reasoningSignature) {
        result.reasoningSignature = reasoningSignature;
      }
      if (toolCallIds.length > 0) {
        result.toolsCallIds = toolCallIds;
        result.toolsCallName = toolCallNames;
        result.toolsCallArgs = toolCallArgs;
        if (toolCallExtra.some(Boolean)) {
          result.toolsCallExtraContent = toolCallExtra.map((e) => e ?? {});
        }
      }
    }

    if (data.usageMetadata) {
      const u = data.usageMetadata as Record<string, number>;
      const promptTokens = u.promptTokenCount ?? 0;
      const completionTokens = u.candidatesTokenCount ?? 0;
      const total = u.totalTokenCount ?? 0;

      if (total === 0 && inputMessages) {
        result.usage = this.estimateUsage(inputMessages, result.completionText ?? "");
      } else {
        result.usage = {
          promptTokens,
          completionTokens,
          total,
          cacheReadInputTokens: u.cachedContentTokenCount,
        } as TokenUsage;
      }
    } else if (inputMessages) {
      result.usage = this.estimateUsage(inputMessages, result.completionText ?? "");
    }

    return result;
  }

  private estimateUsage(inputMessages: Message[], outputText: string): TokenUsage {
    const counter = new EstimateTokenCounter();
    const promptTokens = counter.countTokens(inputMessages);
    const completionTokens = counter.countTokens([{ role: "assistant", content: outputText } as Message]);
    return { promptTokens, completionTokens, total: promptTokens + completionTokens };
  }
}
