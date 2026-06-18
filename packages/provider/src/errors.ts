export class ProviderAPIError extends Error {
  public provider: string;
  public statusCode: number;
  public errorCode?: string;

  constructor(provider: string, statusCode: number, errorCode?: string, message?: string) {
    super(message ?? `Provider ${provider} API error: ${statusCode}`);
    this.name = "ProviderAPIError";
    this.provider = provider;
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

export class RateLimitError extends ProviderAPIError {
  public retryAfterMs?: number;

  constructor(provider: string, retryAfter?: string) {
    super(provider, 429, "rate_limit_exceeded", "Rate limit exceeded");
    this.name = "RateLimitError";
    if (retryAfter) this.retryAfterMs = parseInt(retryAfter, 10) * 1000;
  }
}

export class ContextLengthExceededError extends ProviderAPIError {
  constructor(provider: string) {
    super(provider, 400, "context_length_exceeded", "Context length exceeded");
    this.name = "ContextLengthExceededError";
  }
}

/**
 * 安全解析 API 响应为 JSON。
 * 如果响应体不是有效 JSON（如 HTML 错误页面），返回包含原始文本的错误信息。
 */
export async function safeParseJsonResponse(
  response: Response,
  providerName: string = "unknown"
): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    const text = await response.text().catch(() => "");
    const preview = text.slice(0, 200);
    throw new ProviderAPIError(
      providerName,
      response.status,
      "invalid_content_type",
      `API 返回了非 JSON 响应 (Content-Type: ${contentType})。` +
        `可能是代理/网关拦截或 URL 配置错误。响应预览: ${preview}`
    );
  }

  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    const text = await response.text().catch(() => "");
    const preview = text.slice(0, 200);
    throw new ProviderAPIError(
      providerName,
      response.status,
      "invalid_json",
      `API 响应不是有效的 JSON。响应预览: ${preview}`
    );
  }
}
