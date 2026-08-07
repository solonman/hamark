import { annotationFields } from "./annotation-fields";
import type { AnnotationDraft } from "./types";

// Shared by the submit route and the worksheet UI so the page can name the exact
// blockers before the user clicks publish, instead of only after the server says no.
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
