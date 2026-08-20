export type V04ApiErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    details?: Record<string, unknown>;
  };
};

export class V04UiApiError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId = "",
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "V04UiApiError";
    this.retryable = status >= 500 || status === 408 || status === 429;
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type V04ApiRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  requestId?: string;
  idempotencyKey?: string;
  tabToken?: string;
  signal?: AbortSignal;
};

function requestId(value?: string) {
  return value?.trim() || `v04-ui-${crypto.randomUUID()}`;
}

async function parseResponse<T>(response: Response, fallbackRequestId: string): Promise<T> {
  const raw = await response.text();
  let payload: unknown = undefined;
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      if (response.ok) {
        throw new V04UiApiError(
          response.status,
          "INVALID_RESPONSE",
          "服务器返回了无法识别的数据，请刷新后重试。",
          fallbackRequestId,
        );
      }
      throw new V04UiApiError(
        response.status,
        "HTTP_ERROR",
        `服务暂时不可用（HTTP ${response.status}）。`,
        fallbackRequestId,
      );
    }
  }
  if (!response.ok) {
    const envelope = payload as V04ApiErrorEnvelope | undefined;
    throw new V04UiApiError(
      response.status,
      envelope?.error?.code || "HTTP_ERROR",
      envelope?.error?.message || (raw.trim()
        ? `请求未完成（HTTP ${response.status}）。`
        : `服务未返回错误详情（HTTP ${response.status}）。`),
      envelope?.error?.requestId || fallbackRequestId,
      envelope?.error?.details ?? {},
    );
  }
  if (!raw.trim() && response.status !== 204) {
    throw new V04UiApiError(
      response.status,
      "EMPTY_RESPONSE",
      "服务器没有返回数据，请刷新后重试。",
      fallbackRequestId,
    );
  }
  return payload as T;
}

export function createV04UiApiClient(fetcher: FetchLike = fetch) {
  async function request<T>(path: string, options: V04ApiRequestOptions = {}) {
    const id = requestId(options.requestId);
    const headers = new Headers({
      Accept: "application/json",
      "X-Request-Id": id,
    });
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
    if (options.tabToken) headers.set("X-V04-Tab-Token", options.tabToken);
    const response = await fetcher(path, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    return parseResponse<T>(response, id);
  }

  const videoPath = (videoId: string, suffix = "") =>
    `/api/videos/${encodeURIComponent(videoId)}/analysis/v04${suffix}`;

  return {
    request,
    cards: (videoIds: string[] = [], tabToken?: string, signal?: AbortSignal) => {
      const search = new URLSearchParams();
      for (const videoId of videoIds) search.append("videoId", videoId);
      const suffix = search.size ? `?${search.toString()}` : "";
      return request<{ projections: unknown[] }>(`/api/videos/analysis/v04/cards${suffix}`, { tabToken, signal });
    },
    detail: <T = unknown>(videoId: string, tabToken?: string, signal?: AbortSignal) =>
      request<T>(videoPath(videoId), { tabToken, signal }),
    workspace: <T = unknown>(videoId: string, tabToken?: string, signal?: AbortSignal) =>
      request<T>(videoPath(videoId, "/workspace"), { tabToken, signal }),
    history: <T = unknown>(videoId: string, tabToken?: string, signal?: AbortSignal) =>
      request<T>(videoPath(videoId, "/history"), { tabToken, signal }),
    submissions: <T = unknown>(videoId: string, tabToken?: string, signal?: AbortSignal) =>
      request<T>(videoPath(videoId, "/submissions"), { tabToken, signal }),
    comments: <T = unknown>(videoId: string, tabToken?: string, signal?: AbortSignal) =>
      request<T>(videoPath(videoId, "/comments"), { tabToken, signal }),
    materialize: <T = unknown>(videoId: string, body: unknown, idempotencyKey: string) =>
      request<T>(videoPath(videoId, "/workspace/materialize"), {
        method: "POST", body, idempotencyKey,
      }),
    acquireLease: <T = unknown>(videoId: string, body: unknown) =>
      request<T>(videoPath(videoId, "/lease"), { method: "POST", body }),
    heartbeatLease: <T = unknown>(videoId: string, body: unknown) =>
      request<T>(videoPath(videoId, "/lease"), { method: "PATCH", body }),
    releaseLease: <T = unknown>(videoId: string, body: unknown) =>
      request<T>(videoPath(videoId, "/lease"), { method: "DELETE", body }),
    forceReleaseLease: <T = unknown>(videoId: string, body: unknown, idempotencyKey: string) =>
      request<T>(videoPath(videoId, "/lease/force-release"), {
        method: "POST", body, idempotencyKey,
      }),
    save: <T = unknown>(videoId: string, body: unknown, tabToken: string) =>
      request<T>(videoPath(videoId, "/workspace"), { method: "PUT", body, tabToken }),
    submit: <T = unknown>(videoId: string, body: unknown, idempotencyKey: string, tabToken: string) =>
      request<T>(videoPath(videoId, "/submissions"), {
        method: "POST", body, idempotencyKey, tabToken,
      }),
    grantExpertPreference: <T = unknown>(
      videoId: string,
      submissionId: string,
      body: unknown,
      idempotencyKey: string,
    ) => request<T>(videoPath(videoId, `/expert-preference/${encodeURIComponent(submissionId)}`), {
      method: "PUT", body, idempotencyKey,
    }),
    withdrawExpertPreference: <T = unknown>(videoId: string, body: unknown, idempotencyKey: string) =>
      request<T>(videoPath(videoId, "/expert-preference"), {
        method: "DELETE", body, idempotencyKey,
      }),
    restore: <T = unknown>(videoId: string, body: unknown, idempotencyKey: string, tabToken: string) =>
      request<T>(videoPath(videoId, "/restore"), {
        method: "POST", body, idempotencyKey, tabToken,
      }),
    createComment: <T = unknown>(videoId: string, body: unknown, idempotencyKey: string) =>
      request<T>(videoPath(videoId, "/comments"), {
        method: "POST", body, idempotencyKey,
      }),
    updateComment: <T = unknown>(
      videoId: string,
      commentId: string,
      body: unknown,
      idempotencyKey: string,
    ) => request<T>(videoPath(videoId, `/comments/${encodeURIComponent(commentId)}`), {
      method: "PATCH", body, idempotencyKey,
    }),
  };
}

export const v04UiApi = createV04UiApiClient();
