import type { Provider } from "./provider.js";
import type { EmbeddingProvider, RerankProvider, STTProvider, TTSProvider } from "./manager.js";

import { OpenAIProvider, type OpenAIProviderConfig } from "./implementations/openai-provider.js";
import { OpenAIResponsesProvider, type OpenAIResponsesProviderConfig } from "./implementations/openai-responses-provider.js";
import { GeminiProvider, type GeminiProviderConfig } from "./implementations/gemini-provider.js";
import { AnthropicProvider, type AnthropicProviderConfig } from "./implementations/anthropic-provider.js";
import { OpenAIEmbeddingProvider, type OpenAIEmbeddingProviderConfig } from "./implementations/openai-embedding-provider.js";
import { GeminiEmbeddingProvider, type GeminiEmbeddingProviderConfig } from "./implementations/gemini-embedding-provider.js";
import { GenericRerankProvider, type GenericRerankProviderConfig } from "./implementations/generic-rerank-provider.js";
import { OpenAITTSProvider, type OpenAITTSProviderConfig } from "./implementations/openai-tts-provider.js";
import { OpenAISttProvider, type OpenAISttProviderConfig } from "./implementations/openai-stt-provider.js";

// ─── Chat Provider Factory ──────────────────────────────────────────────────

export type ChatProviderType = "openai" | "openai_responses" | "gemini" | "anthropic";

export type ChatProviderConfig =
  | OpenAIProviderConfig
  | OpenAIResponsesProviderConfig
  | GeminiProviderConfig
  | AnthropicProviderConfig;

const chatProviderFactories = new Map<ChatProviderType, (config: ChatProviderConfig) => Provider>();

export function registerChatFactory(
  type: ChatProviderType,
  factory: (config: ChatProviderConfig) => Provider,
): void {
  chatProviderFactories.set(type, factory);
}

export function createChatProvider(type: ChatProviderType, config: ChatProviderConfig): Provider {
  const factory = chatProviderFactories.get(type);
  if (!factory) {
    throw new Error(`Unknown chat provider type: ${type}`);
  }
  return factory(config);
}

// ─── Embedding Provider Factory ─────────────────────────────────────────────

export type EmbeddingProviderType = "openai_embedding" | "gemini_embedding";

export type EmbeddingProviderConfig =
  | OpenAIEmbeddingProviderConfig
  | GeminiEmbeddingProviderConfig;

const embeddingProviderFactories = new Map<EmbeddingProviderType, (config: EmbeddingProviderConfig) => EmbeddingProvider>();

export function registerEmbeddingFactory(
  type: EmbeddingProviderType,
  factory: (config: EmbeddingProviderConfig) => EmbeddingProvider,
): void {
  embeddingProviderFactories.set(type, factory);
}

export function createEmbeddingProvider(type: EmbeddingProviderType, config: EmbeddingProviderConfig): EmbeddingProvider {
  const factory = embeddingProviderFactories.get(type);
  if (!factory) {
    throw new Error(`Unknown embedding provider type: ${type}`);
  }
  return factory(config);
}

// ─── Rerank Provider Factory ────────────────────────────────────────────────

export type RerankProviderType = "cohere" | "jina" | "voyage" | "generic";

export type RerankProviderConfig = GenericRerankProviderConfig;

const rerankProviderFactories = new Map<RerankProviderType, (config: RerankProviderConfig) => RerankProvider>();

export function registerRerankFactory(
  type: RerankProviderType,
  factory: (config: RerankProviderConfig) => RerankProvider,
): void {
  rerankProviderFactories.set(type, factory);
}

export function createRerankProvider(type: RerankProviderType, config: RerankProviderConfig): RerankProvider {
  const factory = rerankProviderFactories.get(type);
  if (!factory) {
    throw new Error(`Unknown rerank provider type: ${type}`);
  }
  return factory(config);
}

// ─── Preset Rerank Configs ──────────────────────────────────────────────────

export interface PresetRerankConfig {
  baseUrl: string;
  model: string;
}

export const PRESET_RERANK_CONFIGS: Record<string, PresetRerankConfig> = {
  cohere: {
    baseUrl: "https://api.cohere.ai/v1",
    model: "rerank-v3.5",
  },
  jina: {
    baseUrl: "https://api.jina.ai/v1",
    model: "jina-reranker-v2-base-multilingual",
  },
  voyage: {
    baseUrl: "https://api.voyageai.com/v1",
    model: "rerank-2",
  },
  siliconflow: {
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "BAAI/bge-reranker-v2-m3",
  },
};

