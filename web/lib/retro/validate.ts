// 客户需求复盘库的请求校验（docs/26 4.2、4.3、5.1）。纯函数：不碰数据库，失败抛 RetroError(400)，
// message 就是展示给人看的中文原因。校验顺序与前端对话框一致：月份 → 部门 → 客户 → 标题 → 场景标签。

import { audioReviewContentType } from "@/lib/audio-review-model";
import {
  RETRO_FILE_TYPES_HINT,
  RETRO_KEYNOTE_REFUSAL,
  RETRO_LIMITS,
  RETRO_LINK_KIND_LIST,
  classifyRetroFile,
  currentRetroMonthKey,
  isRetroKeynoteFile,
  isRetroMonthKey,
  parseRetroSceneTags,
  shiftRetroMonthKey,
  type RetroAssetType,
  type RetroCaseBasicsInput,
  type RetroDocFormat,
  type RetroLinkKind,
  type RetroNewAssetInput,
  type RetroPatchRoundRequest,
} from "@/lib/retro-model";
import { retroInvalid } from "./errors";

const chars = (value: string) => [...value].length;

function record(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw retroInvalid(`请填写${label}。`);
  return value.trim();
}

/** 必填单行：1–max 字。 */
function requiredLine(value: unknown, label: string, max: number): string {
  const text = requireString(value, label);
  if (!text) throw retroInvalid(`请填写${label}。`);
  if (chars(text) > max) throw retroInvalid(`${label}最多 ${max} 个字。`);
  return text;
}

/** 选填文本：0–max 字（空字符串合法）。 */
function optionalText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw retroInvalid(`${label}要是文字。`);
  const text = value.trim();
  if (chars(text) > max) throw retroInvalid(`${label}最多 ${max} 个字。`);
  return text;
}

// ---------------------------------------------------------------------------
// 案例基本信息与收尾
// ---------------------------------------------------------------------------

/**
 * 复盘月份：新建只能选上月、本月、下月；编辑可以改成任何过去的月份，但不能超过下月（规格 4.2）。
 * 月份按北京时间算。
 */
export function validateRetroMonth(value: unknown, mode: "create" | "edit", now: Date = new Date()): string {
  if (!isRetroMonthKey(value)) throw retroInvalid("请选择复盘月份。");
  const current = currentRetroMonthKey(now);
  const next = shiftRetroMonthKey(current, 1);
  if (value > next) throw retroInvalid("复盘月份最晚只能选到下个月。");
  if (mode === "create" && value < shiftRetroMonthKey(current, -1)) {
    throw retroInvalid("新建案例的复盘月份只能选上月、本月或下月；更早的月份可以建好后再改。");
  }
  return value;
}

function sceneTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "string" && !Array.isArray(value)) throw retroInvalid("客户服务场景的格式不对。");
  const tags = parseRetroSceneTags(value as string | string[]);
  if (tags.length > RETRO_LIMITS.sceneTagsMax) throw retroInvalid(`客户服务场景最多 ${RETRO_LIMITS.sceneTagsMax} 个。`);
  const tooLong = tags.find((tag) => chars(tag) > RETRO_LIMITS.sceneTagMax);
  if (tooLong) throw retroInvalid(`每个客户服务场景最多 ${RETRO_LIMITS.sceneTagMax} 个字：「${tooLong}」太长了。`);
  return tags;
}

export function validateRetroCaseBasics(body: unknown, now: Date = new Date()): RetroCaseBasicsInput {
  const input = record(body);
  const monthKey = validateRetroMonth(input.monthKey, "create", now);
  const department = requiredLine(input.department, "部门", RETRO_LIMITS.departmentMax);
  const clientName = requiredLine(input.clientName, "客户", RETRO_LIMITS.clientMax);
  const title = requiredLine(input.title, "案例标题", RETRO_LIMITS.titleMax);
  return { monthKey, department, clientName, title, sceneTags: sceneTags(input.sceneTags) };
}

