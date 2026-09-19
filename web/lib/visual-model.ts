// 公共视觉库的纯类型与纯函数：错误类型、文本字段校验、素材数量与格式校验、
// 权限判定、封面取舍、载体计数、素材顺序校验、对象键工具。这一层不碰数据库，
// 读写在 lib/visual-server.ts；HTTP 路由只做鉴权与拼装（同报告域 lib/report-model.ts
// 与 lib/report-server.ts 的分层）。规则见
// docs/22_公共视觉_立项与实施规格_V0.2.md 三、四、五。

import {
  isAllowedVisualImage,
  isHttpUrl,
  isVisualSubdomain,
  parseVisualTags,
  VISUAL_DEFAULT_RIGHTS_NOTE,
  VISUAL_LIMITS,
  type VisualAssetType,
  type VisualCarrierCounts,
  type VisualCaseFieldsInput,
  type VisualCaseStatus,
  type VisualNewAssetInput,
  type VisualSubdomain,
  type VisualUploadStatus,
} from "./visual-contract";

/**
 * 服务层的错误自带 HTTP 状态码，路由直接透传，不用再猜「这是 404 还是 403」。
 * 与 ReportServiceError 同构（见 lib/report-model.ts）。
 */
export class VisualServiceError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "VisualServiceError";
    this.status = status;
  }
}

/** 总开关（规格 6.5）。关闭时接口一律 404。 */
export function visualFeatureDisabledResponse(): Response {
  return Response.json({ error: "公共视觉库尚未开放。" }, { status: 404 });
}

// ---------------------------------------------------------------------------
// 文本字段校验（规格五「写入校验」、3.3.1）。顺序与提示跟前端一致：
// 子领域 → 标题（必填） → 采集地点（必填） → 标签（必填/数量/长度） →
// 各长度上限 → 来源链接协议。metadata 的校验在 lib/visual-metadata.ts。
// ---------------------------------------------------------------------------

export type NormalizedVisualCaseFields = {
  subdomain: VisualSubdomain;
  title: string;
  location: string;
  tags: string[];
  textBody: string;
  summary: string;
  creator: string;
  occurredAt: string;
  sourceUrl: string;
  rightsNote: string;
};

export type VisualCaseFieldsValidation =
  | { ok: true; fields: NormalizedVisualCaseFields }
  | { ok: false; error: string };

export function validateVisualCaseFields(input: VisualCaseFieldsInput): VisualCaseFieldsValidation {
  if (!isVisualSubdomain(input.subdomain)) {
    return { ok: false, error: "请选择子领域。" };
  }
  const title = (input.title ?? "").trim();
  if (!title) return { ok: false, error: "请填写标题。" };
  const location = (input.location ?? "").trim();
  if (!location) return { ok: false, error: "请填写采集地点，写到城市即可。" };

  const tags = parseVisualTags(input.tags ?? []);
  if (tags.length === 0) return { ok: false, error: "至少填一个标签。" };
  if (tags.length > VISUAL_LIMITS.tagsMax) {
    return { ok: false, error: `标签最多 ${VISUAL_LIMITS.tagsMax} 个。` };
  }
  if (tags.some((tag) => tag.length > VISUAL_LIMITS.tagLengthMax)) {
    return { ok: false, error: `每个标签不超过 ${VISUAL_LIMITS.tagLengthMax} 个字。` };
  }

  if (title.length > VISUAL_LIMITS.titleMax) {
    return { ok: false, error: `标题最多 ${VISUAL_LIMITS.titleMax} 字。` };
  }
  if (location.length > VISUAL_LIMITS.locationMax) {
    return { ok: false, error: `采集地点最多 ${VISUAL_LIMITS.locationMax} 字。` };
  }
  const creator = (input.creator ?? "").trim();
  if (creator.length > VISUAL_LIMITS.creatorMax) {
    return { ok: false, error: `创作方／品牌最多 ${VISUAL_LIMITS.creatorMax} 字。` };
  }
  const summary = (input.summary ?? "").trim();
  if (summary.length > VISUAL_LIMITS.summaryMax) {
    return { ok: false, error: `一句话摘要最多 ${VISUAL_LIMITS.summaryMax} 字。` };
  }
  const textBody = input.textBody ?? "";
  if (textBody.length > VISUAL_LIMITS.textBodyMax) {
    return { ok: false, error: `案例简介最多 ${VISUAL_LIMITS.textBodyMax} 字。` };
  }
  const sourceUrl = (input.sourceUrl ?? "").trim();
  if (sourceUrl.length > VISUAL_LIMITS.sourceUrlMax) {
    return { ok: false, error: `来源链接最多 ${VISUAL_LIMITS.sourceUrlMax} 字。` };
  }

  if (sourceUrl && !isHttpUrl(sourceUrl)) {
    return { ok: false, error: "来源链接只收 http:// 或 https:// 开头的网址。" };
  }

  const occurredAt = (input.occurredAt ?? "").trim();
  const rightsNote = (input.rightsNote ?? "").trim() || VISUAL_DEFAULT_RIGHTS_NOTE;

  return {
    ok: true,
    fields: { subdomain: input.subdomain, title, location, tags, textBody, summary, creator, occurredAt, sourceUrl, rightsNote },
  };
}

