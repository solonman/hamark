import {
  V04_PAYLOAD_SCHEMA_VERSION,
  V04_PRODUCT_VERSION,
  V04_TAXONOMY_VERSION,
  V04_VOCABULARY_VERSION,
  V04_WORKFLOW_VERSION,
  type V04Change,
  type V04ChoiceValue,
  type V04DraftPayloadV1,
  type V04PerceptionType,
  type V04ShotFieldKey,
} from "@/lib/v04-contract";
import type { VideoItem } from "@/lib/types";

export type V04UiWorkState =
  | "NOT_STARTED"
  | "INCOMPLETE"
  | "SUBMITTED"
  | "MODIFIED_UNSUBMITTED"
  | "MODIFICATION_SUBMITTED";

export type V04UiShot = Record<V04ShotFieldKey, string> & { id: string };

export type V04UiShotGroup = {
  id: string;
  title: string;
  primaryRole: V04ChoiceValue;
  auxiliaryRole: V04ChoiceValue;
  creativeDescription: string;
  shots: V04UiShot[];
};

export type V04UiDraft = {
  shotGroups: V04UiShotGroup[];
  commercialIntent: string;
  storySummary: string;
  creativeMotif: string;
  tensionButton: string;
  primaryMechanism: V04ChoiceValue;
  auxiliaryMechanism: V04ChoiceValue;
  creativeThinkingChain: string;
  storyReference: V04ChoiceValue;
  carriers: string[];
  carrierExplanation: string;
  creativeContract: string;
  overallGrade: "" | "S" | "A" | "B" | "C";
  gradeReason: string;
  primaryPath: "LOVE" | "FUN" | "PERCEPTION";
  primaryPathAnswers: Record<"LOVE" | "FUN" | "PERCEPTION", string[]>;
  auxiliaryPaths: Array<"LOVE" | "FUN" | "PERCEPTION">;
  auxiliaryPathDetails: Partial<Record<"LOVE" | "FUN" | "PERCEPTION", { description: string; role: string }>>;
};

export type V04UiSubmission = {
  id: string;
  versionNumber: number;
  submittedAt: string;
  submittedBy: string;
  draft: V04UiDraft;
};

export type V04UiMediaReference = {
  videoId: string;
  streamPath: string;
  posterPath: string | null;
  metadataPath: string;
  thumbnailKey: string | null;
  originalName: string;
  contentType: string;
  fileSize: number;
  status: string;
};

export type V04UiCapabilities = {
  roles: { member: boolean; uploader: boolean; expert: boolean; systemAdmin: boolean };
  canRead: boolean;
  canComment: boolean;
  canMaterialize: boolean;
  canAcquireLease: boolean;
  canEdit: boolean;
  canSubmit: boolean;
  canExpertReview: boolean;
  canForceRelease: boolean;
};

export type V04UiCase = {
  id: string;
  title: string;
  brand: string;
  duration: string;
  description: string;
  tags: string[];
  workState: V04UiWorkState;
  expertGrade: "" | "S" | "A" | "B" | "C";
  draft: V04UiDraft;
  submissions: V04UiSubmission[];
  activeEditor: string | null;
  lastSavedAt: string;
  submissionCount?: number;
  media?: V04UiMediaReference | null;
  capabilities?: V04UiCapabilities | null;
};

export type V04ServerWorkspaceModel = {
  video: {
    id: string;
    title: string;
    brand: string;
    description: string;
    tags: string[];
    media: V04UiMediaReference;
  };
  logicalEmpty: boolean;
  workspaceId: string | null;
  roundId: string | null;
  payload: V04DraftPayloadV1;
  state: V04UiWorkState;
  draftRevision: number;
  draftContentHash: string;
  submissionCount: number;
  latestSubmission: null | {
    id: string;
    submissionNumber: number;
    contentHash: string;
    submittedAt: string;
    submittedByName: string;
  };
  expertPreference: null | { submissionId: string; submissionNumber: number; grade: "S" | "A" | "B" | "C" };
  lease: null | {
    id: string;
    holderUserId: string;
    holderName: string;
    leaseVersion: number;
    expiresAt: string;
  };
  lastSavedAt: string | null;
  commentTasks: unknown[];
  viewerCapabilities: V04UiCapabilities;
};

