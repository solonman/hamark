import { getDbClient } from "@/db";
import { annotationFields } from "./annotation-fields";
import {
  emptyCreativeStructure,
  V03_TAXONOMY_VERSION,
  V03_WORKFLOW_VERSION,
} from "./taxonomy-v0.3";
import type {
  AnnotationDraft,
  CreativeStructureDraft,
  FieldAnswerDraft,
  ShotDraft,
  ShotGroupDraft,
  TaxonomyVersion,
} from "./types";

function draftId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

type AnnotationRow = {
  id: string;
  video_id: string;
  author_name: string;
  taxonomy_version: TaxonomyVersion;
  workflow_version: AnnotationDraft["workflowVersion"];
  source_snapshot_id: string | null;
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
  shot_group_id: string | null;
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

type ShotGroupRow = {
  id: string;
  order_index: number;
  title: string;
  primary_role_name_snapshot: string;
  auxiliary_roles_json: string;
  custom_role: string;
  note: string;
};

type FieldRow = {
  field_code: string;
  answer: string;
  evidence: string;
  source: FieldAnswerDraft["source"];
};

type CreativeStructureRow = {
  creative_button: string;
  mechanism_statement: string;
  mechanism_primary: string;
  mechanism_auxiliary_json: string;
  mechanism_custom: string;
  realization_skeleton: string;
  brand_product_landing: string;
  story_reference_type: string;
  story_archetype: string;
  primary_creative_path: string;
  auxiliary_creative_paths_json: string;
  composite_state_reason: string;
  formation_primary: string;
  formation_auxiliary_json: string;
  formation_statement: string;
  formation_related_group_ids_json: string;
  creative_carriers: string;
  establishment_conditions: string;
  strength_sources: string;
  acceptance_contract: string;
  audiovisual_mechanism: string;
  information_release_turning: string;
  creative_grade: string;
  creative_grade_reason: string;
  creative_grade_version: string;
  main_path_payload_json: string;
  auxiliary_path_notes_json: string;
  condition_flags_json: string;
};

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function emptyAnnotation(
  videoId: string,
  authorName: string,
  taxonomyVersion: TaxonomyVersion = "V0.2",
): AnnotationDraft {
  const isV03 = taxonomyVersion === V03_TAXONOMY_VERSION;
  return {
    id: null,
    videoId,
    authorName,
    taxonomyVersion,
    workflowVersion: isV03
      ? V03_WORKFLOW_VERSION
      : "REVERSE-WORKFLOW-V0.2",
    sourceSnapshotId: null,
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
    shotGroups: isV03 ? [] : undefined,
    fields: annotationFields.map((field) => ({
      code: field.code,
      answer: "",
      evidence: "",
      source: "HUMAN_ORIGINAL",
    })),
    creativeStructure: isV03 ? emptyCreativeStructure() : undefined,
    updatedAt: null,
  };
}

function mapCreativeStructure(row: CreativeStructureRow | null): CreativeStructureDraft {
  if (!row) return emptyCreativeStructure();
  return {
    creativeButton: row.creative_button,
    mechanismStatement: row.mechanism_statement,
    mechanismPrimary: row.mechanism_primary,
    mechanismAuxiliary: parseJson(row.mechanism_auxiliary_json, []),
    mechanismCustom: row.mechanism_custom,
    realizationSkeleton: row.realization_skeleton,
    brandProductLanding: row.brand_product_landing,
    storyReferenceType: row.story_reference_type,
    storyArchetype: row.story_archetype,
    primaryCreativePath: row.primary_creative_path as CreativeStructureDraft["primaryCreativePath"],
    auxiliaryCreativePaths: parseJson(row.auxiliary_creative_paths_json, []),
    compositeStateReason: row.composite_state_reason,
    formationPrimary: row.formation_primary as CreativeStructureDraft["formationPrimary"],
    formationAuxiliary: parseJson(row.formation_auxiliary_json, []),
    formationStatement: row.formation_statement,
    formationRelatedGroupIds: parseJson(row.formation_related_group_ids_json, []),
    creativeCarriers: row.creative_carriers,
    establishmentConditions: row.establishment_conditions,
    strengthSources: row.strength_sources,
    acceptanceContract: row.acceptance_contract,
    audiovisualMechanism: row.audiovisual_mechanism,
    informationReleaseTurning: row.information_release_turning,
    creativeGrade: row.creative_grade as CreativeStructureDraft["creativeGrade"],
    creativeGradeReason: row.creative_grade_reason,
    creativeGradeVersion: "CREATIVE-GRADE-V0.1",
    mainPathPayload: parseJson(row.main_path_payload_json, {}),
    auxiliaryPathNotes: parseJson(row.auxiliary_path_notes_json, {}),
    conditionFlags: parseJson(row.condition_flags_json, {
      unconventionalWorld: false,
      audiovisualCarriesIdea: false,
      interestingLoadBearing: false,
    }),
  };
}

async function seedV03FromLatestV02(
  videoId: string,
  authorEmail: string,
  authorName: string,
) {
  const snapshot = await getDbClient()
    .prepare(
      `SELECT id, payload_json FROM annotation_snapshots
      WHERE video_id = ? AND author_email = ? AND taxonomy_version = 'V0.2'
      ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(videoId, authorEmail)
    .first<{ id: string; payload_json: string }>();
  if (!snapshot) return emptyAnnotation(videoId, authorName, V03_TAXONOMY_VERSION);

  const source = parseJson<AnnotationDraft | null>(snapshot.payload_json, null);
  if (!source) return emptyAnnotation(videoId, authorName, V03_TAXONOMY_VERSION);

  const seeded = emptyAnnotation(videoId, authorName, V03_TAXONOMY_VERSION);
  const groups: ShotGroupDraft[] = [];
  const copiedShots: ShotDraft[] = [];
  let previousName: string | null = null;
  let currentGroup: ShotGroupDraft | null = null;

  source.shots.forEach((shot, index) => {
    const groupName = shot.groupName.trim() || `桥段 ${groups.length + 1}`;
    if (groupName !== previousName) {
      currentGroup = {
        id: draftId("group"),
        orderIndex: groups.length,
        title: groupName,
        primaryRole: "",
        auxiliaryRoles: [],
        customRole: "",
        note: shot.creativeComment ?? "",
      };
      groups.push(currentGroup);
      previousName = groupName;
    }
    copiedShots.push({
      ...shot,
      id: draftId("shot"),
      orderIndex: index,
      groupName,
      shotGroupId: currentGroup!.id,
      creativeComment: "",
    });
  });

  return {
    ...seeded,
    sourceSnapshotId: snapshot.id,
    analysisTitle: source.analysisTitle,
    commercialIntent: source.commercialIntent,
    creativeTheme: source.creativeTheme,
    synopsis: source.synopsis,
    thinkingChain: source.thinkingChain,
    shotCommentary: source.shotCommentary,
    summary: source.summary,
    shots: copiedShots,
    shotGroups: groups,
  } satisfies AnnotationDraft;
}

export async function loadAnnotation(
  videoId: string,
  authorEmail: string,
  authorName: string,
  taxonomyVersion: TaxonomyVersion = "V0.2",
) {
  const db = getDbClient();
  const row = await db
    .prepare(
      `SELECT id, video_id, author_name, taxonomy_version, workflow_version,
        source_snapshot_id, status, revision, analysis_title,
        commercial_intent, creative_theme, synopsis, thinking_chain,
        shot_commentary, summary, updated_at
      FROM annotations
      WHERE video_id = ? AND author_email = ? AND taxonomy_version = ?
        AND deleted_at IS NULL`,
    )
    .bind(videoId, authorEmail, taxonomyVersion)
    .first<AnnotationRow>();

  if (!row) {
    return taxonomyVersion === V03_TAXONOMY_VERSION
      ? seedV03FromLatestV02(videoId, authorEmail, authorName)
      : emptyAnnotation(videoId, authorName, taxonomyVersion);
  }

  const [shotResult, groupResult, fieldResult, structureRow] = await Promise.all([
    db
      .prepare(
        `SELECT id, order_index, group_name, shot_group_id, shot_number,
          start_time, end_time, shot_size, camera_angle, camera_movement,
          visual_content, dialogue, voiceover, screen_text, sound_effect,
          music, creative_comment
        FROM shots WHERE annotation_id = ? ORDER BY order_index ASC`,
      )
      .bind(row.id)
      .all<ShotRow>(),
    db
      .prepare(
        `SELECT id, order_index, title, primary_role_name_snapshot,
          auxiliary_roles_json, custom_role, note
        FROM shot_groups WHERE annotation_id = ? ORDER BY order_index ASC`,
      )
      .bind(row.id)
      .all<ShotGroupRow>(),
    db
      .prepare(
        `SELECT field_code, answer, evidence, source
        FROM field_answers WHERE annotation_id = ?`,
      )
      .bind(row.id)
      .all<FieldRow>(),
    row.taxonomy_version === V03_TAXONOMY_VERSION
      ? db
          .prepare(`SELECT * FROM annotation_creative_structures WHERE annotation_id = ?`)
          .bind(row.id)
          .first<CreativeStructureRow>()
      : Promise.resolve(null),
  ]);

  const fieldMap = new Map(
    fieldResult.results.map((field: FieldRow) => [field.field_code, field]),
  );
  const shots: ShotDraft[] = shotResult.results.map((shot: ShotRow) => ({
    id: shot.id,
    orderIndex: shot.order_index,
    groupName: shot.group_name,
    shotGroupId: shot.shot_group_id,
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
  const groups: ShotGroupDraft[] = groupResult.results.map((group) => ({
    id: group.id,
    orderIndex: group.order_index,
    title: group.title,
    primaryRole: group.primary_role_name_snapshot,
    auxiliaryRoles: parseJson(group.auxiliary_roles_json, []),
    customRole: group.custom_role,
    note: group.note,
  }));
  const fields: FieldAnswerDraft[] = annotationFields.map((field) => {
    const answer = fieldMap.get(field.code);
    return {
      code: field.code,
      answer: answer?.answer ?? "",
      evidence: answer?.evidence ?? "",
      source: answer?.source ?? "HUMAN_ORIGINAL",
    };
  });

  return {
    id: row.id,
    videoId: row.video_id,
    authorName: row.author_name,
    taxonomyVersion: row.taxonomy_version,
    workflowVersion: row.workflow_version,
    sourceSnapshotId: row.source_snapshot_id,
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
    shotGroups: row.taxonomy_version === V03_TAXONOMY_VERSION ? groups : undefined,
    fields,
    creativeStructure:
      row.taxonomy_version === V03_TAXONOMY_VERSION
        ? mapCreativeStructure(structureRow)
        : undefined,
    updatedAt: row.updated_at,
  } satisfies AnnotationDraft;
}

export { validateAnnotation } from "./annotation-validation";
