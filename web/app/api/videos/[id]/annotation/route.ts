import { ensureSchema } from "@/db/bootstrap";
import { getDbClient, type DbPreparedStatement } from "@/db";
import { loadAnnotation } from "@/lib/annotation-server";
import { annotationFields } from "@/lib/annotation-fields";
import { currentUserFromRequest, newId } from "@/lib/current-user";
import type { AnnotationDraft } from "@/lib/types";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await ensureSchema();
  const { id } = await context.params;
  const user = currentUserFromRequest(request);
  const video = await getDbClient()
    .prepare(`SELECT id, title, status FROM videos WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<{ id: string; title: string; status: string }>();

  if (!video) {
    return Response.json({ error: "视频不存在。" }, { status: 404 });
  }

  const annotation = await loadAnnotation(id, user.email, user.name);
  const published = annotation.id
    ? await getDbClient()
        .prepare(
          `SELECT id FROM annotation_snapshots
          WHERE annotation_id = ? LIMIT 1`,
        )
        .bind(annotation.id)
        .first<{ id: string }>()
    : null;
  return Response.json({
    video,
    annotation,
    hasPublishedVersion: Boolean(published),
  });
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await ensureSchema();
  const { id: videoId } = await context.params;
  const user = currentUserFromRequest(request);
  const payload = (await request.json()) as AnnotationDraft;
  const db = getDbClient();

  const video = await db
    .prepare(`SELECT id FROM videos WHERE id = ? AND deleted_at IS NULL`)
    .bind(videoId)
    .first();
  if (!video || payload.videoId !== videoId) {
    return Response.json({ error: "视频不存在或作业对象不一致。" }, { status: 404 });
  }

  const existing = await db
    .prepare(
      `SELECT id, revision FROM annotations
      WHERE video_id = ? AND author_email = ? AND deleted_at IS NULL`,
    )
    .bind(videoId, user.email)
    .first<{ id: string; revision: number }>();

  if (existing && existing.revision !== payload.revision) {
    return Response.json(
      {
        error: "这份作业已在其他页面更新，请刷新后继续。",
        code: "REVISION_CONFLICT",
        serverRevision: existing.revision,
      },
      { status: 409 },
    );
  }

  const annotationId = existing?.id ?? newId("annotation");
  const nextRevision = (existing?.revision ?? 0) + 1;
  const validCodes = new Set(annotationFields.map((field) => field.code));
  const fields = payload.fields.filter((field) => validCodes.has(field.code));
  const shots = payload.shots.slice(0, 500);

  const statements: DbPreparedStatement[] = [];
  if (existing) {
    statements.push(
      db
        .prepare(
          `UPDATE annotations SET
            author_name = ?, status = 'DRAFT', revision = ?,
            analysis_title = ?, commercial_intent = ?, creative_theme = ?,
            synopsis = ?, thinking_chain = ?, shot_commentary = ?, summary = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND author_email = ?`,
        )
        .bind(
          user.name,
          nextRevision,
          payload.analysisTitle.trim(),
          payload.commercialIntent.trim(),
          payload.creativeTheme.trim(),
          payload.synopsis.trim(),
          payload.thinkingChain.trim(),
          payload.shotCommentary.trim(),
          payload.summary.trim(),
          annotationId,
          user.email,
        ),
    );
  } else {
    statements.push(
      db
        .prepare(
          `INSERT INTO annotations (
            id, video_id, author_email, author_name, taxonomy_version,
            status, revision, analysis_title, commercial_intent, creative_theme,
            synopsis, thinking_chain, shot_commentary, summary
          ) VALUES (?, ?, ?, ?, 'V0.2', 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          annotationId,
          videoId,
          user.email,
          user.name,
          nextRevision,
          payload.analysisTitle.trim(),
          payload.commercialIntent.trim(),
          payload.creativeTheme.trim(),
          payload.synopsis.trim(),
          payload.thinkingChain.trim(),
          payload.shotCommentary.trim(),
          payload.summary.trim(),
        ),
    );
  }

  statements.push(
    db.prepare(`DELETE FROM shots WHERE annotation_id = ?`).bind(annotationId),
    db
      .prepare(`DELETE FROM field_answers WHERE annotation_id = ?`)
      .bind(annotationId),
  );

  shots.forEach((shot, index) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO shots (
            id, annotation_id, order_index, group_name, shot_number,
            start_time, end_time, shot_size, camera_angle, camera_movement,
            visual_content, dialogue, voiceover, screen_text, sound_effect,
            music, creative_comment
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          shot.id || newId("shot"),
          annotationId,
          index,
          shot.groupName ?? "",
          shot.shotNumber || String(index + 1),
          shot.startTime ?? "",
          shot.endTime ?? "",
          shot.shotSize ?? "",
          shot.cameraAngle ?? "",
          shot.cameraMovement ?? "",
          shot.visualContent ?? "",
          shot.dialogue ?? "",
          shot.voiceover ?? "",
          shot.screenText ?? "",
          shot.soundEffect ?? "",
          shot.music ?? "",
          shot.creativeComment ?? "",
        ),
    );
  });

  fields.forEach((field) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO field_answers (
            id, annotation_id, field_code, answer, evidence
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          newId("field"),
          annotationId,
          field.code,
          field.answer ?? "",
          field.evidence ?? "",
        ),
    );
  });

  await db.batch(statements);
  return Response.json({
    ok: true,
    annotationId,
    revision: nextRevision,
    status: "DRAFT",
    updatedAt: new Date().toISOString(),
  });
}