export type V04ServerDetailModel = {
  video: V04ServerWorkspaceModel["video"];
  latestSubmission: null | {
    id: string;
    submissionNumber: number;
    submittedAt: string;
    submittedByName: string;
    payload: V04DraftPayloadV1;
  };
  expertPreferredSubmission: null | {
    id: string;
    submissionNumber: number;
    submittedAt: string;
    submittedByName: string;
    payload: V04DraftPayloadV1;
    grade: "S" | "A" | "B" | "C";
  };
  availableSubmissionVersions: Array<{
    id: string;
    submissionNumber: number;
    submittedAt: string;
    submittedByName: string;
  }>;
  currentDraftStateSummary: { state: V04UiWorkState; draftRevision: number };
  viewerCapabilities: V04UiCapabilities;
};

export type V04ServerCardModel = {
  videoId: string;
  state: V04UiWorkState;
  submissionCount: number;
  latestSubmission: null | { id: string; submissionNumber: number; submittedAt: string; submittedByName: string };
  expertPreference: null | { submissionId: string; submissionNumber: number; grade: "S" | "A" | "B" | "C" };
  currentEditor: null | { userId: string; displayName: string; expiresAt: string };
  viewerCapabilities: V04UiCapabilities;
};

export const V04_UI_MODULES = [
  "第一模块｜脚本反写",
  "第二模块｜全片事实与核心判断",
  "第三模块｜主导感知类型发生路径",
  "第四模块｜提交",
] as const;

export const V04_UI_SHOT_FIELDS: ReadonlyArray<{ key: V04ShotFieldKey; label: string }> = [
  { key: "startTime", label: "开始时间" },
  { key: "endTime", label: "结束时间" },
  { key: "shotScale", label: "景别" },
  { key: "cameraAngle", label: "机位／角度" },
  { key: "cameraMovement", label: "镜头运动" },
  { key: "visualContent", label: "画面内容（镜头故事）" },
  { key: "screenCopy", label: "字幕／屏幕文案" },
  { key: "subtitleEffect", label: "字幕特效" },
  { key: "dialogue", label: "对白" },
  { key: "voiceOver", label: "旁白" },
  { key: "soundEffect", label: "声效" },
  { key: "music", label: "音乐" },
];

export const V04_UI_STATE_LABELS: Record<V04UiWorkState, string> = {
  NOT_STARTED: "尚未开始",
  INCOMPLETE: "尚未完成",
  SUBMITTED: "已提交",
  MODIFIED_UNSUBMITTED: "有修改未提交",
  MODIFICATION_SUBMITTED: "修改已提交",
};

export function cloneV04UiDraft(draft: V04UiDraft): V04UiDraft {
  return structuredClone(draft);
}

const emptyChoice = (): V04ChoiceValue => ({
  selectedOptionIds: [],
  customText: "",
  vocabularyVersion: V04_VOCABULARY_VERSION,
});

export function emptyV04UiDraft(): V04UiDraft {
  return {
    shotGroups: [],
    commercialIntent: "",
    storySummary: "",
    creativeMotif: "",
    tensionButton: "",
    primaryMechanism: emptyChoice(),
    auxiliaryMechanism: emptyChoice(),
    creativeThinkingChain: "",
    storyReference: emptyChoice(),
    carriers: [],
    carrierExplanation: "",
    creativeContract: "",
    overallGrade: "",
    gradeReason: "",
    primaryPath: "LOVE",
    primaryPathAnswers: { LOVE: ["", "", "", "", ""], FUN: ["", "", "", "", ""], PERCEPTION: ["", "", "", "", ""] },
    auxiliaryPaths: [],
    auxiliaryPathDetails: {},
  };
}

const PRIMARY_DETAIL_KEYS: Record<V04PerceptionType, readonly string[]> = {
  LOVE: ["emotionalBase", "accumulation", "gapPressure", "releaseMethod", "mainCarrier"],
  FUN: ["originalExpectation", "deviation", "reveal", "reinterpretation", "mainCarrier"],
  PERCEPTION: ["perceptionRule", "repetitionVariation", "audiovisualRelation", "payoff", "mainCarrier"],
};

