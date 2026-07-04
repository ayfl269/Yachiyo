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
}

export class GeminiProvider implements Provider {
  providerConfig: ProviderConfig;
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config: GeminiProviderConfig) {
    this.providerConfig = config;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.model = config.model;
  }

  // Map to store active context caches
  private activeCaches = new Map<string, {
    cacheName: string;
    cachedContents: any[];
    cachedSystemInstruction?: any;
    cachedTools?: any;
    expireTime: number; // timestamp in ms
  }>();

  private cleanExpiredCaches() {
    const now = Date.now();
    for (const [key, cache] of this.activeCaches.entries()) {
      if (now >= cache.expireTime) {
        this.activeCaches.delete(key);
      }
    }
  }

  /**
   * Delete a server-side cachedContents object to prevent resource leakage.
   * Best-effort: errors are logged but not thrown.
   */
  private async deleteContextCache(cacheName: string): Promise<void> {
    try {
      const url = `${this.baseUrl}/${cacheName}`;
      const res = await safeFetch(url, {
        method: "DELETE",
        headers: { "x-goog-api-key": this.apiKey },
        signal: AbortSignal.timeout(10000),
      });
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

  private async createContextCache(
    useModel: string,
    contents: any[],
    systemInstruction: any,
    tools: any[] | undefined,
    ttlStr: string
  ): Promise<{ name: string; expireTime: string } | null> {
    const modelName = useModel.startsWith("models/") ? useModel : `models/${useModel}`;
    const url = `${this.baseUrl}/cachedContents`;

    const body: Record<string, any> = {
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

    const response = await safeFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
    });

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
  ): Promise<{ body: Record<string, unknown>; url: string; sanitized: any[] }> {
    const { contexts, funcTool, model } = params;
    const useModel = model ?? this.model;

    const [sanitized] = sanitizeContextsByModalities(
      contexts,
      this.providerConfig.modalities,
    );

    // Resolve remote images and audio files to base64 data URLs
    const resolved = await resolveRemoteMediaInContexts(sanitized);

    const { systemInstruction, contents } = messageToGemini(resolved as unknown as Message[]);

    const enableCaching = params.enableCaching ?? (this.providerConfig.enableCaching as boolean | undefined) ?? false;

    const generationConfig: Record<string, unknown> = {};
    if (params.temperature !== undefined) {
      generationConfig.temperature = params.temperature;
    } else if (this.providerConfig.temperature !== undefined) {
      generationConfig.temperature = Number(this.providerConfig.temperature);
    }

    const body: Record<string, unknown> = {
      // Relax safety settings
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      ],
    };

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    let tools: any[] | undefined = undefined;
    if (funcTool && !funcTool.empty()) {
      tools = [funcTool.googleSchema()];
    }

     const rawTtl = this.providerConfig.cacheTtl ?? 300;
     const ttlStr = typeof rawTtl === "number" ? `${rawTtl}s` : String(rawTtl);
     const ttlMs = typeof rawTtl === "number" ? rawTtl * 1000 : (parseInt(String(rawTtl), 10) * 1000 || 300000);

    if (enableCaching && params.sessionId) {
      this.cleanExpiredCaches();
      const sessionKey = `${params.sessionId}_${useModel}`;
      const existing = this.activeCaches.get(sessionKey);

      let canReuse = false;
      if (existing && Date.now() < existing.expireTime) {
        const cachedLen = existing.cachedContents.length;
        if (contents.length > cachedLen) {
          // Fast path: reference equality for system instruction and tools
          const sysMatch = existing.cachedSystemInstruction === systemInstruction ||
            JSON.stringify(existing.cachedSystemInstruction) === JSON.stringify(systemInstruction);
          const toolsMatch = existing.cachedTools === tools ||
            JSON.stringify(existing.cachedTools) === JSON.stringify(tools);
          if (sysMatch && toolsMatch) {
            // Fast path: check element reference equality before expensive JSON.stringify
            let refMatch = true;
            for (let i = 0; i < cachedLen; i++) {
              if (contents[i] !== existing.cachedContents[i]) { refMatch = false; break; }
            }
            if (refMatch) {
              canReuse = true;
            } else {
              canReuse = JSON.stringify(contents.slice(0, cachedLen)) === JSON.stringify(existing.cachedContents);
            }
          }
        }
      }

      if (canReuse && existing) {
        body.cachedContent = existing.cacheName;
        body.contents = contents.slice(existing.cachedContents.length);
      } else {
        const cacheLimit = contents.length - 2;
        if (cacheLimit > 0) {
          const prefixContents = contents.slice(0, cacheLimit);
          const dummyMsgChain = resolved.slice(0, resolved.length - 2) as unknown as Message[];
          const tokenCounter = new EstimateTokenCounter();
          const estimatedTokens = tokenCounter.countTokens(dummyMsgChain);

          const cacheThreshold = (this.providerConfig.cacheThreshold as number) || 32768;

          if (estimatedTokens >= cacheThreshold) {
            try {
              console.info(`[GeminiProvider] Creating context cache for session ${sessionKey} (estimated tokens: ${estimatedTokens})...`);
              const cacheResult = await this.createContextCache(useModel, prefixContents, systemInstruction, tools, ttlStr);
              if (cacheResult) {
                // Delete the old server-side cache before overwriting the local entry
                if (existing) {
                  await this.deleteContextCache(existing.cacheName);
                }
                // Use server-provided expireTime for accuracy; fall back to local estimate
                const expireTime = Date.parse(cacheResult.expireTime) || (Date.now() + ttlMs);
                this.activeCaches.set(sessionKey, {
                  cacheName: cacheResult.name,
                  cachedContents: prefixContents,
                  cachedSystemInstruction: systemInstruction,
                  cachedTools: tools,
                  expireTime
                });
                body.cachedContent = cacheResult.name;
                body.contents = contents.slice(cacheLimit);
              } else {
                body.contents = contents;
                if (systemInstruction) body.systemInstruction = systemInstruction;
                if (tools) body.tools = tools;
              }
            } catch (e) {
              console.error(`[GeminiProvider] Failed to create context cache:`, e);
              body.contents = contents;
              if (systemInstruction) body.systemInstruction = systemInstruction;
              if (tools) body.tools = tools;
            }
          } else {
            body.contents = contents;
            if (systemInstruction) body.systemInstruction = systemInstruction;
            if (tools) body.tools = tools;
          }
        } else {
          body.contents = contents;
          if (systemInstruction) body.systemInstruction = systemInstruction;
          if (tools) body.tools = tools;
        }
      }
    } else {
      body.contents = contents;
      if (systemInstruction) body.systemInstruction = systemInstruction;
      if (tools) body.tools = tools;
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

    const response = await withRetry(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: abortSignal,
        });
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

    const response = await withRetry(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: abortSignal,
        });
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

    // Diagnostic: log raw response structure for empty content debugging
    if (!Array.isArray(parts) || parts.length === 0) {
      const promptFeedback = data.promptFeedback as Record<string, unknown> | undefined;
      const safetyRatings = candidate?.safetyRatings as Array<Record<string, unknown>> | undefined;
      console.warn(
        `[GeminiProvider] Empty/missing parts in response. ` +
        `candidates=${candidates?.length ?? 0}, ` +
        `content keys=${content ? Object.keys(content).join(",") : "none"}, ` +
        `parts=${Array.isArray(parts) ? `array[${parts.length}]` : typeof parts}, ` +
        `finishReason=${candidate?.finishReason ?? "none"}` +
        (promptFeedback ? `, promptFeedback=${JSON.stringify(promptFeedback).slice(0, 300)}` : "") +
        (safetyRatings ? `, safetyRatings=${JSON.stringify(safetyRatings).slice(0, 300)}` : "")
      );
      if (candidate) {
        console.warn(`[GeminiProvider] candidate=`, JSON.stringify(candidate).slice(0, 500));
      }
      // Dump full response body (truncated) to see proxy-level errors
      const fullRespStr = JSON.stringify(data);
      console.warn(`[GeminiProvider] <<< FULL RAW RESPONSE (length=${fullRespStr.length}):`);
      console.warn(fullRespStr.length > 2000
        ? fullRespStr.slice(0, 1500) + "\n... [TRUNCATED] ...\n" + fullRespStr.slice(-500)
        : fullRespStr);
    }

    if (Array.isArray(parts)) {
      const textParts: string[] = [];
      const reasoningParts: string[] = [];
      const toolCallIds: string[] = [];
      const toolCallNames: string[] = [];
      const toolCallArgs: Record<string, unknown>[] = [];

      for (const part of parts) {
        if (part.thought) {
          if (typeof part.thought === "string") {
            reasoningParts.push(part.thought);
          } else if (typeof part.text === "string") {
            reasoningParts.push(part.text);
          }
        } else if (typeof part.text === "string") {
          textParts.push(part.text);
        }
        if (part.functionCall) {
          const fc = part.functionCall as Record<string, unknown>;
          toolCallIds.push(`gemini_fc_${fc.name}`);
          toolCallNames.push(fc.name as string);
          toolCallArgs.push((fc.args as Record<string, unknown>) ?? {});
        }
      }

      if (textParts.length > 0) {
        result.completionText = textParts.join("");
      }
      if (reasoningParts.length > 0) {
        result.reasoningContent = reasoningParts.join("");
      }
      if (toolCallIds.length > 0) {
        result.toolsCallIds = toolCallIds;
        result.toolsCallName = toolCallNames;
        result.toolsCallArgs = toolCallArgs;
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
