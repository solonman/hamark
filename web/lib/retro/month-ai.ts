// 案例与录音（lib/retro/cases 等）和月度整理（AI 流水线、发布）之间的唯一接缝。
// 案例详情、库首页、月份页要显示「整理到哪了、发布了什么」，都只通过这里的三个函数读，
// 不直接解析 retro_month_jobs / retro_month_publications。规格见 docs/26 六、九、10.1、10.3-5。
//
// 函数签名是约定，实现由月度整理那边负责；在它落地之前这里返回「什么都还没有」。

import type { DbClient } from "@/db";
import type { RetroCaseInMinutes, RetroJobView, RetroMonthBadge, RetroPublicationView } from "@/lib/retro-model";

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
  void db;
  void monthKey;
  void viewer;
  return { job: null, latestPublication: null, publicationVersions: [], changedSincePublish: 0 };
}

/** 库首页每个月份标题行上的成果状态（规格 10.1）。没出现在结果里的月份按 NONE 处理。 */
export async function loadRetroMonthBadges(db: DbClient, monthKeys: readonly string[]): Promise<Record<string, RetroMonthBadge>> {
  void db;
  return Object.fromEntries(monthKeys.map((key) => [key, { state: "NONE" } as RetroMonthBadge]));
}

/** 案例页「在本月纪要里」（规格 10.3-5）：只有这个案例被包含在当月最新已发布版本里才返回。 */
export async function loadRetroCaseInMinutes(db: DbClient, caseId: string, monthKey: string): Promise<RetroCaseInMinutes | null> {
  void db;
  void caseId;
  void monthKey;
  return null;
}
