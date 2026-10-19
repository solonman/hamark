// 回合的增、改、软删、整体重排，以及回合上的关联作品（规格 4.2、4.4、九）。
// 回合软删除：行保留，已发布成果里的「第二版」标记仍然能找到它。

import type { DbClient, QueryResultRow } from "@/db";
import {
  RETRO_LIMITS,
  type RetroLinkKind,
  type RetroLinkView,
  type RetroPatchRoundResponse,
  type RetroRoundView,
} from "@/lib/retro-model";
import type { VideoBucket } from "@/storage/types";
import type { RetroViewer } from "./access";
import { requireEditableRetroCase, touchRetroCase } from "./case-head";
import { retroConflict, retroInvalid, retroNotFound } from "./errors";
import { RETRO_ROUND_COLUMNS, buildRetroLinkViews, fetchRetroLinkTargets, toRetroRoundView, type RetroRoundRow } from "./views";
import {
  validateRetroLinks,
  validateRetroNewRoundTitle,
  validateRetroRoundOrder,
  validateRetroRoundPatch,
} from "./validate";
import { retroNewId } from "./keys";

type Editor = Pick<RetroViewer, "userId" | "isAdmin">;
type SigningBucket = Pick<VideoBucket, "createPresignedGetUrl">;

const ROUND_COLUMN_BY_FIELD = {
  title: "title",
  occurredOn: "occurred_on",
  deliveryText: "delivery_text",
  feedbackText: "feedback_text",
  responseText: "response_text",
} as const;

async function liveRoundIds(db: DbClient, caseId: string): Promise<string[]> {
  const rows = await db.prepare(`SELECT id FROM retro_case_rounds WHERE case_id = ? AND deleted_at IS NULL ORDER BY position ASC`)
    .bind(caseId).all<QueryResultRow & { id: string }>();
  return rows.results.map((row) => row.id);
}

/** 回合必须属于这个案例且没被删。 */
async function requireLiveRound(db: DbClient, caseId: string, roundId: string) {
  const row = await db.prepare(
    `SELECT id, revision FROM retro_case_rounds WHERE id = ? AND case_id = ? AND deleted_at IS NULL`,
  ).bind(roundId, caseId).first<QueryResultRow & { id: string; revision: number }>();
  if (!row) throw retroNotFound("回合不存在或已删除。");
  return { id: row.id, revision: Number(row.revision) };
}

export async function addRetroRound(db: DbClient, viewer: Editor, caseId: string, body: unknown): Promise<RetroRoundView> {
  const roundId = retroNewId("rnd");
  await db.withTransaction(async (tx) => {
    // 锁住案例行，串行化同一个案例上的并发新增，回合数上限和 position 才不会算岔。
    await requireEditableRetroCase(tx, caseId, viewer, { lock: true });
    const count = (await liveRoundIds(tx, caseId)).length;
    if (count >= RETRO_LIMITS.roundsMax) throw retroInvalid(`一个案例最多 ${RETRO_LIMITS.roundsMax} 个回合。`);
    const title = validateRetroNewRoundTitle(body, `第 ${count + 1} 版`);
    await tx.prepare(`INSERT INTO retro_case_rounds (id, case_id, position, title) VALUES (?, ?, ?, ?)`)
      .bind(roundId, caseId, count, title).run();
    await touchRetroCase(tx, caseId);
  });
  const row = await db.prepare(`SELECT ${RETRO_ROUND_COLUMNS} FROM retro_case_rounds WHERE id = ?`).bind(roundId).first<RetroRoundRow>();
  return toRetroRoundView(row!, [], []);
}

export async function patchRetroRound(
  db: DbClient,
  viewer: Editor,
  caseId: string,
  roundId: string,
  body: unknown,
): Promise<RetroPatchRoundResponse> {
  const { fields, revision } = validateRetroRoundPatch(body);
  await requireEditableRetroCase(db, caseId, viewer);
  const current = await requireLiveRound(db, caseId, roundId);
  if (current.revision !== revision) throw staleRound();

  const assignments: string[] = [];
  const values: string[] = [];
  for (const [field, column] of Object.entries(ROUND_COLUMN_BY_FIELD)) {
    const value = (fields as Record<string, unknown>)[field];
    if (typeof value === "string") {
      assignments.push(`${column} = ?`);
      values.push(value);
    }
  }
  const row = await db.prepare(
    `UPDATE retro_case_rounds SET ${assignments.join(", ")}, revision = revision + 1, updated_at = now()
     WHERE id = ? AND case_id = ? AND revision = ? AND deleted_at IS NULL
     RETURNING ${RETRO_ROUND_COLUMNS}`,
  ).bind(...values, roundId, caseId, revision).first<RetroRoundRow>();
  if (!row) throw staleRound();
  await touchRetroCase(db, caseId);
  return {
    round: {
      id: row.id,
      title: row.title,
      occurredOn: row.occurred_on,
      deliveryText: row.delivery_text,
      feedbackText: row.feedback_text,
      responseText: row.response_text,
      revision: Number(row.revision),
    },
  };
}