// ─── Register Built-in Factories ────────────────────────────────────────────

registerChatFactory("openai", (config) => new OpenAIProvider(config as OpenAIProviderConfig));
registerChatFactory("openai_responses", (config) => new OpenAIResponsesProvider(config as OpenAIResponsesProviderConfig));
registerChatFactory("gemini", (config) => new GeminiProvider(config as GeminiProviderConfig));
registerChatFactory("anthropic", (config) => new AnthropicProvider(config as AnthropicProviderConfig));

registerEmbeddingFactory("openai_embedding", (config) => new OpenAIEmbeddingProvider(config as OpenAIEmbeddingProviderConfig));
registerEmbeddingFactory("gemini_embedding", (config) => new GeminiEmbeddingProvider(config as GeminiEmbeddingProviderConfig));

registerRerankFactory("cohere", (config) => new GenericRerankProvider(config));
registerRerankFactory("jina", (config) => new GenericRerankProvider(config));
registerRerankFactory("voyage", (config) => new GenericRerankProvider(config));
registerRerankFactory("generic", (config) => new GenericRerankProvider(config));

// ─── TTS Provider Factory ────────────────────────────────────────────────────

export type TTSProviderType = "openai_tts";

export type TTSProviderConfigMap = OpenAITTSProviderConfig;

const ttsProviderFactories = new Map<TTSProviderType, (config: TTSProviderConfigMap) => TTSProvider>();

export function registerTtsFactory(
  type: TTSProviderType,
  factory: (config: TTSProviderConfigMap) => TTSProvider,
): void {
  ttsProviderFactories.set(type, factory);
}

export function createTtsProvider(type: TTSProviderType, config: TTSProviderConfigMap): TTSProvider {
  const factory = ttsProviderFactories.get(type);
  if (!factory) {
    throw new Error(`Unknown TTS provider type: ${type}`);
  }
  return factory(config);
}

// ─── STT Provider Factory ────────────────────────────────────────────────────

export type STTProviderType = "openai_stt";

export type STTProviderConfigMap = OpenAISttProviderConfig;

const sttProviderFactories = new Map<STTProviderType, (config: STTProviderConfigMap) => STTProvider>();

export function registerSttFactory(
  type: STTProviderType,
  factory: (config: STTProviderConfigMap) => STTProvider,
): void {
  sttProviderFactories.set(type, factory);
}

export function createSttProvider(type: STTProviderType, config: STTProviderConfigMap): STTProvider {
  const factory = sttProviderFactories.get(type);
  if (!factory) {
    throw new Error(`Unknown STT provider type: ${type}`);
  }
  return factory(config);
}

// ─── Register TTS/STT Built-in Factories ─────────────────────────────────────

registerTtsFactory("openai_tts", (config) => new OpenAITTSProvider(config as OpenAITTSProviderConfig));
registerSttFactory("openai_stt", (config) => new OpenAISttProvider(config as OpenAISttProviderConfig));

// ─── Dynamic Import Support ─────────────────────────────────────────────────

/**
 * Map from provider type string to the relative module path for dynamic import.
 */
export const PROVIDER_TYPE_MODULE_MAP: Record<string, string> = {
  // Chat providers
  openai: "./implementations/openai-provider.js",
  openai_responses: "./implementations/openai-responses-provider.js",
  gemini: "./implementations/gemini-provider.js",
  anthropic: "./implementations/anthropic-provider.js",
  // Embedding providers
  openai_embedding: "./implementations/openai-embedding-provider.js",
  gemini_embedding: "./implementations/gemini-embedding-provider.js",
  // Rerank providers
  cohere: "./implementations/generic-rerank-provider.js",
  jina: "./implementations/generic-rerank-provider.js",
  voyage: "./implementations/generic-rerank-provider.js",
  generic: "./implementations/generic-rerank-provider.js",
  // TTS providers
  openai_tts: "./implementations/openai-tts-provider.js",
  // STT providers
  openai_stt: "./implementations/openai-stt-provider.js",
};

/**
 * Map from provider type string to the exported class name.
 */