export type RetroCaseFieldsPatch = {
  monthKey?: string;
  department?: string;
  clientName?: string;
  title?: string;
  sceneTags?: string[];
  background?: string;
  outcome?: string;
  turningPoints?: string;
  discussionQuestions?: string;
};

export function validateRetroRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw retroInvalid("缺少版本号，请刷新页面后重试。");
  }
  return value;
}

/** PATCH /api/retro-cases/[id]：只带要改的字段 + revision；一个字段都没带算 400。 */
export function validateRetroCasePatch(body: unknown, now: Date = new Date()): { fields: RetroCaseFieldsPatch; revision: number } {
  const input = record(body);
  const revision = validateRetroRevision(input.revision);
  const fields: RetroCaseFieldsPatch = {};
  if (input.monthKey !== undefined) fields.monthKey = validateRetroMonth(input.monthKey, "edit", now);
  if (input.department !== undefined) fields.department = requiredLine(input.department, "部门", RETRO_LIMITS.departmentMax);
  if (input.clientName !== undefined) fields.clientName = requiredLine(input.clientName, "客户", RETRO_LIMITS.clientMax);
  if (input.title !== undefined) fields.title = requiredLine(input.title, "案例标题", RETRO_LIMITS.titleMax);
  if (input.sceneTags !== undefined) fields.sceneTags = sceneTags(input.sceneTags);
  if (input.background !== undefined) fields.background = optionalText(input.background, "任务与最初需求", RETRO_LIMITS.backgroundMax);
  if (input.outcome !== undefined) fields.outcome = optionalText(input.outcome, "结果", RETRO_LIMITS.outcomeMax);
  if (input.turningPoints !== undefined) fields.turningPoints = optionalText(input.turningPoints, "关键转折", RETRO_LIMITS.turningPointsMax);
  if (input.discussionQuestions !== undefined) {
    fields.discussionQuestions = optionalText(input.discussionQuestions, "希望讨论的问题", RETRO_LIMITS.discussionQuestionsMax);
  }
  if (Object.keys(fields).length === 0) throw retroInvalid("没有要保存的内容。");
  return { fields, revision };
}

// ---------------------------------------------------------------------------
// 回合
// ---------------------------------------------------------------------------

export type RetroRoundFieldsPatch = Omit<RetroPatchRoundRequest, "revision">;

export function validateRetroRoundPatch(body: unknown): { fields: RetroRoundFieldsPatch; revision: number } {
  const input = record(body);
  const revision = validateRetroRevision(input.revision);
  const fields: RetroRoundFieldsPatch = {};
  if (input.title !== undefined) fields.title = requiredLine(input.title, "回合标题", RETRO_LIMITS.roundTitleMax);
  if (input.occurredOn !== undefined) fields.occurredOn = optionalText(input.occurredOn, "回合时间", RETRO_LIMITS.roundOccurredMax);
  if (input.deliveryText !== undefined) fields.deliveryText = optionalText(input.deliveryText, "我们交了什么", RETRO_LIMITS.roundTextMax);
  if (input.feedbackText !== undefined) fields.feedbackText = optionalText(input.feedbackText, "客户怎么反馈", RETRO_LIMITS.roundTextMax);
  if (input.responseText !== undefined) fields.responseText = optionalText(input.responseText, "我们怎么应对", RETRO_LIMITS.roundTextMax);
  if (Object.keys(fields).length === 0) throw retroInvalid("没有要保存的内容。");
  return { fields, revision };
}

/** 新增回合可以带标题；不带就用「第 N 版」。 */
export function validateRetroNewRoundTitle(body: unknown, fallback: string): string {
  const title = record(body).title;
  if (title === undefined || title === null) return fallback;
  return requiredLine(title, "回合标题", RETRO_LIMITS.roundTitleMax);
}

export function validateRetroRoundOrder(body: unknown, currentIds: readonly string[]): string[] {
  const ids = record(body).roundIds;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) throw retroInvalid("回合顺序的格式不对，请刷新后重试。");
  const set = new Set(ids as string[]);
  if (set.size !== ids.length || ids.length !== currentIds.length || !currentIds.every((id) => set.has(id))) {
    throw retroInvalid("回合顺序和现有回合对不上，请刷新后重试。");
  }
  return ids as string[];
}

