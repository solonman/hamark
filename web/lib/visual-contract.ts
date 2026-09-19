// 公共视觉库的前后端约定：常量、词表、接口形状，以及前后端都要用的几个纯函数。
// 规格见 docs/22_公共视觉_立项与实施规格_V0.2.md；这个文件是那份规格的代码版，
// 改这里等于改规格，要同步更新文档（3.3.2、3.4、五）。
//
// 服务端的校验与落库在 lib/visual-metadata.ts / lib/visual-model.ts / lib/visual-server.ts，
// 前端在 components/visual/。两边都只从这里拿词表和类型，不各写一份。

/** 总开关（规格 6.5）。关闭时接口一律 404，页签按钮在但按不动。 */
export function isVisualFeatureEnabled(): boolean {
  return process.env.PUBLIC_VISUAL_LIBRARY_ENABLED === "true";
}

export const VISUAL_DOMAIN_KEY = "PUBLIC_VISUAL";
export const VISUAL_METADATA_SCHEMA_VERSION = "visual-metadata/1";
export const VISUAL_DEFAULT_RIGHTS_NOTE = "仅公司内部学习使用";

// ---------------------------------------------------------------------------
// 词表（规格 3.1、3.3.2）
// ---------------------------------------------------------------------------

export const VISUAL_SUBDOMAINS = ["OOH", "PUBLIC_ART", "RETAIL"] as const;
export type VisualSubdomain = (typeof VISUAL_SUBDOMAINS)[number];

export type VisualFieldSpec =
  | { key: string; label: string; type: "one"; options: readonly string[] }
  | { key: string; label: string; type: "many"; options: readonly string[]; tip?: string }
  | { key: string; label: string; type: "text"; placeholder?: string };

export const VISUAL_SUBDOMAIN_SPECS: Record<VisualSubdomain, {
  label: string;
  hint: string;
  fields: readonly VisualFieldSpec[];
}> = {
  OOH: {
    label: "户外广告",
    hint: "装置、互动、大屏、快闪空间",
    fields: [
      { key: "mediaFormat", label: "媒体形式", type: "one", options: ["地铁", "公交", "楼宇", "户外大牌", "裸眼 3D", "快闪空间", "其他"] },
      { key: "interactionType", label: "互动方式", type: "many", options: ["体感", "触摸", "AR", "声音", "扫码", "人脸识别", "机械动作", "其他"], tip: "不互动就都不选" },
      { key: "techNotes", label: "技术与材料", type: "text", placeholder: "LED、投影、雾幕、镜面…" },
      { key: "campaignPeriod", label: "投放周期", type: "text", placeholder: "如 2026-05 至 2026-08" },
    ],
  },
  PUBLIC_ART: {
    label: "公共艺术",
    hint: "雕塑、壁画、城市家具",
    fields: [
      { key: "artType", label: "作品类型", type: "one", options: ["雕塑", "壁画／涂鸦", "装置", "城市家具", "临时介入", "其他"] },
      { key: "materials", label: "材质", type: "text" },
      { key: "scale", label: "尺度", type: "text", placeholder: "如 12m × 4m × 6m" },
      { key: "permanence", label: "是否永久", type: "one", options: ["永久", "临时", "已拆除"] },
      { key: "commissioner", label: "委托方／策展方", type: "text" },
    ],
  },
  RETAIL: {
    label: "商业展陈",
    hint: "门头、围挡、橱窗、陈列",
    fields: [
      { key: "displayVenue", label: "展陈位置", type: "one", options: ["门头", "围挡", "橱窗", "中庭", "快闪店", "其他"] },
      { key: "displayPeriod", label: "展陈周期", type: "text" },
      { key: "displayMaterials", label: "主材", type: "text" },
      { key: "producer", label: "制作方", type: "text" },
    ],
  },
};

