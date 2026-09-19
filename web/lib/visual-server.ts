// 公共视觉库的读写：建条目与完成上传、列表与详情、编辑与素材增删、收藏、
// 回收站。结构照抄 lib/report-server.ts（建条目/完成上传/列表/详情/软删除的
// 写法）与 lib/case-engagement-server.ts（收藏切换），但公共视觉是独立域，
// 不挂视频侧的 V0.4 契约、不参与每周投票（见规格二.3、3.7）。
//
// 派生图的生成（数据万象持久化处理 / 离线脚本）在 lib/visual-derivatives.ts；
// 这个文件只负责触发时机由路由层用 after() 决定，不在这里直接调用。

import { getVideoBucket, type DbClient, type QueryResultRow } from "@/db";
import { newId } from "@/lib/current-user";
import {
  visualOriginalPath,
  visualStreamPath,
  type VisualAssetType,
  type VisualCarrierCounts,
  type VisualCaseDetail,
  type VisualCaseFieldsInput,
  type VisualCaseListItem,
  type VisualCaseStatus,
  type VisualCompleteResponse,
  type VisualCoverView,
  type VisualDerivativeStatus,
  type VisualFavoriteResponse,
  type VisualMetadata,
  type VisualNewAssetInput,
  type VisualSubdomain,
  type VisualUploadStatus,
  type VisualUploadUrlResponse,
} from "./visual-contract";
import { parseStoredVisualMetadataForDisplay, validateVisualMetadata } from "./visual-metadata";
import {
  canManageVisualCase,
  computeVisualCarrierCounts,
  countVisualAssetsByType,
  formatVisualOversizeReason,
  isOversizedForVisualDerivative,
  isValidVisualAssetOrder,
  isVisualUpdatedAtStale,
  pickVisualCover,
  validateNewVisualAssets,
  validateVisualCaseFields,
  visualCoverObjectKey,
  visualDisplayObjectKey,
  visualOriginalObjectKey,
  visualThumbObjectKey,
  VisualServiceError,
} from "./visual-model";

const SIGNED_URL_TTL_SECONDS = 3 * 60 * 60;
const UPLOAD_URL_TTL_SECONDS = 600;
const STREAM_URL_TTL_SECONDS = 15 * 60;

export type VisualUploadActor = { email: string; displayName: string };
/** 查看/收藏用的身份：任何登录成员都够（不要求管理权）。 */
export type VisualViewer = { userId: string; identityKey: string; isAdmin: boolean };
/** 「谁能管这条案例」用的身份：原上传者或系统管理员，同 canManageVisualCase。 */
export type VisualManageActor = { identityKey: string; isAdmin: boolean };

/** tags_json 解析：同 lib/report-model.ts 的 tagsFromJson，防御式解析，坏数据不抛错。 */
export function tagsFromVisualJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 建条目（规格五 POST /api/visual-cases）
// ---------------------------------------------------------------------------

export type CreateVisualCaseInput = VisualCaseFieldsInput & {
  assets: VisualNewAssetInput[];
  actor: VisualUploadActor;
};

export type CreateVisualCaseResult = { caseId: string; assetIds: string[] };

export async function createVisualCase(db: DbClient, input: CreateVisualCaseInput): Promise<CreateVisualCaseResult> {
  const assetsValidation = validateNewVisualAssets(input.assets);
  if (!assetsValidation.ok) throw new VisualServiceError(assetsValidation.error);

  const fieldsValidation = validateVisualCaseFields(input);
  if (!fieldsValidation.ok) throw new VisualServiceError(fieldsValidation.error);
  const fields = fieldsValidation.fields;

  const metadataValidation = validateVisualMetadata(fields.subdomain, input.metadata);
  if (!metadataValidation.ok) throw new VisualServiceError(metadataValidation.error);

  const caseId = newId("visual");
  const assetIds = input.assets.map(() => newId("vasset"));

  await db.withTransaction(async (tx) => {
    await tx
      .prepare(
        `INSERT INTO visual_cases (
          id, subdomain, title, summary, text_body, tags_json, location, creator, occurred_at,
          source_url, rights_note, metadata_json, status, created_by_email, created_by_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPLOADING', ?, ?)`,
      )
      .bind(
        caseId,
        fields.subdomain,
        fields.title,
        fields.summary,
        fields.textBody,
        JSON.stringify(fields.tags),
        fields.location,
        fields.creator,
        fields.occurredAt,
        fields.sourceUrl,
        fields.rightsNote,
        JSON.stringify(metadataValidation.metadata),
        input.actor.email,
        input.actor.displayName,
      )
      .run();

    for (let index = 0; index < input.assets.length; index += 1) {
      await insertVisualAsset(tx, caseId, assetIds[index], input.assets[index], index);
    }
  });

  return { caseId, assetIds };
}

