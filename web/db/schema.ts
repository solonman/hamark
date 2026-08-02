import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const videos = sqliteTable(
  "videos",
  {
    id: text("id").primaryKey(),
    domainKey: text("domain_key").notNull().default("AD_VIDEO"),
    title: text("title").notNull(),
    brand: text("brand").notNull().default(""),
    description: text("description").notNull().default(""),
    tagsJson: text("tags_json").notNull().default("[]"),
    objectKey: text("object_key").notNull(),
    originalName: text("original_name").notNull(),
    contentType: text("content_type").notNull().default("application/octet-stream"),
    fileSize: integer("file_size").notNull().default(0),
    status: text("status").notNull().default("UPLOADING"),
    rightsConfirmed: integer("rights_confirmed", { mode: "boolean" })
      .notNull()
      .default(false),
    createdByEmail: text("created_by_email").notNull(),
    createdByName: text("created_by_name").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("videos_status_idx").on(table.status),
    index("videos_created_at_idx").on(table.createdAt),
  ],
);

export const annotations = sqliteTable(
  "annotations",
  {
    id: text("id").primaryKey(),
    videoId: text("video_id")
      .notNull()
      .references(() => videos.id),
    authorEmail: text("author_email").notNull(),
    authorName: text("author_name").notNull(),
    taxonomyVersion: text("taxonomy_version").notNull().default("V0.2"),
    status: text("status").notNull().default("DRAFT"),
    revision: integer("revision").notNull().default(0),
    analysisTitle: text("analysis_title").notNull().default(""),
    commercialIntent: text("commercial_intent").notNull().default(""),
    creativeTheme: text("creative_theme").notNull().default(""),
    synopsis: text("synopsis").notNull().default(""),
    thinkingChain: text("thinking_chain").notNull().default(""),
    shotCommentary: text("shot_commentary").notNull().default(""),
    summary: text("summary").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    submittedAt: text("submitted_at"),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    uniqueIndex("annotations_video_author_idx").on(
      table.videoId,
      table.authorEmail,
    ),
    index("annotations_video_status_idx").on(table.videoId, table.status),
  ],
);

export const shots = sqliteTable(
  "shots",
  {
    id: text("id").primaryKey(),
    annotationId: text("annotation_id")
      .notNull()
      .references(() => annotations.id),
    orderIndex: integer("order_index").notNull(),
    groupName: text("group_name").notNull().default(""),
    shotNumber: text("shot_number").notNull().default(""),
    startTime: text("start_time").notNull().default(""),
    endTime: text("end_time").notNull().default(""),
    shotSize: text("shot_size").notNull().default(""),
    cameraAngle: text("camera_angle").notNull().default(""),
    cameraMovement: text("camera_movement").notNull().default(""),
    visualContent: text("visual_content").notNull().default(""),
    dialogue: text("dialogue").notNull().default(""),
    voiceover: text("voiceover").notNull().default(""),
    screenText: text("screen_text").notNull().default(""),
    soundEffect: text("sound_effect").notNull().default(""),
    music: text("music").notNull().default(""),
    creativeComment: text("creative_comment").notNull().default(""),
  },
  (table) => [
    index("shots_annotation_order_idx").on(
      table.annotationId,
      table.orderIndex,
    ),
  ],
);

export const fieldAnswers = sqliteTable(
  "field_answers",
  {
    id: text("id").primaryKey(),
    annotationId: text("annotation_id")
      .notNull()
      .references(() => annotations.id),
    fieldCode: text("field_code").notNull(),
    answer: text("answer").notNull().default(""),
    evidence: text("evidence").notNull().default(""),
  },
  (table) => [
    uniqueIndex("field_answers_annotation_code_idx").on(
      table.annotationId,
      table.fieldCode,
    ),
  ],
);

export const annotationSnapshots = sqliteTable(
  "annotation_snapshots",
  {
    id: text("id").primaryKey(),
    annotationId: text("annotation_id")
      .notNull()
      .references(() => annotations.id),
    videoId: text("video_id")
      .notNull()
      .references(() => videos.id),
    authorEmail: text("author_email").notNull(),
    authorName: text("author_name").notNull(),
    taxonomyVersion: text("taxonomy_version").notNull(),
    revision: integer("revision").notNull(),
    payloadJson: text("payload_json").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("annotation_snapshots_video_idx").on(table.videoId, table.createdAt),
    uniqueIndex("annotation_snapshots_annotation_revision_idx").on(
      table.annotationId,
      table.revision,
    ),
  ],
);

export const assignmentReviews = sqliteTable(
  "assignment_reviews",
  {
    id: text("id").primaryKey(),
    submissionId: text("submission_id")
      .notNull()
      .references(() => annotationSnapshots.id),
    videoId: text("video_id")
      .notNull()
      .references(() => videos.id),
    submissionRevision: integer("submission_revision").notNull(),
    graderEmail: text("grader_email").notNull(),
    graderName: text("grader_name").notNull(),
    graderRole: text("grader_role").notNull().default("PEER"),
    rubricVersion: text("rubric_version").notNull().default("RUBRIC-V0.4"),
    status: text("status").notNull().default("DRAFT"),
    revision: integer("revision").notNull().default(0),
    scoresJson: text("scores_json").notNull().default("{}"),
    totalScore: real("total_score").notNull().default(0),
    generalComment: text("general_comment").notNull().default(""),
    discussionNomination: integer("discussion_nomination", { mode: "boolean" })
      .notNull()
      .default(false),
    isValidForAggregate: integer("is_valid_for_aggregate", { mode: "boolean" })
      .notNull()
      .default(true),
    weight: real("weight").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    submittedAt: text("submitted_at"),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    uniqueIndex("assignment_reviews_submission_grader_idx").on(
      table.submissionId,
      table.graderEmail,
    ),
    index("assignment_reviews_submission_status_idx").on(
      table.submissionId,
      table.status,
    ),
  ],
);

export const assignmentReviewSnapshots = sqliteTable(
  "assignment_review_snapshots",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id")
      .notNull()
      .references(() => assignmentReviews.id),
    submissionId: text("submission_id")
      .notNull()
      .references(() => annotationSnapshots.id),
    graderEmail: text("grader_email").notNull(),
    rubricVersion: text("rubric_version").notNull(),
    revision: integer("revision").notNull(),
    payloadJson: text("payload_json").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("assignment_review_snapshots_revision_idx").on(
      table.reviewId,
      table.revision,
    ),
    index("assignment_review_snapshots_submission_idx").on(table.submissionId),
  ],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    actorEmail: text("actor_email").notNull(),
    action: text("action").notNull(),
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    detailJson: text("detail_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("audit_logs_object_idx").on(table.objectType, table.objectId),
  ],
);
