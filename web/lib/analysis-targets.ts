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

type AnnotationTargetKey = keyof typeof annotationTargets;
type ShotTargetKey = keyof typeof shotTargets;

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