export function isVisualSubdomain(value: unknown): value is VisualSubdomain {
  return typeof value === "string" && (VISUAL_SUBDOMAINS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// 限制（规格 3.2、3.3.1、3.5、3.8）
// ---------------------------------------------------------------------------

export const VISUAL_LIMITS = {
  videos: 12,
  images: 24,
  titleMax: 80,
  locationMax: 60,
  creatorMax: 60,
  summaryMax: 60,
  tagsMax: 10,
  tagLengthMax: 20,
  textBodyMax: 20000,
  sourceUrlMax: 500,
  /** 数据万象持久化处理只接这么大的原图；超过的照样保存，但预览标 FAILED。 */
  derivativeMaxBytes: 20 * 1024 * 1024,
  thumbnailWidth: 480,
  displayWidth: 1600,
} as const;

/** 图片白名单（决定 #16）。扩展名和 MIME 任一命中即可：手机上传的 HEIC 常常没有 MIME。 */
export const VISUAL_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "heic", "heif"] as const;
export const VISUAL_IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;
/** 给 <input accept> 用。视频不限格式（同视频域），所以只写 video/*。 */
export const VISUAL_FILE_ACCEPT = `video/*,${VISUAL_IMAGE_CONTENT_TYPES.join(",")},${VISUAL_IMAGE_EXTENSIONS.map((ext) => `.${ext}`).join(",")}`;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isAllowedVisualImage(originalName: string, contentType?: string | null): boolean {
  const type = (contentType ?? "").toLowerCase().trim();
  if (type === "image/svg+xml" || type === "image/gif") return false;
  if ((VISUAL_IMAGE_CONTENT_TYPES as readonly string[]).includes(type)) return true;
  return (VISUAL_IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(originalName));
}

export function isHeicLike(originalName: string, contentType?: string | null): boolean {
  const type = (contentType ?? "").toLowerCase();
  return type === "image/heic" || type === "image/heif" || ["heic", "heif"].includes(extensionOf(originalName));
}

/** 浏览器上传前按文件本身判断是视频还是图片；两样都不是就返回 null（前端提示"不支持这种文件"）。 */
export function classifyVisualFile(originalName: string, contentType?: string | null): VisualAssetType | null {
  const type = (contentType ?? "").toLowerCase();
  if (type.startsWith("video/")) return "VIDEO";
  if (isAllowedVisualImage(originalName, contentType)) return "IMAGE";
  if (["mp4", "mov", "m4v", "webm", "avi", "mkv"].includes(extensionOf(originalName))) return "VIDEO";
  return null;
}

// ---------------------------------------------------------------------------
// 前后端共用的纯函数
// ---------------------------------------------------------------------------

/**
 * 标签（规格 3.3.1）：中英文逗号分隔；去首尾空白、NFKC 归一（全角转半角）、内部连续空白压成一个；
 * 同一案例内忽略大小写和空格去重，保留先写的那个。不在这里截断数量和长度——超了由校验报错。
 */
export function parseVisualTags(input: string | readonly string[]): string[] {
  const raw = typeof input === "string" ? input.split(/[，,]/) : input;
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    const tag = String(item ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
    if (!tag) continue;
    const key = tag.toLocaleLowerCase("zh-CN").replace(/\s/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/** 来源链接只收 http(s)（规格 3.3.1）。空串视为没填，由调用方决定要不要校验。 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** 搜索用的归一化，与视频库、报告库一致。 */
export function normalizeVisualSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN");
}

/** 载体摘要（规格 3.2 第 2 条）：「视频 2 · 图片 3 · 文字」。查询期推导，不入库。 */
export function visualCarrierLabel(counts: VisualCarrierCounts): string {
  const parts: string[] = [];
  if (counts.videos) parts.push(`视频 ${counts.videos}`);
  if (counts.images) parts.push(`图片 ${counts.images}`);
  if (counts.hasBrief) parts.push("文字");
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// 接口形状（规格五）。字段名是接口的一部分，前后端都照这里写。
// ---------------------------------------------------------------------------

export type VisualAssetType = "VIDEO" | "IMAGE";
export type VisualCaseStatus = "UPLOADING" | "READY";
export type VisualUploadStatus = "UPLOADING" | "READY";
export type VisualDerivativeStatus = "PENDING" | "READY" | "FAILED";
/** 单选、文本是字符串；多选是字符串数组；空值不写键（规格 3.4 第 4 条）。 */
export type VisualMetadata = Record<string, string | string[]>;

export type VisualCarrierCounts = { videos: number; images: number; hasBrief: boolean };

/** 浏览器建条目／追加素材时报上来的一份素材。 */
export type VisualNewAssetInput = {
  type: VisualAssetType;
  originalName: string;
  contentType: string;
  fileSize: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
};

/** 建条目与编辑共用的文本字段。 */
export type VisualCaseFieldsInput = {
  subdomain: VisualSubdomain;
  title: string;
  location: string;
  tags: string[];
  textBody?: string;
  summary?: string;
  creator?: string;
  occurredAt?: string;
  sourceUrl?: string;
  rightsNote?: string;
  metadata: VisualMetadata;
};

/** POST /api/visual-cases：assets 按展示顺序排好，至少一个。 */
export type VisualCreateRequest = VisualCaseFieldsInput & { assets: VisualNewAssetInput[] };
/** 201：assetIds 与请求里 assets 的顺序一一对应。不在这里签上传链接。 */
export type VisualCreateResponse = { caseId: string; assetIds: string[] };

/** POST /api/visual-cases/[id]/assets/[assetId]/upload-url：600 秒有效；视频另带封面的 PUT。 */
export type VisualUploadUrlResponse = { uploadUrl: string; coverUploadUrl: string | null };

/** POST /api/visual-cases/[id]/complete：200 全部到位；409 时 missing 列出没到位的素材。 */
export type VisualCompleteResponse = { status: VisualCaseStatus; missing: string[] };

/** POST /api/visual-cases/[id]/assets：追加到最后，返回顺序与请求一致。 */
export type VisualAddAssetsRequest = { assets: VisualNewAssetInput[] };
export type VisualAddAssetsResponse = { assetIds: string[] };

/**
 * PATCH /api/visual-cases/[id]：改文字字段与素材顺序。updatedAt 是乐观锁（取自详情），
 * 对不上返回 409。assetOrder 必须恰好是这条案例当前全部素材 id 的一个排列（含没传完的）。
 * 素材的增删走 /assets 两个接口，不改 updated_at。
 */
export type VisualPatchRequest = VisualCaseFieldsInput & { updatedAt: string; assetOrder: string[] };

/** POST /api/visual-cases/[id]/favorite（形状同视频库、报告库，没有配额字段）。 */
export type VisualFavoriteResponse = { caseId: string; favorited: boolean; favoriteCount: number };

export type VisualCoverView = {
  assetId: string;
  type: VisualAssetType;
  derivativeStatus: VisualDerivativeStatus;
  derivativeError: string | null;
  /** 图片是 480w 派生图，视频是截帧封面；没就绪时为 null（前端显示占位，不拿原图顶）。 */
  thumbnailUrl: string | null;
  durationSeconds: number;
  fileSize: number;
};

/** GET /api/visual-cases 的一条。列表按 created_at 倒序给全量，前端筛选、排序、分周。 */
export type VisualCaseListItem = {
  id: string;
  subdomain: VisualSubdomain;
  title: string;
  summary: string;
  /** 案例简介全文：库首页的搜索要搜到它（规格 6.2）。纯文本，前端只按文本渲染。 */
  textBody: string;
  tags: string[];
  location: string;
  creator: string;
  status: VisualCaseStatus;
  createdAt: string;
  createdByName: string;
  /** READY 的案例按已传完的素材数；UPLOADING 的按计划上传的数。 */
  counts: VisualCarrierCounts;
  /** 没传完的素材数（只有 canManage 的人才会拿到非 0 值）。 */
  missingCount: number;
  /** 第一位（已传完的）素材；UPLOADING 且一个都没传完时为 null。 */
  cover: VisualCoverView | null;
  favoriteCount: number;
  viewerFavorited: boolean;
  canManage: boolean;
};

export type VisualListResponse = { cases: VisualCaseListItem[] };

export type VisualAssetView = {
  id: string;
  type: VisualAssetType;
  position: number;
  originalName: string;
  contentType: string;
  fileSize: number;
  width: number;
  height: number;
  durationSeconds: number;
  uploadStatus: VisualUploadStatus;
  derivativeStatus: VisualDerivativeStatus;
  derivativeError: string | null;
  /** 图片 480w／视频封面；没就绪为 null。 */
  thumbnailUrl: string | null;
  /** 图片 1600w；视频与没就绪时为 null。 */
  displayUrl: string | null;
  /** 视频：站内播放地址 /api/visual-cases/{id}/assets/{assetId}/stream（302 到新签的地址）；图片为 null。 */
  streamPath: string | null;
  /** 图片：查看原图 /api/visual-cases/{id}/assets/{assetId}/original（302）；视频为 null。 */
  originalPath: string | null;
};

/**
 * GET /api/visual-cases/[id]。assets 按 position 排；能编辑的人拿到全部素材（含没传完的，
 * 前端舞台只放 uploadStatus=READY 的），其他人只拿到已传完的。
 */
export type VisualCaseDetail = Omit<VisualCaseListItem, "cover"> & {
  textBody: string;
  occurredAt: string;
  sourceUrl: string;
  rightsNote: string;
  metadata: VisualMetadata;
  metadataSchemaVersion: string;
  updatedAt: string;
  assets: VisualAssetView[];
  viewerCapabilities: { canEdit: boolean; canTrash: boolean };
};

export type VisualDetailResponse = { case: VisualCaseDetail };

/** 所有接口出错时的信封：{ error: 可读中文 }，状态码 400/403/404/409。 */
export type VisualErrorResponse = { error: string };

export const visualStreamPath = (caseId: string, assetId: string) =>
  `/api/visual-cases/${encodeURIComponent(caseId)}/assets/${encodeURIComponent(assetId)}/stream`;
export const visualOriginalPath = (caseId: string, assetId: string) =>
  `/api/visual-cases/${encodeURIComponent(caseId)}/assets/${encodeURIComponent(assetId)}/original`;
export const visualDetailHref = (caseId: string) => `/visual/${encodeURIComponent(caseId)}`;
export const VISUAL_LIBRARY_HREF = "/?library=VISUAL";
