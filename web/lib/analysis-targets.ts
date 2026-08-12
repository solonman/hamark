import { annotationFields, type AnnotationFieldCode } from "./annotation-fields";
import type { AnnotationDraft } from "./types";

const annotationTargets = {
  "core:commercial-intent": {
    property: "commercialIntent",
    column: "commercial_intent",
  },
  "core:creative-theme": {
    property: "creativeTheme",
    column: "creative_theme",
  },
  "core:story-synopsis": {
    property: "synopsis",
    column: "synopsis",
  },
  "core:thinking-chain": {
    property: "thinkingChain",
    column: "thinking_chain",
  },
  "core:full-summary": {
    property: "summary",
    column: "summary",
  },
  "core:shot-commentary": {
    property: "shotCommentary",
    column: "shot_commentary",
  },
} as const;

const shotTargets = {
  "group-name": { property: "groupName", column: "group_name" },
  number: { property: "shotNumber", column: "shot_number" },
  "start-time": { property: "startTime", column: "start_time" },
  "end-time": { property: "endTime", column: "end_time" },
  "shot-size": { property: "shotSize", column: "shot_size" },
  "camera-angle": { property: "cameraAngle", column: "camera_angle" },
  "camera-movement": {
    property: "cameraMovement",
    column: "camera_movement",
  },
  "visual-content": {
    property: "visualContent",
    column: "visual_content",
  },
  dialogue: { property: "dialogue", column: "dialogue" },
  voiceover: { property: "voiceover", column: "voiceover" },
  "screen-text": { property: "screenText", column: "screen_text" },
  "sound-effect": { property: "soundEffect", column: "sound_effect" },
  music: { property: "music", column: "music" },
  "creative-comment": {
    property: "creativeComment",
    column: "creative_comment",
  },
} as const;

const shotGroupTargets = {
  title: { property: "title", column: "title" },
  note: { property: "note", column: "note" },
  "custom-role": { property: "customRole", column: "custom_role" },
} as const;

const creativeStructureTargets = {
  "creative-button": { property: "creativeButton", column: "creative_button" },
  "mechanism-statement": { property: "mechanismStatement", column: "mechanism_statement" },
  "mechanism-custom": { property: "mechanismCustom", column: "mechanism_custom" },
  "creative-realization-path": { property: "creativeRealizationPath", column: "realization_skeleton" },
  "realization-skeleton": { property: "realizationSkeleton", column: "realization_skeleton" },
  "brand-product-landing": { property: "brandProductLanding", column: "brand_product_landing" },
  "story-reference-type": { property: "storyReferenceType", column: "story_reference_type" },
  "story-archetype": { property: "storyArchetype", column: "story_archetype" },
  "composite-state-reason": { property: "compositeStateReason", column: "composite_state_reason" },
  "formation-statement": { property: "formationStatement", column: "formation_statement" },
  "creative-carriers": { property: "creativeCarriers", column: "creative_carriers" },
  "establishment-conditions": { property: "establishmentConditions", column: "establishment_conditions" },
  "strength-sources": { property: "strengthSources", column: "strength_sources" },
  "acceptance-contract": { property: "acceptanceContract", column: "acceptance_contract" },
  "audiovisual-mechanism": { property: "audiovisualMechanism", column: "audiovisual_mechanism" },
  "information-release-turning": { property: "informationReleaseTurning", column: "information_release_turning" },
  "creative-grade-reason": { property: "creativeGradeReason", column: "creative_grade_reason" },
} as const;

type AnnotationTargetKey = keyof typeof annotationTargets;
type ShotTargetKey = keyof typeof shotTargets;
type ShotGroupTargetKey = keyof typeof shotGroupTargets;
type CreativeStructureTargetKey = keyof typeof creativeStructureTargets;

export type ParsedAnalysisTarget =
  | {
      scope: "annotation";
      property: (typeof annotationTargets)[AnnotationTargetKey]["property"];
      column: (typeof annotationTargets)[AnnotationTargetKey]["column"];
    }
  | {
      scope: "shot";
      shotId: string;
      property: (typeof shotTargets)[ShotTargetKey]["property"];
      column: (typeof shotTargets)[ShotTargetKey]["column"];
    }
  | {
      scope: "field";
      fieldCode: AnnotationFieldCode;
      property: "answer" | "evidence";
      column: "answer" | "evidence";
    }
  | {
      scope: "shot-group";
      groupId: string;
      property: (typeof shotGroupTargets)[ShotGroupTargetKey]["property"];
      column: (typeof shotGroupTargets)[ShotGroupTargetKey]["column"];
    }
  | {
      scope: "creative-structure";
      property: (typeof creativeStructureTargets)[CreativeStructureTargetKey]["property"];
      column: (typeof creativeStructureTargets)[CreativeStructureTargetKey]["column"];
    }
  | {
      scope: "creative-structure-json";
      property: "mainPathPayload" | "auxiliaryPathNotes";
      column: "main_path_payload_json" | "auxiliary_path_notes_json";
      itemKey: string;
    };

