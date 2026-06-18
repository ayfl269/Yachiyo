export enum ProviderType {
  CHAT_COMPLETION = "chat_completion",
  SPEECH_TO_TEXT = "speech_to_text",
  TEXT_TO_SPEECH = "text_to_speech",
  EMBEDDING = "embedding",
  RERANK = "rerank",
}

export interface ProviderMeta {
  id: string;
  model: string | null;
  type: string;
  providerType: ProviderType;
}
