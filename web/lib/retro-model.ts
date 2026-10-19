// 客户需求复盘库：前后端共用的常量、词表、纯函数和接口形状。客户端组件可直接引用（不碰 @/db）。
// 规格见 docs/26_客户需求复盘库_实施规格_V0.1.md；这个文件是那份规格的代码版，改这里等于改规格。
//
// 服务端（lib/retro/*、app/api/retro-*）与前端（components/retro/*）都只从这里拿词表和类型，不各写一份。

import { parseVisualTags } from "@/lib/visual-contract";

/** 总开关（规格 4.1）。关闭时接口一律 404，页签在、显示「建设中」。 */
export function isRetroFeatureEnabled(): boolean {
  return process.env.RETRO_LIBRARY_ENABLED === "true";
}

// ---------------------------------------------------------------------------
// 词表（与 db/retro-schema.ts 逐项一致，tests/retro-schema.test.ts 断言）
// ---------------------------------------------------------------------------

export const RETRO_RECORDING_STATUS_LIST = ["UPLOADING", "TRANSCRIBING", "READY", "FAILED", "REMOVED"] as const;
export type RetroRecordingStatus = (typeof RETRO_RECORDING_STATUS_LIST)[number];

export const RETRO_ASSET_TYPE_LIST = ["IMAGE", "VIDEO", "AUDIO", "DOC"] as const;
export type RetroAssetType = (typeof RETRO_ASSET_TYPE_LIST)[number];

export const RETRO_DOC_FORMAT_LIST = ["PDF", "WORD", "EXCEL", "PPT"] as const;
export type RetroDocFormat = (typeof RETRO_DOC_FORMAT_LIST)[number];

export const RETRO_TRANSCRIBE_STATUS_LIST = ["NONE", "TRANSCRIBING", "READY", "FAILED"] as const;
export type RetroTranscribeStatus = (typeof RETRO_TRANSCRIBE_STATUS_LIST)[number];

export const RETRO_LINK_KIND_LIST = ["VIDEO", "REPORT", "VISUAL"] as const;
export type RetroLinkKind = (typeof RETRO_LINK_KIND_LIST)[number];
export const RETRO_LINK_KIND_LABELS: Record<RetroLinkKind, string> = { VIDEO: "视频库", REPORT: "报告库", VISUAL: "公共视觉库" };

export const RETRO_JOB_STATUS_LIST = [
  "QUEUED",
  "EXTRACTING",
  "SUMMARIZING",
  "DISTILLING",
  "PENDING_REVIEW",
  "PUBLISHED",
  "FAILED",
  "ABANDONED",
] as const;
export type RetroJobStatus = (typeof RETRO_JOB_STATUS_LIST)[number];

export const RETRO_JOB_FAILED_STEP_LIST = ["EXTRACT", "SUMMARIZE", "DISTILL"] as const;
export type RetroJobFailedStep = (typeof RETRO_JOB_FAILED_STEP_LIST)[number];

/** 界面上的三步（规格 10.5）：逐案提炼 i / N · 汇总纪要 · 汇总方法。 */
export const RETRO_JOB_STEP_LABELS: Record<RetroJobFailedStep, string> = {
  EXTRACT: "逐案提炼",
  SUMMARIZE: "汇总纪要",
  DISTILL: "汇总方法",
};

export function isRetroJobRunning(status: RetroJobStatus) {
  return status === "QUEUED" || status === "EXTRACTING" || status === "SUMMARIZING" || status === "DISTILLING";
}

export function isRetroJobLive(status: RetroJobStatus) {
  return status !== "PUBLISHED" && status !== "ABANDONED";
}

/** 分析维度（规格 6.4）。需求文档的「方法迁移」不单列，是每条候选的 transfer 属性。 */
export const RETRO_METHOD_DIMENSION_LIST = ["ENTRY", "INFO", "PATH", "VALUE", "SOLUTION", "INTERACTION"] as const;
export type RetroMethodDimension = (typeof RETRO_METHOD_DIMENSION_LIST)[number];
export const RETRO_DIMENSION_LABELS: Record<RetroMethodDimension, string> = {
  ENTRY: "问题切入",
  INFO: "信息判断",
  PATH: "分析路径",
  VALUE: "价值判断",
  SOLUTION: "解决思路",
  INTERACTION: "互动方法",
};

