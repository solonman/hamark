// 录音点评改写：前后端共用的只读契约类型 + 浏览器端客户端。客户端组件可直接引用（不碰 @/db）。
// 见 docs/25_录音点评改写_实施规格_V0.1.md 四、4.2 / 4.6 / 4.8。

import { V04UiApiError } from "@/lib/v04-ui-api-client";

export const AUDIO_REVIEW_STATUS_LIST = [
  "UPLOADING",
  "TRANSCRIBING",
  "UNDERSTANDING",
  "PENDING_CONFIRM",
  "GENERATED",
  "FAILED",
  "ABANDONED",
] as const;

export type AudioReviewStatus = (typeof AUDIO_REVIEW_STATUS_LIST)[number];
export type AudioReviewFailedStep = "UPLOAD" | "TRANSCRIBE" | "UNDERSTAND";

/** 界面上的三步：上传录音 / 转写成文字 / 理解点评、拟定改动。 */
export const AUDIO_REVIEW_STEP_LABELS = ["上传录音", "转写成文字", "理解点评、拟定改动"] as const;
export type AudioReviewStep = 0 | 1 | 2;

export function audioReviewStepOf(status: AudioReviewStatus, failedStep: AudioReviewFailedStep | null): AudioReviewStep {
  if (status === "FAILED") return failedStep === "UPLOAD" ? 0 : failedStep === "TRANSCRIBE" ? 1 : 2;
  if (status === "UPLOADING") return 0;
  if (status === "TRANSCRIBING") return 1;
  return 2;
}

export function isAudioReviewInFlight(status: AudioReviewStatus) {
  return status === "UPLOADING" || status === "TRANSCRIBING" || status === "UNDERSTANDING";
}

export function isAudioReviewTerminal(status: AudioReviewStatus) {
  return status === "GENERATED" || status === "ABANDONED";
}

export type AudioReviewOpinionKind = "GENERAL" | "SPECIFIC";

export type AudioReviewOpinion = {
  id: string;
  /** 1…N，按引用片段的最早时间排序。 */
  number: number;
  kind: AudioReviewOpinionKind;
  summary: string;
  /** 落实说明：总体意见为什么改了这些处，具体意见改了哪里。 */
  rationale: string;
  segmentIds: number[];
  changeIds: string[];
};

export type AudioReviewValueType =
  | "TEXT"
  | "RATING"
  | "CHOICE"
  | "MECHANISM"
  | "CARRIERS"
  | "PATH_DETAIL"
  | "PATH_PRIMARY"
  | "PATH_AUXILIARY";

export type AudioReviewChange = {
  id: string;
  /** 模型给出的细粒度键，如 `path.primaryDetails.reveal`、`shot:<id>.visualContent`。 */
  key: string;
  /** 落库用的 V04 键：细项归到 `path.primaryDetails`，辅助路径归到 `path.auxiliaryTypes`。 */
  targetKey: string;
  subKey: string | null;
  /** 「第三模块 · 主导路径细项 · 揭示／反转」这样的位置说明。 */
  label: string;
  valueType: AudioReviewValueType;
  before: unknown;
  after: unknown;
  beforeText: string;
  afterText: string;
  opinionIds: string[];
};

export type AudioReviewUnaddressed = {
  segmentIds: number[];
  startMs: number;
  speaker: string;
  text: string;
  reason: string;
};

export type AudioReviewProposalView = {
  opinions: AudioReviewOpinion[];
  changes: AudioReviewChange[];
  unaddressed: AudioReviewUnaddressed[];
  model: string | null;
  promptVersion: string | null;
};

export type AudioReviewSegment = {
  id: number;
  startMs: number;
  endMs: number;
  /** 显示用：老孙 / 被点评人姓名 / 其他人 A… */
  speaker: string;
  isReviewer: boolean;
  text: string;
  corrections: { from: string; to: string }[];
};

export type AudioReviewView = {
  id: string;
  videoId: string;
  baseVersionId: string;
  baseVersionNumber: number;
  baseOwnerName: string;
  reviewerName: string;
  status: AudioReviewStatus;
  failedStep: AudioReviewFailedStep | null;
  failReason: string | null;
  step: AudioReviewStep;
  audio: { fileName: string; sizeBytes: number; durationMs: number | null; url: string };
  transcript: { segments: AudioReviewSegment[] } | null;
  proposal: AudioReviewProposalView | null;
  selectedChangeIds: string[] | null;
  reviewVersionId: string | null;
  reviewVersionNumber: number | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
};

