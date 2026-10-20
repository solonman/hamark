// 案例的读写：库首页列表、新建（含空的「第 1 版」回合）、详情、按字段 PATCH（revision 乐观锁）、回收站。
// 规格 docs/26 4.2、4.5、九、10.1–10.3。结构照 lib/visual-server.ts。
//
// 月份成果状态（库首页）和案例页的「在本月纪要里」只通过 lib/retro/month-ai.ts 读，
// 这里不解析 retro_month_jobs / retro_month_publications。

import type { DbClient, QueryResultRow } from "@/db";
import { isoOrNull } from "@/lib/audio-review/view";
import {
  type RetroCaseCard,
  type RetroCaseCover,
  type RetroCaseDetail,
  type RetroCaseBasicsInput,
  type RetroCreateCaseResponse,
  type RetroLibraryResponse,
  type RetroMonthSummary,
  type RetroPatchCaseResponse,
  type RetroRecordingBadge,
  type RetroRecordingStatus,
  retroCaseNumbers,
} from "@/lib/retro-model";
import type { VideoBucket } from "@/storage/types";
import { canEditRetroCase, canRemoveRetroRecording, type RetroViewer } from "./access";
import { requireEditableRetroCase, loadRetroCaseHead } from "./case-head";
import { retroConflict, retroNotFound, retroForbidden } from "./errors";
import { pickRetroCaseCover, type RetroCoverCandidate } from "./cover";
import { loadRetroCaseInMinutes, loadRetroMonthBadges } from "./month-ai";
import {
  RETRO_ASSET_COLUMNS,
  RETRO_RECORDING_COLUMNS,
  RETRO_ROUND_COLUMNS,
  RETRO_SIGNED_URL_TTL_SECONDS,
  buildRetroAssetViews,
  buildRetroLinkViews,
  toRetroRecordingView,
  toRetroRoundView,
  type RetroAssetRow,
  type RetroLinkRow,
  type RetroRecordingRow,
  type RetroRoundRow,
} from "./views";
import { validateRetroCaseBasics, validateRetroCasePatch } from "./validate";
import { retroNewId } from "./keys";

type SigningBucket = Pick<VideoBucket, "createPresignedGetUrl">;

const BACKGROUND_EXCERPT_CHARS = 80;
const SEARCH_TEXT_CHARS = 4000;

function tagsOf(value: unknown): string[] {
  const raw = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  return Array.isArray(raw) ? raw.filter((tag): tag is string => typeof tag === "string") : [];
}

function excerpt(text: string, chars: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  const list = [...flat];
  return list.length > chars ? `${list.slice(0, chars).join("")}…` : flat;
}

// ---------------------------------------------------------------------------
// 新建
// ---------------------------------------------------------------------------

/** 当月序号「案例 N」（规格 6.7）：按创建先后，被删除的案例也占号。 */
async function loadRetroCaseNumber(db: DbClient, caseId: string, monthKey: string): Promise<number | undefined> {
  const rows = (await db.prepare(`SELECT id, created_at FROM retro_cases WHERE month_key = ?`)
    .bind(monthKey).all<QueryResultRow & { id: string; created_at: unknown }>()).results;
  return retroCaseNumbers(rows.map((item) => ({ id: item.id, createdAt: isoOrNull(item.created_at) ?? "" })))[caseId];
}

export async function createRetroCase(
  db: DbClient,
  viewer: Pick<RetroViewer, "userId" | "displayName">,
  body: unknown,
  now: Date = new Date(),
): Promise<RetroCreateCaseResponse> {
  const basics: RetroCaseBasicsInput = validateRetroCaseBasics(body, now);
  const caseId = retroNewId("rtc");
  const firstRoundId = retroNewId("rnd");
  await db.withTransaction(async (tx) => {
    await tx.prepare(
      `INSERT INTO retro_cases (id, month_key, department, client_name, title, scene_tags_json, created_by_user_id, created_by_name)
       VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?)`,
    ).bind(
      caseId, basics.monthKey, basics.department, basics.clientName, basics.title,
      JSON.stringify(basics.sceneTags), viewer.userId, viewer.displayName,
    ).run();
    // 创建后案例页上已经有一张空的「第 1 版」（规格 10.3）。
    await tx.prepare(
      `INSERT INTO retro_case_rounds (id, case_id, position, title) VALUES (?, ?, 0, '第 1 版')`,
    ).bind(firstRoundId, caseId).run();
  });
  return { caseId, firstRoundId };
}

