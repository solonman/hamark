// 案例与录音（lib/retro/cases 等）和月度整理（AI 流水线、发布）之间的唯一接缝。
// 案例详情、库首页、月份页要显示「整理到哪了、发布了什么」，都只通过这里的三个函数读，
// 不直接解析 retro_month_jobs / retro_month_publications。规格见 docs/26 六、九、10.1、10.3-5。

import type { DbClient, QueryResultRow } from "@/db";
import type { RetroCaseInMinutes, RetroJobView, RetroMonthBadge, RetroPublicationView, RetroSource } from "@/lib/retro-model";
import { buildRetroMonthAiState, loadLatestRetroPublication } from "./month-view";

export type RetroMonthAiViewer = { userId: string; isReviewer: boolean };

export type RetroMonthAiState = {
  job: RetroJobView | null;
  latestPublication: RetroPublicationView | null;
  publicationVersions: number[];
  /** 发布后录音变动的段数（新增或移除）。 */
  changedSincePublish: number;
};

/** 月份页（GET /api/retro-months/[month]）里与整理相关的部分。草稿内容只给老孙。 */
export async function loadRetroMonthAiState(db: DbClient, monthKey: string, viewer: RetroMonthAiViewer): Promise<RetroMonthAiState> {
  const { job, latestPublication, publicationVersions, changedSincePublish } = await buildRetroMonthAiState(db, monthKey, { isReviewer: viewer.isReviewer });
  return { job, latestPublication, publicationVersions, changedSincePublish };
}

const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");

/** 库首页每个月份标题行上的成果状态（规格 10.1）。没出现在结果里的月份按 NONE 处理。 */
export async function loadRetroMonthBadges(db: DbClient, monthKeys: readonly string[]): Promise<Record<string, RetroMonthBadge>> {
  const keys = [...new Set(monthKeys)];
  const badges: Record<string, RetroMonthBadge> = Object.fromEntries(keys.map((key) => [key, { state: "NONE" } as RetroMonthBadge]));
  if (!keys.length) return badges;
  const live = new Set((await db.prepare(
    `SELECT DISTINCT month_key FROM retro_month_jobs WHERE month_key IN (${placeholders(keys.length)}) AND status NOT IN ('PUBLISHED', 'ABANDONED')`,
  ).bind(...keys).all<QueryResultRow & { month_key: string }>()).results.map((row) => row.month_key));
  const published = new Map((await db.prepare(
    `SELECT month_key, MAX(version_number) AS version FROM retro_month_publications
    WHERE month_key IN (${placeholders(keys.length)}) GROUP BY month_key`,
  ).bind(...keys).all<QueryResultRow & { month_key: string; version: number | string }>()).results.map((row) => [row.month_key, Number(row.version)]));
  // 发布后录音变动：发布后新增且未移除的，加上发布前就有、发布后被移除的（同 countRecordingChangesSince）。
  const changed = new Map((await db.prepare(
    `SELECT r.month_key, COUNT(*) AS changes
    FROM retro_recordings r
    JOIN (SELECT month_key, MAX(published_at) AS published_at FROM retro_month_publications
      WHERE month_key IN (${placeholders(keys.length)}) GROUP BY month_key) p ON p.month_key = r.month_key
    WHERE (r.created_at > p.published_at AND r.status <> 'REMOVED')
      OR (r.created_at <= p.published_at AND r.removed_at IS NOT NULL AND r.removed_at > p.published_at)
    GROUP BY r.month_key`,
  ).bind(...keys).all<QueryResultRow & { month_key: string; changes: number | string }>()).results.map((row) => [row.month_key, Number(row.changes)]));
  for (const key of keys) {
    const version = published.get(key) ?? null;
    if (live.has(key)) badges[key] = { state: "RUNNING", publishedVersion: version };
    else if (version != null) badges[key] = { state: "PUBLISHED", version, changed: (changed.get(key) ?? 0) > 0 };
  }
  return badges;
}

const mentionsCase = (sources: readonly RetroSource[], caseId: string) => sources.some((source) => source.caseId === caseId);

/** 案例页「在本月纪要里」（规格 10.3-5）：只有这个案例被包含在当月最新已发布版本里才返回。 */
export async function loadRetroCaseInMinutes(db: DbClient, caseId: string, monthKey: string): Promise<RetroCaseInMinutes | null> {
  const publication = await loadLatestRetroPublication(db, monthKey);
  if (!publication || !publication.caseIds.includes(caseId)) return null;
  const review = publication.minutes.cases.find((item) => item.caseId === caseId) ?? null;
  const methods = publication.methods.candidates.filter((candidate) => mentionsCase(candidate.sources, caseId));
  return {
    publicationVersion: publication.versionNumber,
    publishedAt: publication.publishedAt,
    publishedByName: publication.publishedByName,
    caseNumber: publication.caseNumbers[caseId],
    review,
    methods,
    quotedSegments: publication.quotedSegments,
    recordingRefs: publication.recordingRefs,
  };
}