async function insertVisualAsset(
  db: DbClient,
  caseId: string,
  assetId: string,
  asset: VisualNewAssetInput,
  position: number,
): Promise<void> {
  const objectKey = visualOriginalObjectKey(caseId, assetId, asset.originalName);
  await db
    .prepare(
      `INSERT INTO visual_case_assets (
        id, case_id, type, position, object_key, original_name, content_type, file_size,
        width, height, duration_seconds, upload_status, derivative_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPLOADING', 'PENDING')`,
    )
    .bind(
      assetId,
      caseId,
      asset.type,
      position,
      objectKey,
      (asset.originalName ?? "").trim(),
      (asset.contentType ?? "").trim() || "application/octet-stream",
      Math.max(0, Number(asset.fileSize) || 0),
      Math.max(0, Number(asset.width) || 0),
      Math.max(0, Number(asset.height) || 0),
      Math.max(0, Number(asset.durationSeconds) || 0),
    )
    .run();
}

// ---------------------------------------------------------------------------
// 签上传链接（规格五 POST .../upload-url）
// ---------------------------------------------------------------------------

type SignAssetRow = QueryResultRow & {
  id: string;
  case_id: string;
  type: string;
  object_key: string;
  content_type: string;
  upload_status: string;
  created_by_email: string;
};

export async function signVisualAssetUpload(
  db: DbClient,
  input: { caseId: string; assetId: string; actor: VisualManageActor },
): Promise<VisualUploadUrlResponse> {
  const row = await db
    .prepare(
      `SELECT a.id, a.case_id, a.type, a.object_key, a.content_type, a.upload_status, c.created_by_email
       FROM visual_case_assets a
       JOIN visual_cases c ON c.id = a.case_id
       WHERE a.id = ? AND a.case_id = ? AND c.deleted_at IS NULL`,
    )
    .bind(input.assetId, input.caseId)
    .first<SignAssetRow>();
  if (!row) throw new VisualServiceError("素材不存在或案例已删除。", 404);
  if (!canManageVisualCase({ createdByEmail: row.created_by_email }, input.actor)) {
    throw new VisualServiceError("只有原上传者或管理员可以上传素材。", 403);
  }
  if (row.upload_status !== "UPLOADING") {
    throw new VisualServiceError("这份素材已经上传完成，无需再次签名。", 409);
  }

  const bucket = getVideoBucket();
  const uploadUrl = await bucket.createPresignedPutUrl(row.object_key, {
    contentType: row.content_type || "application/octet-stream",
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  });

  let coverUploadUrl: string | null = null;
  if (row.type === "VIDEO") {
    coverUploadUrl = await bucket.createPresignedPutUrl(visualCoverObjectKey(row.case_id, row.id), {
      contentType: "image/jpeg",
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });
  }

  return { uploadUrl, coverUploadUrl };
}

// ---------------------------------------------------------------------------
// 完成上传（规格五 POST .../complete）
// ---------------------------------------------------------------------------

/** complete 遇到缺失素材时，错误信封里除了 {error} 还要带 status 与 missing（规格五）。 */
export class VisualCompleteIncompleteError extends VisualServiceError {
  readonly missing: string[];

  constructor(missing: string[]) {
    super("还有素材没有上传完成，请重传或去掉缺的素材。", 409);
    this.name = "VisualCompleteIncompleteError";
    this.missing = missing;
  }
}

type CompleteCaseRow = QueryResultRow & { id: string; status: string; created_by_email: string };
type CompleteAssetRow = QueryResultRow & {
  id: string;
  type: string;
  object_key: string;
  file_size: number;
  upload_status: string;
};