/** 三类（规格三-3）。 */
export const RETRO_METHOD_KIND_LIST = ["METHOD", "INTUITION", "SITUATIONAL"] as const;
export type RetroMethodKind = (typeof RETRO_METHOD_KIND_LIST)[number];
export const RETRO_KIND_LABELS: Record<RetroMethodKind, string> = { METHOD: "方法", INTUITION: "直觉", SITUATIONAL: "情境" };

export const RETRO_METHOD_TRANSFER_LIST = ["TRANSFERABLE", "CASE_ONLY", "UNSURE"] as const;
export type RetroMethodTransfer = (typeof RETRO_METHOD_TRANSFER_LIST)[number];
export const RETRO_TRANSFER_LABELS: Record<RetroMethodTransfer, string> = {
  TRANSFERABLE: "可迁移",
  CASE_ONLY: "只适用本案",
  UNSURE: "说不准",
};

// ---------------------------------------------------------------------------
// 长度与数量（规格 4.2、4.3、5.1）
// ---------------------------------------------------------------------------

export const RETRO_LIMITS = {
  departmentMax: 30,
  clientMax: 60,
  titleMax: 80,
  sceneTagsMax: 8,
  sceneTagMax: 20,
  backgroundMax: 5000,
  roundsMax: 20,
  roundTitleMax: 40,
  roundOccurredMax: 40,
  roundTextMax: 5000,
  outcomeMax: 3000,
  turningPointsMax: 3000,
  discussionQuestionsMax: 2000,
  assetsPerOwnerMax: 12, // 需求凭证、每个回合各自 ≤12
  linksPerRoundMax: 6,
  recordingPartsMax: 3,
  recordingMaxBytes: 500 * 1024 * 1024,
  /** 客户录音进提示词的字数上限（每个案例合计，规格 6.4）。 */
  clientTranscriptCharsPerCase: 30000,
  /** 点评录音进逐案提炼提示词的字数上限（每个案例各段合计）；超出按时间截断并注明省略。 */
  reviewTranscriptCharsPerCase: 60000,
  /** 整场总结进汇总提示词的字数上限（各段合计）。 */
  summaryTranscriptChars: 60000,
  draftTextMax: 600,
  draftTitleMax: 40,
} as const;

// ---------------------------------------------------------------------------
// 月份（北京时间）
// ---------------------------------------------------------------------------

const MONTH_KEY = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export function isRetroMonthKey(value: unknown): value is string {
  return typeof value === "string" && MONTH_KEY.test(value);
}

/** 当前复盘月份（Asia/Shanghai）。 */
export function currentRetroMonthKey(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  return `${year}-${month}`;
}

