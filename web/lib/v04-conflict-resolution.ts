import { V04_VOCABULARY_OPTIONS } from "@/lib/v04-vocabulary";
import { V04_UI_SHOT_FIELDS } from "@/lib/v04-ui-model";
import { V04_UI_PATHS } from "@/lib/v04-ui-fixture";

export type V04ConflictDifference = {
  path: string;
  serverText: string;
  localText: string;
};

const OPTION_LABELS = new Map<string, string>(
  V04_VOCABULARY_OPTIONS.map((option) => [option.optionId as string, option.labelZhCn]));

const PRIMARY_DETAIL_KEYS = {
  LOVE: ["emotionalBase", "accumulation", "gapPressure", "releaseMethod", "mainCarrier"],
  FUN: ["originalExpectation", "deviation", "reveal", "reinterpretation", "mainCarrier"],
  PERCEPTION: ["perceptionRule", "repetitionVariation", "audiovisualRelation", "payoff", "mainCarrier"],
} as const;

const PRIMARY_DETAIL_LABELS = new Map<string, string>(
  V04_UI_PATHS.flatMap((path) =>
    PRIMARY_DETAIL_KEYS[path.id].map((key, index) => [key, path.fields[index] ?? key] as const)),
);

const GROUP_FIELD_LABELS: Record<string, string> = {
  bridgeName: "桥段名称",
  primaryCreativeRole: "桥段主创意作用",
  auxiliaryCreativeRole: "桥段辅助创意作用",
  keyCreativeDescription: "本桥段关键创意描述",
};

const SHOT_FIELD_LABELS = new Map(V04_UI_SHOT_FIELDS.map((field) => [field.key as string, field.label]));

const ABSENT = "（不存在）";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isChoice(value: unknown) {
  return isRecord(value) && Array.isArray(value.selectedOptionIds);
}