// ---------------------------------------------------------------------------
// 库首页列表（规格九 GET /api/retro-cases、10.1、10.2）
// ---------------------------------------------------------------------------

type CaseListRow = QueryResultRow & {
  id: string;
  month_key: string;
  department: string;
  client_name: string;
  title: string;
  scene_tags_json: unknown;
  background: string;
  outcome: string;
  created_by_user_id: string;
  created_by_name: string;
  created_at: unknown;
};

/** 卡片上的录音标记：上传中也算转写中；有失败的要让人看见；其余是就绪的段数和总时长。 */
export function retroRecordingBadge(recordings: ReadonlyArray<{ status: RetroRecordingStatus; durationMs: number | null }>): RetroRecordingBadge {
  if (recordings.length === 0) return { state: "NONE" };
  if (recordings.some((item) => item.status === "UPLOADING" || item.status === "TRANSCRIBING")) return { state: "PROCESSING" };
  if (recordings.some((item) => item.status === "FAILED")) return { state: "FAILED" };
  const ready = recordings.filter((item) => item.status === "READY");
  if (ready.length === 0) return { state: "NONE" };
  return { state: "READY", parts: ready.length, durationMs: ready.reduce((sum, item) => sum + (item.durationMs ?? 0), 0) };
}

export async function listRetroLibrary(
  db: DbClient,
  viewer: Pick<RetroViewer, "userId" | "isAdmin">,
  bucket: SigningBucket,
): Promise<RetroLibraryResponse> {
  const liveCases = `SELECT id FROM retro_cases WHERE deleted_at IS NULL`;
  const [casesResult, roundsResult, recordingsResult, coverResult] = await Promise.all([
    db.prepare(
      `SELECT id, month_key, department, client_name, title, scene_tags_json, background, outcome,
              created_by_user_id, created_by_name, created_at
       FROM retro_cases WHERE deleted_at IS NULL ORDER BY month_key DESC, created_at DESC`,
    ).all<CaseListRow>(),
    db.prepare(
      `SELECT case_id, title, feedback_text, delivery_text, response_text FROM retro_case_rounds
       WHERE deleted_at IS NULL AND case_id IN (${liveCases}) ORDER BY case_id, position ASC`,
    ).all<QueryResultRow & { case_id: string; title: string; feedback_text: string; delivery_text: string; response_text: string }>(),
    db.prepare(
      `SELECT case_id, status, audio_duration_ms FROM retro_recordings
       WHERE case_id IS NOT NULL AND status <> 'REMOVED' AND case_id IN (${liveCases})`,
    ).all<QueryResultRow & { case_id: string; status: string; audio_duration_ms: number | null }>(),
    // 封面候选（规格 10.2）：一次查出全部案例里已就绪的图片、视频、文档（只带第 1 页），不按案例逐个查。
    // 已删除回合上的附件不算（详情页上也看不到它们）。
    db.prepare(
      `SELECT a.id, a.case_id, r.position AS round_position, a.position, a.type, a.upload_status, a.derivative_status,
              a.thumbnail_key, a.pages_json -> 0 AS first_page
       FROM retro_case_assets a
       LEFT JOIN retro_case_rounds r ON r.id = a.round_id
       WHERE a.case_id IN (${liveCases}) AND a.type IN ('IMAGE', 'VIDEO', 'DOC')
         AND a.upload_status = 'READY' AND a.derivative_status = 'READY'
         AND (a.round_id IS NULL OR r.deleted_at IS NULL)`,
    ).all<QueryResultRow & {
      id: string; case_id: string; round_position: number | null; position: number; type: string;
      upload_status: string; derivative_status: string; thumbnail_key: string | null; first_page: unknown;
    }>(),
  ]);

  const roundsByCase = new Map<string, typeof roundsResult.results>();
  for (const row of roundsResult.results) {
    const list = roundsByCase.get(row.case_id);
    if (list) list.push(row);
    else roundsByCase.set(row.case_id, [row]);
  }
  const recordingsByCase = new Map<string, { status: RetroRecordingStatus; durationMs: number | null }[]>();
  for (const row of recordingsResult.results) {
    const entry = { status: row.status as RetroRecordingStatus, durationMs: row.audio_duration_ms === null ? null : Number(row.audio_duration_ms) };
    const list = recordingsByCase.get(row.case_id);
    if (list) list.push(entry);
    else recordingsByCase.set(row.case_id, [entry]);
  }

  const coverCandidates = new Map<string, RetroCoverCandidate[]>();
  for (const row of coverResult.results) {
    const candidate: RetroCoverCandidate = {
      id: row.id,
      caseId: row.case_id,
      roundPosition: row.round_position === null ? null : Number(row.round_position),
      position: Number(row.position),
      type: row.type,
      uploadStatus: row.upload_status,
      derivativeStatus: row.derivative_status,
      thumbnailKey: row.thumbnail_key,
      firstPage: row.first_page,
    };
    const list = coverCandidates.get(row.case_id);
    if (list) list.push(candidate);
    else coverCandidates.set(row.case_id, [candidate]);
  }
  const coverByCase = new Map<string, RetroCaseCover>();
  await Promise.all(casesResult.results.map(async (row) => {
    const pick = pickRetroCaseCover(coverCandidates.get(row.id) ?? []);
    if (!pick) return;
    coverByCase.set(row.id, {
      url: await bucket.createPresignedGetUrl(pick.key, { expiresInSeconds: RETRO_SIGNED_URL_TTL_SECONDS }),
      kind: pick.kind,
    });
  }));

  const cases = casesResult.results.map((row): RetroCaseCard => {
    const rounds = roundsByCase.get(row.id) ?? [];
    const searchText = [row.background, ...rounds.flatMap((round) => [round.title, round.delivery_text, round.feedback_text, round.response_text])]
      .join(" ").replace(/\s+/g, " ").trim();
    return {
      id: row.id,
      monthKey: row.month_key,
      department: row.department,
      clientName: row.client_name,
      title: row.title,
      sceneTags: tagsOf(row.scene_tags_json),
      backgroundExcerpt: excerpt(row.background, BACKGROUND_EXCERPT_CHARS),
      roundTrack: rounds.map((round) => ({ title: round.title, hasFeedback: round.feedback_text.trim().length > 0 })),
      hasOutcome: row.outcome.trim().length > 0,
      recording: retroRecordingBadge(recordingsByCase.get(row.id) ?? []),
      cover: coverByCase.get(row.id) ?? null,
      createdByName: row.created_by_name,
      createdAt: isoOrNull(row.created_at) ?? "",
      canManage: canEditRetroCase({ createdByUserId: row.created_by_user_id }, viewer),
      searchText: [...searchText].slice(0, SEARCH_TEXT_CHARS).join(""),
    };
  });

  // 月份从新到旧；「录音 5 / 6」里的 5 是至少有一段点评录音已转写完的案例数（和月度整理「参与提炼」的口径一致）。
  const hasReadyRecording = new Set(
    [...recordingsByCase].filter(([, list]) => list.some((item) => item.status === "READY")).map(([caseId]) => caseId),
  );
  const monthKeys = [...new Set(cases.map((item) => item.monthKey))].sort().reverse();
  const badges = await loadRetroMonthBadges(db, monthKeys);
  const months = monthKeys.map((monthKey): RetroMonthSummary => {
    const inMonth = cases.filter((item) => item.monthKey === monthKey);
    return {
      monthKey,
      caseCount: inMonth.length,
      recordedCaseCount: inMonth.filter((item) => hasReadyRecording.has(item.id)).length,
      badge: badges[monthKey] ?? { state: "NONE" },
    };
  });
  return { cases, months };
}