const PROVIDER_TYPE_CLASS_MAP: Record<string, string> = {
  openai: "OpenAIProvider",
  openai_responses: "OpenAIResponsesProvider",
  gemini: "GeminiProvider",
  anthropic: "AnthropicProvider",
  openai_embedding: "OpenAIEmbeddingProvider",
  gemini_embedding: "GeminiEmbeddingProvider",
  cohere: "GenericRerankProvider",
  jina: "GenericRerankProvider",
  voyage: "GenericRerankProvider",
  generic: "GenericRerankProvider",
  openai_tts: "OpenAITTSProvider",
  openai_stt: "OpenAISttProvider",
};

/**
 * Dynamically import a provider module by type string.
 * Returns the provider class constructor, or null if the type is unknown.
 *
 * This enables runtime provider loading without requiring static imports
 * of all provider implementations at startup.
 *
 * @example
 * ```ts
 * const ProviderClass = await dynamicImportProviderModule("openai");
 * if (ProviderClass) {
 *   const provider = new ProviderClass(config);
 * }
 * ```
 */
export async function dynamicImportProviderModule(
  type: string
): Promise<(new (config: unknown) => unknown) | null> {
  const modulePath = PROVIDER_TYPE_MODULE_MAP[type];
  if (!modulePath) {
    console.warn(`[ProviderFactory] Unknown provider type for dynamic import: ${type}`);
    return null;
  }

  const className = PROVIDER_TYPE_CLASS_MAP[type];
  if (!className) return null;

  try {
    const mod = await import(modulePath);
    const cls = mod[className];
    if (typeof cls !== "function") {
      console.error(`[ProviderFactory] Module ${modulePath} does not export ${className}`);
      return null;
    }
    return cls;
  } catch (e) {
    console.error(`[ProviderFactory] Failed to dynamically import ${type} from ${modulePath}: ${e}`);
    return null;
  }
}

/**
 * Dynamically create a chat provider instance from a type string and config.
 * Falls back to the static factory registry first, then tries dynamic import.
 */
export async function dynamicCreateChatProvider(
  type: string,
  config: ChatProviderConfig
): Promise<Provider | null> {
  // Try static factory first
  const staticFactory = chatProviderFactories.get(type as ChatProviderType);
  if (staticFactory) {
    return staticFactory(config);
  }

  // Fall back to dynamic import
  const cls = await dynamicImportProviderModule(type);
  if (cls) {
    return new cls(config) as Provider;
  }

  return null;
}

/**
 * Dynamically create an embedding provider instance from a type string and config.
 */
export async function dynamicCreateEmbeddingProvider(
  type: string,
  config: EmbeddingProviderConfig
): Promise<EmbeddingProvider | null> {
  const staticFactory = embeddingProviderFactories.get(type as EmbeddingProviderType);
  if (staticFactory) {
    return staticFactory(config);
  }

  const cls = await dynamicImportProviderModule(type);
  if (cls) {
    return new cls(config) as EmbeddingProvider;
  }

  return null;
}

/**
 * Dynamically create a rerank provider instance from a type string and config.
 */
export async function dynamicCreateRerankProvider(
  type: string,
  config: RerankProviderConfig
): Promise<RerankProvider | null> {
  const staticFactory = rerankProviderFactories.get(type as RerankProviderType);
  if (staticFactory) {
    return staticFactory(config);
  }

  const cls = await dynamicImportProviderModule(type);
  if (cls) {
    return new cls(config) as RerankProvider;
  }

  return null;
}

/**
 * Dynamically create a TTS provider instance from a type string and config.
 */
export async function dynamicCreateTtsProvider(
  type: string,
  config: TTSProviderConfigMap
): Promise<TTSProvider | null> {
  const staticFactory = ttsProviderFactories.get(type as TTSProviderType);
  if (staticFactory) {
    return staticFactory(config);
  }

  const cls = await dynamicImportProviderModule(type);
  if (cls) {
    return new cls(config) as TTSProvider;
  }

  return null;
}

/**
 * Dynamically create an STT provider instance from a type string and config.
 */
export async function dynamicCreateSttProvider(
  type: string,
  config: STTProviderConfigMap
): Promise<STTProvider | null> {
  const staticFactory = sttProviderFactories.get(type as STTProviderType);
  if (staticFactory) {
    return staticFactory(config);
  }

  const cls = await dynamicImportProviderModule(type);
  if (cls) {
    return new cls(config) as STTProvider;
  }

  return null;
}