const carrierToUi = (value: string) => ({
  STORY: "故事",
  COPY: "文案",
  AUDIOVISUAL_RULE: "视听规则",
}[value] ?? value);

const carrierToContract = (value: string) => ({
  故事: "STORY",
  文案: "COPY",
  视听规则: "AUDIOVISUAL_RULE",
}[value] ?? value) as "STORY" | "COPY" | "AUDIOVISUAL_RULE";

export function v04PayloadToUiDraft(payload: V04DraftPayloadV1): V04UiDraft {
  const primary = (payload.perceptionPath.primaryType || "LOVE") as V04PerceptionType;
  const primaryPathAnswers = {
    LOVE: PRIMARY_DETAIL_KEYS.LOVE.map((key) => payload.perceptionPath.primaryType === "LOVE" ? payload.perceptionPath.primaryDetails[key] ?? "" : ""),
    FUN: PRIMARY_DETAIL_KEYS.FUN.map((key) => payload.perceptionPath.primaryType === "FUN" ? payload.perceptionPath.primaryDetails[key] ?? "" : ""),
    PERCEPTION: PRIMARY_DETAIL_KEYS.PERCEPTION.map((key) => payload.perceptionPath.primaryType === "PERCEPTION" ? payload.perceptionPath.primaryDetails[key] ?? "" : ""),
  };
  return {
    shotGroups: payload.script.shotGroups.map((group) => ({
      id: group.id,
      title: group.bridgeName,
      primaryRole: structuredClone(group.primaryCreativeRole),
      auxiliaryRole: structuredClone(group.auxiliaryCreativeRole),
      creativeDescription: group.keyCreativeDescription,
      shots: group.shots.map((shot) => ({
        id: shot.id,
        ...Object.fromEntries(V04_UI_SHOT_FIELDS.map(({ key }) => [key, shot[key] ?? ""])),
      })) as V04UiShot[],
    })),
    commercialIntent: payload.factsAndCoreJudgement.commercialIntent,
    storySummary: payload.factsAndCoreJudgement.storySynopsis,
    creativeMotif: payload.factsAndCoreJudgement.creativeMotif,
    tensionButton: payload.factsAndCoreJudgement.tensionButton,
    primaryMechanism: structuredClone(payload.factsAndCoreJudgement.mainMechanism),
    auxiliaryMechanism: structuredClone(payload.factsAndCoreJudgement.auxiliaryMechanism),
    creativeThinkingChain: payload.factsAndCoreJudgement.creativeThinkingChain,
    storyReference: structuredClone(payload.factsAndCoreJudgement.storyReference),
    carriers: payload.factsAndCoreJudgement.creativeCarriers.map(carrierToUi),
    carrierExplanation: payload.factsAndCoreJudgement.carrierExplanation,
    creativeContract: payload.factsAndCoreJudgement.acceptanceContract,
    overallGrade: payload.factsAndCoreJudgement.overallCreativeRating,
    gradeReason: payload.factsAndCoreJudgement.ratingReason,
    primaryPath: primary,
    primaryPathAnswers,
    auxiliaryPaths: payload.perceptionPath.auxiliaryTypes.map((item) => item.type),
    auxiliaryPathDetails: Object.fromEntries(payload.perceptionPath.auxiliaryTypes.map((item) => [
      item.type,
      { description: item.description, role: item.creativeRole },
    ])),
  };
}

