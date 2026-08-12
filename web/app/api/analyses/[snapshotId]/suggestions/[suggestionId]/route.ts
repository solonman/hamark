import { getDbClient, withDbTransaction, type DbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import {
  parseAnalysisTarget,
  resolveAnchoredReplacement,
  type ParsedAnalysisTarget,
} from "@/lib/analysis-targets";
import {
  newId,
  requireApiUser,
  requireSameOriginMutation,
} from "@/lib/current-user";

type SuggestionRow = {
  id: string;
  submission_id: string;
  annotation_id: string;
  video_id: string;
  submission_author_email: string;
  target_key: string;
  selected_text: string;
  anchor_start: number;
  anchor_end: number;
  replacement_text: string;
  status: "PENDING" | "ACCEPTED" | "REJECTED";
  applied_revision: number | null;
};

export async function PATCH(
  request: Request,
  context: {
    params: Promise<{ snapshotId: string; suggestionId: string }>;
  },
) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { snapshotId, suggestionId } = await context.params;
  const payload = (await request.json()) as { status?: unknown };
  if (payload.status !== "ACCEPTED" && payload.status !== "REJECTED") {
    return Response.json({ error: "修订处理状态无效。" }, { status: 400 });
  }

  const suggestion = await loadSuggestion(getDbClient(), snapshotId, suggestionId);
  if (!suggestion) {
    return Response.json({ error: "修订建议不存在。" }, { status: 404 });
  }
  if (
    suggestion.submission_author_email !== user.identityKey &&
    !(await isAppAdmin(user))
  ) {
    return Response.json(
      { error: "只有作业作者或管理员可以处理修订建议。" },
      { status: 403 },
    );
  }
  if (suggestion.status !== "PENDING") {
    return Response.json({
      ok: true,
      status: suggestion.status,
      appliedRevision: suggestion.applied_revision,
    });
  }

  if (payload.status === "REJECTED") {
    await getDbClient()
      .prepare(
        `UPDATE analysis_revision_suggestions
        SET status = 'REJECTED', decided_by_email = ?, decided_by_name = ?,
          decided_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND submission_id = ? AND status = 'PENDING'`,
      )
      .bind(
        user.identityKey,
        user.displayName,
        new Date().toISOString(),
        suggestionId,
        snapshotId,
      )
      .run();
    return Response.json({ ok: true, status: "REJECTED" });
  }

  const target = parseAnalysisTarget(suggestion.target_key);
  if (!target) {
    return Response.json({ error: "当前内容项不支持修订。" }, { status: 400 });
  }

  try {
    const result = await withDbTransaction(async (db) => {
      const locked = await loadSuggestion(db, snapshotId, suggestionId, true);
      if (!locked || locked.status !== "PENDING") {
        return {
          status: locked?.status ?? "MISSING",
          appliedRevision: locked?.applied_revision ?? null,
        };
      }
      const annotation = await db
        .prepare(
          `SELECT revision FROM annotations
          WHERE id = ? AND video_id = ? AND deleted_at IS NULL
          FOR UPDATE`,
        )
        .bind(locked.annotation_id, locked.video_id)
        .first<{ revision: number }>();
      if (!annotation) return { status: "MISSING", appliedRevision: null };

      const currentValue = await readTargetValue(db, locked, target);
      if (currentValue == null) {
        return { status: "TARGET_MISSING", appliedRevision: null };
      }
      const nextValue = resolveAnchoredReplacement({
        currentValue,
        selectedText: locked.selected_text,
        anchorStart: Number(locked.anchor_start),
        anchorEnd: Number(locked.anchor_end),
        replacementText: locked.replacement_text,
      });
      if (nextValue == null) {
        return { status: "CONTENT_CHANGED", appliedRevision: null };
      }

      await writeTargetValue(db, locked, target, currentValue, nextValue);
      const nextRevision = Number(annotation.revision) + 1;
      await db.batch([
        db
          .prepare(
            `UPDATE annotations
            SET status = 'DRAFT', revision = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
          )
          .bind(nextRevision, locked.annotation_id),
        db
          .prepare(
            `UPDATE analysis_revision_suggestions
            SET status = 'ACCEPTED', decided_by_email = ?, decided_by_name = ?,
              decided_at = ?, applied_revision = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND submission_id = ? AND status = 'PENDING'`,
          )
          .bind(
            user.identityKey,
            user.displayName,
            new Date().toISOString(),
            nextRevision,
            suggestionId,
            snapshotId,
          ),
        db
          .prepare(
            `INSERT INTO audit_logs (
              id, actor_email, action, object_type, object_id, detail_json
            ) VALUES (?, ?, 'REVISION_SUGGESTION_ACCEPTED', 'REVISION_SUGGESTION', ?, ?)`,
          )
          .bind(
            newId("audit"),
            user.identityKey,
            suggestionId,
            JSON.stringify({ snapshotId, targetKey: locked.target_key, nextRevision }),
          ),
      ]);
      return { status: "ACCEPTED", appliedRevision: nextRevision };
    });

    if (result.status === "CONTENT_CHANGED") {
      return Response.json(
        { error: "个人草稿中的该段内容已变化，请先查看最新草稿。" },
        { status: 409 },
      );
    }
    if (result.status === "MISSING" || result.status === "TARGET_MISSING") {
      return Response.json({ error: "修订目标已不存在。" }, { status: 404 });
    }
    return Response.json({
      ok: true,
      status: result.status,
      appliedRevision: result.appliedRevision,
    });
  } catch (error) {
    console.error("Accept revision suggestion failed", {
      requestId: newId("revision_error"),
      suggestionId,
      error,
    });
    return Response.json({ error: "修订应用失败，请稍后重试。" }, { status: 500 });
  }
}

async function loadSuggestion(
  db: DbClient,
  snapshotId: string,
  suggestionId: string,
  lock = false,
) {
  return db
    .prepare(
      `SELECT r.id, r.submission_id, s.annotation_id, r.video_id,
        s.author_email AS submission_author_email, r.target_key,
        r.selected_text, r.anchor_start, r.anchor_end, r.replacement_text,
        r.status, r.applied_revision
      FROM analysis_revision_suggestions r
      INNER JOIN annotation_snapshots s ON s.id = r.submission_id
      WHERE r.id = ? AND r.submission_id = ? AND r.deleted_at IS NULL
      ${lock ? "FOR UPDATE" : ""}`,
    )
    .bind(suggestionId, snapshotId)
    .first<SuggestionRow>();
}

async function readTargetValue(
  db: DbClient,
  suggestion: SuggestionRow,
  target: ParsedAnalysisTarget,
) {
  if (target.scope === "annotation") {
    const row = await db
      .prepare(
        `SELECT ${target.column} AS value FROM annotations WHERE id = ? FOR UPDATE`,
      )
      .bind(suggestion.annotation_id)
      .first<{ value: string }>();
    return row?.value ?? null;
  }
  if (target.scope === "shot") {
    const row = await db
      .prepare(
        `SELECT ${target.column} AS value FROM shots
        WHERE id = ? AND annotation_id = ? FOR UPDATE`,
      )
      .bind(target.shotId, suggestion.annotation_id)
      .first<{ value: string }>();
    return row?.value ?? null;
  }
  if (target.scope === "shot-group") {
    const row = await db
      .prepare(
        `SELECT ${target.column} AS value FROM shot_groups
        WHERE id = ? AND annotation_id = ? FOR UPDATE`,
      )
      .bind(target.groupId, suggestion.annotation_id)
      .first<{ value: string }>();
    return row?.value ?? null;
  }
  if (target.scope === "creative-structure") {
    const row = await db
      .prepare(
        `SELECT ${target.column} AS value FROM annotation_creative_structures
        WHERE annotation_id = ? FOR UPDATE`,
      )
      .bind(suggestion.annotation_id)
      .first<{ value: string }>();
    return row?.value ?? null;
  }
  if (target.scope === "creative-structure-json") {
    const row = await db
      .prepare(
        `SELECT ${target.column} AS value FROM annotation_creative_structures
        WHERE annotation_id = ? FOR UPDATE`,
      )
      .bind(suggestion.annotation_id)
      .first<{ value: string }>();
    if (!row) return null;
    try {
      const values = JSON.parse(row.value || "{}") as Record<string, string>;
      return values[target.itemKey] ?? "";
    } catch {
      return null;
    }
  }
  if (
    target.scope === "shot-group-structured" ||
    target.scope === "creative-structure-structured"
  ) {
    return null;
  }
  const row = await db
    .prepare(
      `SELECT ${target.column} AS value FROM field_answers
      WHERE annotation_id = ? AND field_code = ? FOR UPDATE`,
    )
    .bind(suggestion.annotation_id, target.fieldCode)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function writeTargetValue(
  db: DbClient,
  suggestion: SuggestionRow,
  target: ParsedAnalysisTarget,
  currentValue: string,
  value: string,
) {
  if (target.scope === "annotation") {
    await db
      .prepare(`UPDATE annotations SET ${target.column} = ? WHERE id = ?`)
      .bind(value, suggestion.annotation_id)
      .run();
    return;
  }
  if (target.scope === "shot") {
    if (target.property === "groupName") {
      const result = await db
        .prepare(
          `SELECT id, group_name FROM shots
          WHERE annotation_id = ? ORDER BY order_index ASC FOR UPDATE`,
        )
        .bind(suggestion.annotation_id)
        .all<{ id: string; group_name: string }>();
      const targetIndex = result.results.findIndex(
        (shot) => shot.id === target.shotId,
      );
      if (targetIndex < 0) return;
      let first = targetIndex;
      let last = targetIndex;
      while (
        first > 0 &&
        result.results[first - 1].group_name === currentValue
      ) {
        first -= 1;
      }
      while (
        last + 1 < result.results.length &&
        result.results[last + 1].group_name === currentValue
      ) {
        last += 1;
      }
      await db.batch(
        result.results.slice(first, last + 1).map((shot) =>
          db
            .prepare(
              `UPDATE shots SET group_name = ?
              WHERE id = ? AND annotation_id = ?`,
            )
            .bind(value, shot.id, suggestion.annotation_id),
        ),
      );
      return;
    }
    await db
      .prepare(
        `UPDATE shots SET ${target.column} = ? WHERE id = ? AND annotation_id = ?`,
      )
      .bind(value, target.shotId, suggestion.annotation_id)
      .run();
    return;
  }
  if (target.scope === "shot-group") {
    await db
      .prepare(
        `UPDATE shot_groups SET ${target.column} = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND annotation_id = ?`,
      )
      .bind(value, target.groupId, suggestion.annotation_id)
      .run();
    if (target.property === "title") {
      await db
        .prepare(
          `UPDATE shots SET group_name = ?
          WHERE shot_group_id = ? AND annotation_id = ?`,
        )
        .bind(value, target.groupId, suggestion.annotation_id)
        .run();
    }
    return;
  }
  if (target.scope === "creative-structure") {
    await db
      .prepare(
        `UPDATE annotation_creative_structures
        SET ${target.column} = ?, updated_at = CURRENT_TIMESTAMP
        WHERE annotation_id = ?`,
      )
      .bind(value, suggestion.annotation_id)
      .run();
    return;
  }
  if (target.scope === "creative-structure-json") {
    const row = await db
      .prepare(
        `SELECT ${target.column} AS value FROM annotation_creative_structures
        WHERE annotation_id = ? FOR UPDATE`,
      )
      .bind(suggestion.annotation_id)
      .first<{ value: string }>();
    const values = (() => {
      try {
        return JSON.parse(row?.value || "{}") as Record<string, string>;
      } catch {
        return {} as Record<string, string>;
      }
    })();
    values[target.itemKey] = value;
    await db
      .prepare(
        `UPDATE annotation_creative_structures
        SET ${target.column} = ?, updated_at = CURRENT_TIMESTAMP
        WHERE annotation_id = ?`,
      )
      .bind(JSON.stringify(values), suggestion.annotation_id)
      .run();
    return;
  }
  if (
    target.scope === "shot-group-structured" ||
    target.scope === "creative-structure-structured"
  ) {
    throw new Error("STRUCTURED_REVISION_REQUIRES_V03_WORKFLOW");
  }
  await db
    .prepare(
      `UPDATE field_answers SET ${target.column} = ?
      WHERE annotation_id = ? AND field_code = ?`,
    )
    .bind(value, suggestion.annotation_id, target.fieldCode)
    .run();
}
