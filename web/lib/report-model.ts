// 报告库的纯类型与纯函数：状态机、任务类型、上传格式判定、上传限制、权限判定。
// 这一层不碰数据库，读写在 lib/report-server.ts / lib/report-engagement-server.ts /
// lib/report-review-server.ts；HTTP 路由只做鉴权与拼装。

/** 转换流水线的显式状态机，见实施规格三、3.2 与四。 */
export const REPORT_STATUSES = ["UPLOADING", "QUEUED", "PROCESSING", "READY", "FAILED"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export function isReportStatus(value: unknown): value is ReportStatus {
  return typeof value === "string" && (REPORT_STATUSES as readonly string[]).includes(value);
}

/** 只有转换完成、页图都生成了的报告才算「就绪」——收藏和进入工作台都卡在这一步。 */
export function isReportReady(status: string): boolean {
  return status === "READY";
}

/** 只有失败的报告才谈得上重试；其余状态点重试都是没意义的重复操作。 */
export function canRetryReportStatus(status: string): boolean {
  return status === "FAILED";
}

/** 上传时选定的任务类型，工作台不再出现这个字段（规格 2.2）。 */
export const TASK_TYPES = [
  "宣发企划",
  "故事线",
  "宣发阶段性提报",
  "月度总结报告",
  "专项宣发方案",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export function isValidTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && (TASK_TYPES as readonly string[]).includes(value);
}

/** 报告库页签的总开关；关闭时接口一律 404，UI 仍是占位空态。 */
export function isReportFeatureEnabled(): boolean {
  return process.env.REPORT_LIBRARY_UI_ENABLED === "true";
}

export function reportFeatureDisabledResponse(): Response {
  return Response.json({ error: "报告库尚未开放。" }, { status: 404 });
}

/**
 * 服务层的错误自带 HTTP 状态码，路由直接透传，不用再猜「这是 404 还是 403」。
 * 不设默认状态码之外的分支——没标注状态码的一律按 400（参数或业务规则问题）处理。
 */
export class ReportServiceError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ReportServiceError";
    this.status = status;
  }
}

export type SourceFormat = "PPT" | "PPTX" | "PDF";

const EXTENSION_FORMATS: Record<string, SourceFormat> = {
  ppt: "PPT",
  pptx: "PPTX",
  pdf: "PDF",
};

const CONTENT_TYPE_FORMATS: Record<string, SourceFormat> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
  "application/vnd.ms-powerpoint": "PPT",
};

export const REPORT_ALLOWED_EXTENSIONS = Object.keys(EXTENSION_FORMATS).map((ext) => `.${ext}`);
export const REPORT_ALLOWED_CONTENT_TYPES = Object.keys(CONTENT_TYPE_FORMATS);

function extensionOf(name: string): string {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf(".");
  if (dot < 0 || dot === trimmed.length - 1) return "";
  return trimmed.slice(dot + 1).toLowerCase();
}

/**
 * 按扩展名 + content-type 双检（规格四）：扩展名优先，因为浏览器/系统对这三种格式
 * 的 content-type 上报并不总是可靠；扩展名无法识别时才退回看 content-type。
 * 两者都对不上已知格式时返回 null，调用方据此拒绝上传。
 */
export function sourceFormatOf(
  originalName: string,
  contentType: string | null | undefined,
): SourceFormat | null {
  const ext = extensionOf(originalName ?? "");
  if (ext && EXTENSION_FORMATS[ext]) return EXTENSION_FORMATS[ext];
  const type = (contentType ?? "").trim().toLowerCase();
  if (type && CONTENT_TYPE_FORMATS[type]) return CONTENT_TYPE_FORMATS[type];
  return null;
}

/** 原件 ≤ 200 MB（规格四）。相关资料复用同一个上限，规格没有另行规定。 */
export const REPORT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export type ReportUploadValidation =
  | { ok: true; sourceFormat: SourceFormat }
  | { ok: false; error: string };

/** 建条目前的第一道闸门：格式、大小都在这里挡掉，不合格的请求不该写进数据库。 */
export function validateReportUpload(input: {
  originalName: string;
  contentType?: string | null;
  fileSize: number;
}): ReportUploadValidation {
  const originalName = input.originalName?.trim() ?? "";
  if (!originalName) {
    return { ok: false, error: "请选择要上传的报告文件。" };
  }
  const fileSize = Number(input.fileSize);
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return { ok: false, error: "无法识别文件大小，请重新选择文件。" };
  }
  if (fileSize > REPORT_MAX_UPLOAD_BYTES) {
    return { ok: false, error: "原件不能超过 200 MB，版式要求高的建议直接传 PDF。" };
  }
  const sourceFormat = sourceFormatOf(originalName, input.contentType);
  if (!sourceFormat) {
    return { ok: false, error: "只接受 PPT、PPTX 或 PDF 格式的报告文件。" };
  }
  return { ok: true, sourceFormat };
}

export const REPORT_MAX_TAGS = 12;

export function normalizeReportTags(tags: readonly string[] | null | undefined): string[] {
  return (tags ?? [])
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, REPORT_MAX_TAGS);
}

export function tagsFromJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 「谁能管这份报告」的唯一判定：原上传者或系统管理员。重试、删除都用它，
 * 避免重试可以做而删除不能做（或反过来）这种不一致。
 */
export function canManageReport(
  report: { createdByEmail: string },
  viewer: { identityKey: string; isAdmin?: boolean },
): boolean {
  return Boolean(viewer.isAdmin) || report.createdByEmail === viewer.identityKey;
}

export type ReportVersionSummary = {
  count: number;
  latestOwnerName: string | null;
  latestUpdatedAt: string | null;
};

export type ReportListItem = {
  id: string;
  title: string;
  taskType: string;
  tags: string[];
  status: ReportStatus;
  sourceFormat: string;
  originalName: string;
  contentType: string;
  fileSize: number;
  pageCount: number;
  pagesDone: number;
  failReason: string | null;
  coverUrl: string | null;
  versionSummary: ReportVersionSummary;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

export type ReportPageView = {
  pageNo: number;
  /** 渲染失败的页不签 URL——`render_status !== 'OK'` 时这两个字段都是 null。 */
  thumbUrl: string | null;
  largeUrl: string | null;
  width: number;
  height: number;
  textExcerpt: string;
  renderStatus: string;
};

export type ReportFileView = {
  id: string;
  originalName: string;
  contentType: string;
  fileSize: number;
  uploadedByUserId: string;
  createdAt: string;
  url: string;
};

export type ReportDetail = {
  id: string;
  title: string;
  taskType: string;
  tags: string[];
  status: ReportStatus;
  sourceFormat: string;
  originalName: string;
  contentType: string;
  fileSize: number;
  pageCount: number;
  pagesDone: number;
  failReason: string | null;
  convertNotes: string | null;
  convertAttempts: number;
  converterVersion: string | null;
  createdByEmail: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  pages: ReportPageView[];
  files: ReportFileView[];
};
