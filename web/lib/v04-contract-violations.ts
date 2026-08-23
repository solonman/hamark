import type { V04ContractViolation } from "@/lib/v04-contract-rules";
import { v04GroupPrimaryRoleTargetId, V04_WORKSPACE_TARGETS } from "@/lib/v04-ui-client-state";

export function readV04ContractViolations(details: unknown): V04ContractViolation[] {
  const list = details && typeof details === "object"
    ? (details as { violations?: unknown }).violations
    : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is V04ContractViolation =>
    Boolean(item) && typeof item === "object" &&
    typeof (item as V04ContractViolation).targetKey === "string" &&
    typeof (item as V04ContractViolation).targetLabel === "string" &&
    typeof (item as V04ContractViolation).message === "string");
}

/**
 * A contract violation is not a transient failure: the same draft fails the
 * same way on every retry. The message must say so and name the field,
 * never invite a retry that cannot succeed.
 */
export function v04ContractViolationMessage(violations: readonly V04ContractViolation[]) {
  const names = [...new Set(violations.map((item) => item.targetLabel))];
  return `以下字段不符合固定规则，修正后会自动保存（重试不会改变结果）：${names.join("、")}。本地内容已保留。`;
}

export function v04ViolationLocateId(targetKey: string): string | null {
  const group = /^shotGroup:([^.]+)/.exec(targetKey);
  if (group) return v04GroupPrimaryRoleTargetId(group[1]);
  if (targetKey === "facts.mainMechanism") return V04_WORKSPACE_TARGETS.primaryMechanism;
  if (targetKey === "facts.auxiliaryMechanism") return V04_WORKSPACE_TARGETS.auxiliaryMechanism;
  if (targetKey === "facts.storyReference") return V04_WORKSPACE_TARGETS.storyReference;
  if (targetKey === "facts.creativeCarriers") return V04_WORKSPACE_TARGETS.carriers;
  if (targetKey.startsWith("path.")) return "module-3";
  if (targetKey.startsWith("shot:")) return "module-1";
  return null;
}
