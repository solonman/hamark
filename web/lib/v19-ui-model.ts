// V1.9 二合一工作台：只读契约类型 + 浏览器端类型化客户端。
// 见 docs/18_V1.9_二合一工作台重构实施规格_V0.1.md 四、接口。
//
// `case` / `media` / `viewerCapabilities` 复用 v04-ui-model.ts 已有类型做组合，
// 不重复声明；`case` 去掉 `media` 字段，因为响应体把媒体信息单独放在顶层 `media`。

import type { V04Change, V04DraftPayloadV1 } from "@/lib/v04-contract";
import type {
  V04ServerWorkspaceModel,
  V04UiCapabilities,
  V04UiMediaReference,
} from "@/lib/v04-ui-model";

export type V19StudioCase = Omit<V04ServerWorkspaceModel["video"], "media">;

export type V19VersionSummary = {
  id: string | null;
  number: number;
  ownerUserId: string;
  ownerName: string;
  baseNumber: number | null;
  createdAt: string;
  updatedAt: string;
  isMine: boolean;
  isVirtual: boolean;
};

export type V19CurrentVersion = V19VersionSummary & {
  payload: V04DraftPayloadV1;
  basePayload: V04DraftPayloadV1 | null;
  revision: number;
  contentHash: string;
};

export type V19StudioModel = {
  case: V19StudioCase;
  media: V04UiMediaReference;
  viewerCapabilities: V04UiCapabilities;
  versions: V19VersionSummary[];
  current: V19CurrentVersion;
  myVersionId: string | null;
};

export type V19SaveRequestBody = {
  basedOnVersionId?: string | null;
  changeSetId: string;
  changes: V04Change[];
};

export type V19SaveResponseBody = {
  versionId: string;
  versionNumber: number;
  revision: number;
  contentHash: string;
  updatedAt: string;
  createdVersion: boolean;
  skippedTargets?: string[];
};

export type V19CreateVersionRequestBody = {
  baseVersionId: string;
};

// `formatV19VersionLabel` is also exported from lib/v19-version-chain.ts, but
// that module pulls in server-only code (node:crypto, @/db, the workspace
// service) through its imports. The studio UI is a client component, so it
// cannot import that module — this is a duplicated, client-safe copy of the
// same ~6-line pure function. Keep both in sync if the label format changes.
export function formatV19VersionLabel(input: {
  number: number;
  baseNumber: number | null;
  ownerName: string;
  ownerIsUploader: boolean;
}): string {
  const ownerLabel = input.ownerIsUploader ? `${input.ownerName}·上传者` : input.ownerName;
  const basis = input.baseNumber === null ? "初始版本" : `基于v${input.baseNumber}`;
  return `v${input.number}（${basis}，${ownerLabel}）`;
}

// ---------------------------------------------------------------------------
// Browser API client — modelled on createV04UiApiClient in v04-ui-api-client.ts.
// V04UiApiError and its request/timeout handling are reused as-is since that
// module already exports them; nothing here reimplements that plumbing.
// ---------------------------------------------------------------------------

import { V04UiApiError } from "@/lib/v04-ui-api-client";

export { V04UiApiError };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type V19ApiRequestOptions = {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  requestId?: string;
  signal?: AbortSignal;
};

function v19RequestId(value?: string) {
  return value?.trim() || `v19-ui-${crypto.randomUUID()}`;
}

async function parseV19Response<T>(response: Response, fallbackRequestId: string): Promise<T> {
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
    const envelope = payload as {
      error?: { code?: string; message?: string; requestId?: string; details?: Record<string, unknown> };
    } | undefined;
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

export function createV19UiApiClient(fetcher: FetchLike = fetch) {
  async function request<T>(path: string, options: V19ApiRequestOptions = {}) {
    const id = v19RequestId(options.requestId);
    const headers = new Headers({
      Accept: "application/json",
      "X-Request-Id": id,
    });
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await fetcher(path, {
        method: options.method ?? "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      });
    } catch (reason) {
      if (options.signal?.aborted || (reason instanceof DOMException && reason.name === "AbortError")) {
        throw new V04UiApiError(408, "REQUEST_TIMEOUT", "服务器响应超时，本地内容已保留，可直接重试。", id);
      }
      throw new V04UiApiError(0, "NETWORK_ERROR", "网络连接失败，本地内容已保留。", id);
    }
    return parseV19Response<T>(response, id);
  }

  const basePath = (videoId: string, suffix = "") =>
    `/api/videos/${encodeURIComponent(videoId)}/analysis/v19${suffix}`;

  return {
    request,
    load: (videoId: string, versionId?: string, signal?: AbortSignal) => {
      const search = versionId ? `?version=${encodeURIComponent(versionId)}` : "";
      return request<V19StudioModel>(basePath(videoId, search), { signal });
    },
    save: (videoId: string, body: V19SaveRequestBody, signal?: AbortSignal) =>
      request<V19SaveResponseBody>(basePath(videoId), { method: "PUT", body, signal }),
    createVersion: (videoId: string, baseVersionId: string, signal?: AbortSignal) =>
      request<V19SaveResponseBody>(basePath(videoId, "/versions"), {
        method: "POST",
        body: { baseVersionId } satisfies V19CreateVersionRequestBody,
        signal,
      }),
  };
}

export const v19Api = createV19UiApiClient();

/**
 * Keeps an untouched perception path unset instead of recording a default.
 *
 * The UI draft cannot represent "未选择" — it renders an unset 主导感知类型 as
 * LOVE — so converting a draft back to a payload invents that answer. Under
 * manual save that only reached the record when someone pressed 保存; on a
 * surface where every keystroke saves, editing an unrelated field would write
 * a core analytical judgement the analyst never made. So a path that still
 * carries no information stays unset, and becomes real the moment any of its
 * details or auxiliary paths are filled in.
 */
export function preserveV19UntouchedPerceptionPath(
  next: V04DraftPayloadV1,
  previous: V04DraftPayloadV1,
): V04DraftPayloadV1 {
  if (previous.perceptionPath.primaryType !== "") return next;
  const carriesAnswer = Object.values(next.perceptionPath.primaryDetails)
    .some((value) => typeof value === "string" && value.trim().length > 0);
  if (carriesAnswer || next.perceptionPath.auxiliaryTypes.length > 0) return next;
  return {
    ...next,
    perceptionPath: { ...next.perceptionPath, primaryType: "", primaryDetails: {} },
  };
}
