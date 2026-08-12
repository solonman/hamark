import { getDbClient, type DbPreparedStatement } from "@/db";
import { loadAnnotation } from "@/lib/annotation-server";
import { annotationFields } from "@/lib/annotation-fields";
import {
  emptyCreativeStructure,
  V03_TAXONOMY_VERSION,
  V03_VOCABULARY_VERSION,
  V03_WORKFLOW_VERSION,
} from "@/lib/taxonomy-v0.3";
import { newId, requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import type { AnnotationDraft, TaxonomyVersion } from "@/lib/types";

function requestedTaxonomy(request: Request): TaxonomyVersion | null {
  const value = new URL(request.url).searchParams.get("taxonomy") ?? "V0.2";
  return value === "V0.2" || value === V03_TAXONOMY_VERSION ? value : null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const taxonomyVersion = requestedTaxonomy(request);
  if (!taxonomyVersion) {
    return Response.json({ error: "不支持的标注体系版本。" }, { status: 400 });
  }
  const { id } = await context.params;
  const video = await getDbClient()
    .prepare(`SELECT id, title, status FROM videos WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<{ id: string; title: string; status: string }>();

  if (!video) {
    return Response.json({ error: "视频不存在。" }, { status: 404 });
  }

  const annotation = await loadAnnotation(
    id,
    user.identityKey,
    user.displayName,
    taxonomyVersion,
  );
  const published = annotation.id
    ? await getDbClient()
        .prepare(
          `SELECT COUNT(*) AS version_count FROM annotation_snapshots
          WHERE annotation_id = ? AND workflow_status = 'SUBMITTED'`,
        )
        .bind(annotation.id)
        .first<{ version_count: number }>()
    : null;
  return Response.json({
    video,
    annotation,
    seededFromV02: taxonomyVersion === V03_TAXONOMY_VERSION &&
      Boolean(annotation.sourceSnapshotId) && !annotation.baseReleaseId && !annotation.id,
    hasPublishedVersion: Number(published?.version_count ?? 0) > 0,
    publishedVersionCount: Number(published?.version_count ?? 0),
  });
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const taxonomyVersion = requestedTaxonomy(request);
  if (!taxonomyVersion) {
    return Response.json({ error: "不支持的标注体系版本。" }, { status: 400 });
  }
  const { id: videoId } = await context.params;
  const payload = (await request.json()) as AnnotationDraft;
  const db = getDbClient();

  if (taxonomyVersion === "V0.2") {
    return Response.json(
      { error: "V0.2 已归档为历史体系，只读保留；请使用当前逆向体系。" },
      { status: 409 },
    );
  }

  const video = await db
    .prepare(`SELECT id FROM videos WHERE id = ? AND deleted_at IS NULL`)
    .bind(videoId)
    .first();
  if (
    !video ||
    payload.videoId !== videoId ||
    payload.taxonomyVersion !== taxonomyVersion
  ) {
    return Response.json({ error: "视频或标注体系与作业不一致。" }, { status: 400 });
  }

  const existing = await db
    .prepare(
      `SELECT id, revision, source_snapshot_id, review_status,
        base_release_id, base_snapshot_id, source_public_snapshot_id
      FROM annotations
      WHERE video_id = ? AND author_email = ? AND taxonomy_version = ?
        AND deleted_at IS NULL`,
    )
    .bind(videoId, user.identityKey, taxonomyVersion)
    .first<{
      id: string;
      revision: number;
      source_snapshot_id: string | null;
      review_status: string;
      base_release_id: string | null;
      base_snapshot_id: string | null;
      source_public_snapshot_id: string | null;
    }>();

  if (
    existing &&
    (existing.review_status === "PENDING_REVIEW" ||
      existing.review_status === "PENDING_REREVIEW")
  ) {
    return Response.json(
      {
        error: "这份提交正在终审，当前轮次结束前不能并行修改。",
        code: "ACTIVE_REVIEW_LOCK",
      },
      { status: 423 },
    );
  }

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
  const isV03 = taxonomyVersion === V03_TAXONOMY_VERSION;
  const shotGroups = isV03 ? (payload.shotGroups ?? []).slice(0, 100) : [];
  const validGroupIds = new Set(shotGroups.map((group) => group.id));
  const structure = payload.creativeStructure ?? emptyCreativeStructure();
  const workflowVersion = isV03
    ? V03_WORKFLOW_VERSION
    : "REVERSE-WORKFLOW-V0.2";
  const requestedSource =
    isV03 && payload.sourceSnapshotId
      ? await db
          .prepare(
            `SELECT id FROM annotation_snapshots
            WHERE id = ? AND video_id = ? AND author_email = ?
              AND taxonomy_version = 'V0.2'`,
          )
          .bind(payload.sourceSnapshotId, videoId, user.identityKey)
          .first<{ id: string }>()
      : null;
  const sourceSnapshotId =
    requestedSource?.id ?? existing?.source_snapshot_id ?? null;
  const requestedBaseline = isV03 && payload.baseReleaseId
    ? await db.prepare(
        `SELECT id, approved_snapshot_id, source_snapshot_id
        FROM approved_analysis_releases
        WHERE id = ? AND video_id = ? AND status = 'ACTIVE'`,
      ).bind(payload.baseReleaseId, videoId).first<{
        id: string; approved_snapshot_id: string; source_snapshot_id: string;
      }>()
    : null;
  const baseReleaseId = requestedBaseline?.id ?? existing?.base_release_id ?? null;
  const baseSnapshotId = requestedBaseline?.approved_snapshot_id ?? existing?.base_snapshot_id ?? null;
  const sourcePublicSnapshotId = requestedBaseline?.source_snapshot_id ?? existing?.source_public_snapshot_id ?? null;

  const statements: DbPreparedStatement[] = [];
  if (existing) {
    statements.push(
      db
        .prepare(
          `UPDATE annotations SET
            author_name = ?, workflow_version = ?, source_snapshot_id = ?,
            base_release_id = ?, base_snapshot_id = ?, source_public_snapshot_id = ?,
            status = 'DRAFT',
            review_status = CASE WHEN review_status = 'APPROVED' THEN 'DRAFT' ELSE review_status END,
            revision = ?, analysis_title = ?,
            commercial_intent = ?, creative_theme = ?, synopsis = ?,
            thinking_chain = ?, shot_commentary = ?, summary = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND author_email = ? AND taxonomy_version = ?`,
        )
        .bind(
          user.displayName,
          workflowVersion,
          sourceSnapshotId,
          baseReleaseId,
          baseSnapshotId,
          sourcePublicSnapshotId,
          nextRevision,
          payload.analysisTitle.trim(),
          payload.commercialIntent.trim(),
          payload.creativeTheme.trim(),
          payload.synopsis.trim(),
          payload.thinkingChain.trim(),
          payload.shotCommentary.trim(),
          payload.summary.trim(),
          annotationId,
          user.identityKey,
          taxonomyVersion,
        ),
    );
  } else {
    statements.push(
      db
        .prepare(
          `INSERT INTO annotations (
            id, video_id, author_email, author_name, taxonomy_version,
            workflow_version, source_snapshot_id, status, revision,
            base_release_id, base_snapshot_id, source_public_snapshot_id,
            analysis_title, commercial_intent, creative_theme, synopsis,
            thinking_chain, shot_commentary, summary
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          annotationId,
          videoId,
          user.identityKey,
          user.displayName,
          taxonomyVersion,
          workflowVersion,
          sourceSnapshotId,
          nextRevision,
          baseReleaseId,
          baseSnapshotId,
          sourcePublicSnapshotId,
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
    db.prepare(`DELETE FROM shot_groups WHERE annotation_id = ?`).bind(annotationId),
    db.prepare(`DELETE FROM field_answers WHERE annotation_id = ?`).bind(annotationId),
    db
      .prepare(`DELETE FROM annotation_creative_structures WHERE annotation_id = ?`)
      .bind(annotationId),
  );

  shotGroups.forEach((group, index) => {
    const auxiliaries = [...new Set(group.auxiliaryRoles)].slice(0, 2);
    statements.push(
      db
        .prepare(
          `INSERT INTO shot_groups (
            id, annotation_id, order_index, title, primary_role_id,
            primary_role_name_snapshot, auxiliary_roles_json, custom_role,
            note, taxonomy_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          group.id || newId("group"),
          annotationId,
          index,
          group.title.trim(),
          group.primaryRole,
          group.primaryRole,
          JSON.stringify(auxiliaries),
          group.customRole.trim(),
          group.note.trim(),
          taxonomyVersion,
        ),
    );
  });

  shots.forEach((shot, index) => {
    const groupId =
      isV03 && shot.shotGroupId && validGroupIds.has(shot.shotGroupId)
        ? shot.shotGroupId
        : null;
    const groupName = isV03
      ? shotGroups.find((group) => group.id === groupId)?.title ?? ""
      : shot.groupName ?? "";
    statements.push(
      db
        .prepare(
          `INSERT INTO shots (
            id, annotation_id, order_index, group_name, shot_number,
            start_time, end_time, shot_size, camera_angle, camera_movement,
            visual_content, dialogue, voiceover, screen_text, sound_effect,
            music, creative_comment, shot_group_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          shot.id || newId("shot"),
          annotationId,
          index,
          groupName,
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
          isV03 ? "" : shot.creativeComment ?? "",
          groupId,
        ),
    );
  });

  fields.forEach((field) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO field_answers (
            id, annotation_id, field_code, answer, evidence, source
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newId("field"),
          annotationId,
          field.code,
          field.answer ?? "",
          field.evidence ?? "",
          field.source ?? "HUMAN_ORIGINAL",
        ),
    );
  });

  if (isV03) {
    statements.push(
      db
        .prepare(
          `INSERT INTO annotation_creative_structures (
            annotation_id, vocabulary_version, creative_button, mechanism_statement,
            mechanism_primary, mechanism_auxiliary_json, mechanism_custom,
            realization_skeleton, brand_product_landing,
            story_reference_type, story_archetype, primary_creative_path,
            auxiliary_creative_paths_json, composite_state_reason,
            formation_primary, formation_auxiliary_json, formation_statement,
            formation_related_group_ids_json, creative_carriers,
            establishment_conditions, strength_sources, acceptance_contract,
            audiovisual_mechanism, information_release_turning, creative_grade,
            creative_grade_reason, creative_grade_version,
            main_path_payload_json, auxiliary_path_notes_json,
            condition_flags_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          annotationId,
          V03_VOCABULARY_VERSION,
          structure.creativeButton.trim(),
          structure.mechanismStatement.trim(),
          structure.mechanismPrimary,
          JSON.stringify([...new Set(structure.mechanismAuxiliary)].slice(0, 2)),
          structure.mechanismCustom.trim(),
          (structure.creativeRealizationPath || structure.realizationSkeleton).trim(),
          structure.brandProductLanding.trim(),
          structure.storyReferenceType.trim(),
          structure.storyArchetype.trim(),
          structure.primaryCreativePath,
          JSON.stringify([...new Set(structure.auxiliaryCreativePaths)].slice(0, 2)),
          structure.compositeStateReason.trim(),
          structure.formationPrimary,
          JSON.stringify([...new Set(structure.formationAuxiliary)].slice(0, 2)),
          structure.formationStatement.trim(),
          JSON.stringify(structure.formationRelatedGroupIds.filter((id) => validGroupIds.has(id))),
          structure.creativeCarriers.trim(),
          structure.establishmentConditions.trim(),
          structure.strengthSources.trim(),
          structure.acceptanceContract.trim(),
          structure.audiovisualMechanism.trim(),
          structure.informationReleaseTurning.trim(),
          structure.creativeGrade,
          structure.creativeGradeReason.trim(),
          structure.creativeGradeVersion,
          JSON.stringify(structure.mainPathPayload),
          JSON.stringify(structure.auxiliaryPathNotes),
          JSON.stringify(structure.conditionFlags),
        ),
    );
  }

  await db.batch(statements);
  return Response.json({
    ok: true,
    annotationId,
    revision: nextRevision,
    status: "DRAFT",
    taxonomyVersion,
    updatedAt: new Date().toISOString(),
  });
}
