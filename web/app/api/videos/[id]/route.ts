import { getDbClient, getVideoBucket } from "@/db";
import { isFinalReviewer } from "@/lib/admin";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { loadSharedV03ReadModel } from "@/lib/v03-collaboration";
import { v04IdempotencyKey, v04Route } from "@/lib/v04-api";
import {
  trashVideoWithSchemaCompatibility,
  videoUploaderMatches,
} from "@/lib/legacy-video-schema-compat";
import type { VideoUploaderIdentity } from "@/lib/legacy-video-schema-compat";

type VideoDetailRow = {
  id: string;
  title: string;
  brand: string;
  description: string;
  tags_json: string;
  object_key: string;
  thumbnail_key: string | null;
  original_name: string;
  content_type: string;
  file_size: number;
  status: string;
  created_by_email: string;
  created_by_user_id: string | null;
  created_by_name: string;
  created_at: string;
};

type SnapshotRow = {
  id: string;
  annotation_id: string;
  author_email: string;
  author_name: string;
  taxonomy_version: string;
  revision: number;
  payload_json: string;
  content_hash: string;
  created_at: string;
  annotation_review_status: string;
  active_base_snapshot_id: string | null;
  round_id: string | null;
  round_number: number | null;
  round_status: "PENDING" | "IN_REVIEW" | "CHANGES_REQUESTED" | "APPROVED" | null;
  reviewer_name: string | null;
  decision_note: string | null;
  round_created_at: string | null;
  round_decided_at: string | null;
};

type SnapshotVersionRow = {
  id: string;
  annotation_id: string;
  revision: number;
  content_hash: string;
  created_at: string;
  workflow_status: string;
};

