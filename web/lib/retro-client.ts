// 客户需求复盘库的浏览器端 API 客户端：覆盖规格第九节的全部接口，请求和返回的形状都来自 lib/retro-model.ts。
// 写法照 lib/audio-review-model.ts 末尾的 createAudioReviewApiClient：同源、不缓存、带 X-Request-Id，
// 失败统一抛 V04UiApiError（带 HTTP 状态和中文原因）。
//
// 返回体形状见 lib/retro-model.ts 末尾的 Retro*Response；解包仍然宽松（`{ case: … }` 与裸对象都认）。
// 失焦保存（PATCH 案例／回合）只回 revision 和归一后的值，调用方只并这几项，不整份覆盖。

import { V04UiApiError } from "@/lib/v04-ui-api-client";
import type {
  RetroAddAssetsResponse,
  RetroCaseBasicsInput,
  RetroCaseDetail,
  RetroCompleteAssetsResponse,
  RetroCreateCaseResponse,
  RetroCreateRecordingRequest,
  RetroCreateRoundResponse,
  RetroCreateRecordingResponse,
  RetroDraftPatchRequest,
  RetroJobAction,
  RetroLibraryResponse,
  RetroLinkKind,
  RetroMonthView,
  RetroNewAssetInput,
  RetroPatchCaseRequest,
  RetroPatchCaseResponse,
  RetroPatchRoundRequest,
  RetroPatchRoundResponse,
  RetroPublicationView,
  RetroRecordingAction,
  RetroRecordingView,
  RetroStartJobRequest,
  RetroTranscribeView,
  RetroUploadUrlResponse,
} from "@/lib/retro-model";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** 路由返回的错误体可能是 `{ error: "…" }`，也可能是 `{ error: { code, message } }`。 */
export function retroErrorMessage(payload: unknown, status: number): { code: string; message: string } {
  const error = (payload as { error?: unknown } | undefined)?.error;
  if (typeof error === "string" && error.trim()) return { code: "HTTP_ERROR", message: error };
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof message === "string" && message.trim()) return { code: typeof code === "string" ? code : "HTTP_ERROR", message };
  }
  const message = (payload as { message?: unknown } | undefined)?.message;
  if (typeof message === "string" && message.trim()) return { code: "HTTP_ERROR", message };
  return { code: "HTTP_ERROR", message: `请求未完成（HTTP ${status}）。` };
}

/** 取 `{ key: value }` 里的 value；没有这个键时把整个对象当成 value。 */
export function unwrapRetro<T>(payload: unknown, key: string): T {
  if (payload && typeof payload === "object" && key in (payload as Record<string, unknown>)) {
    return (payload as Record<string, unknown>)[key] as T;
  }
  return payload as T;
}