export function v04UiDraftToPayload(
  draft: V04UiDraft,
  previous?: V04DraftPayloadV1,
): V04DraftPayloadV1 {
  const primaryType = draft.primaryPath as V04PerceptionType;
  return {
    contract: previous?.contract ?? {
      productVersion: V04_PRODUCT_VERSION,
      taxonomyVersion: V04_TAXONOMY_VERSION,
      workflowVersion: V04_WORKFLOW_VERSION,
      vocabularyVersion: V04_VOCABULARY_VERSION,
      payloadSchemaVersion: V04_PAYLOAD_SCHEMA_VERSION,
    },
    script: {
      shotGroups: draft.shotGroups.map((group, groupIndex) => ({
        id: group.id,
        orderIndex: groupIndex,
        bridgeName: group.title,
        primaryCreativeRole: structuredClone(group.primaryRole),
        auxiliaryCreativeRole: structuredClone(group.auxiliaryRole),
        keyCreativeDescription: group.creativeDescription,
        shots: group.shots.map((shot, shotIndex) => ({
          id: shot.id,
          orderIndex: draft.shotGroups.slice(0, groupIndex)
            .reduce((sum, item) => sum + item.shots.length, 0) + shotIndex,
          ...Object.fromEntries(V04_UI_SHOT_FIELDS.map(({ key }) => [key, shot[key] ?? ""])),
        })) as V04DraftPayloadV1["script"]["shotGroups"][number]["shots"],
      })),
    },
    factsAndCoreJudgement: {
      commercialIntent: draft.commercialIntent,
      storySynopsis: draft.storySummary,
      creativeMotif: draft.creativeMotif,
      tensionButton: draft.tensionButton,
      mainMechanism: structuredClone(draft.primaryMechanism),
      auxiliaryMechanism: structuredClone(draft.auxiliaryMechanism),
      creativeThinkingChain: draft.creativeThinkingChain,
      storyReference: structuredClone(draft.storyReference),
      creativeCarriers: draft.carriers.map(carrierToContract),
      carrierExplanation: draft.carrierExplanation,
      acceptanceContract: draft.creativeContract,
      overallCreativeRating: draft.overallGrade,
      ratingReason: draft.gradeReason,
    },
    perceptionPath: {
      primaryType,
      primaryDetails: Object.fromEntries(PRIMARY_DETAIL_KEYS[primaryType].map((key, index) => [
        key,
        draft.primaryPathAnswers[primaryType][index] ?? "",
      ])),
      auxiliaryTypes: draft.auxiliaryPaths.map((type) => ({
        type,
        description: draft.auxiliaryPathDetails[type]?.description ?? "",
        creativeRole: draft.auxiliaryPathDetails[type]?.role ?? "",
      })),
    },
    metadata: previous?.metadata ?? { source: "HUMAN" },
  };
}

export function v04PayloadChanges(before: V04DraftPayloadV1, after: V04DraftPayloadV1): V04Change[] {
  const changes: V04Change[] = [];
  const push = (targetKey: string, targetLabel: string, beforeValue: unknown, afterValue: unknown, valueType: V04Change["valueType"] = "TEXT") => {
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      changes.push({ targetKey, targetLabel, beforeValue, afterValue, valueType });
    }
  };
  const structure = (payload: V04DraftPayloadV1) => payload.script.shotGroups.map((group) => ({
    id: group.id,
    orderIndex: group.orderIndex,
    shotIds: group.shots.map((shot) => ({ id: shot.id, orderIndex: shot.orderIndex })),
  }));
  if (JSON.stringify(structure(before)) !== JSON.stringify(structure(after))) {
    push("script.structure", "脚本结构", before.script.shotGroups, after.script.shotGroups, "STRUCTURE");
  } else {
    for (const afterGroup of after.script.shotGroups) {
      const beforeGroup = before.script.shotGroups.find((group) => group.id === afterGroup.id)!;
      push(`shotGroup:${afterGroup.id}.bridgeName`, "桥段名称", beforeGroup.bridgeName, afterGroup.bridgeName);
      push(`shotGroup:${afterGroup.id}.primaryCreativeRole`, "桥段主创意作用", beforeGroup.primaryCreativeRole, afterGroup.primaryCreativeRole, "CHOICE_WITH_CUSTOM");
      push(`shotGroup:${afterGroup.id}.auxiliaryCreativeRole`, "桥段辅助创意作用", beforeGroup.auxiliaryCreativeRole, afterGroup.auxiliaryCreativeRole, "CHOICE_WITH_CUSTOM");
      push(`shotGroup:${afterGroup.id}.keyCreativeDescription`, "本桥段关键创意描述", beforeGroup.keyCreativeDescription, afterGroup.keyCreativeDescription);
      for (const afterShot of afterGroup.shots) {
        const beforeShot = beforeGroup.shots.find((shot) => shot.id === afterShot.id)!;
        for (const field of V04_UI_SHOT_FIELDS) {
          push(`shot:${afterShot.id}.${field.key}`, field.label, beforeShot[field.key], afterShot[field.key]);
        }
      }
    }
  }
  const facts = after.factsAndCoreJudgement;
  for (const key of Object.keys(facts) as Array<keyof typeof facts>) {
    const valueType: V04Change["valueType"] = typeof facts[key] === "string"
      ? "TEXT"
      : key === "creativeCarriers" ? "MULTI_SELECT" : "CHOICE_WITH_CUSTOM";
    push(`facts.${key}`, String(key), before.factsAndCoreJudgement[key], facts[key], valueType);
  }
  push("path.primaryType", "主导路径", before.perceptionPath.primaryType, after.perceptionPath.primaryType, "SINGLE_SELECT");
  push("path.primaryDetails", "主导路径细项", before.perceptionPath.primaryDetails, after.perceptionPath.primaryDetails, "STRUCTURE");
  push("path.auxiliaryTypes", "辅助路径", before.perceptionPath.auxiliaryTypes, after.perceptionPath.auxiliaryTypes, "STRUCTURE");
  return changes;
}

