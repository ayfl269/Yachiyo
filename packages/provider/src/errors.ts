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
    if (retryAfter) {
      // Try integer seconds first, then fall back to HTTP-date format.
      const asInt = parseInt(retryAfter, 10);
      if (!Number.isNaN(asInt)) {
        this.retryAfterMs = asInt * 1000;
      } else {
        const asDate = Date.parse(retryAfter);
        if (!Number.isNaN(asDate)) {
          this.retryAfterMs = Math.max(0, asDate - Date.now());
        }
      }
    }
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
 * Body 只读取一次并缓冲，两个错误分支复用同一文本。
 *
 * 错误预览会经过 `redactSensitive` 脱敏，屏蔽 API Key、Bearer token、
 * Authorization 头等敏感模式，防止这些值通过错误消息进入日志或上层。
 */
export async function safeParseJsonResponse(
  response: Response,
  providerName: string = "unknown"
): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";

  // Buffer the body once — response.text() consumes the stream and a second
  // call returns "". Reading upfront lets both error paths show a preview.
  const bodyText = await response.text().catch(() => "");
  const preview = redactSensitive(bodyText.slice(0, 200));

  if (!contentType.includes("application/json")) {
    throw new ProviderAPIError(
      providerName,
      response.status,
      "invalid_content_type",
      `API 返回了非 JSON 响应 (Content-Type: ${contentType})。` +
        `可能是代理/网关拦截或 URL 配置错误。响应预览: ${preview}`
    );
  }

  try {
    return JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new ProviderAPIError(
      providerName,
      response.status,
      "invalid_json",
      `API 响应不是有效的 JSON。响应预览: ${preview}`
    );
  }
}

/**
 * 脱敏敏感信息：将 API Key、Bearer token、Authorization 头等模式替换为 `***`。
 * 用于错误预览，避免凭证通过错误消息泄露到日志或调用方。
 *
 * 覆盖模式：
 * - `Authorization: Bearer xxx` / `authorization: xxx`
 * - `api_key`/`apikey`/`api-key` JSON 字段值
 * - `sk-`、`Bearer `、`key-` 等常见前缀的 token
 * - `password`/`secret`/`token` 字段值
 */
function redactSensitive(text: string): string {
  return text
    // Authorization header (case-insensitive): "Authorization: Bearer xxx" / "authorization: xxx"
    .replace(/(authorization\s*[:=]\s*)([^\s,;"']+)/gi, (_m, prefix: string) => `${prefix}***`)
    // JSON fields with sensitive names: "api_key":"xxx", "api-key":"xxx", "apikey":"xxx"
    .replace(/"(?:api[_-]?key|apikey|password|secret|token|access[_-]?token)"\s*:\s*"(?:[^"\\]|\\.)*"/gi,
      '"***":"***"')
    // Bare token prefixes: sk-..., Bearer xxx, key-...
    .replace(/(sk-[A-Za-z0-9_-]{6,})/g, "sk-***")
    .replace(/(Bearer\s+)[A-Za-z0-9_.\-]+/gi, "$1***")
    .replace(/(key-[A-Za-z0-9_-]{6,})/g, "key-***");
}
