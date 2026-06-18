export class AgentSystemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSystemError";
  }
}

export class ProviderNotFoundError extends AgentSystemError {
  constructor(providerId?: string) {
    super(`Provider not found${providerId ? `: ${providerId}` : ""}`);
    this.name = "ProviderNotFoundError";
  }
}

export class EmptyModelOutputError extends AgentSystemError {
  constructor() {
    super("Model returned empty output");
    this.name = "EmptyModelOutputError";
  }
}

export class KnowledgeBaseUploadError extends AgentSystemError {
  stage: string;
  userMessage: string;
  details: Record<string, unknown>;

  constructor(options: { stage: string; userMessage: string; details?: Record<string, unknown> }) {
    super(`Knowledge base upload error at stage '${options.stage}': ${options.userMessage}`);
    this.name = "KnowledgeBaseUploadError";
    this.stage = options.stage;
    this.userMessage = options.userMessage;
    this.details = options.details ?? {};
  }
}