function locateV04UiPayloadTarget(payload: V04DraftPayloadV1, targetKey: string) {
  const groupMatch = /^shotGroup:([^.]+)\.(.+)$/.exec(targetKey);
  if (groupMatch) {
    const group = payload.script.shotGroups.find((entry) => entry.id === groupMatch[1]);
    if (!group) return null;
    const keys: Record<string, keyof typeof group> = {
      bridgeName: "bridgeName",
      primaryCreativeRole: "primaryCreativeRole",
      auxiliaryCreativeRole: "auxiliaryCreativeRole",
      keyCreativeDescription: "keyCreativeDescription",
    };
    const key = keys[groupMatch[2]];
    return key ? { object: group as unknown as Record<string, unknown>, key } : null;
  }
  const shotMatch = /^shot:([^.]+)\.(.+)$/.exec(targetKey);
  if (shotMatch) {
    const shot = payload.script.shotGroups.flatMap((group) => group.shots)
      .find((entry) => entry.id === shotMatch[1]);
    return shot ? { object: shot as unknown as Record<string, unknown>, key: shotMatch[2] } : null;
  }
  if (targetKey.startsWith("facts.") && !targetKey.slice(6).includes(".")) {
    return {
      object: payload.factsAndCoreJudgement as unknown as Record<string, unknown>,
      key: targetKey.slice(6),
    };
  }
  if (targetKey.startsWith("path.") && !targetKey.slice(5).includes(".")) {
    return {
      object: payload.perceptionPath as unknown as Record<string, unknown>,
      key: targetKey.slice(5),
    };
  }
  if (targetKey === "script.structure") {
    return { object: payload.script as unknown as Record<string, unknown>, key: "shotGroups" };
  }
  return null;
}

export function v04PayloadTargetValue(payload: V04DraftPayloadV1, targetKey: string) {
  const target = locateV04UiPayloadTarget(payload, targetKey);
  return target ? structuredClone(target.object[target.key]) : undefined;
}

export function applyV04PayloadValues(
  payload: V04DraftPayloadV1,
  changes: readonly Pick<V04Change, "targetKey" | "afterValue">[],
) {
  const next = structuredClone(payload);
  for (const change of changes) {
    const target = locateV04UiPayloadTarget(next, change.targetKey);
    if (!target) throw new Error("UNADDRESSABLE_RECOVERY_TARGET");
    target.object[target.key] = structuredClone(change.afterValue);
  }
  return next;
}

export type V04ConflictResolutionPlan = {
  payload: V04DraftPayloadV1;
  keptTargets: string[];
  droppedTargets: string[];
  unaddressableTargets: string[];
};

/**
 * Rebuilds the draft on top of the server's current payload after a version
 * conflict, keeping every local edit that is not being handed to the server.
 *
 * Starting from the server payload rather than from the local one matters in
 * both directions: a colleague's edit to a target this page never touched
 * survives instead of being silently reverted on the next save, and choosing
 * "server wins" narrows to the named conflict targets instead of discarding
 * the whole local draft.
 */