export function createRetroApiClient(fetcher: FetchLike = fetch) {
  async function request<T = unknown>(
    path: string,
    init: { method?: Method; body?: unknown; signal?: AbortSignal; redirectOn401?: boolean } = {},
  ): Promise<T> {
    const requestId = `retro-${crypto.randomUUID()}`;
    const headers = new Headers({ Accept: "application/json", "X-Request-Id": requestId });
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await fetcher(path, {
        method: init.method ?? "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal,
      });
    } catch (reason) {
      if (init.signal?.aborted || (reason instanceof DOMException && reason.name === "AbortError")) {
        throw new V04UiApiError(408, "REQUEST_ABORTED", "请求已取消。", requestId);
      }
      throw new V04UiApiError(0, "NETWORK_ERROR", "网络连接失败，请检查网络后重试。", requestId);
    }
    // 未登录：后端先一步回 401，跟其它库一样直接带回登录页。
    if (response.status === 401 && init.redirectOn401 !== false && typeof window !== "undefined") {
      window.location.assign(`/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }
    const raw = await response.text();
    let payload: unknown;
    try {
      payload = raw.trim() ? JSON.parse(raw) : undefined;
    } catch {
      throw new V04UiApiError(response.status, "INVALID_RESPONSE", `服务器返回了无法识别的数据（HTTP ${response.status}）。`, requestId);
    }
    if (!response.ok) {
      const { code, message } = retroErrorMessage(payload, response.status);
      throw new V04UiApiError(response.status, code, message, requestId, (payload as { details?: Record<string, unknown> } | undefined)?.details ?? {});
    }
    return payload as T;
  }

  const enc = encodeURIComponent;
  const caseBase = (caseId: string, suffix = "") => `/api/retro-cases/${enc(caseId)}${suffix}`;

  return {
    // ---- 库首页 ----
    listCases: async (signal?: AbortSignal) => unwrapRetro<RetroLibraryResponse>(await request("/api/retro-cases", { signal }), "library"),
    createCase: (body: RetroCaseBasicsInput) => request<RetroCreateCaseResponse>("/api/retro-cases", { method: "POST", body }),

    // ---- 案例 ----
    getCase: async (caseId: string, signal?: AbortSignal) => unwrapRetro<RetroCaseDetail>(await request(caseBase(caseId), { signal }), "case"),
    /** 只回新的 revision 和归一后的值，不回整份详情。 */
    patchCase: (caseId: string, body: RetroPatchCaseRequest) => request<RetroPatchCaseResponse>(caseBase(caseId), { method: "PATCH", body }),
    trashCase: (caseId: string) => request(caseBase(caseId, "/trash"), { method: "POST" }),
    restoreCase: (caseId: string) => request(caseBase(caseId, "/restore"), { method: "POST" }),

    // ---- 回合 ----
    createRound: (caseId: string) => request<RetroCreateRoundResponse>(caseBase(caseId, "/rounds"), { method: "POST", body: {} }),
    patchRound: (caseId: string, roundId: string, body: RetroPatchRoundRequest) =>
      request<RetroPatchRoundResponse>(caseBase(caseId, `/rounds/${enc(roundId)}`), { method: "PATCH", body }),
    deleteRound: (caseId: string, roundId: string) => request(caseBase(caseId, `/rounds/${enc(roundId)}`), { method: "DELETE" }),
    orderRounds: (caseId: string, roundIds: string[]) => request(caseBase(caseId, "/round-order"), { method: "PATCH", body: { roundIds } }),
    putLinks: (caseId: string, roundId: string, links: { kind: RetroLinkKind; targetId: string }[]) =>
      request(caseBase(caseId, `/rounds/${enc(roundId)}/links`), { method: "PUT", body: { links } }),

    // ---- 附件（需求凭证与回合附件共用，roundId 为 null 是需求凭证） ----
    addAssets: (caseId: string, assets: RetroNewAssetInput[]) =>
      request<RetroAddAssetsResponse>(caseBase(caseId, "/assets"), { method: "POST", body: { assets } }),
    assetUploadUrl: (caseId: string, assetId: string) =>
      request<RetroUploadUrlResponse>(caseBase(caseId, `/assets/${enc(assetId)}/upload-url`), { method: "POST" }),
    completeAssets: (caseId: string, assetIds: string[]) =>
      request<RetroCompleteAssetsResponse>(caseBase(caseId, "/assets/complete"), { method: "POST", body: { assetIds } }),
    deleteAsset: (caseId: string, assetId: string) => request(caseBase(caseId, `/assets/${enc(assetId)}`), { method: "DELETE" }),
    assetTranscript: async (caseId: string, assetId: string, signal?: AbortSignal) =>
      unwrapRetro<RetroTranscribeView>(await request(caseBase(caseId, `/assets/${enc(assetId)}/transcript`), { signal }), "transcribe"),
    retryAssetTranscript: (caseId: string, assetId: string) =>
      request(caseBase(caseId, `/assets/${enc(assetId)}/transcript`), { method: "POST", body: { action: "RETRY" } }),

    // ---- 点评录音（案例录音与整场总结共用） ----
    createRecording: (body: RetroCreateRecordingRequest) =>
      request<RetroCreateRecordingResponse>("/api/retro-recordings", { method: "POST", body }),
    getRecording: async (recordingId: string, signal?: AbortSignal) =>
      unwrapRetro<RetroRecordingView>(await request(`/api/retro-recordings/${enc(recordingId)}`, { signal }), "recording"),
    recordingAction: async (recordingId: string, action: RetroRecordingAction) =>
      unwrapRetro<RetroRecordingView | undefined>(await request(`/api/retro-recordings/${enc(recordingId)}`, { method: "POST", body: { action } }), "recording"),

    // ---- 月份 ----
    getMonth: async (monthKey: string, signal?: AbortSignal) =>
      unwrapRetro<RetroMonthView>(await request(`/api/retro-months/${enc(monthKey)}`, { signal }), "month"),
    getPublication: async (monthKey: string, version: number, signal?: AbortSignal) =>
      unwrapRetro<RetroPublicationView>(await request(`/api/retro-months/${enc(monthKey)}/publications/${version}`, { signal }), "publication"),
    /** replaceJobId：待审阅时「重新生成」——服务端在一个事务里放弃旧任务并开新任务，失败整体回滚、草稿保留。 */
    startJob: (monthKey: string, body: RetroStartJobRequest) =>
      request(`/api/retro-months/${enc(monthKey)}/jobs`, { method: "POST", body }),
    jobAction: (monthKey: string, jobId: string, action: RetroJobAction) =>
      request(`/api/retro-months/${enc(monthKey)}/jobs/${enc(jobId)}`, { method: "POST", body: { action } }),
    patchDraft: (monthKey: string, jobId: string, body: RetroDraftPatchRequest) =>
      request(`/api/retro-months/${enc(monthKey)}/jobs/${enc(jobId)}/draft`, { method: "PATCH", body }),
  };
}

export const retroApi = createRetroApiClient();

/** 409（乐观锁对不上）：别人刚改过。 */
export function isRetroConflict(reason: unknown): boolean {
  return reason instanceof V04UiApiError && reason.status === 409;
}

export function retroReasonText(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}