// ---------------------------------------------------------------------------
// 素材数量与格式校验（规格 3.2、3.8、五）。
// ---------------------------------------------------------------------------

export type VisualAssetCounts = { videos: number; images: number };

export function countVisualAssetsByType(assets: readonly { type: string }[]): VisualAssetCounts {
  let videos = 0;
  let images = 0;
  for (const asset of assets) {
    if (asset.type === "VIDEO") videos += 1;
    else if (asset.type === "IMAGE") images += 1;
  }
  return { videos, images };
}

export type VisualAssetsValidation = { ok: true } | { ok: false; error: string };

/**
 * 新增素材（建条目或追加）的校验：至少一个（按「已有 + 新增」合计判断，建条目时
 * existing 是 {0,0}）；素材类型只能是 VIDEO/IMAGE；图片必须过图片白名单；
 * 视频 ≤12、图片 ≤24、合计 ≤36，按「已有 + 新增」算。
 */
export function validateNewVisualAssets(
  assets: readonly VisualNewAssetInput[],
  existing: VisualAssetCounts = { videos: 0, images: 0 },
): VisualAssetsValidation {
  if (assets.length === 0 && existing.videos + existing.images === 0) {
    return { ok: false, error: "请先选择视频或图片，至少一个。" };
  }
  for (const asset of assets) {
    if (asset.type !== "VIDEO" && asset.type !== "IMAGE") {
      return { ok: false, error: "素材类型只能是视频或图片。" };
    }
    if (asset.type === "IMAGE" && !isAllowedVisualImage(asset.originalName, asset.contentType)) {
      return { ok: false, error: `不支持的图片格式：${asset.originalName || "未命名文件"}。` };
    }
  }
  const added = countVisualAssetsByType(assets);
  const totalVideos = existing.videos + added.videos;
  const totalImages = existing.images + added.images;
  if (totalVideos > VISUAL_LIMITS.videos) {
    return { ok: false, error: `每条案例最多 ${VISUAL_LIMITS.videos} 段视频。` };
  }
  if (totalImages > VISUAL_LIMITS.images) {
    return { ok: false, error: `每条案例最多 ${VISUAL_LIMITS.images} 张图片。` };
  }
  if (totalVideos + totalImages > VISUAL_LIMITS.videos + VISUAL_LIMITS.images) {
    return { ok: false, error: `视频和图片合计最多 ${VISUAL_LIMITS.videos + VISUAL_LIMITS.images} 份。` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 权限判定（规格 3.6）：唯一口径，重试/删除/编辑都用它。
// ---------------------------------------------------------------------------

export function canManageVisualCase(
  visualCase: { createdByEmail: string },
  viewer: { identityKey: string; isAdmin?: boolean },
): boolean {
  return Boolean(viewer.isAdmin) || visualCase.createdByEmail === viewer.identityKey;
}

// ---------------------------------------------------------------------------
// 封面取舍（规格 3.2 第 4、5 条；决定 #13）：只有一条规则——第一位已传完的素材。
// ---------------------------------------------------------------------------

export function pickVisualCover<T extends { position: number; uploadStatus: string }>(
  assets: readonly T[],
): T | null {
  let cover: T | null = null;
  for (const asset of assets) {
    if (asset.uploadStatus !== "READY") continue;
    if (!cover || asset.position < cover.position) cover = asset;
  }
  return cover;
}

// ---------------------------------------------------------------------------
// 载体计数（规格 3.2 第 2 条）：READY 的案例按已传完的素材数；UPLOADING 的按
// 计划上传的数（含还没传完的）。查询时推导，不入库。
// ---------------------------------------------------------------------------

export function computeVisualCarrierCounts(
  assets: readonly { type: VisualAssetType; uploadStatus: VisualUploadStatus }[],
  caseStatus: VisualCaseStatus,
  hasBrief: boolean,
): VisualCarrierCounts {
  const relevant = caseStatus === "READY" ? assets.filter((asset) => asset.uploadStatus === "READY") : assets;
  const counted = countVisualAssetsByType(relevant);
  return { videos: counted.videos, images: counted.images, hasBrief };
}

// ---------------------------------------------------------------------------
// 乐观锁（规格五 PATCH）：PATCH 带的 updatedAt 必须与库里当前值一致，对不上就是
// 「这条案例刚被别人改过」。抽成纯函数方便单测，patchVisualCase 直接调用它。
// ---------------------------------------------------------------------------

export function isVisualUpdatedAtStale(storedUpdatedAt: string, providedUpdatedAt: string): boolean {
  return String(storedUpdatedAt) !== String(providedUpdatedAt);
}

// ---------------------------------------------------------------------------
// 素材顺序（规格五 PATCH）：assetOrder 必须恰好是当前全部素材 id 的一个排列。
// ---------------------------------------------------------------------------

export function isValidVisualAssetOrder(currentIds: readonly string[], assetOrder: readonly string[]): boolean {
  if (assetOrder.length !== currentIds.length) return false;
  const currentSet = new Set(currentIds);
  if (currentSet.size !== currentIds.length) return false;
  const seen = new Set<string>();
  for (const id of assetOrder) {
    if (!currentSet.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

// ---------------------------------------------------------------------------
// 对象键工具（规格 4.3）：visual/{caseId}/{assetId}/original.{ext}、cover.jpg、
// thumb.jpg、display.jpg。扩展名取原文件名的、清洗后小写，没有就 bin。
// ---------------------------------------------------------------------------

export function visualObjectExtension(originalName: string | null | undefined): string {
  const trimmed = (originalName ?? "").trim();
  const dot = trimmed.lastIndexOf(".");
  if (dot < 0 || dot === trimmed.length - 1) return "bin";
  const cleaned = trimmed
    .slice(dot + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return cleaned || "bin";
}

export function visualOriginalObjectKey(caseId: string, assetId: string, originalName: string | null | undefined): string {
  return `visual/${caseId}/${assetId}/original.${visualObjectExtension(originalName)}`;
}

export function visualCoverObjectKey(caseId: string, assetId: string): string {
  return `visual/${caseId}/${assetId}/cover.jpg`;
}

export function visualThumbObjectKey(caseId: string, assetId: string): string {
  return `visual/${caseId}/${assetId}/thumb.jpg`;
}

export function visualDisplayObjectKey(caseId: string, assetId: string): string {
  return `visual/${caseId}/${assetId}/display.jpg`;
}

// ---------------------------------------------------------------------------
// 派生图 20 MB 上限（规格 3.5）：超过的原图照样保存，只是不送数据万象持久化处理。
// ---------------------------------------------------------------------------

export function isOversizedForVisualDerivative(fileSizeBytes: number): boolean {
  return fileSizeBytes > VISUAL_LIMITS.derivativeMaxBytes;
}

/** 卡片与舞台的失败文案：「原图 26.3 MB，超过 20 MB 的处理上限；可以查看原图」，保留一位小数。 */
export function formatVisualOversizeReason(fileSizeBytes: number): string {
  const mb = fileSizeBytes / (1024 * 1024);
  const limitMb = VISUAL_LIMITS.derivativeMaxBytes / (1024 * 1024);
  return `原图 ${mb.toFixed(1)} MB，超过 ${limitMb} MB 的处理上限；可以查看原图`;
}
