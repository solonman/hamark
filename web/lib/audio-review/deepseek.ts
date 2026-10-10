// DeepSeek 对话补全（docs/25 4.5）。只碰网络、不碰数据库；fetch 可注入，单测不真调。
// 调用失败一律翻成中文原因，并标明值不值得自动再试（密钥错、欠费这类再试也没用）。

export const DEEPSEEK_TIMEOUT_MS = 240_000;
export const DEEPSEEK_MAX_TOKENS = 32_000;

export type DeepseekFetch = (input: string, init: RequestInit) => Promise<Response>;

export type DeepseekOptions = {
  apiKey: string;
  model: string;
  baseUrl: string;
  fetchImpl?: DeepseekFetch;
  timeoutMs?: number;
  /** 计时用；测试里固定。 */
  clock?: () => number;
};

export type LlmMessages = { system: string; user: string };

export type LlmSuccess = {
  ok: true;
  content: string;
  finishReason: string | null;
  usage: unknown;
  model: string;
  durationMs: number;
};

export type LlmFailure = {
  ok: false;
  reason: string;
  /** false：密钥、余额、请求格式这类问题，再试一次也不会好，直接转失败。 */
  retryable: boolean;
  status: number | null;
  usage?: unknown;
  durationMs: number;
};

export type LlmOutcome = LlmSuccess | LlmFailure;

export function buildDeepseekRequestBody(model: string, messages: LlmMessages) {
  return {
    model,
    messages: [
      { role: "system", content: messages.system },
      { role: "user", content: messages.user },
    ],
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    response_format: { type: "json_object" },
    max_tokens: DEEPSEEK_MAX_TOKENS,
    stream: false,
  };
}

export function describeDeepseekHttpError(status: number, message: string | null): { reason: string; retryable: boolean } {
  const detail = message ? `（${message.slice(0, 160)}）` : "";
  switch (status) {
    case 400:
      return { reason: `DeepSeek 拒绝了请求格式${detail}。`, retryable: false };
    case 401:
      return { reason: "DeepSeek 密钥无效，请检查 DEEPSEEK_API_KEY。", retryable: false };
    case 402:
      return { reason: "DeepSeek 账户余额不足，请充值后重试。", retryable: false };
    case 422:
      return { reason: `DeepSeek 不接受请求参数${detail}。`, retryable: false };
    case 429:
      return { reason: "DeepSeek 请求过于频繁，稍后会自动重试。", retryable: true };
    case 500:
    case 502:
    case 503:
    case 504:
      return { reason: "DeepSeek 服务繁忙或暂时故障，稍后会自动重试。", retryable: true };
    default:
      return { reason: `DeepSeek 请求失败（HTTP ${status}）${detail}。`, retryable: status >= 500 };
  }
}

export async function callDeepseekChat(messages: LlmMessages, options: DeepseekOptions): Promise<LlmOutcome> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const elapsed = () => Math.max(0, clock() - started);
  const timeoutMs = options.timeoutMs ?? DEEPSEEK_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(buildDeepseekRequestBody(options.model, messages)),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        return {
          ok: false,
          reason: `模型 ${Math.round(timeoutMs / 1000)} 秒内没有返回结果，稍后会自动重试。`,
          retryable: true,
          status: null,
          durationMs: elapsed(),
        };
      }
      return { ok: false, reason: "连接 DeepSeek 失败（网络异常），稍后会自动重试。", retryable: true, status: null, durationMs: elapsed() };
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      if (controller.signal.aborted) {
        return {
          ok: false,
          reason: `模型 ${Math.round(timeoutMs / 1000)} 秒内没有返回结果，稍后会自动重试。`,
          retryable: true,
          status: response.status,
          durationMs: elapsed(),
        };
      }
      return { ok: false, reason: "读取 DeepSeek 响应失败，稍后会自动重试。", retryable: true, status: response.status, durationMs: elapsed() };
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const errorMessage = (body?.error as { message?: unknown } | undefined)?.message;
      return {
        ok: false,
        ...describeDeepseekHttpError(response.status, typeof errorMessage === "string" ? errorMessage : null),
        status: response.status,
        durationMs: elapsed(),
      };
    }
    if (!body) {
      return { ok: false, reason: "DeepSeek 返回了无法识别的内容。", retryable: true, status: response.status, durationMs: elapsed() };
    }
    const choice = Array.isArray(body.choices) ? body.choices[0] as Record<string, unknown> | undefined : undefined;
    const message = choice?.message as { content?: unknown } | undefined;
    const content = typeof message?.content === "string" ? message.content : "";
    const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
    const usage = body.usage ?? null;
    if (!content.trim()) {
      return {
        ok: false,
        reason: finishReason === "length" ? "模型输出过长被截断，没有给出结果。" : "模型返回了空内容。",
        retryable: true,
        status: response.status,
        usage,
        durationMs: elapsed(),
      };
    }
    return {
      ok: true,
      content,
      finishReason,
      usage,
      model: typeof body.model === "string" ? body.model : options.model,
      durationMs: elapsed(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析 `choices[0].message.content` 里的 JSON。JSON 模式下一般就是纯 JSON；
 * 偶尔会包在 ```json 围栏里或前后带一句话，这两种都容忍。顶层必须是对象。
 */
export function parseModelJsonContent(content: string, finishReason: string | null = null):
  { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidates = [fenced ? fenced[1] : trimmed];
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return { ok: true, value: value as Record<string, unknown> };
      }
    } catch {
      // try the next candidate
    }
  }
  return {
    ok: false,
    reason: finishReason === "length" ? "模型输出过长被截断，JSON 不完整。" : "模型返回的内容不是合法的 JSON。",
  };
}
