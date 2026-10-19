// 案例的「头」：权限判定和各个子服务（回合、附件、关联、录音）开工前都要先查的几个字段。

import type { DbClient, QueryResultRow } from "@/db";
import { canEditRetroCase, type RetroViewer } from "./access";
import { retroForbidden, retroNotFound } from "./errors";

export type RetroCaseHead = {
  id: string;
  monthKey: string;
  createdByUserId: string;
  createdByName: string;
  revision: number;
  deleted: boolean;
};

type HeadRow = QueryResultRow & {
  id: string;
  month_key: string;
  created_by_user_id: string;
  created_by_name: string;
  revision: number;
  deleted_at: unknown;
};

export async function loadRetroCaseHead(
  db: DbClient,
  caseId: string,
  options: { lock?: boolean } = {},
): Promise<RetroCaseHead | null> {
  const row = await db.prepare(
    `SELECT id, month_key, created_by_user_id, created_by_name, revision, deleted_at
     FROM retro_cases WHERE id = ?${options.lock ? " FOR UPDATE" : ""}`,
  ).bind(caseId).first<HeadRow>();
  if (!row) return null;
  return {
    id: row.id,
    monthKey: row.month_key,
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    revision: Number(row.revision),
    deleted: row.deleted_at !== null && row.deleted_at !== undefined,
  };
}

/** 取一个没进回收站的案例，并要求 viewer 有编辑权：不存在或已删 404，没权限 403。 */
export async function requireEditableRetroCase(
  db: DbClient,
  caseId: string,
  viewer: Pick<RetroViewer, "userId" | "isAdmin">,
  options: { lock?: boolean; forbiddenMessage?: string } = {},
): Promise<RetroCaseHead> {
  const head = await loadRetroCaseHead(db, caseId, { lock: options.lock });
  if (!head || head.deleted) throw retroNotFound("案例不存在或已进入回收站。");
  if (!canEditRetroCase(head, viewer)) throw retroForbidden(options.forbiddenMessage ?? "只有案例上传者或管理员可以修改这个案例。");
  return head;
}

/** 案例有变动就把 updated_at 往前推（不动 revision：revision 只管基本信息与收尾字段的乐观锁）。 */
export async function touchRetroCase(db: DbClient, caseId: string) {
  await db.prepare(`UPDATE retro_cases SET updated_at = now() WHERE id = ?`).bind(caseId).run();
}