function staleRound() {
  return retroConflict("REVISION_CONFLICT", "这个回合刚被别人改过，请刷新页面后再改。");
}

export async function deleteRetroRound(db: DbClient, viewer: Editor, caseId: string, roundId: string): Promise<{ ok: true }> {
  await db.withTransaction(async (tx) => {
    await requireEditableRetroCase(tx, caseId, viewer, { lock: true });
    await requireLiveRound(tx, caseId, roundId);
    await tx.prepare(`UPDATE retro_case_rounds SET deleted_at = now(), updated_at = now() WHERE id = ? AND case_id = ?`)
      .bind(roundId, caseId).run();
    // 剩下的回合重新排成 0..n-1，新增回合接在最后才不会和旧位置撞。
    const remaining = await liveRoundIds(tx, caseId);
    for (let index = 0; index < remaining.length; index += 1) {
      await tx.prepare(`UPDATE retro_case_rounds SET position = ? WHERE id = ?`).bind(index, remaining[index]).run();
    }
    await touchRetroCase(tx, caseId);
  });
  return { ok: true };
}

export async function reorderRetroRounds(db: DbClient, viewer: Editor, caseId: string, body: unknown): Promise<{ ok: true }> {
  await db.withTransaction(async (tx) => {
    await requireEditableRetroCase(tx, caseId, viewer, { lock: true });
    const ids = validateRetroRoundOrder(body, await liveRoundIds(tx, caseId));
    for (let index = 0; index < ids.length; index += 1) {
      await tx.prepare(`UPDATE retro_case_rounds SET position = ? WHERE id = ? AND case_id = ?`).bind(index, ids[index], caseId).run();
    }
    await touchRetroCase(tx, caseId);
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 关联作品：整体写回（规格 4.4、九 PUT …/rounds/[roundId]/links）
// ---------------------------------------------------------------------------

export async function putRetroRoundLinks(
  db: DbClient,
  bucket: SigningBucket,
  viewer: Editor,
  caseId: string,
  roundId: string,
  body: unknown,
): Promise<RetroLinkView[]> {
  const links = validateRetroLinks(body);
  await db.withTransaction(async (tx) => {
    await requireEditableRetroCase(tx, caseId, viewer, { lock: true });
    await requireLiveRound(tx, caseId, roundId);

    const existing = await tx.prepare(`SELECT target_kind, target_id FROM retro_round_links WHERE round_id = ?`)
      .bind(roundId).all<QueryResultRow & { target_kind: string; target_id: string }>();
    const already = new Set(existing.results.map((row) => `${row.target_kind}:${row.target_id}`));
    // 新加的必须是真实存在、没被删的作品；原来就挂着的（哪怕原作品后来删了）整体写回时照样保留。
    const fresh = links.filter((link) => !already.has(`${link.kind}:${link.targetId}`));
    if (fresh.length > 0) {
      const found = await fetchRetroLinkTargets(tx, fresh);
      for (const link of fresh) {
        const target = found.get(`${link.kind}:${link.targetId}`);
        if (!target || target.deleted) throw retroInvalid("有作品找不到或已被删除，不能关联，请刷新后重试。");
      }
    }

    await tx.prepare(`DELETE FROM retro_round_links WHERE round_id = ?`).bind(roundId).run();
    for (let index = 0; index < links.length; index += 1) {
      await tx.prepare(`INSERT INTO retro_round_links (round_id, target_kind, target_id, position) VALUES (?, ?, ?, ?)`)
        .bind(roundId, links[index].kind as RetroLinkKind, links[index].targetId, index).run();
    }
    await touchRetroCase(tx, caseId);
  });
  return buildRetroLinkViews(db, bucket, links.map((link) => ({ target_kind: link.kind, target_id: link.targetId })));
}