export async function completeVisualCase(
  db: DbClient,
  input: { caseId: string; actor: VisualManageActor },
): Promise<VisualCompleteResponse> {
  const caseRow = await db
    .prepare(`SELECT id, status, created_by_email FROM visual_cases WHERE id = ? AND deleted_at IS NULL`)
    .bind(input.caseId)
    .first<CompleteCaseRow>();
  if (!caseRow) throw new VisualServiceError("案例不存在或已删除。", 404);
  if (!canManageVisualCase({ createdByEmail: caseRow.created_by_email }, input.actor)) {
    throw new VisualServiceError("只有原上传者或管理员可以完成上传。", 403);
  }

  const assetsResult = await db
    .prepare(
      `SELECT id, type, object_key, file_size, upload_status FROM visual_case_assets
       WHERE case_id = ? ORDER BY position ASC`,
    )
    .bind(input.caseId)
    .all<CompleteAssetRow>();

  const bucket = getVideoBucket();
  const missing: string[] = [];

  for (const asset of assetsResult.results) {
    if (asset.upload_status === "READY") continue;

    const object = await bucket.head(asset.object_key);
    const registeredSize = Number(asset.file_size) || 0;
    if (!object || object.size <= 0 || (registeredSize > 0 && object.size !== registeredSize)) {
      missing.push(asset.id);
      continue;
    }

    if (asset.type === "VIDEO") {
      const coverKey = visualCoverObjectKey(input.caseId, asset.id);
      const cover = await bucket.head(coverKey);
      if (cover && cover.size > 0) {
        await db
          .prepare(
            `UPDATE visual_case_assets
             SET upload_status = 'READY', file_size = ?, thumbnail_key = ?,
                 derivative_status = 'READY', derivative_error = NULL
             WHERE id = ?`,
          )
          .bind(object.size, coverKey, asset.id)
          .run();
      } else {
        await db
          .prepare(
            `UPDATE visual_case_assets
             SET upload_status = 'READY', file_size = ?, derivative_status = 'FAILED', derivative_error = ?
             WHERE id = ?`,
          )
          .bind(object.size, "浏览器没能截到这段视频的封面", asset.id)
          .run();
      }
      continue;
    }

    // IMAGE
    if (isOversizedForVisualDerivative(object.size)) {
      await db
        .prepare(
          `UPDATE visual_case_assets
           SET upload_status = 'READY', file_size = ?, derivative_status = 'FAILED', derivative_error = ?
           WHERE id = ?`,
        )
        .bind(object.size, formatVisualOversizeReason(object.size), asset.id)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE visual_case_assets SET upload_status = 'READY', file_size = ?, derivative_status = 'PENDING'
           WHERE id = ?`,
        )
        .bind(object.size, asset.id)
        .run();
    }
  }

  if (missing.length > 0) {
    throw new VisualCompleteIncompleteError(missing);
  }

  await db
    .prepare(`UPDATE visual_cases SET status = 'READY', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'UPLOADING'`)
    .bind(input.caseId)
    .run();

  return { status: "READY", missing: [] };
}

// ---------------------------------------------------------------------------
// 列表（规格五 GET /api/visual-cases）
// ---------------------------------------------------------------------------

type CaseListRow = QueryResultRow & {
  id: string;
  subdomain: string;
  title: string;
  summary: string;
  text_body: string;
  tags_json: string;
  location: string;
  creator: string;
  status: string;
  created_at: string;
  created_by_email: string;
  created_by_name: string;
};

type AssetSummaryRow = QueryResultRow & {
  id: string;
  case_id: string;
  type: string;
  position: number;
  upload_status: string;
  derivative_status: string;
  derivative_error: string | null;
  thumbnail_key: string | null;
  duration_seconds: number;
  file_size: number;
};

export async function listVisualCases(db: DbClient, viewer: VisualViewer): Promise<VisualCaseListItem[]> {
  const casesResult = await db
    .prepare(
      `SELECT id, subdomain, title, summary, text_body, tags_json, location, creator, status,
              created_at, created_by_email, created_by_name
       FROM visual_cases WHERE deleted_at IS NULL ORDER BY created_at DESC`,
    )
    .all<CaseListRow>();
  const cases = casesResult.results;
  if (cases.length === 0) return [];

  const ids = cases.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(", ");

  const [assetsResult, favoriteCountResult, viewerFavoriteResult] = await Promise.all([
    db
      .prepare(
        `SELECT id, case_id, type, position, upload_status, derivative_status, derivative_error,
                thumbnail_key, duration_seconds, file_size
         FROM visual_case_assets WHERE case_id IN (${placeholders}) ORDER BY case_id, position ASC`,
      )
      .bind(...ids)
      .all<AssetSummaryRow>(),
    db
      .prepare(
        `SELECT case_id, COUNT(*)::integer AS favorite_count FROM visual_case_favorites
         WHERE case_id IN (${placeholders}) GROUP BY case_id`,
      )
      .bind(...ids)
      .all<QueryResultRow & { case_id: string; favorite_count: number }>(),
    db
      .prepare(`SELECT case_id FROM visual_case_favorites WHERE user_id = ? AND case_id IN (${placeholders})`)
      .bind(viewer.userId, ...ids)
      .all<QueryResultRow & { case_id: string }>(),
  ]);

  const assetsByCase = new Map<string, AssetSummaryRow[]>();
  for (const row of assetsResult.results) {
    const list = assetsByCase.get(row.case_id);
    if (list) list.push(row);
    else assetsByCase.set(row.case_id, [row]);
  }
  const favoriteCountByCase = new Map(favoriteCountResult.results.map((row) => [row.case_id, Number(row.favorite_count)]));
  const viewerFavoriteSet = new Set(viewerFavoriteResult.results.map((row) => row.case_id));

  const bucket = getVideoBucket();

  return Promise.all(
    cases.map(async (row): Promise<VisualCaseListItem> => {
      const assets = assetsByCase.get(row.id) ?? [];
      const canManage = canManageVisualCase({ createdByEmail: row.created_by_email }, viewer);
      const status = row.status as VisualCaseStatus;
      const counts = computeVisualCarrierCounts(
        assets.map((asset) => ({ type: asset.type as VisualAssetType, uploadStatus: asset.upload_status as VisualUploadStatus })),
        status,
        Boolean(row.text_body?.trim()),
      );
      const missingCount = canManage ? assets.filter((asset) => asset.upload_status !== "READY").length : 0;

      const coverAsset = pickVisualCover(
        assets.map((asset) => ({ ...asset, position: Number(asset.position), uploadStatus: asset.upload_status })),
      );
      const cover = coverAsset ? await buildVisualCoverView(bucket, coverAsset) : null;

      return {
        id: row.id,
        subdomain: row.subdomain as VisualSubdomain,
        title: row.title,
        summary: row.summary,
        textBody: row.text_body ?? "",
        tags: tagsFromVisualJson(row.tags_json),
        location: row.location,
        creator: row.creator,
        status,
        createdAt: row.created_at,
        createdByName: row.created_by_name,
        counts,
        missingCount,
        cover,
        favoriteCount: favoriteCountByCase.get(row.id) ?? 0,
        viewerFavorited: viewerFavoriteSet.has(row.id),
        canManage,
      };
    }),
  );
}

async function buildVisualCoverView(
  bucket: ReturnType<typeof getVideoBucket>,
  asset: AssetSummaryRow,
): Promise<VisualCoverView> {
  const thumbnailUrl = asset.thumbnail_key
    ? await bucket.createPresignedGetUrl(asset.thumbnail_key, { expiresInSeconds: SIGNED_URL_TTL_SECONDS })
    : null;
  return {
    assetId: asset.id,
    type: asset.type as VisualAssetType,
    derivativeStatus: asset.derivative_status as VisualDerivativeStatus,
    derivativeError: asset.derivative_error,
    thumbnailUrl,
    durationSeconds: Number(asset.duration_seconds),
    fileSize: Number(asset.file_size),
  };
}

// ---------------------------------------------------------------------------
// 详情（规格五 GET /api/visual-cases/[id]）
// ---------------------------------------------------------------------------

type CaseDetailRow = QueryResultRow & {
  id: string;
  subdomain: string;
  title: string;
  summary: string;
  text_body: string;
  tags_json: string;
  location: string;
  creator: string;
  occurred_at: string;
  source_url: string;
  rights_note: string;
  metadata_json: string;
  metadata_schema_version: string;
  status: string;
  created_by_email: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
};

type AssetDetailRow = QueryResultRow & {
  id: string;
  type: string;
  position: number;
  object_key: string;
  thumbnail_key: string | null;
  display_key: string | null;
  original_name: string;
  content_type: string;
  file_size: number;
  width: number;
  height: number;
  duration_seconds: number;
  upload_status: string;
  derivative_status: string;
  derivative_error: string | null;
};

export async function loadVisualCaseDetail(
  db: DbClient,
  caseId: string,
  viewer: VisualViewer,
): Promise<VisualCaseDetail | null> {
  const row = await db
    .prepare(
      `SELECT id, subdomain, title, summary, text_body, tags_json, location, creator, occurred_at,
              source_url, rights_note, metadata_json, metadata_schema_version, status,
              created_by_email, created_by_name, created_at, updated_at
       FROM visual_cases WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(caseId)
    .first<CaseDetailRow>();
  if (!row) return null;

  const canManage = canManageVisualCase({ createdByEmail: row.created_by_email }, viewer);
  // UPLOADING 的案例只有能管理的人能看，其他人当 404（规格 3.6、4.2「状态」）。
  if (row.status === "UPLOADING" && !canManage) return null;

  const assetsResult = await db
    .prepare(
      `SELECT id, type, position, object_key, thumbnail_key, display_key, original_name, content_type,
              file_size, width, height, duration_seconds, upload_status, derivative_status, derivative_error
       FROM visual_case_assets WHERE case_id = ? ORDER BY position ASC`,
    )
    .bind(caseId)
    .all<AssetDetailRow>();
  const allAssets = assetsResult.results;
  // 能编辑的人拿全部素材（含没传完的）；其他人只拿已传完的。
  const visibleAssets = canManage ? allAssets : allAssets.filter((asset) => asset.upload_status === "READY");

  const [favoriteCountRow, viewerFavoriteRow] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*)::integer AS favorite_count FROM visual_case_favorites WHERE case_id = ?`)
      .bind(caseId)
      .first<QueryResultRow & { favorite_count: number }>(),
    db
      .prepare(`SELECT 1 AS present FROM visual_case_favorites WHERE case_id = ? AND user_id = ?`)
      .bind(caseId, viewer.userId)
      .first<QueryResultRow & { present: number }>(),
  ]);

  const bucket = getVideoBucket();
  const assetViews = await Promise.all(
    visibleAssets.map(async (asset) => {
      const type = asset.type as VisualAssetType;
      const [thumbnailUrl, displayUrl] = await Promise.all([
        asset.thumbnail_key
          ? bucket.createPresignedGetUrl(asset.thumbnail_key, { expiresInSeconds: SIGNED_URL_TTL_SECONDS })
          : Promise.resolve(null),
        asset.display_key
          ? bucket.createPresignedGetUrl(asset.display_key, { expiresInSeconds: SIGNED_URL_TTL_SECONDS })
          : Promise.resolve(null),
      ]);
      return {
        id: asset.id,
        type,
        position: Number(asset.position),
        originalName: asset.original_name,
        contentType: asset.content_type,
        fileSize: Number(asset.file_size),
        width: Number(asset.width),
        height: Number(asset.height),
        durationSeconds: Number(asset.duration_seconds),
        uploadStatus: asset.upload_status as VisualUploadStatus,
        derivativeStatus: asset.derivative_status as VisualDerivativeStatus,
        derivativeError: asset.derivative_error,
        thumbnailUrl,
        displayUrl,
        streamPath: type === "VIDEO" ? visualStreamPath(caseId, asset.id) : null,
        originalPath: type === "IMAGE" ? visualOriginalPath(caseId, asset.id) : null,
      };
    }),
  );

  const status = row.status as VisualCaseStatus;
  const subdomain = row.subdomain as VisualSubdomain;
  const hasBrief = Boolean(row.text_body?.trim());
  const counts: VisualCarrierCounts = computeVisualCarrierCounts(
    allAssets.map((asset) => ({ type: asset.type as VisualAssetType, uploadStatus: asset.upload_status as VisualUploadStatus })),
    status,
    hasBrief,
  );
  const missingCount = canManage ? allAssets.filter((asset) => asset.upload_status !== "READY").length : 0;
  const metadata: VisualMetadata = parseStoredVisualMetadataForDisplay(subdomain, row.metadata_json);

  return {
    id: row.id,
    subdomain,
    title: row.title,
    summary: row.summary,
    tags: tagsFromVisualJson(row.tags_json),
    location: row.location,
    creator: row.creator,
    status,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
    counts,
    missingCount,
    favoriteCount: Number(favoriteCountRow?.favorite_count ?? 0),
    viewerFavorited: Boolean(viewerFavoriteRow),
    canManage,
    textBody: row.text_body,
    occurredAt: row.occurred_at,
    sourceUrl: row.source_url,
    rightsNote: row.rights_note,
    metadata,
    metadataSchemaVersion: row.metadata_schema_version,
    updatedAt: row.updated_at,
    assets: assetViews,
    viewerCapabilities: { canEdit: canManage, canTrash: canManage },
  };
}

// ---------------------------------------------------------------------------
// 编辑（规格五 PATCH /api/visual-cases/[id]）
// ---------------------------------------------------------------------------

export type PatchVisualCaseInput = VisualCaseFieldsInput & {
  caseId: string;
  updatedAt: string;
  assetOrder: string[];
  viewer: VisualViewer;
};

export async function patchVisualCase(db: DbClient, input: PatchVisualCaseInput): Promise<VisualCaseDetail> {
  const row = await db
    .prepare(`SELECT id, created_by_email, updated_at FROM visual_cases WHERE id = ? AND deleted_at IS NULL`)
    .bind(input.caseId)
    .first<QueryResultRow & { id: string; created_by_email: string; updated_at: string }>();
  if (!row) throw new VisualServiceError("案例不存在或已删除。", 404);
  if (!canManageVisualCase({ createdByEmail: row.created_by_email }, input.viewer)) {
    throw new VisualServiceError("只有原上传者或管理员可以编辑这条案例。", 403);
  }
  if (isVisualUpdatedAtStale(row.updated_at, input.updatedAt)) {
    throw new VisualServiceError("这条案例刚被别人改过，请关掉重新打开再改。", 409);
  }

  const fieldsValidation = validateVisualCaseFields(input);
  if (!fieldsValidation.ok) throw new VisualServiceError(fieldsValidation.error);
  const fields = fieldsValidation.fields;

  const metadataValidation = validateVisualMetadata(fields.subdomain, input.metadata);
  if (!metadataValidation.ok) throw new VisualServiceError(metadataValidation.error);

  const currentAssetsResult = await db
    .prepare(`SELECT id FROM visual_case_assets WHERE case_id = ?`)
    .bind(input.caseId)
    .all<QueryResultRow & { id: string }>();
  const currentIds = currentAssetsResult.results.map((asset) => asset.id);
  if (!isValidVisualAssetOrder(currentIds, input.assetOrder)) {
    throw new VisualServiceError("素材顺序不对，请刷新后重试。");
  }

  await db.withTransaction(async (tx) => {
    await tx
      .prepare(
        `UPDATE visual_cases SET
          subdomain = ?, title = ?, summary = ?, text_body = ?, tags_json = ?, location = ?,
          creator = ?, occurred_at = ?, source_url = ?, rights_note = ?, metadata_json = ?,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .bind(
        fields.subdomain,
        fields.title,
        fields.summary,
        fields.textBody,
        JSON.stringify(fields.tags),
        fields.location,
        fields.creator,
        fields.occurredAt,
        fields.sourceUrl,
        fields.rightsNote,
        JSON.stringify(metadataValidation.metadata),
        input.caseId,
      )
      .run();

    for (let index = 0; index < input.assetOrder.length; index += 1) {
      await tx
        .prepare(`UPDATE visual_case_assets SET position = ? WHERE id = ? AND case_id = ?`)
        .bind(index, input.assetOrder[index], input.caseId)
        .run();
    }
  });

  const detail = await loadVisualCaseDetail(db, input.caseId, input.viewer);
  if (!detail) throw new VisualServiceError("案例不存在或已删除。", 404);
  return detail;
}

