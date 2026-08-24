/**
 * V1.9 "对比基版" (diff against base version) — pure functions ported from the
 * approved interaction demo (`docs/demos/2026-08-24-二合一工作台交互demo.html`,
 * see `computeDiff`) per spec rule 8 in
 * `docs/18_V1.9_二合一工作台重构实施规格_V0.1.md`.
 *
 * No React, no DOM, no network — safe to import from both server and client
 * code.
 */

import {
  V04_SHOT_FIELD_KEYS,
  type V04DraftPayloadV1,
  type V04FactsAndCoreJudgement,
  type V04PerceptionPath,
  type V04ShotGroupPayload,
} from "@/lib/v04-contract";

export type V19BaseDiff = {
  /** Stable target key -> the BASE value, so the UI can show 基版原文. */
  changedFields: Map<string, unknown>;
  newShotIds: Set<string>;
  newBridgeIds: Set<string>;
  counts: { changedFields: number; newShots: number; newBridges: number };
};

const V19_SHOT_GROUP_FIELD_KEYS = [
  "bridgeName",
  "keyCreativeDescription",
  "primaryCreativeRole",
  "auxiliaryCreativeRole",
] as const satisfies readonly (keyof V04ShotGroupPayload)[];

const V19_FACTS_FIELD_KEYS = [
  "commercialIntent",
  "storySynopsis",
  "creativeMotif",
  "tensionButton",
  "mainMechanism",
  "auxiliaryMechanism",
  "creativeThinkingChain",
  "storyReference",
  "creativeCarriers",
  "carrierExplanation",
  "acceptanceContract",
  "overallCreativeRating",
  "ratingReason",
] as const satisfies readonly (keyof V04FactsAndCoreJudgement)[];

const V19_PERCEPTION_PATH_FIELD_KEYS = [
  "primaryType",
  "primaryDetails",
  "auxiliaryTypes",
] as const satisfies readonly (keyof V04PerceptionPath)[];

/**
 * Canonicalises a value so structurally-equal choice values / arrays compare
 * equal regardless of object key order. Equivalent to the local `stableValue`
 * helper behind `canonicalV04Payload` in `lib/v04-domain.ts`, reproduced here
 * so this module stays free-standing (pure, no server-only dependency).
 */
function stableV19Value(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableV19Value);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, item]) => [key, stableV19Value(item)]),
    );
  }
  return value;
}

function canonicalV19Value(value: unknown): string {
  return JSON.stringify(stableV19Value(value));
}

/**
 * Diffs `current` against the version's frozen base snapshot. Returns `null`
 * when there is no base (e.g. the version was not created from another
 * version).
 *
 * A bridge present in `current` but absent from `base` counts as one new
 * bridge and all of its shots count as new shots — its fields are NOT also
 * reported as changed, so a new block is labelled once rather than field by
 * field. Same rule for a new shot inside an otherwise-existing bridge.
 */
export function diffV19AgainstBase(
  current: V04DraftPayloadV1,
  base: V04DraftPayloadV1 | null,
): V19BaseDiff | null {
  if (!base) return null;

  const changedFields = new Map<string, unknown>();
  const newShotIds = new Set<string>();
  const newBridgeIds = new Set<string>();
  let newShotCount = 0;
  let newBridgeCount = 0;

  const mark = (key: string, baseValue: unknown) => {
    changedFields.set(key, baseValue);
  };

  const baseGroupsById = new Map(base.script.shotGroups.map((group) => [group.id, group]));
  const baseShotsById = new Map(
    base.script.shotGroups.flatMap((group) => group.shots.map((shot) => [shot.id, shot] as const)),
  );

  for (const group of current.script.shotGroups) {
    const baseGroup = baseGroupsById.get(group.id);
    if (!baseGroup) {
      newBridgeIds.add(group.id);
      newBridgeCount += 1;
      for (const shot of group.shots) {
        newShotIds.add(shot.id);
        newShotCount += 1;
      }
      continue;
    }

    for (const fieldKey of V19_SHOT_GROUP_FIELD_KEYS) {
      if (canonicalV19Value(group[fieldKey]) !== canonicalV19Value(baseGroup[fieldKey])) {
        mark(`shotGroup:${group.id}.${fieldKey}`, baseGroup[fieldKey]);
      }
    }

    for (const shot of group.shots) {
      const baseShot = baseShotsById.get(shot.id);
      if (!baseShot) {
        newShotIds.add(shot.id);
        newShotCount += 1;
        continue;
      }
      for (const fieldKey of V04_SHOT_FIELD_KEYS) {
        if (canonicalV19Value(shot[fieldKey]) !== canonicalV19Value(baseShot[fieldKey])) {
          mark(`shot:${shot.id}.${fieldKey}`, baseShot[fieldKey]);
        }
      }
    }
  }

  for (const fieldKey of V19_FACTS_FIELD_KEYS) {
    if (canonicalV19Value(current.factsAndCoreJudgement[fieldKey]) !== canonicalV19Value(base.factsAndCoreJudgement[fieldKey])) {
      mark(`facts.${fieldKey}`, base.factsAndCoreJudgement[fieldKey]);
    }
  }

  for (const fieldKey of V19_PERCEPTION_PATH_FIELD_KEYS) {
    if (canonicalV19Value(current.perceptionPath[fieldKey]) !== canonicalV19Value(base.perceptionPath[fieldKey])) {
      mark(`path.${fieldKey}`, base.perceptionPath[fieldKey]);
    }
  }

  return {
    changedFields,
    newShotIds,
    newBridgeIds,
    counts: {
      changedFields: changedFields.size,
      newShots: newShotCount,
      newBridges: newBridgeCount,
    },
  };
}

/** Chinese summary used in the toast, e.g. "相比基版：修改 2 项 · 新增 1 个镜头 · 新增 0 个桥段". */
export function describeV19Diff(diff: V19BaseDiff | null): string {
  if (!diff) return "";
  return `相比基版：修改 ${diff.counts.changedFields} 项 · 新增 ${diff.counts.newShots} 个镜头 · 新增 ${diff.counts.newBridges} 个桥段`;
}