export function planV04ConflictResolution(input: {
  server: V04DraftPayloadV1;
  base: V04DraftPayloadV1;
  local: V04DraftPayloadV1;
  conflictTargets: readonly string[];
  prefer: "LOCAL" | "SERVER";
}): V04ConflictResolutionPlan {
  const conflicting = new Set(input.conflictTargets);
  // The primary perception type and its detail fields are one answer: keeping a
  // local type change while taking the server's details (or the reverse) would
  // leave details that belong to a different path. They resolve together.
  if (input.prefer === "SERVER" &&
    (conflicting.has("path.primaryType") || conflicting.has("path.primaryDetails"))) {
    conflicting.add("path.primaryType");
    conflicting.add("path.primaryDetails");
  }
  const payload = structuredClone(input.server);
  const keptTargets: string[] = [];
  const droppedTargets: string[] = [];
  const unaddressableTargets: string[] = [];
  for (const change of v04PayloadChanges(input.base, input.local)) {
    if (input.prefer === "SERVER" && conflicting.has(change.targetKey)) {
      droppedTargets.push(change.targetKey);
      continue;
    }
    const target = locateV04UiPayloadTarget(payload, change.targetKey);
    if (!target) {
      // The target no longer exists on the server: another editor removed the
      // bridge or shot this edit belongs to. It cannot be replayed here.
      unaddressableTargets.push(change.targetKey);
      continue;
    }
    target.object[target.key] = structuredClone(change.afterValue);
    keptTargets.push(change.targetKey);
  }
  return { payload, keptTargets, droppedTargets, unaddressableTargets };
}

export function v04CardToUiCase(video: VideoItem, card: V04ServerCardModel): V04UiCase {
  const encodedId = encodeURIComponent(video.id);
  return {
    id: video.id,
    title: video.title,
    brand: video.brand,
    duration: "",
    description: video.description,
    tags: video.tags,
    workState: card.state,
    expertGrade: card.expertPreference?.grade ?? "",
    draft: emptyV04UiDraft(),
    submissions: [],
    activeEditor: card.currentEditor?.displayName ?? null,
    lastSavedAt: "",
    submissionCount: card.submissionCount,
    media: {
      videoId: video.id,
      streamPath: `/api/videos/${encodedId}/stream`,
      posterPath: video.thumbnailUrl,
      metadataPath: `/api/videos/${encodedId}`,
      thumbnailKey: null,
      originalName: video.originalName,
      contentType: video.contentType,
      fileSize: video.fileSize,
      status: video.status,
    },
    capabilities: card.viewerCapabilities,
  };
}

export function v04DetailToUiCase(detail: V04ServerDetailModel): V04UiCase {
  const selected = detail.latestSubmission;
  const submission = selected ? [{
    id: selected.id,
    versionNumber: selected.submissionNumber,
    submittedAt: selected.submittedAt,
    submittedBy: selected.submittedByName,
    draft: v04PayloadToUiDraft(selected.payload),
  }] : [];
  return {
    id: detail.video.id,
    title: detail.video.title,
    brand: detail.video.brand,
    duration: "",
    description: detail.video.description,
    tags: detail.video.tags,
    workState: detail.currentDraftStateSummary.state,
    expertGrade: detail.expertPreferredSubmission?.grade ?? "",
    draft: submission[0]?.draft ?? emptyV04UiDraft(),
    submissions: submission,
    activeEditor: null,
    lastSavedAt: "",
    submissionCount: detail.availableSubmissionVersions.length,
    media: detail.video.media,
    capabilities: detail.viewerCapabilities,
  };
}

export function v04WorkspaceToUiCase(workspace: V04ServerWorkspaceModel): V04UiCase {
  return {
    id: workspace.video.id,
    title: workspace.video.title,
    brand: workspace.video.brand,
    duration: "",
    description: workspace.video.description,
    tags: workspace.video.tags,
    workState: workspace.state,
    expertGrade: workspace.expertPreference?.grade ?? "",
    draft: v04PayloadToUiDraft(workspace.payload),
    submissions: [],
    activeEditor: workspace.lease?.holderName ?? null,
    lastSavedAt: workspace.lastSavedAt ?? "",
    submissionCount: workspace.submissionCount,
    media: workspace.video.media,
    capabilities: workspace.viewerCapabilities,
  };
}
