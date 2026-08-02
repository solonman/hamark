import { getD1 } from "@/db";
import { annotationFields } from "./annotation-fields";
import type { AnnotationDraft, FieldAnswerDraft, ShotDraft } from "./types";

type AnnotationRow = {
  id: string;
  video_id: string;
  author_name: string;
  taxonomy_version: "V0.2";
  status: "DRAFT" | "SUBMITTED";
  revision: number;
  analysis_title: string;
  commercial_intent: string;
  creative_theme: string;
  synopsis: string;
  thinking_chain: string;
  shot_commentary: string;
  summary: string;
  updated_at: string;
};

type ShotRow = {
  id: string;
  order_index: number;
  group_name: string;
  shot_number: string;
  start_time: string;
  end_time: string;
  shot_size: string;
  camera_angle: string;
  camera_movement: string;
  visual_content: string;
  dialogue: string;
  voiceover: string;
  screen_text: string;
  sound_effect: string;
  music: string;
  creative_comment: string;
};

type FieldRow = {
  field_code: string;
  answer: string;
  evidence: string;
};

export function emptyAnnotation(
  videoId: string,
  authorName: string,
): AnnotationDraft {
  return {
    id: null,
    videoId,
    authorName,
    taxonomyVersion: "V0.2",
    status: "DRAFT",
    revision: 0,
    analysisTitle: "",
    commercialIntent: "",
    creativeTheme: "",
    synopsis: "",
    thinkingChain: "",
    shotCommentary: "",
    summary: "",
    shots: [],
    fields: annotationFields.map((field) => ({
      code: field.code,
      answer: "",
      evidence: "",
    })),
    updatedAt: null,
  };
}

export async function loadAnnotation(
  videoId: string,
  authorEmail: string,
  authorName: string,
) {
  const d1 = getD1();
  const row = await d1
    .prepare(
      `SELECT id, video_id, author_name, taxonomy_version, status, revision,
        analysis_title, commercial_intent, creative_theme, synopsis,
        thinking_chain, shot_commentary, summary, updated_at
      FROM annotations
      WHERE video_id = ? AND author_email = ? AND deleted_at IS NULL`,
    )
    .bind(videoId, authorEmail)
    .first<AnnotationRow>();

  if (!row) {
    return emptyAnnotation(videoId, authorName);
  }

  const [shotResult, fieldResult] = await Promise.all([
    d1
      .prepare(
        `SELECT id, order_index, group_name, shot_number, start_time, end_time,
          shot_size, camera_angle, camera_movement, visual_content, dialogue,
          voiceover, screen_text, sound_effect, music, creative_comment
        FROM shots WHERE annotation_id = ? ORDER BY order_index ASC`,
      )
      .bind(row.id)
      .all<ShotRow>(),
    d1
      .prepare(
        `SELECT field_code, answer, evidence
        FROM field_answers WHERE annotation_id = ?`,
      )
      .bind(row.id)
      .all<FieldRow>(),
  ]);

  const fieldMap = new Map(
    fieldResult.results.map((field: FieldRow) => [field.field_code, field]),
  );

  const shots: ShotDraft[] = shotResult.results.map((shot: ShotRow) => ({
    id: shot.id,
    orderIndex: shot.order_index,
    groupName: shot.group_name,
    shotNumber: shot.shot_number,
    startTime: shot.start_time,
    endTime: shot.end_time,
    shotSize: shot.shot_size,
    cameraAngle: shot.camera_angle,
    cameraMovement: shot.camera_movement,
    visualContent: shot.visual_content,
    dialogue: shot.dialogue,
    voiceover: shot.voiceover,
    screenText: shot.screen_text,
    soundEffect: shot.sound_effect,
    music: shot.music,
    creativeComment: shot.creative_comment,
  }));

  const fields: FieldAnswerDraft[] = annotationFields.map((field) => {
    const answer: FieldRow | undefined = fieldMap.get(field.code);
    return {
      code: field.code,
      answer: answer?.answer ?? "",
      evidence: answer?.evidence ?? "",
    };
  });

  return {
    id: row.id,
    videoId: row.video_id,
    authorName: row.author_name,
    taxonomyVersion: row.taxonomy_version,
    status: row.status,
    revision: row.revision,
    analysisTitle: row.analysis_title,
    commercialIntent: row.commercial_intent,
    creativeTheme: row.creative_theme,
    synopsis: row.synopsis,
    thinkingChain: row.thinking_chain,
    shotCommentary: row.shot_commentary,
    summary: row.summary,
    shots,
    fields,
    updatedAt: row.updated_at,
  } satisfies AnnotationDraft;
}

export function validateAnnotation(payload: AnnotationDraft) {
  const missing: string[] = [];
  if (!payload.analysisTitle.trim()) missing.push("分析标题");
  if (!payload.commercialIntent.trim()) missing.push("商业意图");
  if (!payload.creativeTheme.trim()) missing.push("创意母题");
  if (!payload.synopsis.trim()) missing.push("故事梗概");
  if (!payload.thinkingChain.trim()) missing.push("创意思维链");
  if (!payload.shots.some((shot) => shot.visualContent.trim())) {
    missing.push("至少一个有画面内容的镜头");
  }
  for (const field of annotationFields) {
    const answer = payload.fields.find((item) => item.code === field.code);
    if (!answer?.answer.trim()) missing.push(`${field.code} ${field.name}`);
  }
  return missing;
}