type MyAnnotationRow = {
  id: string;
  status: "DRAFT" | "SUBMITTED";
  revision: number;
  updated_at: string;
  taxonomy_version: "V0.2" | "V0.3-PILOT";
  review_status: "DRAFT" | "PENDING_REVIEW" | "CHANGES_REQUESTED" | "PENDING_REREVIEW" | "APPROVED";
  base_release_id: string | null;
  base_release_number: number | null;
  base_snapshot_id: string | null;
  source_public_snapshot_id: string | null;
};

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const db = getDbClient();
  const video = await db
    .prepare(
      `SELECT v.id, v.title, v.brand, v.description, v.tags_json, v.object_key,
        to_jsonb(v)->>'thumbnail_key' AS thumbnail_key, v.original_name,
        v.content_type, v.file_size, v.status, v.created_by_email,
        to_jsonb(v)->>'created_by_user_id' AS created_by_user_id,
        v.created_by_name, v.created_at
      FROM videos v
      WHERE v.id = ? AND v.deleted_at IS NULL`,
    )
    .bind(id)
    .first<VideoDetailRow>();

  if (!video) {
    return Response.json({ error: "视频不存在或已进入回收站。" }, { status: 404 });
  }
  const finalReviewer = await isFinalReviewer(user);

  const [
    snapshots,
    snapshotVersions,
    myAnnotations,
    approvedStandards,
    playbackUrl,
    thumbnailUrl,
  ] = await Promise.all([
    db
      .prepare(
        `SELECT s.id, s.annotation_id, s.author_email, s.author_name,
          s.taxonomy_version, s.revision,
          s.payload_json, s.content_hash, s.created_at,
          a.review_status AS annotation_review_status,
          a.active_base_snapshot_id,
          r.id AS round_id, r.round_number, r.status AS round_status,
          r.reviewer_name, r.decision_note,
          r.created_at AS round_created_at, r.decided_at AS round_decided_at
        FROM annotation_snapshots s
        INNER JOIN (
          SELECT author_email, taxonomy_version, MAX(revision) AS latest_revision
          FROM annotation_snapshots
          WHERE video_id = ? AND workflow_status = 'SUBMITTED'
          GROUP BY author_email, taxonomy_version
        ) latest
        ON latest.author_email = s.author_email
        AND latest.taxonomy_version = s.taxonomy_version
        AND latest.latest_revision = s.revision
        INNER JOIN annotations a ON a.id = s.annotation_id
        LEFT JOIN analysis_review_rounds r ON r.submitted_snapshot_id = s.id
        WHERE s.video_id = ? AND s.workflow_status = 'SUBMITTED'
        ORDER BY s.created_at DESC`,
      )
      .bind(id, id)
      .all<SnapshotRow>(),
    db
      .prepare(
        `SELECT id, annotation_id, revision, content_hash, created_at,
          workflow_status
        FROM annotation_snapshots
        WHERE video_id = ? AND workflow_status = 'SUBMITTED'
        ORDER BY annotation_id ASC, created_at ASC, revision ASC`,
      )
      .bind(id)
      .all<SnapshotVersionRow>(),
    db
      .prepare(
        `SELECT a.id, a.status, a.revision, a.updated_at, a.taxonomy_version,
          a.review_status, a.base_release_id, a.base_snapshot_id,
          a.source_public_snapshot_id, release.release_number AS base_release_number
        FROM annotations a
        LEFT JOIN approved_analysis_releases release ON release.id = a.base_release_id
        WHERE a.video_id = ? AND a.author_email = ? AND a.deleted_at IS NULL
        ORDER BY CASE WHEN a.taxonomy_version = 'V0.3-PILOT' THEN 0 ELSE 1 END`,
    )
      .bind(id, user.identityKey)
      .all<MyAnnotationRow>(),
    db
      .prepare(
        `SELECT r.id, r.release_number, r.approved_snapshot_id, r.source_snapshot_id,
          r.payload_json, r.content_hash, r.approved_by_name, r.approved_at,
          r.expert_creative_grade, r.assignment_quality_grade, r.status,
          source.author_name AS source_author_name,
          COALESCE(source.submitted_at, source.created_at) AS source_submitted_at
        FROM approved_analysis_releases r
        INNER JOIN annotation_snapshots source ON source.id = r.source_snapshot_id
        WHERE r.video_id = ?
        ORDER BY r.release_number DESC, r.approved_at DESC`,
      )
      .bind(id)
      .all<{
        id: string; release_number: number; approved_snapshot_id: string;
        source_snapshot_id: string; payload_json: string; content_hash: string;
        approved_by_name: string; approved_at: string;
        expert_creative_grade: "S" | "A" | "B" | "C";
        assignment_quality_grade: string | null;
        status: "ACTIVE" | "SUPERSEDED" | "WITHDRAWN";
        source_author_name: string;
        source_submitted_at: string;
      }>(),
    video.status === "READY"
      ? getVideoBucket().createPresignedGetUrl(video.object_key, {
          expiresInSeconds: 3 * 60 * 60,
        })
      : Promise.resolve(null),
    video.status === "READY" && video.thumbnail_key
      ? getVideoBucket().createPresignedGetUrl(video.thumbnail_key, {
          expiresInSeconds: 3 * 60 * 60,
        })
      : Promise.resolve(null),
  ]);

  let tags: string[] = [];
  try {
    tags = JSON.parse(video.tags_json);
  } catch {
    tags = [];
  }

  const canManage = videoUploaderMatches(video, {
    userId: user.id,
    identityKey: user.identityKey,
  });
  const shared = await loadSharedV03ReadModel(id);
  const currentSharedSnapshot = shared?.collaboration?.currentSnapshotId
    ? await db.prepare(
        `SELECT id, content_hash, created_at FROM annotation_snapshots WHERE id = ?`,
      ).bind(shared.collaboration.currentSnapshotId).first<{
        id: string; content_hash: string; created_at: string;
      }>()
    : null;

  return Response.json({
    video: {
      id: video.id,
      title: video.title,
      brand: video.brand,
      description: video.description,
      tags,
      originalName: video.original_name,
      playbackUrl,
      thumbnailUrl,
      contentType: video.content_type,
      fileSize: video.file_size,
      status: video.status,
      createdByName: video.created_by_name,
      createdAt: video.created_at,
      annotationCount: snapshots.results.length,
    },
    analyses: snapshots.results.filter((snapshot) =>
      !(shared && snapshot.taxonomy_version === "V0.3-PILOT") &&
      !approvedStandards.results.some(
        (release) => release.status === "ACTIVE" && release.source_snapshot_id === snapshot.id,
      ),
    ).map((snapshot: SnapshotRow) => {
      const versions = snapshotVersions.results
        .filter((version) => version.annotation_id === snapshot.annotation_id)
        .map((version, index) => ({
          id: version.id,
          revision: version.revision,
          versionNumber: index + 1,
          createdAt: version.created_at,
          contentHash: version.content_hash,
        }));
      const roundIsActive = Boolean(
        snapshot.round_id &&
        snapshot.active_base_snapshot_id === snapshot.id &&
        snapshot.round_status &&
        ["PENDING", "IN_REVIEW"].includes(snapshot.round_status),
      );
      const activeRelease = approvedStandards.results.find(
        (release) =>
          release.status === "ACTIVE" &&
          release.source_snapshot_id === snapshot.id,
      );
      return {
        id: snapshot.id,
        authorName: snapshot.author_name,
        taxonomyVersion: snapshot.taxonomy_version,
        revision: snapshot.revision,
        versionNumber:
          versions.find((version) => version.id === snapshot.id)?.versionNumber ?? 1,
        createdAt: snapshot.created_at,
        contentHash: snapshot.content_hash,
        payload: JSON.parse(snapshot.payload_json),
        versions,
        versionIdentity: "PUBLIC_SUBMISSION" as const,
        reviewContext: {
          round: snapshot.round_id ? {
            id: snapshot.round_id,
            submissionId: snapshot.id,
            roundNumber: Number(snapshot.round_number),
            status: snapshot.round_status,
            reviewerName: snapshot.reviewer_name,
            decisionNote: snapshot.decision_note,
            createdAt: snapshot.round_created_at,
            decidedAt: snapshot.round_decided_at,
          } : null,
          isAuthor: snapshot.author_email === user.identityKey,
          isFinalReviewer: finalReviewer,
          canReview: finalReviewer && roundIsActive,
          canReturn: finalReviewer && roundIsActive,
          canApprove: finalReviewer && roundIsActive,
          canWithdraw: false,
          activeReleaseNumber: activeRelease
            ? Number(activeRelease.release_number)
            : null,
        },
      };
    }),
    approvedStandards: approvedStandards.results.filter((release) => release.status === "ACTIVE").map((release) => ({
      id: release.id,
      releaseNumber: Number(release.release_number),
      approvedSnapshotId: release.approved_snapshot_id,
      sourceSnapshotId: release.source_snapshot_id,
      approvedByName: release.approved_by_name,
      approvedAt: release.approved_at,
      expertCreativeGrade: release.expert_creative_grade,
      assignmentQualityGrade: release.assignment_quality_grade,
      contentHash: release.content_hash,
      status: release.status,
      versionIdentity: "ACTIVE_STANDARD" as const,
      sourceAuthorName: release.source_author_name,
      sourceSubmittedAt: release.source_submitted_at,
      payload: JSON.parse(release.payload_json),
    })),
    approvedStandardHistory: approvedStandards.results.map((release) => ({
      id: release.id,
      releaseNumber: Number(release.release_number),
      approvedSnapshotId: release.approved_snapshot_id,
      sourceSnapshotId: release.source_snapshot_id,
      approvedByName: release.approved_by_name,
      approvedAt: release.approved_at,
      expertCreativeGrade: release.expert_creative_grade,
      assignmentQualityGrade: release.assignment_quality_grade,
      contentHash: release.content_hash,
      status: release.status,
      versionIdentity: release.status === "ACTIVE" ? "ACTIVE_STANDARD" as const : "HISTORICAL_STANDARD" as const,
      sourceAuthorName: release.source_author_name,
      sourceSubmittedAt: release.source_submitted_at,
    })),
    collaboration: shared?.collaboration ?? null,
    sharedV03MutableAvailable: shared?.mutableAvailable ?? false,
    sharedV03DisplaySource: shared?.displaySource ?? null,
    sharedV03PendingBackfill: shared?.pendingSharedBackfill ?? false,
    sharedV03SourceAuthorName: shared?.sourceAuthorName ?? null,
    canAdminSharedV03Backfill: finalReviewer,
    currentPublicV03: shared ? {
      id: currentSharedSnapshot?.id ?? shared.annotation.id ?? `legacy-v03-${id}`,
      authorName: shared.sourceAuthorName,
      taxonomyVersion: "V0.3-PILOT",
      revision: shared.annotation.revision,
      versionNumber: shared.collaboration?.roundNumber ?? 0,
      createdAt: currentSharedSnapshot?.created_at ?? shared.sourceUpdatedAt ?? "",
      contentHash: currentSharedSnapshot?.content_hash ?? shared.contentHash,
      payload: shared.annotation,
      versions: [],
      versionIdentity: "PUBLIC_SUBMISSION" as const,
      reviewContext: {
        round: null,
        isAuthor: false,
        isFinalReviewer: finalReviewer,
        canReview: Boolean(shared.collaboration),
        canReturn: false,
        canApprove: false,
        canWithdraw: false,
        activeReleaseNumber: shared.collaboration?.activeReleaseNumber ?? null,
      },
    } : null,
    canFinalizeSharedV03: finalReviewer && Boolean(shared?.collaboration),
    myAnalysis: myAnnotations.results[0]
      ? {
          id: myAnnotations.results[0].id,
          status: myAnnotations.results[0].status,
          revision: myAnnotations.results[0].revision,
          updatedAt: myAnnotations.results[0].updated_at,
      taxonomyVersion: myAnnotations.results[0].taxonomy_version,
          reviewStatus: myAnnotations.results[0].review_status,
          baseReleaseId: myAnnotations.results[0].base_release_id,
          baseReleaseNumber: myAnnotations.results[0].base_release_number == null ? null : Number(myAnnotations.results[0].base_release_number),
          baseSnapshotId: myAnnotations.results[0].base_snapshot_id,
          sourcePublicSnapshotId: myAnnotations.results[0].source_public_snapshot_id,
        }
      : null,
    myAnalyses: myAnnotations.results.map((annotation) => ({
      id: annotation.id,
      status: annotation.status,
      revision: annotation.revision,
      updatedAt: annotation.updated_at,
      taxonomyVersion: annotation.taxonomy_version,
      reviewStatus: annotation.review_status,
      baseReleaseId: annotation.base_release_id,
      baseReleaseNumber: annotation.base_release_number == null ? null : Number(annotation.base_release_number),
      baseSnapshotId: annotation.base_snapshot_id,
      sourcePublicSnapshotId: annotation.source_public_snapshot_id,
    })),
    canManage,
    canTrash: canManage,
    canReplaceOriginal: canManage,
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const body = (await request.json()) as {
    title?: string;
    brand?: string;
    description?: string;
    tags?: string[];
  };
  const title = body.title?.trim();
  if (!title) {
    return Response.json({ error: "请填写片名。" }, { status: 400 });
  }

  const tags = (body.tags ?? [])
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
  const db = getDbClient();
  const video = await db
    .prepare(
      `SELECT id, created_by_email,
        to_jsonb(videos)->>'created_by_user_id' AS created_by_user_id
      FROM videos WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(id)
    .first<VideoUploaderIdentity & { id: string }>();
  if (!video) {
    return Response.json({ error: "视频不存在。" }, { status: 404 });
  }
  if (!videoUploaderMatches(video, { userId: user.id, identityKey: user.identityKey })) {
    return Response.json({ error: "只有原上传者可以编辑视频信息。" }, { status: 403 });
  }

  const brand = body.brand?.trim() ?? "";
  const description = body.description?.trim() ?? "";
  const updateResult = await db
    .prepare(
      `UPDATE videos
      SET title = ?, brand = ?, description = ?, tags_json = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND deleted_at IS NULL
        AND (
          (NULLIF(to_jsonb(videos)->>'created_by_user_id', '') IS NOT NULL
            AND to_jsonb(videos)->>'created_by_user_id' = ?)
          OR
          (NULLIF(to_jsonb(videos)->>'created_by_user_id', '') IS NULL
            AND created_by_email = ?)
        )`,
    )
    .bind(title, brand, description, JSON.stringify(tags), id, user.id, user.identityKey)
    .run();
  if (updateResult.meta.rows_written !== 1) {
    return Response.json({ error: "视频状态已变化，请刷新后重试。" }, { status: 409 });
  }

  return Response.json({ video: { title, brand, description, tags } });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return v04Route(request, { mutation: true, requireFeature: false }, async (actor) => {
    const { id } = await context.params;
    const result = await trashVideoWithSchemaCompatibility(getDbClient(), id, actor, {
      reason: "用户移入回收站",
      idempotencyKey: v04IdempotencyKey(request, actor.requestId),
    });
    return Response.json(result);
  });
}