const fieldCodes = new Set(annotationFields.map((field) => field.code));

export function parseAnalysisTarget(targetKey: string): ParsedAnalysisTarget | null {
  if (targetKey in annotationTargets) {
    const target = annotationTargets[targetKey as AnnotationTargetKey];
    return { scope: "annotation", ...target };
  }

  const shotMatch = /^shot:([^:]+):([a-z-]+)$/.exec(targetKey);
  if (shotMatch && shotMatch[2] in shotTargets) {
    const target = shotTargets[shotMatch[2] as ShotTargetKey];
    return { scope: "shot", shotId: shotMatch[1], ...target };
  }

  const groupMatch = /^group:([^:]+):([a-z-]+)$/.exec(targetKey);
  if (groupMatch && groupMatch[2] in shotGroupTargets) {
    const target = shotGroupTargets[groupMatch[2] as ShotGroupTargetKey];
    return { scope: "shot-group", groupId: groupMatch[1], ...target };
  }

  const structureMatch = /^structure:([a-z-]+)$/.exec(targetKey);
  if (structureMatch && structureMatch[1] in creativeStructureTargets) {
    const target = creativeStructureTargets[
      structureMatch[1] as CreativeStructureTargetKey
    ];
    return { scope: "creative-structure", ...target };
  }

  const structureJsonMatch =
    /^structure:(main-path|aux-path):([A-Za-z0-9_-]+)$/.exec(targetKey);
  if (structureJsonMatch) {
    return structureJsonMatch[1] === "main-path"
      ? {
          scope: "creative-structure-json",
          property: "mainPathPayload",
          column: "main_path_payload_json",
          itemKey: structureJsonMatch[2],
        }
      : {
          scope: "creative-structure-json",
          property: "auxiliaryPathNotes",
          column: "auxiliary_path_notes_json",
          itemKey: structureJsonMatch[2],
        };
  }

  const fieldMatch = /^field:([AB]\d+):(answer|evidence)$/.exec(targetKey);
  if (fieldMatch && fieldCodes.has(fieldMatch[1] as AnnotationFieldCode)) {
    return {
      scope: "field",
      fieldCode: fieldMatch[1] as AnnotationFieldCode,
      property: fieldMatch[2] as "answer" | "evidence",
      column: fieldMatch[2] as "answer" | "evidence",
    };
  }
  return null;
}

export function analysisTargetValue(
  annotation: AnnotationDraft,
  targetKey: string,
): string | null {
  const target = parseAnalysisTarget(targetKey);
  if (!target) return null;
  if (target.scope === "annotation") {
    return annotation[target.property];
  }
  if (target.scope === "shot") {
    const shot = annotation.shots.find((item) => item.id === target.shotId);
    return shot?.[target.property] ?? null;
  }
  if (target.scope === "shot-group") {
    const group = annotation.shotGroups?.find((item) => item.id === target.groupId);
    return group?.[target.property] ?? null;
  }
  if (target.scope === "creative-structure") {
    if (target.property === "creativeRealizationPath") {
      return annotation.creativeStructure
        ? annotation.creativeStructure.creativeRealizationPath ||
            annotation.creativeStructure.realizationSkeleton
        : null;
    }
    return annotation.creativeStructure?.[target.property] ?? null;
  }
  if (target.scope === "creative-structure-json") {
    const values = annotation.creativeStructure?.[target.property] as
      | Record<string, string | undefined>
      | undefined;
    return values?.[target.itemKey] ?? null;
  }
  const field = annotation.fields.find((item) => item.code === target.fieldCode);
  return field?.[target.property] ?? null;
}

export function resolveAnchoredReplacement(input: {
  currentValue: string;
  selectedText: string;
  anchorStart: number;
  anchorEnd: number;
  replacementText: string;
}) {
  const { currentValue, selectedText, anchorStart, anchorEnd, replacementText } = input;
  if (
    Number.isInteger(anchorStart) &&
    Number.isInteger(anchorEnd) &&
    anchorStart >= 0 &&
    anchorEnd >= anchorStart &&
    currentValue.slice(anchorStart, anchorEnd) === selectedText
  ) {
    return `${currentValue.slice(0, anchorStart)}${replacementText}${currentValue.slice(anchorEnd)}`;
  }

  if (!selectedText) {
    return currentValue ? null : replacementText;
  }
  const firstMatch = currentValue.indexOf(selectedText);
  if (firstMatch < 0 || currentValue.indexOf(selectedText, firstMatch + 1) >= 0) {
    return null;
  }
  return `${currentValue.slice(0, firstMatch)}${replacementText}${currentValue.slice(firstMatch + selectedText.length)}`;
}
