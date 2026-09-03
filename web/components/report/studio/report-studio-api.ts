"use client";

/**
 * 报告拆解工作台的 fetch 封装：`app/api/reports/[id]/*` 的浏览器端客户端。
 *
 * 这些路由的错误信封是扁平的 `{error, code?, details?}`（见
 * `lib/report-version-chain.ts` 的 `reportVersionErrorResponse`、
 * `lib/report-model.ts` 的 `ReportServiceError`），跟二合一工作台
 * `v19-ui-model.ts` 里 `{error:{code,message,...}}` 那套嵌套信封不是一回事，
 * 所以这里另起一个轻量客户端，不复用 `createV19UiApiClient`。
 *
 * 类型全部用 `import type` 从服务端模块借，不引入任何运行时代码——
 * `lib/report-version-chain.ts` 顶部有 `node:crypto`，被当作值 import 会把
 * node 内置模块打进浏览器包。
 */

import type {
  ReportCreateFromInput,
  ReportSaveInput,
  ReportSaveResult,
  ReportVersionChain,
} from "@/lib/report-version-chain";
import type { ReportDetail } from "@/lib/report-model";
import type { CaseReviewModel } from "@/lib/case-review";
import type { ReportFinalSummary } from "@/lib/report-final-version";

export class ReportStudioApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, message: string, code?: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ReportStudioApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type ErrorEnvelope = { error?: string; code?: string; details?: Record<string, unknown> };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
  } catch {
    throw new ReportStudioApiError(0, "网络连接失败，本地内容已保留，可稍后重试。");
  }
  const raw = await response.text();
  let payload: unknown;
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new ReportStudioApiError(response.status, `服务器返回了无法识别的响应（HTTP ${response.status}）。`);
    }
  }
  if (!response.ok) {
    const envelope = (payload ?? {}) as ErrorEnvelope;
    throw new ReportStudioApiError(
      response.status,
      envelope.error?.trim() || `请求未完成（HTTP ${response.status}）。`,
      envelope.code,
      envelope.details ?? {},
    );
  }
  return payload as T;
}

const reportPath = (reportId: string, suffix = "") => `/api/reports/${encodeURIComponent(reportId)}${suffix}`;

export function loadReportDetail(reportId: string, signal?: AbortSignal): Promise<{ report: ReportDetail }> {
  return request(reportPath(reportId), { signal });
}

export function loadAnnotationChain(
  reportId: string,
  versionId?: string | null,
  signal?: AbortSignal,
): Promise<ReportVersionChain> {
  const search = versionId ? `?version=${encodeURIComponent(versionId)}` : "";
  return request(reportPath(reportId, `/annotation${search}`), { signal });
}

export function saveAnnotation(reportId: string, input: ReportSaveInput): Promise<ReportSaveResult> {
  return request(reportPath(reportId, "/annotation"), {
    method: "PUT",
    body: JSON.stringify({
      versionId: input.versionId,
      baseVersionId: input.baseVersionId,
      revision: input.revision,
      payload: input.payload,
    }),
  });
}

export function createVersionFrom(
  reportId: string,
  input: ReportCreateFromInput,
): Promise<ReportSaveResult> {
  return request(reportPath(reportId, "/annotation/versions"), {
    method: "POST",
    body: JSON.stringify({ fromVersionId: input.fromVersionId }),
  });
}

/** 定稿／取消定稿（`docs/21_报告集成版_实施规格_V0.1.md` 四、4.3）；只有老孙能调，非老孙 403。 */
export function setReportFinalStatus(
  reportId: string,
  status: "OPEN" | "DONE",
): Promise<{ final: ReportFinalSummary }> {
  return request(reportPath(reportId, "/annotation/final"), {
    method: "POST",
    body: JSON.stringify({ action: "SET_STATUS", status }),
  });
}

/** 采纳未纳入的修改，`all: true` 或 `intakeIds` 二选一（同上，四、4.3）。 */
export function adoptReportFinalIntakes(
  reportId: string,
  input: { intakeIds?: string[]; all?: boolean },
): Promise<{ final: ReportFinalSummary; adopted: number }> {
  return request(reportPath(reportId, "/annotation/final"), {
    method: "POST",
    body: JSON.stringify({ action: "ADOPT", ...input }),
  });
}

export function loadReview(
  reportId: string,
  versionId: string | null,
  signal?: AbortSignal,
): Promise<CaseReviewModel> {
  const search = versionId ? `?version=${encodeURIComponent(versionId)}` : "";
  return request(reportPath(reportId, `/review${search}`), { signal });
}

export function rateVersion(reportId: string, versionId: string, stars: number): Promise<{ stars: number | null }> {
  return request(reportPath(reportId, "/review"), {
    method: "POST",
    body: JSON.stringify({ kind: "RATING", versionId, stars }),
  });
}

export function commentOnVersion(
  reportId: string,
  input: { versionId: string; targetKey: string; targetLabel: string; body: string },
): Promise<{ comment: CaseReviewModel["comments"][number] | null }> {
  return request(reportPath(reportId, "/review"), {
    method: "POST",
    body: JSON.stringify({ kind: "COMMENT", ...input }),
  });
}

export function retryReport(reportId: string): Promise<{ ok: true }> {
  return request(reportPath(reportId, "/retry"), { method: "POST", body: JSON.stringify({}) });
}

/** 上传者删除，做法与视频侧一致：软删（`lib/report-server.ts` 的 `trashReport`），可恢复。 */
export function trashReport(reportId: string): Promise<{ ok: true }> {
  return request(reportPath(reportId, "/trash"), { method: "POST", body: JSON.stringify({}) });
}

export type CreateReportFileUploadResult = { fileId: string; uploadUrl: string };

export function createFileUpload(
  reportId: string,
  input: { originalName: string; contentType?: string | null; fileSize: number },
): Promise<CreateReportFileUploadResult> {
  return request(reportPath(reportId, "/files"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** 把文件内容真正传到预签名地址；跟建库记录（`createFileUpload`）是两步。 */
export async function putFileContent(uploadUrl: string, file: File): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream" },
  });
  if (!response.ok) {
    throw new ReportStudioApiError(response.status, "文件上传未完成，请重试。");
  }
}

export function deleteFile(reportId: string, fileId: string): Promise<{ ok: true }> {
  return request(reportPath(reportId, `/files/${encodeURIComponent(fileId)}`), { method: "DELETE" });
}
