// 外部 Agent 读取报告案例与报告拆解作业（每人一版 + 报告集成版）。只读：只有
// SELECT，外加本来就不写库的 loadReportFinalVersion。刻意不复用
// listReports / loadReportDetail——那两个会顺手向数据万象轮询转换进度并写库。
// 见 docs/23_外部Agent只读API_V0.1.md 三、接口。

import { getVideoBucket, type DbClient, type QueryResultRow } from "@/db";
import { loadReportFinalVersion } from "@/lib/report-final-version";
import { resolveReportDefaultVersion } from "@/lib/report-version-chain";
import type { ReportAnnotation } from "@/lib/report-structure";
import {
  AGENT_MEDIA_URL_TTL_SECONDS,
  AgentApiError,
  isoOrNull,
  likePattern,
  tagsFromJson,
  type AgentListQuery,
  type AgentPayloadFormat,
  type AgentVersionSelector,
} from "./params";
import { toReadableReportAnalysis } from "./readable";

// 与报告库同一口径：未删除、转换完成。
const VISIBLE_REPORT_WHERE = `r.deleted_at IS NULL AND r.status = 'READY'`;

type ReportRow = QueryResultRow & {
  id: string;
  title: string;
  task_type: string;
  tags_json: string;
  source_format: string;
  original_name: string;
  page_count: number;
  created_by_name: string;
  created_at: string;
};

type ReportListRow = ReportRow & {
  version_count: number | string | null;
  last_version_at: Date | string | null;
  final_status: "OPEN" | "DONE" | null;
  final_done_at: Date | string | null;
  final_updated_at: Date | string | null;
  total_count: number | string;
};

type ReportVersionRow = QueryResultRow & {
  id: string;
  version_number: number;
  owner_name_snapshot: string;
  base_version_number: number | null;
  base_is_final: boolean;
  payload_json: ReportAnnotation | string;
  content_hash: string;
  revision: number;
  payload_schema_version: string;
  created_at: Date | string;
  updated_at: Date | string;
};

function reportFields(row: ReportRow) {
  return {
    id: row.id,
    title: row.title,
    taskType: row.task_type,
    tags: tagsFromJson(row.tags_json),
    sourceFormat: row.source_format,
    originalName: row.original_name,
    pageCount: Number(row.page_count),
    uploaderName: row.created_by_name,
    createdAt: isoOrNull(row.created_at),
  };
}

export async function listAgentReports(db: DbClient, query: AgentListQuery) {
  const where = [VISIBLE_REPORT_WHERE];
  const binds: Array<string | number> = [];
  if (query.q) {
    where.push(`(r.title ILIKE ? OR r.task_type ILIKE ? OR r.tags_json ILIKE ?)`);
    const pattern = likePattern(query.q);
    binds.push(pattern, pattern, pattern);
  }
  if (query.hasAnalysis) where.push(`COALESCE(stats.version_count, 0) > 0`);
  if (query.updatedSince) {
    where.push(`GREATEST(stats.last_version_at, f.updated_at) >= ?::timestamptz`);
    binds.push(query.updatedSince);
  }
  binds.push(query.limit, query.offset);

  const { results } = await db.prepare(
    `SELECT r.id, r.title, r.task_type, r.tags_json, r.source_format, r.original_name,
      r.page_count, r.created_by_name, r.created_at,
      stats.version_count, stats.last_version_at,
      f.status AS final_status, f.done_at AS final_done_at, f.updated_at AS final_updated_at,
      COUNT(*) OVER () AS total_count
    FROM reports r
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS version_count, MAX(rv.updated_at) AS last_version_at
      FROM report_versions rv WHERE rv.report_id = r.id
    ) stats ON TRUE
    LEFT JOIN report_final_versions f ON f.report_id = r.id
    WHERE ${where.join("\n      AND ")}
    ORDER BY r.created_at DESC, r.id ASC
    LIMIT ? OFFSET ?`,
  ).bind(...binds).all<ReportListRow>();

  return {
    total: results.length ? Number(results[0].total_count) : 0,
    limit: query.limit,
    offset: query.offset,
    reports: results.map((row) => {
      const versionCount = Number(row.version_count ?? 0);
      return {
        ...reportFields(row),
        analysis: {
          versionCount,
          lastVersionUpdatedAt: isoOrNull(row.last_version_at),
          finalStatus: row.final_status ?? (versionCount > 0 ? "OPEN" : null),
          finalDoneAt: isoOrNull(row.final_done_at),
          finalUpdatedAt: isoOrNull(row.final_updated_at),
        },
      };
    }),
  };
}

async function requireVisibleReport(db: DbClient, reportId: string) {
  const row = await db.prepare(
    `SELECT r.id, r.title, r.task_type, r.tags_json, r.source_format, r.original_name,
      r.page_count, r.created_by_name, r.created_at
    FROM reports r WHERE r.id = ? AND ${VISIBLE_REPORT_WHERE}`,
  ).bind(reportId).first<ReportRow>();
  if (!row) throw new AgentApiError(404, "REPORT_NOT_FOUND", "报告不存在或尚未就绪。");
  return row;
}

/** 详情页只要版本摘要，不拉整份 payload（几百页的报告 × 多个版本并不小）。 */
async function listReportVersionRows(db: DbClient, reportId: string, withPayload = true) {
  return (await db.prepare(
    `SELECT id, version_number, owner_name_snapshot, base_version_number, base_is_final,
      ${withPayload ? "payload_json" : "NULL AS payload_json"}, content_hash, revision,
      payload_schema_version, created_at, updated_at
    FROM report_versions WHERE report_id = ? ORDER BY version_number ASC`,
  ).bind(reportId).all<ReportVersionRow>()).results;
}

