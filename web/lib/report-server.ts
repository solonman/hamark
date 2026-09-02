// 报告库的读写：建条目与完成上传、列表与详情、重试与软删除、相关资料的增删。
// 结构照抄 app/api/videos/route.ts / [id]/complete / [id]/trash 的做法，
// 但报告是独立域，不挂视频侧的 V0.4 契约（见实施规格 3.1）。

import { getVideoBucket, type DbClient, type QueryResultRow } from "@/db";
import { newId } from "@/lib/current-user";
import {
  getConverterMode,
  pollAllProcessingReports,
  pollReportIfProcessing,
  submitReportToCi,
} from "@/lib/report-converter";
import {
  canManageReport,
  canRetryReportStatus,
  isValidTaskType,
  normalizeReportTags,
  ReportServiceError,
  REPORT_MAX_UPLOAD_BYTES,
  tagsFromJson,
  validateReportUpload,
  type ReportDetail,
  type ReportFileView,
  type ReportListItem,
  type ReportPageView,
  type ReportStatus,
} from "@/lib/report-model";

const SIGNED_URL_TTL_SECONDS = 3 * 60 * 60;

export type ReportUploadActor = { email: string; displayName: string };

export type CreateReportUploadInput = {
  title: string;
  originalName: string;
  contentType?: string | null;
  fileSize: number;
  taskType: string;
  tags?: string[];
  actor: ReportUploadActor;
};

export type CreateReportUploadResult = {
  reportId: string;
  uploadUrl: string;
};

export async function createReportUpload(
  db: DbClient,
  input: CreateReportUploadInput,
): Promise<CreateReportUploadResult> {
  const title = input.title?.trim();
  if (!title) throw new ReportServiceError("请填写报告标题。");
  if (!isValidTaskType(input.taskType)) {
    throw new ReportServiceError("请选择任务类型。");
  }
  const validation = validateReportUpload({
    originalName: input.originalName,
    contentType: input.contentType,
    fileSize: input.fileSize,
  });
  if (!validation.ok) throw new ReportServiceError(validation.error);

  const id = newId("report");
  const objectKey = `reports/${id}/original`;
  const contentType = input.contentType?.trim() || "application/octet-stream";
  const tags = normalizeReportTags(input.tags);
  const bucket = getVideoBucket();
  const uploadUrl = await bucket.createPresignedPutUrl(objectKey, { contentType });

  await db
    .prepare(
      `INSERT INTO reports (
        id, title, task_type, tags_json, object_key, original_name, content_type,
        file_size, source_format, status, created_by_email, created_by_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPLOADING', ?, ?)`,
    )
    .bind(
      id,
      title,
      input.taskType,
      JSON.stringify(tags),
      objectKey,
      input.originalName.trim(),
      contentType,
      Math.max(0, Number(input.fileSize) || 0),
      validation.sourceFormat,
      input.actor.email,
      input.actor.displayName,
    )
    .run();

  return { reportId: id, uploadUrl };
}

type UploadRow = QueryResultRow & {
  id: string;
  object_key: string;
  file_size: number;
  status: string;
  created_by_email: string;
  source_format: string;
};