// ---------------------------------------------------------------------------
// 追加素材／移除素材（规格五 POST/DELETE .../assets）
// ---------------------------------------------------------------------------

export type AddVisualAssetsInput = { caseId: string; assets: VisualNewAssetInput[]; actor: VisualManageActor };

export async function addVisualAssets(db: DbClient, input: AddVisualAssetsInput): Promise<{ assetIds: string[] }> {
  const caseRow = await db
    .prepare(`SELECT id, created_by_email FROM visual_cases WHERE id = ? AND deleted_at IS NULL`)
    .bind(input.caseId)
    .first<QueryResultRow & { id: string; created_by_email: string }>();
  if (!caseRow) throw new VisualServiceError("案例不存在或已删除。", 404);
  if (!canManageVisualCase({ createdByEmail: caseRow.created_by_email }, input.actor)) {
    throw new VisualServiceError("只有原上传者或管理员可以增加素材。", 403);
  }

  const existingResult = await db
    .prepare(`SELECT type, position FROM visual_case_assets WHERE case_id = ?`)
    .bind(input.caseId)
    .all<QueryResultRow & { type: string; position: number }>();
  const existingRows = existingResult.results;
  const existingCounts = countVisualAssetsByType(existingRows);

  const assetsValidation = validateNewVisualAssets(input.assets, existingCounts);
  if (!assetsValidation.ok) throw new VisualServiceError(assetsValidation.error);

  const startPosition = existingRows.length
    ? Math.max(...existingRows.map((row) => Number(row.position))) + 1
    : 0;
  const assetIds = input.assets.map(() => newId("vasset"));

  await db.withTransaction(async (tx) => {
    for (let index = 0; index < input.assets.length; index += 1) {
      await insertVisualAsset(tx, input.caseId, assetIds[index], input.assets[index], startPosition + index);
    }
  });

  return { assetIds };
}