// ---------------------------------------------------------------------------
// 详情（规格九 GET /api/retro-cases/[id]）
// ---------------------------------------------------------------------------

type CaseDetailRow = QueryResultRow & {
  id: string;
  month_key: string;
  department: string;
  client_name: string;
  title: string;
  scene_tags_json: unknown;
  background: string;
  outcome: string;
  turning_points: string;
  discussion_questions: string;
  revision: number;
  created_by_user_id: string;
  created_by_name: string;
  created_at: unknown;
  updated_at: unknown;
};

export async function loadRetroCaseDetail(
  db: DbClient,
  bucket: SigningBucket,
  caseId: string,
  viewer: Pick<RetroViewer, "userId" | "isAdmin">,
): Promise<RetroCaseDetail | null> {
  const row = await db.prepare(
    `SELECT id, month_key, department, client_name, title, scene_tags_json, background, outcome, turning_points,
            discussion_questions, revision, created_by_user_id, created_by_name, created_at, updated_at
     FROM retro_cases WHERE id = ? AND deleted_at IS NULL`,
  ).bind(caseId).first<CaseDetailRow>();
  if (!row) return null;
  const canEdit = canEditRetroCase({ createdByUserId: row.created_by_user_id }, viewer);

  const [roundsResult, assetsResult, linksResult, recordingsResult] = await Promise.all([
    db.prepare(`SELECT ${RETRO_ROUND_COLUMNS} FROM retro_case_rounds WHERE case_id = ? AND deleted_at IS NULL ORDER BY position ASC`)
      .bind(caseId).all<RetroRoundRow>(),
    db.prepare(`SELECT ${RETRO_ASSET_COLUMNS} FROM retro_case_assets WHERE case_id = ? ORDER BY position ASC, created_at ASC`)
      .bind(caseId).all<RetroAssetRow>(),
    db.prepare(
      `SELECT l.round_id, l.target_kind, l.target_id, l.position FROM retro_round_links l
       JOIN retro_case_rounds r ON r.id = l.round_id
       WHERE r.case_id = ? AND r.deleted_at IS NULL ORDER BY l.position ASC`,
    ).bind(caseId).all<RetroLinkRow>(),
    db.prepare(`SELECT ${RETRO_RECORDING_COLUMNS} FROM retro_recordings WHERE case_id = ? AND status <> 'REMOVED' ORDER BY part_no ASC`)
      .bind(caseId).all<RetroRecordingRow>(),
  ]);

  // 能编辑的人拿全部附件（含没传完的，好重传或去掉）；其他人只拿已传完的。
  const visibleAssets = assetsResult.results.filter((asset) => canEdit || asset.upload_status === "READY");
  const [assetViews, linkViews] = await Promise.all([
    buildRetroAssetViews(bucket, visibleAssets),
    buildRetroLinkViews(db, bucket, linksResult.results),
  ]);
  const assetViewById = new Map(assetViews.map((view) => [view.id, view]));
  const assetsByOwner = new Map<string, typeof assetViews>();
  for (const asset of visibleAssets) {
    const key = asset.round_id ?? "NEED";
    assetsByOwner.set(key, [...(assetsByOwner.get(key) ?? []), assetViewById.get(asset.id)!]);
  }
  const linkViewByIndex = linksResult.results.map((link, index) => ({ roundId: link.round_id, view: linkViews[index] }));

  const rounds = roundsResult.results.map((round) => toRetroRoundView(
    round,
    assetsByOwner.get(round.id) ?? [],
    linkViewByIndex.filter((link) => link.roundId === round.id).map((link) => link.view),
  ));

  const caseHead = { createdByUserId: row.created_by_user_id };
  const recordings = recordingsResult.results.map((recording) => toRetroRecordingView(
    recording,
    canRemoveRetroRecording({ uploadedByUserId: recording.uploaded_by_user_id }, caseHead, viewer),
  ));

  return {
    id: row.id,
    monthKey: row.month_key,
    department: row.department,
    clientName: row.client_name,
    title: row.title,
    sceneTags: tagsOf(row.scene_tags_json),
    background: row.background,
    outcome: row.outcome,
    turningPoints: row.turning_points,
    discussionQuestions: row.discussion_questions,
    revision: Number(row.revision),
    createdByName: row.created_by_name,
    createdAt: isoOrNull(row.created_at) ?? "",
    updatedAt: isoOrNull(row.updated_at) ?? "",
    needAssets: assetsByOwner.get("NEED") ?? [],
    rounds,
    recordings,
    caseNumber: await loadRetroCaseNumber(db, row.id, row.month_key),
    inMinutes: await loadRetroCaseInMinutes(db, row.id, row.month_key),
    viewerCapabilities: { canEdit, canTrash: canEdit, canUploadRecording: true },
  };
}

