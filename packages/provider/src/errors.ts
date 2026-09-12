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
 * 已知会报告"上下文超限"的错误文本特征。
 * 覆盖：OpenAI / OpenAI 兼容（OneAPI、LiteLLM、各家网关）、Anthropic、Gemini。
 * 注意这只是"是否超限"的判断；真实窗口数字由 {@link parseContextOverflowLimit} 解析。
 */
const CONTEXT_OVERFLOW_TEXT_PATTERNS: RegExp[] = [
  /context_length_exceeded/i,
  /maximum context length/i,
  /context length (?:exceeded|too long)/i,
  /prompt is too long/i,
  /too many (?:input )?tokens/i,
  /input (?:tokens|length) exceed/i,
  /exceed(?:s|ed)? the (?:maximum )?(?:context|token)/i,
];

/**
 * 从错误文本里解析 provider 报告的真实上下文窗口（tokens）。
 *
 * 主流 provider 的超限报错自带数字，一次失败就能拿到**精确值**——
 * 这比任何静态阶梯都准（阶梯见 agent 包的 CONTEXT_WINDOW_LADDER，仅作
 * 报错不带数字时的兜底）。已覆盖：
 * - OpenAI:  "This model's maximum context length is 16385 tokens. ..."
 * - Anthropic: "prompt is too long: 12345 tokens > 200000 maximum"
 * - 常见网关: "... context length limit 8192 tokens ..."
 *
 * 识别不到数字时返回 undefined（调用方走阶梯）。上限 1024 起是防止把
 * "requested 12 tokens" 之类的无关数字当成窗口。
 */
export function parseContextOverflowLimit(text: string): number | undefined {
  if (!text) return undefined;
  const patterns: RegExp[] = [
    /maximum context length is (\d+)/i,
    /maximum context length[^\d]{0,24}(\d{3,})/i,
    /prompt is too long:\s*\d+\s*tokens?\s*>\s*(\d{3,})/i,
    /(?:context|input)[^\d]{0,40}?(?:limit|maximum|max)[^\d]{0,24}(\d{4,})/i,
  ];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= 1024) return n;
  }
  return undefined;
}

/**
 * 判断错误文本是否为"上下文超限"。供无法按类型抛错的兼容网关兜底——
 * 能抛 {@link ContextLengthExceededError} 的路径请优先用类型判断。
 */
export function isContextOverflowText(text: string): boolean {
  if (!text) return false;
  if (parseContextOverflowLimit(text) !== undefined) return true;
  return CONTEXT_OVERFLOW_TEXT_PATTERNS.some((p) => p.test(text));
}

/**
 * 判断一个抛出的错误是否为"上下文超限"。
 * 优先按类型（{@link ContextLengthExceededError} / errorCode），再按文本兜底。
 */
export function isContextOverflowError(error: unknown): boolean {
  if (error instanceof ContextLengthExceededError) return true;
  if (error instanceof ProviderAPIError && error.errorCode === "context_length_exceeded") {
    return true;
  }
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return isContextOverflowText(text);
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