export type RemoveVisualAssetInput = { caseId: string; assetId: string; actor: VisualManageActor };

export async function removeVisualAsset(db: DbClient, input: RemoveVisualAssetInput): Promise<{ ok: true }> {
  const caseRow = await db
    .prepare(`SELECT id, created_by_email FROM visual_cases WHERE id = ? AND deleted_at IS NULL`)
    .bind(input.caseId)
    .first<QueryResultRow & { id: string; created_by_email: string }>();
  if (!caseRow) throw new VisualServiceError("案例不存在或已删除。", 404);
  if (!canManageVisualCase({ createdByEmail: caseRow.created_by_email }, input.actor)) {
    throw new VisualServiceError("只有原上传者或管理员可以移除素材。", 403);
  }

  const assetsResult = await db
    .prepare(`SELECT id, object_key FROM visual_case_assets WHERE case_id = ? ORDER BY position ASC`)
    .bind(input.caseId)
    .all<QueryResultRow & { id: string; object_key: string }>();
  const assets = assetsResult.results;
  const target = assets.find((asset) => asset.id === input.assetId);
  if (!target) throw new VisualServiceError("素材不存在或已移除。", 404);
  if (assets.length <= 1) {
    throw new VisualServiceError("至少要保留一段视频或一张图片。");
  }

  const remaining = assets.filter((asset) => asset.id !== input.assetId);
  await db.withTransaction(async (tx) => {
    await tx.prepare(`DELETE FROM visual_case_assets WHERE id = ? AND case_id = ?`).bind(input.assetId, input.caseId).run();
    for (let index = 0; index < remaining.length; index += 1) {
      await tx
        .prepare(`UPDATE visual_case_assets SET position = ? WHERE id = ? AND case_id = ?`)
        .bind(index, remaining[index].id, input.caseId)
        .run();
    }
  });

  // 忽略不存在：无论素材当时传到哪一步，这四个键位有几个算几个，delete 对不存在的
  // 对象本身就是幂等操作（COS 对不存在的键返回成功，本地桶内部吞掉 ENOENT）。
  const bucket = getVideoBucket();
  const keys = [
    target.object_key,
    visualCoverObjectKey(input.caseId, target.id),
    visualThumbObjectKey(input.caseId, target.id),
    visualDisplayObjectKey(input.caseId, target.id),
  ];
  await Promise.all(keys.map((key) => bucket.delete(key).catch(() => undefined)));

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 收藏（规格 3.7、五 POST .../favorite）：不限数量的纯收藏，没有配额分支。
// ---------------------------------------------------------------------------

export async function toggleVisualFavorite(
  db: DbClient,
  input: { caseId: string; userId: string },
): Promise<VisualFavoriteResponse> {
  const caseRow = await db
    .prepare(`SELECT id, status FROM visual_cases WHERE id = ? AND deleted_at IS NULL`)
    .bind(input.caseId)
    .first<QueryResultRow & { id: string; status: string }>();
  if (!caseRow) throw new VisualServiceError("案例不存在或已删除。", 404);
  if (caseRow.status !== "READY") {
    throw new VisualServiceError("这条案例还没有上传完成，暂时不能收藏。", 409);
  }

  return db.withTransaction(async (tx) => {
    const existing = await tx
      .prepare(`SELECT 1 AS present FROM visual_case_favorites WHERE case_id = ? AND user_id = ?`)
      .bind(input.caseId, input.userId)
      .first<QueryResultRow & { present: number }>();

    let favorited: boolean;
    if (existing) {
      await tx
        .prepare(`DELETE FROM visual_case_favorites WHERE case_id = ? AND user_id = ?`)
        .bind(input.caseId, input.userId)
        .run();
      favorited = false;
    } else {
      await tx
        .prepare(`INSERT INTO visual_case_favorites (case_id, user_id) VALUES (?, ?)`)
        .bind(input.caseId, input.userId)
        .run();
      favorited = true;
    }

    const countRow = await tx
      .prepare(`SELECT COUNT(*)::integer AS favorite_count FROM visual_case_favorites WHERE case_id = ?`)
      .bind(input.caseId)
      .first<QueryResultRow & { favorite_count: number }>();

    return { caseId: input.caseId, favorited, favoriteCount: Number(countRow?.favorite_count ?? 0) };
  });
}

// ---------------------------------------------------------------------------
// 回收站（规格 3.6、五）：与 trashReport/restoreReport 完全同构。
// ---------------------------------------------------------------------------

type ManageRow = QueryResultRow & { id: string; created_by_email: string };

export async function trashVisualCase(db: DbClient, input: { caseId: string; actor: VisualManageActor }): Promise<{ ok: true }> {
  const row = await db
    .prepare(`SELECT id, created_by_email FROM visual_cases WHERE id = ? AND deleted_at IS NULL`)
    .bind(input.caseId)
    .first<ManageRow>();
  if (!row) throw new VisualServiceError("案例不存在或已在回收站中。", 404);
  if (!canManageVisualCase({ createdByEmail: row.created_by_email }, input.actor)) {
    throw new VisualServiceError("只有原上传者或管理员可以删除案例。", 403);
  }
  const result = await db
    .prepare(`UPDATE visual_cases SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL`)
    .bind(row.id)
    .run();
  if (result.meta.rows_written !== 1) {
    throw new VisualServiceError("案例已被删除。", 409);
  }
  return { ok: true };
}

export async function restoreVisualCase(db: DbClient, input: { caseId: string; actor: VisualManageActor }): Promise<{ ok: true }> {
  const row = await db
    .prepare(`SELECT id, created_by_email FROM visual_cases WHERE id = ?`)
    .bind(input.caseId)
    .first<ManageRow>();
  if (!row) throw new VisualServiceError("案例不存在。", 404);
  if (!canManageVisualCase({ createdByEmail: row.created_by_email }, input.actor)) {
    throw new VisualServiceError("只有原上传者或管理员可以恢复案例。", 403);
  }
  const result = await db
    .prepare(`UPDATE visual_cases SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NOT NULL`)
    .bind(row.id)
    .run();
  if (result.meta.rows_written !== 1) {
    throw new VisualServiceError("案例未在回收站中，无需恢复。", 409);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 视频站内播放／图片查看原图（规格五 GET .../stream、GET .../original）：
// 只对能看这条案例的人放行，302 到新签的地址。
// ---------------------------------------------------------------------------

type VisibleAssetRow = QueryResultRow & { id: string; type: string; object_key: string; upload_status: string };

async function loadVisibleVisualAsset(
  db: DbClient,
  input: { caseId: string; assetId: string; viewer: VisualViewer },
  expectedType: VisualAssetType,
): Promise<VisibleAssetRow> {
  const caseRow = await db
    .prepare(`SELECT id, status, created_by_email FROM visual_cases WHERE id = ? AND deleted_at IS NULL`)
    .bind(input.caseId)
    .first<QueryResultRow & { id: string; status: string; created_by_email: string }>();
  if (!caseRow) throw new VisualServiceError("案例不存在或已删除。", 404);
  const canManage = canManageVisualCase({ createdByEmail: caseRow.created_by_email }, input.viewer);
  if (caseRow.status === "UPLOADING" && !canManage) throw new VisualServiceError("案例不存在或已删除。", 404);

  const assetRow = await db
    .prepare(`SELECT id, type, object_key, upload_status FROM visual_case_assets WHERE id = ? AND case_id = ?`)
    .bind(input.assetId, input.caseId)
    .first<VisibleAssetRow>();
  if (!assetRow) throw new VisualServiceError("素材不存在。", 404);
  if (!canManage && assetRow.upload_status !== "READY") throw new VisualServiceError("素材不存在。", 404);
  if (assetRow.type !== expectedType) throw new VisualServiceError("素材类型不对。", 404);
  return assetRow;
}

export async function resolveVisualAssetStreamUrl(
  db: DbClient,
  input: { caseId: string; assetId: string; viewer: VisualViewer },
): Promise<string> {
  const asset = await loadVisibleVisualAsset(db, input, "VIDEO");
  return getVideoBucket().createPresignedGetUrl(asset.object_key, { expiresInSeconds: STREAM_URL_TTL_SECONDS });
}

export async function resolveVisualAssetOriginalUrl(
  db: DbClient,
  input: { caseId: string; assetId: string; viewer: VisualViewer },
): Promise<string> {
  const asset = await loadVisibleVisualAsset(db, input, "IMAGE");
  return getVideoBucket().createPresignedGetUrl(asset.object_key, { expiresInSeconds: SIGNED_URL_TTL_SECONDS });
}