export async function completeReportUpload(
  db: DbClient,
  input: { reportId: string; actorEmail: string },
): Promise<{ ok: true; reportId: string }> {
  const report = await db
    .prepare(
      `SELECT id, object_key, file_size, status, created_by_email, source_format
      FROM reports WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(input.reportId)
    .first<UploadRow>();
  if (!report) throw new ReportServiceError("上传会话不存在。", 404);
  if (report.created_by_email !== input.actorEmail) {
    throw new ReportServiceError("只有原上传者可以完成报告上传。", 403);
  }
  if (report.status !== "UPLOADING") {
    // 已经完成过（或流水线已经领走），当作成功处理，允许重复点击。
    return { ok: true, reportId: report.id };
  }

  const bucket = getVideoBucket();
  const object = await bucket.head(report.object_key);
  if (!object || object.size <= 0) {
    throw new ReportServiceError("未检测到已上传的报告文件，请重试。", 409);
  }
  if (report.file_size > 0 && object.size !== report.file_size) {
    throw new ReportServiceError("上传文件大小与原始文件不一致，请重新上传。", 409);
  }

  const didTransition = await db.withTransaction(async (transaction) => {
    const updateResult = await transaction
      .prepare(
        `UPDATE reports
        SET status = 'QUEUED', file_size = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'UPLOADING'`,
      )
      .bind(object.size, report.id)
      .run();
    if (updateResult.meta.rows_written !== 1) return false;

    await transaction
      .prepare(
        `INSERT INTO audit_logs (
          id, actor_email, action, object_type, object_id, detail_json
        ) VALUES (?, ?, 'REPORT_UPLOAD_COMPLETED', 'REPORT', ?, ?)`,
      )
      .bind(
        newId("audit"),
        input.actorEmail,
        report.id,
        JSON.stringify({ fileSize: object.size, etag: object.httpEtag ?? null }),
      )
      .run();
    return true;
  });

  // 只有真的从 UPLOADING 转成 QUEUED 时才需要往下推；重复点击（didTransition===false）
  // 不该重复提交数据万象任务。ci 后端直接接手排队，跳过等离线脚本来领的那一步；
  // script 后端保持现状，留在 QUEUED 等 scripts/convert-report-pages.ts。
  if (didTransition && getConverterMode() === "ci") {
    await submitReportToCi(db, {
      id: report.id,
      objectKey: report.object_key,
      sourceFormat: report.source_format,
    });
  }

  return { ok: true, reportId: report.id };
}

type ReportListRow = QueryResultRow & {
  id: string;
  title: string;
  task_type: string;
  tags_json: string;
  original_name: string;
  content_type: string;
  file_size: number;
  source_format: string;
  status: string;
  page_count: number;
  pages_done: number;
  fail_reason: string | null;
  created_by_email: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
};

/** 报告库首页要知道「这份我能不能管」（重试／改传 PDF／删除），口径与 canManageReport 一致。 */
export type ReportListItemView = ReportListItem & { canManage: boolean };

type VersionSummaryRow = QueryResultRow & {
  report_id: string;
  version_count: number;
  latest_owner_name: string | null;
  latest_updated_at: string | null;
};

type CoverRow = QueryResultRow & { report_id: string; thumb_key: string };

export async function listReports(
  db: DbClient,
  viewer: { identityKey: string; isAdmin: boolean },
): Promise<ReportListItemView[]> {
  // 兜底轮询：CI 回调可能丢，PROCESSING 且距上次检查超过节流窗口的报告顺手查一次
  // 数据万象任务状态并落库，这样列表在没等到回调时也能自己追上真实进度。
  // pollAllProcessingReports 自己吞异常，不会因为数据万象抖动拖垮这个纯读接口。
  await pollAllProcessingReports(db);

  const [reports, versionSummaries, covers] = await Promise.all([
    db
      .prepare(
        `SELECT id, title, task_type, tags_json, original_name, content_type, file_size,
          source_format, status, page_count, pages_done, fail_reason,
          created_by_email, created_by_name, created_at, updated_at
        FROM reports
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC`,
      )
      .all<ReportListRow>(),
    db
      .prepare(
        `SELECT report_id, COUNT(*)::integer AS version_count,
          (array_agg(owner_name_snapshot ORDER BY updated_at DESC))[1] AS latest_owner_name,
          MAX(updated_at) AS latest_updated_at
        FROM report_versions
        GROUP BY report_id`,
      )
      .all<VersionSummaryRow>(),
    // 封面取每份报告里页码最小的「渲染成功」页；若第 1 页恰好渲染失败，改用后面
    // 最靠前的一张，不直接空着。未就绪的报告没有页图，交给下面按状态过滤。
    db
      .prepare(
        `SELECT DISTINCT ON (report_id) report_id, thumb_key
        FROM report_pages
        WHERE render_status = 'OK'
        ORDER BY report_id, page_no ASC`,
      )
      .all<CoverRow>(),
  ]);

  const versionByReport = new Map(versionSummaries.results.map((row) => [row.report_id, row]));
  const coverByReport = new Map(covers.results.map((row) => [row.report_id, row.thumb_key]));
  const bucket = getVideoBucket();

  return Promise.all(
    reports.results.map(async (row): Promise<ReportListItemView> => {
      const version = versionByReport.get(row.id);
      const thumbKey = coverByReport.get(row.id);
      const coverUrl =
        row.status === "READY" && thumbKey
          ? await bucket.createPresignedGetUrl(thumbKey, { expiresInSeconds: SIGNED_URL_TTL_SECONDS })
          : null;
      return {
        id: row.id,
        title: row.title,
        taskType: row.task_type,
        tags: tagsFromJson(row.tags_json),
        status: row.status as ReportStatus,
        sourceFormat: row.source_format,
        originalName: row.original_name,
        contentType: row.content_type,
        fileSize: Number(row.file_size),
        pageCount: Number(row.page_count),
        pagesDone: Number(row.pages_done),
        failReason: row.fail_reason,
        coverUrl,
        versionSummary: {
          count: version ? Number(version.version_count) : 0,
          latestOwnerName: version?.latest_owner_name ?? null,
          latestUpdatedAt: version?.latest_updated_at ?? null,
        },
        createdByName: row.created_by_name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // 前端拿这个决定要不要露出重试／改传 PDF／删除，别再靠显示名猜——canManageReport 逻辑不改，只是把
        // viewer 换成真实身份（identityKey/isAdmin）而不是列表页那种「显示名撞一下」的近似判断。
        canManage: canManageReport({ createdByEmail: row.created_by_email }, viewer),
      };
    }),
  );
}

type ReportDetailRow = QueryResultRow & {
  id: string;
  title: string;
  task_type: string;
  tags_json: string;
  original_name: string;
  content_type: string;
  file_size: number;
  source_format: string;
  status: string;
  page_count: number;
  pages_done: number;
  fail_reason: string | null;
  convert_notes: string | null;
  convert_attempts: number;
  converter_version: string | null;
  created_by_email: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
};

type PageRow = QueryResultRow & {
  page_no: number;
  thumb_key: string;
  large_key: string;
  width: number;
  height: number;
  text_excerpt: string;
  render_status: string;
};

type FileRow = QueryResultRow & {
  id: string;
  object_key: string;
  original_name: string;
  content_type: string;
  file_size: number;
  uploaded_by_user_id: string;
  created_at: string;
};

export async function loadReportDetail(db: DbClient, reportId: string): Promise<ReportDetail | null> {
  // 同 listReports 的兜底轮询：这份报告如果还在 PROCESSING 且该查了，先查一次再读，
  // 详情页打开时能看到尽量新的进度，不用非等到回调或下一次轮询窗口。
  await pollReportIfProcessing(db, reportId);

  const report = await db
    .prepare(
      `SELECT id, title, task_type, tags_json, original_name, content_type, file_size,
        source_format, status, page_count, pages_done, fail_reason, convert_notes,
        convert_attempts, converter_version, created_by_email, created_by_name,
        created_at, updated_at
      FROM reports WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(reportId)
    .first<ReportDetailRow>();
  if (!report) return null;

  const [pages, files] = await Promise.all([
    db
      .prepare(
        `SELECT page_no, thumb_key, large_key, width, height, text_excerpt, render_status
        FROM report_pages WHERE report_id = ? ORDER BY page_no ASC`,
      )
      .bind(reportId)
      .all<PageRow>(),
    db
      .prepare(
        `SELECT id, object_key, original_name, content_type, file_size, uploaded_by_user_id, created_at
        FROM report_files WHERE report_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
      )
      .bind(reportId)
      .all<FileRow>(),
  ]);

  const bucket = getVideoBucket();
  const [pageViews, fileViews] = await Promise.all([
    Promise.all(
      pages.results.map(async (page): Promise<ReportPageView> => {
        // 渲染失败的页没有落图片文件（见 convert-report-pages.ts），签出的 URL 只会指向
        // 不存在的对象；不签，交给前端按 renderStatus 显示"渲染失败"占位。
        const [thumbUrl, largeUrl] =
          page.render_status === "OK"
            ? await Promise.all([
                bucket.createPresignedGetUrl(page.thumb_key, { expiresInSeconds: SIGNED_URL_TTL_SECONDS }),
                bucket.createPresignedGetUrl(page.large_key, { expiresInSeconds: SIGNED_URL_TTL_SECONDS }),
              ])
            : [null, null];
        return {
          pageNo: Number(page.page_no),
          thumbUrl,
          largeUrl,
          width: Number(page.width),
          height: Number(page.height),
          textExcerpt: page.text_excerpt,
          renderStatus: page.render_status,
        };
      }),
    ),
    Promise.all(
      files.results.map(
        async (file): Promise<ReportFileView> => ({
          id: file.id,
          originalName: file.original_name,
          contentType: file.content_type,
          fileSize: Number(file.file_size),
          uploadedByUserId: file.uploaded_by_user_id,
          createdAt: file.created_at,
          url: await bucket.createPresignedGetUrl(file.object_key, {
            expiresInSeconds: SIGNED_URL_TTL_SECONDS,
          }),
        }),
      ),
    ),
  ]);

  return {
    id: report.id,
    title: report.title,
    taskType: report.task_type,
    tags: tagsFromJson(report.tags_json),
    status: report.status as ReportStatus,
    sourceFormat: report.source_format,
    originalName: report.original_name,
    contentType: report.content_type,
    fileSize: Number(report.file_size),
    pageCount: Number(report.page_count),
    pagesDone: Number(report.pages_done),
    failReason: report.fail_reason,
    convertNotes: report.convert_notes,
    convertAttempts: Number(report.convert_attempts),
    converterVersion: report.converter_version,
    createdByEmail: report.created_by_email,
    createdByName: report.created_by_name,
    createdAt: report.created_at,
    updatedAt: report.updated_at,
    pages: pageViews,
    files: fileViews,
  };
}

export type ReportManageActor = { identityKey: string; isAdmin: boolean };

type ManageRow = QueryResultRow & {
  id: string;
  status: string;
  created_by_email: string;
  object_key: string;
  source_format: string;
};

export async function retryReport(
  db: DbClient,
  input: { reportId: string; actor: ReportManageActor },
): Promise<{ ok: true }> {
  const report = await db
    .prepare(
      `SELECT id, status, created_by_email, object_key, source_format
      FROM reports WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(input.reportId)
    .first<ManageRow>();
  if (!report) throw new ReportServiceError("报告不存在或已删除。", 404);
  if (!canManageReport({ createdByEmail: report.created_by_email }, input.actor)) {
    throw new ReportServiceError("只有原上传者或管理员可以重试转换。", 403);
  }
  if (!canRetryReportStatus(report.status)) {
    throw new ReportServiceError("只有转换失败的报告可以重试。", 409);
  }
  // 顺手清掉上一轮数据万象任务的痕迹（jobId/回调 token/检查时间）——旧任务已经判过
  // 失败，留着这几列只会让轮询/回调误认到一份过期任务上。
  const result = await db
    .prepare(
      `UPDATE reports
      SET status = 'QUEUED', fail_reason = NULL, ci_job_large = NULL, ci_job_small = NULL,
          ci_callback_token = NULL, ci_checked_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'FAILED'`,
    )
    .bind(report.id)
    .run();
  if (result.meta.rows_written !== 1) {
    throw new ReportServiceError("报告状态已变化，请刷新后重试。", 409);
  }

  if (getConverterMode() === "ci") {
    await submitReportToCi(db, {
      id: report.id,
      objectKey: report.object_key,
      sourceFormat: report.source_format,
    });
  }

  return { ok: true };
}

export async function trashReport(
  db: DbClient,
  input: { reportId: string; actor: ReportManageActor },
): Promise<{ ok: true }> {
  const report = await db
    .prepare(`SELECT id, status, created_by_email FROM reports WHERE id = ? AND deleted_at IS NULL`)
    .bind(input.reportId)
    .first<ManageRow>();
  if (!report) throw new ReportServiceError("报告不存在或已在回收站中。", 404);
  if (!canManageReport({ createdByEmail: report.created_by_email }, input.actor)) {
    throw new ReportServiceError("只有原上传者或管理员可以删除报告。", 403);
  }
  const result = await db
    .prepare(
      `UPDATE reports SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(report.id)
    .run();
  if (result.meta.rows_written !== 1) {
    throw new ReportServiceError("报告已被删除。", 409);
  }
  return { ok: true };
}

/**
 * trashReport 的镜像：同样只认原上传者或管理员，同样先按 id 找行（不再过滤
 * deleted_at，因为要恢复的正是已经软删的那份），再用 UPDATE 的 WHERE 子句
 * 当并发闸门——真的从"已删"翻回"未删"才算数，否则说明这份报告本来就没在
 * 回收站里（或者已经被别的请求恢复过），报 409 而不是静默当成功处理。
 */
export async function restoreReport(
  db: DbClient,
  input: { reportId: string; actor: ReportManageActor },
): Promise<{ ok: true }> {
  const report = await db
    .prepare(`SELECT id, status, created_by_email FROM reports WHERE id = ?`)
    .bind(input.reportId)
    .first<ManageRow>();
  if (!report) throw new ReportServiceError("报告不存在。", 404);
  if (!canManageReport({ createdByEmail: report.created_by_email }, input.actor)) {
    throw new ReportServiceError("只有原上传者或管理员可以恢复报告。", 403);
  }
  const result = await db
    .prepare(
      `UPDATE reports SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND deleted_at IS NOT NULL`,
    )
    .bind(report.id)
    .run();
  if (result.meta.rows_written !== 1) {
    throw new ReportServiceError("报告未在回收站中，无需恢复。", 409);
  }
  return { ok: true };
}

/** 相关资料的对象键里带原始文件名，只需要把会拆出多层目录的路径分隔符清掉。 */
function safeFileSegment(name: string): string {
  const cleaned = name.trim().replace(/[\\/]+/g, "_");
  return cleaned || "file";
}

export type CreateReportFileInput = {
  reportId: string;
  originalName: string;
  contentType?: string | null;
  fileSize: number;
  uploadedByUserId: string;
};

export async function createReportFileUpload(
  db: DbClient,
  input: CreateReportFileInput,
): Promise<{ fileId: string; uploadUrl: string }> {
  const report = await db
    .prepare(`SELECT id FROM reports WHERE id = ? AND deleted_at IS NULL`)
    .bind(input.reportId)
    .first<QueryResultRow & { id: string }>();
  if (!report) throw new ReportServiceError("报告不存在或已删除。", 404);

  const originalName = input.originalName?.trim();
  if (!originalName) throw new ReportServiceError("请选择要上传的相关资料。");
  const fileSize = Math.max(0, Number(input.fileSize) || 0);
  if (fileSize > REPORT_MAX_UPLOAD_BYTES) {
    throw new ReportServiceError("单个相关资料不能超过 200 MB。");
  }

  const fileId = newId("reportfile");
  const objectKey = `reports/${input.reportId}/files/${fileId}/${safeFileSegment(originalName)}`;
  const contentType = input.contentType?.trim() || "application/octet-stream";
  const bucket = getVideoBucket();
  const uploadUrl = await bucket.createPresignedPutUrl(objectKey, { contentType });

  await db
    .prepare(
      `INSERT INTO report_files (
        id, report_id, object_key, original_name, content_type, file_size, uploaded_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(fileId, input.reportId, objectKey, originalName, contentType, fileSize, input.uploadedByUserId)
    .run();

  return { fileId, uploadUrl };
}

export type RemoveReportFileInput = {
  reportId: string;
  fileId: string;
  actor: ReportManageActor & { userId: string };
};

export async function removeReportFile(db: DbClient, input: RemoveReportFileInput): Promise<{ ok: true }> {
  const report = await db
    .prepare(`SELECT id, created_by_email FROM reports WHERE id = ? AND deleted_at IS NULL`)
    .bind(input.reportId)
    .first<QueryResultRow & { id: string; created_by_email: string }>();
  if (!report) throw new ReportServiceError("报告不存在或已删除。", 404);

  const file = await db
    .prepare(
      `SELECT id, uploaded_by_user_id FROM report_files
      WHERE id = ? AND report_id = ? AND deleted_at IS NULL`,
    )
    .bind(input.fileId, input.reportId)
    .first<QueryResultRow & { id: string; uploaded_by_user_id: string }>();
  if (!file) throw new ReportServiceError("相关资料不存在或已移除。", 404);

  const canRemove =
    input.actor.isAdmin ||
    file.uploaded_by_user_id === input.actor.userId ||
    report.created_by_email === input.actor.identityKey;
  if (!canRemove) {
    throw new ReportServiceError("只有上传者本人、报告上传者或管理员可以移除这份资料。", 403);
  }

  const result = await db
    .prepare(`UPDATE report_files SET deleted_at = now() WHERE id = ? AND deleted_at IS NULL`)
    .bind(file.id)
    .run();
  if (result.meta.rows_written !== 1) {
    throw new ReportServiceError("这份资料已被移除。", 409);
  }
  return { ok: true };
}