function versionSummary(row: ReportVersionRow) {
  return {
    id: row.id,
    number: Number(row.version_number),
    ownerName: row.owner_name_snapshot,
    baseNumber: row.base_version_number == null ? null : Number(row.base_version_number),
    baseIsFinal: Boolean(row.base_is_final),
    createdAt: isoOrNull(row.created_at),
    updatedAt: isoOrNull(row.updated_at),
  };
}

export async function getAgentReport(db: DbClient, reportId: string) {
  const report = await requireVisibleReport(db, reportId);
  const [pages, files, rows] = await Promise.all([
    db.prepare(
      `SELECT page_no, thumb_key, large_key, width, height, text_excerpt, render_status
      FROM report_pages WHERE report_id = ? ORDER BY page_no ASC`,
    ).bind(reportId).all<QueryResultRow & {
      page_no: number; thumb_key: string; large_key: string; width: number; height: number;
      text_excerpt: string; render_status: string;
    }>(),
    db.prepare(
      `SELECT id, object_key, original_name, content_type, file_size, created_at
      FROM report_files WHERE report_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
    ).bind(reportId).all<QueryResultRow & {
      id: string; object_key: string; original_name: string; content_type: string;
      file_size: number; created_at: Date | string;
    }>(),
    listReportVersionRows(db, reportId, false),
  ]);
  const final = rows.length ? await loadReportFinalVersion(db, reportId) : null;

  const bucket = getVideoBucket();
  const sign = (key: string) => bucket.createPresignedGetUrl(key, { expiresInSeconds: AGENT_MEDIA_URL_TTL_SECONDS });

  return {
    report: reportFields(report),
    pages: await Promise.all(pages.results.map(async (page) => {
      // 渲染失败的页没有落图片文件，签出来也是死链；照报告库的做法不签。
      const ok = page.render_status === "OK";
      return {
        pageNo: Number(page.page_no),
        renderStatus: page.render_status,
        width: Number(page.width),
        height: Number(page.height),
        textExcerpt: page.text_excerpt,
        thumbUrl: ok ? await sign(page.thumb_key) : null,
        imageUrl: ok ? await sign(page.large_key) : null,
      };
    })),
    files: await Promise.all(files.results.map(async (file) => ({
      id: file.id,
      originalName: file.original_name,
      contentType: file.content_type,
      fileSize: Number(file.file_size),
      createdAt: isoOrNull(file.created_at),
      url: await sign(file.object_key),
    }))),
    mediaExpiresInSeconds: AGENT_MEDIA_URL_TTL_SECONDS,
    versions: rows.map(versionSummary),
    final: final
      ? {
          status: final.status,
          doneAt: isoOrNull(final.doneAt),
          doneByName: final.doneByName,
          updatedAt: isoOrNull(final.updatedAt),
          pendingCount: final.pendingCount,
          isVirtual: final.isVirtual,
        }
      : null,
  };
}

function parsePayload(value: ReportAnnotation | string): ReportAnnotation {
  return typeof value === "string" ? (JSON.parse(value) as ReportAnnotation) : value;
}

function shapePayload(payload: ReportAnnotation, format: AgentPayloadFormat) {
  return {
    payloadSchemaVersion: "report-annotation/1",
    ...(format !== "readable" ? { payload } : {}),
    ...(format !== "raw" ? { readable: toReadableReportAnalysis(payload) } : {}),
  };
}

export async function getAgentReportAnalysis(
  db: DbClient,
  reportId: string,
  selector: AgentVersionSelector,
  format: AgentPayloadFormat,
) {
  const report = await requireVisibleReport(db, reportId);
  const reportRef = { id: report.id, title: report.title, taskType: report.task_type };
  const rows = await listReportVersionRows(db, reportId);
  if (rows.length === 0) {
    if (selector.kind === "ID") throw new AgentApiError(404, "VERSION_NOT_FOUND", "指定的版本不存在。");
    throw new AgentApiError(404, "NO_ANALYSIS", "这份报告还没有拆解内容。");
  }

  if (selector.kind === "FINAL") {
    const final = await loadReportFinalVersion(db, reportId);
    return {
      report: reportRef,
      version: {
        kind: "FINAL" as const,
        id: final.id,
        label: "集成版",
        status: final.status,
        doneAt: isoOrNull(final.doneAt),
        doneByName: final.doneByName,
        pendingCount: final.pendingCount,
        isVirtual: final.isVirtual,
        updatedAt: isoOrNull(final.updatedAt),
        revision: final.revision,
        contentHash: final.contentHash,
      },
      ...shapePayload(final.payload, format),
    };
  }

  let row: ReportVersionRow | undefined;
  if (selector.kind === "LATEST") {
    const latest = resolveReportDefaultVersion(rows.map((r) => ({
      id: r.id, number: Number(r.version_number), updatedAt: isoOrNull(r.updated_at) ?? "",
    })));
    row = rows.find((r) => r.id === latest.id);
  } else {
    // 只在这份报告自己的版本里找：别的报告的版本 id 在这里一律当不存在。
    row = rows.find((r) => r.id === selector.id);
  }
  if (!row) throw new AgentApiError(404, "VERSION_NOT_FOUND", "指定的版本不存在。");

  return {
    report: reportRef,
    version: {
      kind: "VERSION" as const,
      ...versionSummary(row),
      revision: Number(row.revision),
      contentHash: row.content_hash,
    },
    ...shapePayload(parsePayload(row.payload_json), format),
  };
}