export function shiftRetroMonthKey(key: string, delta: number): string {
  const [year, month] = key.split("-").map(Number);
  const index = year * 12 + (month - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** 「2026 年 10 月」。 */
export function formatRetroMonth(key: string): string {
  const [year, month] = key.split("-");
  return `${year} 年 ${Number(month)} 月`;
}

// ---------------------------------------------------------------------------
// 附件分类（规格 4.3：图片、视频、音频、文档；其它拒收）
// ---------------------------------------------------------------------------

const IMAGE_EXT = ["jpg", "jpeg", "png", "webp", "heic", "heif"];
const VIDEO_EXT = ["mp4", "mov", "m4v", "webm", "avi", "mkv"];
const AUDIO_EXT = ["m4a", "mp3", "wav", "aac", "flac", "ogg", "opus", "amr", "wma", "3gp"];
const DOC_EXT: Record<string, RetroDocFormat> = {
  pdf: "PDF",
  doc: "WORD",
  docx: "WORD",
  xls: "EXCEL",
  xlsx: "EXCEL",
  ppt: "PPT",
  pptx: "PPT",
  key: "PPT",
};

export const RETRO_FILE_ACCEPT = [
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "video/*", "audio/*",
  ...[...IMAGE_EXT, ...VIDEO_EXT, ...AUDIO_EXT, ...Object.keys(DOC_EXT)].map((ext) => `.${ext}`),
].join(",");

export const RETRO_FILE_TYPES_HINT = "支持图片、视频、音频，以及 PDF、Word、Excel、PPT 文档";

function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export type RetroFileClass = { type: RetroAssetType; docFormat: RetroDocFormat | null };

/** 按扩展名优先、MIME 兜底分类；SVG、GIF 和其它类型返回 null（拒收）。前后端用同一份规则。 */
export function classifyRetroFile(originalName: string, contentType?: string | null): RetroFileClass | null {
  const ext = extensionOf(originalName);
  const type = (contentType ?? "").toLowerCase().trim();
  if (type === "image/svg+xml" || type === "image/gif" || ext === "svg" || ext === "gif") return null;
  if (DOC_EXT[ext]) return { type: "DOC", docFormat: DOC_EXT[ext] };
  if (IMAGE_EXT.includes(ext)) return { type: "IMAGE", docFormat: null };
  if (AUDIO_EXT.includes(ext)) return { type: "AUDIO", docFormat: null };
  if (VIDEO_EXT.includes(ext)) return { type: "VIDEO", docFormat: null };
  if (type === "application/pdf") return { type: "DOC", docFormat: "PDF" };
  if (type.startsWith("image/")) return ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(type) ? { type: "IMAGE", docFormat: null } : null;
  if (type.startsWith("audio/")) return { type: "AUDIO", docFormat: null };
  if (type.startsWith("video/")) return { type: "VIDEO", docFormat: null };
  return null;
}

// ---------------------------------------------------------------------------
// 其它纯函数
// ---------------------------------------------------------------------------

/** 场景标签：归一与去重同公共视觉（docs/22 3.3.1）。数量和长度由校验报错，不在这里截断。 */
export function parseRetroSceneTags(input: string | readonly string[]): string[] {
  return parseVisualTags(input);
}

export function normalizeRetroSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN");
}

export function formatRetroClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 「案例 N」的序号（规格 6.7）：当月案例按创建先后排，**被删除的也占号**，所以序号一经出现就不再变。
 * 生成时冻结进 input_snapshot_json；已发布版本只用冻结的那份。
 */
export function retroCaseNumbers(cases: ReadonlyArray<{ id: string; createdAt: string }>): Record<string, number> {
  const sorted = [...cases].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return Object.fromEntries(sorted.map((item, index) => [item.id, index + 1]));
}

// ---------------------------------------------------------------------------
// 转写与出处
// ---------------------------------------------------------------------------

export type RetroTranscriptSegment = {
  /** 从 1 起的句序号；一段录音内唯一。 */
  id: number;
  startMs: number;
  endMs: number;
  /** S0、S1…（腾讯云 SpeakerId 加前缀 S）。 */
  speakerId: string;
  text: string;
};

/** 出处（规格 6.5）：点评录音，或客户录音（只用于纪要的「经过」「关键争议」）。 */
export type RetroSource =
  | { kind: "REVIEW"; recordingId: string; segmentIds: number[]; caseId: string | null; roundIds?: string[] }
  | { kind: "CLIENT"; assetId: string; segmentIds: number[]; caseId: string; roundId: string | null };

/** 被引用片段的原文快照（发布时冻结进 quoted_segments_json，键见 retroSourceKey）。 */
export type RetroQuotedSegment = { segmentId: number; startMs: number; speakerLabel: string; text: string };

export function retroSourceKey(source: Pick<RetroSource, "kind"> & { recordingId?: string; assetId?: string }): string {
  return source.kind === "REVIEW" ? `R:${source.recordingId}` : `C:${source.assetId}`;
}

/**
 * 出处标记的文字（规格 6.7）：
 * - 点评录音：「案例 2 · 12:40」；案例有多段录音时「案例 1 · 第 2 段 05:10」；整场总结「总结 · 03:15」；
 * - 客户录音：「客户录音 · 00:42」。
 */
export function formatRetroSourceLabel(input: {
  kind: RetroSource["kind"];
  caseNumber: number | null;
  partNo: number | null;
  partCount: number;
  startMs: number;
}): string {
  const clock = formatRetroClock(input.startMs);
  if (input.kind === "CLIENT") return `客户录音 · ${clock}`;
  if (input.caseNumber == null) return `总结 · ${clock}`;
  const part = input.partCount > 1 && input.partNo ? `第 ${input.partNo} 段 ` : "";
  return `案例 ${input.caseNumber} · ${part}${clock}`;
}

// ---------------------------------------------------------------------------
// 两份成果（规格 6.5）
// ---------------------------------------------------------------------------

export type RetroDraftOrigin = "AI" | "MANUAL";

export type RetroItem = { id: string; text: string; sources: RetroSource[]; origin: RetroDraftOrigin; edited: boolean };

export type RetroCaseReview = {
  caseId: string;
  /** 经过：只能改，不能删（规格 6.6）。 */
  process: string;
  processSources: RetroSource[];
  /** 老孙在草稿里改过「经过」（RetroItem.edited 的对应物；「经过」不是条目，没有 edited 字段）。 */
  processEdited?: boolean;
  disputes: RetroItem[];
  founderPoints: RetroItem[];
  suggestions: RetroItem[];
  /** 全部被校验丢光时为 true，界面写「这个案例没有提炼出有依据的内容」。 */
  empty: boolean;
};

export type RetroMinutes = {
  cases: RetroCaseReview[];
  /** 有案例但没有点评录音、未参与提炼的案例 id（列在案例清单里）。 */
  unanalyzedCaseIds: string[];
  insights: RetroItem[];
  actions: RetroItem[];
};

export type RetroMethodCandidate = {
  id: string;
  number: number;
  dimension: RetroMethodDimension;
  kind: RetroMethodKind;
  title: string;
  description: string;
  situation: string;
  transfer: RetroMethodTransfer;
  transferNote: string;
  sources: RetroSource[];
  origin: RetroDraftOrigin;
  edited: boolean;
};

export type RetroMethods = { candidates: RetroMethodCandidate[]; observations: RetroItem[] };

/** 草稿各节能做什么（规格 6.6）。 */
export const RETRO_DRAFT_SECTIONS = {
  "case.process": { update: true, remove: false, add: false },
  "case.disputes": { update: true, remove: true, add: false },
  "case.founderPoints": { update: true, remove: true, add: false },
  "case.suggestions": { update: true, remove: true, add: false },
  insights: { update: true, remove: true, add: true },
  actions: { update: true, remove: true, add: true },
  candidates: { update: true, remove: true, add: true },
  observations: { update: true, remove: true, add: true },
} as const;
export type RetroDraftSection = keyof typeof RETRO_DRAFT_SECTIONS;

// ---------------------------------------------------------------------------
// 视图（GET 返回给前端的形状）
// ---------------------------------------------------------------------------

export type RetroTranscribeView = {
  status: RetroTranscribeStatus;
  failReason: string | null;
  durationMs: number | null;
  segments: RetroTranscriptSegment[] | null;
};

export type RetroAssetView = {
  id: string;
  roundId: string | null;
  type: RetroAssetType;
  docFormat: RetroDocFormat | null;
  position: number;
  originalName: string;
  contentType: string;
  fileSize: number;
  width: number;
  height: number;
  durationSeconds: number;
  uploadStatus: "UPLOADING" | "READY";
  derivativeStatus: "PENDING" | "READY" | "FAILED";
  derivativeError: string | null;
  /** 图片 480w／视频截帧；没就绪为 null。 */
  thumbnailUrl: string | null;
  /** 图片 1600w；其它类型为 null。 */
  displayUrl: string | null;
  /** 站内地址：图片原图、PDF、Office 下载走 …/original；视频、音频走 …/stream。 */
  openUrl: string;
  /** 只有 AUDIO 有。 */
  transcribe: RetroTranscribeView | null;
};

export type RetroLinkView = {
  kind: RetroLinkKind;
  targetId: string;
  title: string;
  subtitle: string;
  thumbnailUrl: string | null;
  /** 原作品页；原作品已删除时为 null。 */
  href: string | null;
  deleted: boolean;
};

export type RetroRoundView = {
  id: string;
  position: number;
  title: string;
  occurredOn: string;
  deliveryText: string;
  feedbackText: string;
  responseText: string;
  revision: number;
  assets: RetroAssetView[];
  links: RetroLinkView[];
};

export type RetroRecordingView = {
  id: string;
  monthKey: string;
  caseId: string | null;
  partNo: number;
  status: RetroRecordingStatus;
  failReason: string | null;
  fileName: string;
  sizeBytes: number;
  durationMs: number | null;
  /** `/api/retro-recordings/[id]/audio`。 */
  audioUrl: string;
  uploadedByName: string;
  createdAt: string;
  canRemove: boolean;
  segments: RetroTranscriptSegment[] | null;
  /** 当月发布后由 AI 认定的称呼（S0 → 老孙…）；未认定为 null，界面显示「说话人 N」。 */
  speakerLabels: Record<string, string> | null;
};

/** 卡片上的录音标记（规格 10.2）。 */
export type RetroRecordingBadge =
  | { state: "NONE" }
  | { state: "PROCESSING" }
  | { state: "FAILED" }
  | { state: "READY"; parts: number; durationMs: number };

export type RetroCaseCard = {
  id: string;
  monthKey: string;
  department: string;
  clientName: string;
  title: string;
  sceneTags: string[];
  backgroundExcerpt: string;
  /** 回合轨迹：每回合一个点，有客户反馈的描边。 */
  roundTrack: { title: string; hasFeedback: boolean }[];
  hasOutcome: boolean;
  recording: RetroRecordingBadge;
  createdByName: string;
  createdAt: string;
  canManage: boolean;
  /** 库首页搜索用：需求加各回合的标题与文字，压成一行、最多 4000 字（规格 10.1「搜需求与回合文字」）。 */
  searchText?: string;
};

/** 月份标题行上的成果状态（规格 10.1）。 */
export type RetroMonthBadge =
  | { state: "NONE" }
  | { state: "RUNNING"; publishedVersion: number | null }
  | { state: "PUBLISHED"; version: number; changed: boolean };

export type RetroMonthSummary = { monthKey: string; caseCount: number; recordedCaseCount: number; badge: RetroMonthBadge };

export type RetroLibraryResponse = { cases: RetroCaseCard[]; months: RetroMonthSummary[] };

export type RetroCaseCapabilities = { canEdit: boolean; canTrash: boolean; canUploadRecording: boolean };

/** 出处里的「第二版」标记要用的回合信息：回合 id → 所属案例与标题（软删除的回合也要在，规格 6.7、10.3）。 */
export type RetroRoundRefs = Record<string, { caseId: string; title: string }>;

export type RetroCaseInMinutes = {
  publicationVersion: number;
  publishedAt: string;
  publishedByName: string;
  caseNumber: number;
  review: RetroCaseReview | null;
  methods: RetroMethodCandidate[];
  quotedSegments: Record<string, RetroQuotedSegment[]>;
  /** 出处标记要用的：录音 id → { caseNumber, partNo, partCount }。 */
  recordingRefs: Record<string, { caseId: string | null; caseNumber: number | null; partNo: number; partCount: number }>;
  /** 可选；没给时回合标记只能写「对应回合」。 */
  roundRefs?: RetroRoundRefs;
};

export type RetroCaseDetail = {
  id: string;
  monthKey: string;
  department: string;
  clientName: string;
  title: string;
  sceneTags: string[];
  background: string;
  outcome: string;
  turningPoints: string;
  discussionQuestions: string;
  revision: number;
  /** 当月序号（「案例 N」，按创建先后、被删除的也占号）；可选，没给时面包屑只写「案例」。 */
  caseNumber?: number;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  /** 「任务与最初需求」的需求凭证（round_id 为空的附件）。 */
  needAssets: RetroAssetView[];
  rounds: RetroRoundView[];
  recordings: RetroRecordingView[];
  /** 只有这个案例被包含在当月最新已发布版本里时才有（规格 10.3-5）。 */
  inMinutes: RetroCaseInMinutes | null;
  viewerCapabilities: RetroCaseCapabilities;
};

export type RetroJobView = {
  id: string;
  status: RetroJobStatus;
  /** EXTRACTING 时做到第几个、一共几个。 */
  progress: { done: number; total: number };
  failedStep: RetroJobFailedStep | null;
  failReason: string | null;
  /** 「修订已发布内容」时的来源版本号。 */
  revisingFromVersion: number | null;
  /** 只有老孙能拿到，且只在 PENDING_REVIEW 时有。 */
  draft: {
    minutes: RetroMinutes;
    methods: RetroMethods;
    revision: number;
    quotedSegments: Record<string, RetroQuotedSegment[]>;
    /** 出处标记要用的录音信息（同 RetroPublicationView.recordingRefs）。 */
    recordingRefs: RetroCaseInMinutes["recordingRefs"];
    /** 草稿纳入的案例与生成时冻结的序号。 */
    caseNumbers: Record<string, number>;
    roundRefs?: RetroRoundRefs;
  } | null;
  createdAt: string;
  updatedAt: string;
};

export type RetroPublicationView = {
  id: string;
  versionNumber: number;
  publishedAt: string;
  publishedByName: string;
  caseIds: string[];
  caseNumbers: Record<string, number>;
  minutes: RetroMinutes;
  methods: RetroMethods;
  quotedSegments: Record<string, RetroQuotedSegment[]>;
  recordingRefs: RetroCaseInMinutes["recordingRefs"];
  roundRefs?: RetroRoundRefs;
};

/**
 * retro_month_publications 里几列 JSON 的存储形状（发布时一次写定，之后只读）：
 * - case_ids_json：发布那一刻纳入的案例和冻结的序号，按序号升序；
 * - minutes_json / methods_json：RetroMinutes / RetroMethods；
 * - quoted_segments_json：被引用片段的原文快照，以及出处标记要用的录音信息。
 * retro_month_jobs 的 minutes_json / methods_json 草稿是同样的形状；草稿的引文在读取时现取。
 */
export type RetroStoredPublicationCases = { caseId: string; number: number }[];
export type RetroStoredQuotes = {
  segments: Record<string, RetroQuotedSegment[]>;
  recordingRefs: RetroCaseInMinutes["recordingRefs"];
};

export type RetroMonthCaseRow = {
  id: string;
  number: number;
  department: string;
  clientName: string;
  title: string;
  roundCount: number;
  recording: RetroRecordingBadge;
};

/** 生成前提（规格 6.1）。 */
export type RetroGeneratePreconditions = {
  caseCount: number;
  recordedCaseCount: number;
  unrecordedCaseCount: number;
  reviewRecordingsProcessing: number;
  summaryParts: number;
  clientAudio: { total: number; ready: number; transcribing: number; failed: number };
  canGenerate: boolean;
  /** canGenerate 为 false 时的原因，给按钮旁边写。 */
  blockedReason: string | null;
} & RetroRegeneratePreconditions;

export type RetroMonthView = {
  monthKey: string;
  cases: RetroMonthCaseRow[];
  summaryRecordings: RetroRecordingView[];
  totalDurationMs: number;
  latestPublication: RetroPublicationView | null;
  publicationVersions: number[];
  /** 发布后录音变动的段数（新增或移除）。 */
  changedSincePublish: number;
  job: RetroJobView | null;
  preconditions: RetroGeneratePreconditions;
  viewer: { isReviewer: boolean; canUploadSummary: boolean };
};

// ---------------------------------------------------------------------------
// 请求形状
// ---------------------------------------------------------------------------

export type RetroCaseBasicsInput = {
  monthKey: string;
  department: string;
  clientName: string;
  title: string;
  sceneTags: string[];
};

export type RetroCreateCaseResponse = { caseId: string; firstRoundId: string };

/** PATCH /api/retro-cases/[id]：只带要改的字段 + revision。 */
export type RetroPatchCaseRequest = Partial<RetroCaseBasicsInput> & {
  background?: string;
  outcome?: string;
  turningPoints?: string;
  discussionQuestions?: string;
  revision: number;
};

export type RetroPatchRoundRequest = {
  title?: string;
  occurredOn?: string;
  deliveryText?: string;
  feedbackText?: string;
  responseText?: string;
  revision: number;
};

export type RetroNewAssetInput = {
  roundId: string | null;
  originalName: string;
  contentType: string;
  fileSize: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
};

export type RetroAddAssetsResponse = { assetIds: string[] };
/** contentType 是服务端按扩展名定的白名单类型，已经签进 uploadUrl：前端 PUT 时必须原样用它，不能用浏览器的 file.type。 */
export type RetroUploadUrlResponse = { uploadUrl: string; coverUploadUrl: string | null; contentType: string };
export type RetroCompleteAssetsResponse = { missing: string[] };

export type RetroPutLinksRequest = { links: { kind: RetroLinkKind; targetId: string }[] };

export type RetroCreateRecordingRequest = { monthKey: string; caseId: string | null; fileName: string; contentType: string; sizeBytes: number };
export type RetroCreateRecordingResponse = { recording: RetroRecordingView; uploadUrl: string };
export type RetroRecordingAction = "UPLOADED" | "RETRY" | "REMOVE";

export type RetroStartJobRequest = {
  mode: "GENERATE" | "REVISE_PUBLISHED";
  /** 待审阅或失败时「重新生成」：要替换的在途任务 id。服务端在同一个事务里放弃它并插入新任务，任何一步失败都整体回滚。 */
  replaceJobId?: string;
};
export type RetroJobAction = "RETRY" | "ABANDON" | "PUBLISH";

export type RetroDraftPatchRequest = {
  section: RetroDraftSection;
  /** case.* 节要带 caseId。 */
  caseId?: string;
  itemId?: string;
  op: "UPDATE" | "DELETE" | "ADD";
  value?: Partial<Pick<RetroItem, "text">> &
    Partial<Pick<RetroMethodCandidate, "dimension" | "kind" | "title" | "description" | "situation" | "transfer" | "transferNote">>;
  revision: number;
};

// ---------------------------------------------------------------------------
// 案例与录音接口的响应形状（B1 追加；请求形状见上）
// ---------------------------------------------------------------------------

/** GET /api/retro-cases/[id] */
export type RetroCaseDetailResponse = { case: RetroCaseDetail };

/**
 * PATCH /api/retro-cases/[id]：不回整份详情（失焦自动保存时，整份覆盖会冲掉别的字段里还没提交的输入），
 * 只回新的 revision 和服务端归一后的值。
 */
export type RetroPatchCaseResponse = Pick<
  RetroCaseDetail,
  | "revision"
  | "updatedAt"
  | "monthKey"
  | "department"
  | "clientName"
  | "title"
  | "sceneTags"
  | "background"
  | "outcome"
  | "turningPoints"
  | "discussionQuestions"
>;

/** POST /api/retro-cases/[id]/rounds，可选 body { title? }。 */
export type RetroCreateRoundRequest = { title?: string };
export type RetroCreateRoundResponse = { round: RetroRoundView };

/** PATCH /api/retro-cases/[id]/rounds/[roundId]：回新的 revision 和归一后的文字。 */
export type RetroPatchRoundResponse = {
  round: Pick<RetroRoundView, "id" | "title" | "occurredOn" | "deliveryText" | "feedbackText" | "responseText" | "revision">;
};

/** PATCH /api/retro-cases/[id]/round-order：必须恰好是现有未删除回合的全部 id。 */
export type RetroRoundOrderRequest = { roundIds: string[] };

/** POST /api/retro-cases/[id]/assets：每个附件自带 roundId（null = 需求凭证）。 */
export type RetroAddAssetsRequest = { assets: RetroNewAssetInput[] };

/**
 * POST /api/retro-cases/[id]/assets/complete：可选 { assetIds }，不带就核对这个案例里所有还在上传中的附件。
 * 响应一律 200，missing 是没核对到的附件 id（没传上或大小不符），可以重传或去掉；其余的已置为就绪。
 */
export type RetroCompleteAssetsRequest = { assetIds?: string[] };

/** GET /api/retro-cases/[id]/assets/[assetId]/transcript，POST 同样返回这个形状。 */
export type RetroTranscriptResponse = { assetId: string; transcribe: RetroTranscribeView };

/** PUT /api/retro-cases/[id]/rounds/[roundId]/links */
export type RetroPutLinksResponse = { links: RetroLinkView[] };

/** POST /api/retro-recordings/[id]、GET /api/retro-recordings/[id] */
export type RetroRecordingResponse = { recording: RetroRecordingView };

/** 回收站、删除回合、删除附件、回合排序的响应。 */
export type RetroOkResponse = { ok: true };

// 月度整理接口的返回（/api/retro-months/**）：GET 月份页直接返回 RetroMonthView，GET publications/[n] 直接返回 RetroPublicationView。
/** POST jobs → 201。待审阅（或失败）时「重新生成」带 replaceJobId：服务端在一个事务里放弃旧任务并开新任务，失败整体回滚、草稿保留；不带它直接 GENERATE 会 409。 */
export type RetroStartJobResponse = { job: RetroJobView };
/** POST jobs/[jobId]（RETRY / ABANDON / PUBLISH）；PUBLISH 时带 publicationVersion。 */
export type RetroJobActionResponse = { job: RetroJobView; publicationVersion?: number };
/** PATCH jobs/[jobId]/draft；ADD 时 itemId 是新条目的 id。 */
export type RetroDraftPatchResponse = { job: RetroJobView; itemId: string | null };

/**
 * 待审阅或失败时「重新生成」的前提（审查意见 1）：排除当前在途任务计算。服务端恒给出，标成可选只为兼容旧的测试样例。
 * 没有在途任务、或任务还在跑时 canRegenerate 为 false。
 */
export type RetroRegeneratePreconditions = {
  canRegenerate?: boolean;
  regenerateBlockedReason?: string | null;
};