export function describeV04ConflictValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "（空）";
  if (isChoice(value)) {
    const record = value as Record<string, unknown>;
    const options = (record.selectedOptionIds as string[])
      .map((optionId) => OPTION_LABELS.get(optionId) ?? optionId);
    const parts = [
      options.join("、"),
      typeof record.customText === "string" ? record.customText.trim() : "",
      typeof record.advancedText === "string" ? record.advancedText.trim() : "",
    ].filter(Boolean);
    return parts.length ? parts.join(" ｜ ") : "（空）";
  }
  if (Array.isArray(value)) {
    return value.length ? value.map(describeV04ConflictValue).join("、") : "（空）";
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function push(
  differences: V04ConflictDifference[],
  path: string,
  serverValue: unknown,
  localValue: unknown,
) {
  if (same(serverValue, localValue)) return;
  differences.push({
    path,
    serverText: serverValue === undefined ? ABSENT : describeV04ConflictValue(serverValue),
    localText: localValue === undefined ? ABSENT : describeV04ConflictValue(localValue),
  });
}

type ShotGroupLike = Record<string, unknown> & { id?: string; shots?: unknown };

function groupsById(value: unknown) {
  const groups = Array.isArray(value) ? value as ShotGroupLike[] : [];
  return new Map(groups
    .filter((group) => isRecord(group) && typeof group.id === "string")
    .map((group) => [group.id as string, group]));
}

function shotsById(group: ShotGroupLike | undefined) {
  const shots = Array.isArray(group?.shots) ? group.shots as Record<string, unknown>[] : [];
  return new Map(shots
    .filter((shot) => isRecord(shot) && typeof shot.id === "string")
    .map((shot) => [shot.id as string, shot]));
}

function groupLabel(
  groupId: string,
  server: ShotGroupLike | undefined,
  local: ShotGroupLike | undefined,
  order: number,
) {
  const name = [local?.bridgeName, server?.bridgeName]
    .find((value) => typeof value === "string" && value.trim());
  return `桥段 ${order}｜${typeof name === "string" && name.trim() ? name.trim() : groupId}`;
}

function shotLabel(group: string, shotId: string, order: number) {
  return `${group} · 镜头 ${order}`;
}

function diffShotGroups(serverValue: unknown, localValue: unknown) {
  const differences: V04ConflictDifference[] = [];
  const serverGroups = groupsById(serverValue);
  const localGroups = groupsById(localValue);
  const groupIds = [...new Set([...localGroups.keys(), ...serverGroups.keys()])];
  groupIds.forEach((groupId, groupIndex) => {
    const server = serverGroups.get(groupId);
    const local = localGroups.get(groupId);
    const label = groupLabel(groupId, server, local, groupIndex + 1);
    if (!server || !local) {
      push(differences, label, server && "（整段存在）", local && "（整段存在）");
      return;
    }
    for (const [key, fieldLabel] of Object.entries(GROUP_FIELD_LABELS)) {
      push(differences, `${label} · ${fieldLabel}`, server[key], local[key]);
    }
    const serverShots = shotsById(server);
    const localShots = shotsById(local);
    const shotIds = [...new Set([...localShots.keys(), ...serverShots.keys()])];
    shotIds.forEach((shotId, shotIndex) => {
      const serverShot = serverShots.get(shotId);
      const localShot = localShots.get(shotId);
      const currentShotLabel = shotLabel(label, shotId, shotIndex + 1);
      if (!serverShot || !localShot) {
        push(
          differences,
          currentShotLabel,
          serverShot && "（整个镜头存在）",
          localShot && "（整个镜头存在）",
        );
        return;
      }
      for (const [key, fieldLabel] of SHOT_FIELD_LABELS) {
        push(differences, `${currentShotLabel} · ${fieldLabel}`, serverShot[key], localShot[key]);
      }
    });
  });
  return differences;
}

function diffPrimaryDetails(serverValue: unknown, localValue: unknown) {
  const differences: V04ConflictDifference[] = [];
  const server = isRecord(serverValue) ? serverValue : {};
  const local = isRecord(localValue) ? localValue : {};
  for (const key of [...new Set([...Object.keys(local), ...Object.keys(server)])]) {
    push(differences, PRIMARY_DETAIL_LABELS.get(key) ?? key, server[key], local[key]);
  }
  return differences;
}

function diffAuxiliaryTypes(serverValue: unknown, localValue: unknown) {
  const differences: V04ConflictDifference[] = [];
  const index = (value: unknown) => new Map((Array.isArray(value) ? value : [])
    .filter(isRecord)
    .map((item) => [String(item.type), item]));
  const server = index(serverValue);
  const local = index(localValue);
  for (const type of [...new Set([...local.keys(), ...server.keys()])]) {
    const label = V04_UI_PATHS.find((path) => path.id === type)?.label ?? type;
    const serverItem = server.get(type);
    const localItem = local.get(type);
    if (!serverItem || !localItem) {
      push(
        differences,
        `${label} 辅助路径`,
        serverItem && "（已选择）",
        localItem && "（已选择）",
      );
      continue;
    }
    push(differences, `${label} 辅助路径 · 描述`, serverItem.description, localItem.description);
    push(differences, `${label} 辅助路径 · 创意作用`, serverItem.creativeRole, localItem.creativeRole);
  }
  return differences;
}

/**
 * A conflicting stable target can carry a whole module: `script.structure`
 * holds every bridge, shot and shot field of the case. Choosing a side for
 * such a target is only an informed choice if the editor can see which
 * concrete fields differ, so composite values are broken down to the leaves
 * that actually disagree.
 */
export function summarizeV04ConflictDifferences(
  targetKey: string,
  serverValue: unknown,
  localValue: unknown,
  limit = 8,
): { differences: V04ConflictDifference[]; hidden: number } {
  let all: V04ConflictDifference[];
  if (targetKey === "script.structure") all = diffShotGroups(serverValue, localValue);
  else if (targetKey === "path.primaryDetails") all = diffPrimaryDetails(serverValue, localValue);
  else if (targetKey === "path.auxiliaryTypes") all = diffAuxiliaryTypes(serverValue, localValue);
  else {
    all = [];
    push(all, "", serverValue, localValue);
  }
  return { differences: all.slice(0, limit), hidden: Math.max(0, all.length - limit) };
}