// ---------------------------------------------------------------------------
// 编辑（规格九 PATCH /api/retro-cases/[id]）
// ---------------------------------------------------------------------------

const PATCH_COLUMNS: Record<string, string> = {
  monthKey: "month_key",
  department: "department",
  clientName: "client_name",
  title: "title",
  background: "background",
  outcome: "outcome",
  turningPoints: "turning_points",
  discussionQuestions: "discussion_questions",
};

export async function patchRetroCase(
  db: DbClient,
  viewer: Pick<RetroViewer, "userId" | "isAdmin">,
  caseId: string,
  body: unknown,
  now: Date = new Date(),
): Promise<RetroPatchCaseResponse> {
  const { fields, revision } = validateRetroCasePatch(body, now);
  const head = await requireEditableRetroCase(db, caseId, viewer);
  if (head.revision !== revision) throw staleCase();

  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
    const value = (fields as Record<string, unknown>)[key];
    if (typeof value === "string") {
      assignments.push(`${column} = ?`);
      values.push(value);
    }
  }
  if (fields.sceneTags) {
    assignments.push(`scene_tags_json = ?::jsonb`);
    values.push(JSON.stringify(fields.sceneTags));
  }

  const updated = await db.withTransaction(async (tx) => {
    const result = await tx.prepare(
      `UPDATE retro_cases SET ${assignments.join(", ")}, revision = revision + 1, updated_at = now()
       WHERE id = ? AND revision = ? AND deleted_at IS NULL
       RETURNING id, month_key, department, client_name, title, scene_tags_json, background, outcome,
                 turning_points, discussion_questions, revision, updated_at`,
    ).bind(...values, caseId, revision).first<QueryResultRow & {
      month_key: string; department: string; client_name: string; title: string; scene_tags_json: unknown;
      background: string; outcome: string; turning_points: string; discussion_questions: string;
      revision: number; updated_at: unknown;
    }>();
    if (!result) return null;
    // 案例换了复盘月份，它的点评录音跟着走（整场总结挂在月份上，不受影响）。
    if (fields.monthKey && fields.monthKey !== head.monthKey) {
      await tx.prepare(`UPDATE retro_recordings SET month_key = ?, updated_at = now() WHERE case_id = ?`).bind(fields.monthKey, caseId).run();
    }
    return result;
  });
  if (!updated) throw staleCase();

  return {
    revision: Number(updated.revision),
    updatedAt: isoOrNull(updated.updated_at) ?? "",
    monthKey: updated.month_key,
    department: updated.department,
    clientName: updated.client_name,
    title: updated.title,
    sceneTags: tagsOf(updated.scene_tags_json),
    background: updated.background,
    outcome: updated.outcome,
    turningPoints: updated.turning_points,
    discussionQuestions: updated.discussion_questions,
  };
}