/** `V19StudioModel.audioReviews` 的一项：页头入口、版本菜单、提示条只需要这些。 */
export type V19AudioReviewSummary = {
  id: string;
  baseVersionId: string;
  status: AudioReviewStatus;
  step: AudioReviewStep;
  failReason: string | null;
  /** 待确认时是拟定改动总数；已生成时是实际写进点评版的处数。 */
  changeCount: number;
  reviewVersionId: string | null;
  reviewVersionNumber: number | null;
};

/** 集成版溯源里「点评版 vN 的写法」一行（spec 六）。 */
export type V19ReviewCandidate = {
  reviewVersionId: string;
  reviewVersionNumber: number;
  targetKey: string;
  targetLabel: string;
  value: unknown;
  updatedAt: string;
};

export type CreateAudioReviewRequestBody = {
  /** null = 被点评的是还没落库的虚拟 v1。 */
  baseVersionId: string | null;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

export type CreateAudioReviewResponseBody = {
  review: AudioReviewView;
  uploadUrl: string;
};

export type AudioReviewActionRequestBody =
  | { action: "UPLOADED" }
  | { action: "RETRY" }
  | { action: "ABANDON" }
  | { action: "CONFIRM"; selectedChangeIds: string[] };

export type AudioReviewActionResponseBody = {
  review: AudioReviewView;
  reviewVersionId?: string;
};

export const AUDIO_REVIEW_MAX_BYTES = 500 * 1024 * 1024;
export const AUDIO_REVIEW_EXTENSIONS = ["m4a", "mp3", "wav", "aac", "flac", "ogg", "opus", "amr", "wma", "3gp", "mp4"] as const;

/** 浏览器给不出 MIME 时（常见于 .m4a / .amr）按扩展名补一个；服务端用同一份规则校验。 */
export function audioReviewContentType(fileName: string, browserType: string): string | null {
  const type = browserType.trim().toLowerCase();
  if (type.startsWith("audio/")) return type;
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (!(AUDIO_REVIEW_EXTENSIONS as readonly string[]).includes(ext)) return null;
  if (type === "video/mp4" || type === "video/3gpp") return type;
  const byExt: Record<string, string> = {
    m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac", flac: "audio/flac",
    ogg: "audio/ogg", opus: "audio/ogg", amr: "audio/amr", wma: "audio/x-ms-wma", "3gp": "audio/3gpp", mp4: "audio/mp4",
  };
  return byExt[ext] ?? null;
}

export function formatAudioClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ---------------------------------------------------------------------------
// 浏览器端客户端。错误信封与 v19Api 相同（{ error: { code, message, requestId } }）。
// ---------------------------------------------------------------------------

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createAudioReviewApiClient(fetcher: FetchLike = fetch) {
  async function request<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const requestId = `audio-review-${crypto.randomUUID()}`;
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
        throw new V04UiApiError(408, "REQUEST_TIMEOUT", "服务器响应超时，请稍后重试。", requestId);
      }
      throw new V04UiApiError(0, "NETWORK_ERROR", "网络连接失败，请检查网络后重试。", requestId);
    }
    const raw = await response.text();
    let payload: unknown;
    try {
      payload = raw.trim() ? JSON.parse(raw) : undefined;
    } catch {
      throw new V04UiApiError(response.status, "INVALID_RESPONSE", `服务器返回了无法识别的数据（HTTP ${response.status}）。`, requestId);
    }
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string; requestId?: string } } | undefined)?.error;
      throw new V04UiApiError(
        response.status,
        error?.code || "HTTP_ERROR",
        error?.message || `请求未完成（HTTP ${response.status}）。`,
        error?.requestId || requestId,
      );
    }
    return payload as T;
  }

  const base = (videoId: string, suffix = "") => `/api/videos/${encodeURIComponent(videoId)}/audio-reviews${suffix}`;

  return {
    create: (videoId: string, body: CreateAudioReviewRequestBody, signal?: AbortSignal) =>
      request<CreateAudioReviewResponseBody>(base(videoId), { method: "POST", body, signal }),
    get: (videoId: string, reviewId: string, signal?: AbortSignal) =>
      request<{ review: AudioReviewView }>(base(videoId, `/${encodeURIComponent(reviewId)}`), { signal }),
    action: (videoId: string, reviewId: string, body: AudioReviewActionRequestBody, signal?: AbortSignal) =>
      request<AudioReviewActionResponseBody>(base(videoId, `/${encodeURIComponent(reviewId)}`), { method: "POST", body, signal }),
    audioUrl: (videoId: string, reviewId: string) => base(videoId, `/${encodeURIComponent(reviewId)}/audio`),
  };
}

export const audioReviewApi = createAudioReviewApiClient();