// ---------------------------------------------------------------------------
// 附件
// ---------------------------------------------------------------------------

export const RETRO_ASSETS_PER_REQUEST_MAX = 36;

/**
 * 附件的 Content-Type 不取自用户：按扩展名映射成固定的白名单类型（规格 4.3 之外的加固）。
 * 建条目时就用映射值，签进预签名 PUT 并通过 upload-url 返回给前端上传；GET 时再用 response-content-type 覆盖，
 * 所以对象上存的类型即使被改过，浏览器拿到的也是这里的值。
 */
const RETRO_CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm", avi: "video/x-msvideo", mkv: "video/x-matroska",
  m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg",
  opus: "audio/ogg", amr: "audio/amr", wma: "audio/x-ms-wma", "3gp": "audio/3gpp",
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const RETRO_ALLOWED_CONTENT_TYPES = new Set(Object.values(RETRO_CONTENT_TYPE_BY_EXTENSION));

/** 扩展名优先；没有扩展名（或不认识）时，只有浏览器给的类型恰好在白名单里才采用；都不行返回 null。 */
export function retroContentTypeFor(originalName: string, browserType?: string | null): string | null {
  const dot = originalName.lastIndexOf(".");
  const ext = dot >= 0 ? originalName.slice(dot + 1).toLowerCase() : "";
  const byExtension = RETRO_CONTENT_TYPE_BY_EXTENSION[ext];
  if (byExtension) return byExtension;
  const claimed = (browserType ?? "").trim().toLowerCase();
  return RETRO_ALLOWED_CONTENT_TYPES.has(claimed) ? claimed : null;
}

export type NormalizedRetroAsset = {
  roundId: string | null;
  originalName: string;
  contentType: string;
  fileSize: number;
  durationSeconds: number;
  width: number;
  height: number;
  type: RetroAssetType;
  docFormat: RetroDocFormat | null;
};