function staleCase() {
  return retroConflict("REVISION_CONFLICT", "这个案例刚被别人改过，请刷新页面后再改。");
}

// ---------------------------------------------------------------------------
// 回收站（软删除；同视频、公共视觉）
// ---------------------------------------------------------------------------

export async function trashRetroCase(db: DbClient, viewer: Pick<RetroViewer, "userId" | "isAdmin">, caseId: string): Promise<{ ok: true }> {
  const head = await loadRetroCaseHead(db, caseId);
  if (!head || head.deleted) throw retroNotFound("案例不存在或已在回收站中。");
  if (!canEditRetroCase(head, viewer)) throw retroForbidden("只有案例上传者或管理员可以删除案例。");
  const result = await db.prepare(
    `UPDATE retro_cases SET deleted_at = now(), updated_at = now() WHERE id = ? AND deleted_at IS NULL`,
  ).bind(caseId).run();
  if (result.meta.rows_written !== 1) throw retroConflict("ALREADY_TRASHED", "案例已被删除。");
  return { ok: true };
}

export async function restoreRetroCase(db: DbClient, viewer: Pick<RetroViewer, "userId" | "isAdmin">, caseId: string): Promise<{ ok: true }> {
  const head = await loadRetroCaseHead(db, caseId);
  if (!head) throw retroNotFound("案例不存在。");
  if (!canEditRetroCase(head, viewer)) throw retroForbidden("只有案例上传者或管理员可以恢复案例。");
  const result = await db.prepare(
    `UPDATE retro_cases SET deleted_at = NULL, updated_at = now() WHERE id = ? AND deleted_at IS NOT NULL`,
  ).bind(caseId).run();
  if (result.meta.rows_written !== 1) throw retroConflict("NOT_TRASHED", "案例未在回收站中，无需恢复。");
  return { ok: true };
}