function nonNegativeInt(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export function validateRetroNewAssets(body: unknown): NormalizedRetroAsset[] {
  const list = record(body).assets;
  if (!Array.isArray(list) || list.length === 0) throw retroInvalid("请先选择要上传的文件。");
  if (list.length > RETRO_ASSETS_PER_REQUEST_MAX) throw retroInvalid(`一次最多上传 ${RETRO_ASSETS_PER_REQUEST_MAX} 个文件。`);
  return list.map((raw) => {
    const item = record(raw) as Partial<RetroNewAssetInput>;
    const originalName = typeof item.originalName === "string" ? item.originalName.trim().slice(0, 200) : "";
    if (!originalName) throw retroInvalid("缺少文件名。");
    const contentType = typeof item.contentType === "string" ? item.contentType.trim() : "";
    if (isRetroKeynoteFile(originalName, contentType)) throw retroInvalid(`「${originalName}」：${RETRO_KEYNOTE_REFUSAL}。`);
    const classified = classifyRetroFile(originalName, contentType);
    if (!classified) throw retroInvalid(`不支持「${originalName}」这种文件。${RETRO_FILE_TYPES_HINT}。`);
    const fileSize = Number(item.fileSize);
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw retroInvalid(`「${originalName}」的文件大小无效。`);
    if (classified.type === "AUDIO" && fileSize > RETRO_LIMITS.recordingMaxBytes) {
      throw retroInvalid(`「${originalName}」超过 500MB，录音文件不能超过 500MB。`);
    }
    if (item.roundId !== null && item.roundId !== undefined && (typeof item.roundId !== "string" || !item.roundId)) {
      throw retroInvalid("附件所属的回合无效。");
    }
    const storedType = retroContentTypeFor(originalName, contentType);
    if (!storedType) throw retroInvalid(`不支持「${originalName}」这种文件。${RETRO_FILE_TYPES_HINT}。`);
    return {
      roundId: typeof item.roundId === "string" ? item.roundId : null,
      originalName,
      contentType: storedType,
      fileSize,
      durationSeconds: nonNegativeInt(item.durationSeconds),
      width: nonNegativeInt(item.width),
      height: nonNegativeInt(item.height),
      type: classified.type,
      docFormat: classified.docFormat,
    };
  });
}

/** 每个归属（需求凭证、每个回合）各自 ≤12 个。existing 的键是 roundId 或 "NEED"。 */
export function assertRetroAssetCapacity(
  existing: ReadonlyMap<string, number>,
  incoming: ReadonlyArray<{ roundId: string | null }>,
  ownerLabel: (ownerKey: string) => string,
) {
  const added = new Map<string, number>();
  for (const item of incoming) {
    const key = item.roundId ?? "NEED";
    added.set(key, (added.get(key) ?? 0) + 1);
  }
  for (const [key, count] of added) {
    const total = (existing.get(key) ?? 0) + count;
    if (total > RETRO_LIMITS.assetsPerOwnerMax) {
      throw retroInvalid(`${ownerLabel(key)}最多放 ${RETRO_LIMITS.assetsPerOwnerMax} 个附件，已经有 ${existing.get(key) ?? 0} 个了。`);
    }
  }
}

// ---------------------------------------------------------------------------
// 关联作品
// ---------------------------------------------------------------------------

export function validateRetroLinks(body: unknown): { kind: RetroLinkKind; targetId: string }[] {
  const list = record(body).links;
  if (!Array.isArray(list)) throw retroInvalid("关联作品的格式不对。");
  const seen = new Set<string>();
  const links: { kind: RetroLinkKind; targetId: string }[] = [];
  for (const raw of list) {
    const item = record(raw);
    const kind = item.kind;
    const targetId = typeof item.targetId === "string" ? item.targetId.trim() : "";
    if (typeof kind !== "string" || !(RETRO_LINK_KIND_LIST as readonly string[]).includes(kind) || !targetId || targetId.length > 200) {
      throw retroInvalid("关联作品的格式不对。");
    }
    const key = `${kind}:${targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ kind: kind as RetroLinkKind, targetId });
  }
  if (links.length > RETRO_LIMITS.linksPerRoundMax) throw retroInvalid(`每个回合最多关联 ${RETRO_LIMITS.linksPerRoundMax} 个作品。`);
  return links;
}

// ---------------------------------------------------------------------------
// 点评录音
// ---------------------------------------------------------------------------

export type NormalizedRetroRecordingRequest = {
  monthKey: string;
  caseId: string | null;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

export function validateRetroRecordingRequest(body: unknown): NormalizedRetroRecordingRequest {
  const input = record(body);
  if (!isRetroMonthKey(input.monthKey)) throw retroInvalid("复盘月份无效。");
  let caseId: string | null = null;
  if (input.caseId !== null && input.caseId !== undefined) {
    if (typeof input.caseId !== "string" || !input.caseId.trim()) throw retroInvalid("案例无效。");
    caseId = input.caseId.trim();
  }
  const fileName = typeof input.fileName === "string" ? input.fileName.trim().slice(0, 200) : "";
  if (!fileName) throw retroInvalid("缺少录音文件名。");
  const contentType = audioReviewContentType(fileName, typeof input.contentType === "string" ? input.contentType : "");
  if (!contentType) throw retroInvalid("只能上传录音文件（m4a、mp3、wav、aac、flac、ogg、amr、wma、3gp、mp4 等）。");
  const sizeBytes = Number(input.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw retroInvalid("录音文件大小无效。");
  if (sizeBytes > RETRO_LIMITS.recordingMaxBytes) throw retroInvalid("录音文件不能超过 500MB。");
  return { monthKey: input.monthKey, caseId, fileName, contentType, sizeBytes };
}

export type RetroRecordingActionName = "UPLOADED" | "RETRY" | "REMOVE";

export function validateRetroRecordingAction(body: unknown): RetroRecordingActionName {
  const action = record(body).action;
  if (action === "UPLOADED" || action === "RETRY" || action === "REMOVE") return action;
  throw retroInvalid("不支持的操作。");
}
