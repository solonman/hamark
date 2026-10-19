import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { emptyV04ChoiceValue } from "../lib/v04-domain.ts";
import { listV04ContractViolations, resolveV04ExclusiveOverlaps } from "../lib/v04-contract-rules.ts";
import { foldV04ExclusiveAdjustments } from "../lib/v04-domain.ts";
import { cloneV04UiDraft, v04UiDraftToPayload } from "../lib/v04-ui-model.ts";
import { getV04UiCase } from "../lib/v04-ui-fixture.ts";

// 「工作稿不符合冻结规则」回归：V1.9 工作台的主辅选择框没有互斥，同一项可以既选
// 主导又选辅助，服务端整份拒收，之后每次自动保存都跟着失败，胶囊里只剩一句被截断的话。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".css")) return { url: `css-stub:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("css-stub:")) return { format: "module", source: "export default {};", shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { withoutV19PrimaryOverlap } = await import("../components/v04/V19StudioDocument.tsx");
const { describeV19ContractViolations, applyV19AdjustedTargets } = await import("../components/v04/V04StudioClient.tsx");
const documentSource = await readFile(new URL("../components/v04/V19StudioDocument.tsx", import.meta.url), "utf8");
const clientSource = await readFile(new URL("../components/v04/V04StudioClient.tsx", import.meta.url), "utf8");

const choice = (ids: string[]) => ({ ...emptyV04ChoiceValue(), selectedOptionIds: ids, customText: "保留" });

test("withoutV19PrimaryOverlap drops only the primary's options and keeps custom text", () => {
  const aux = choice(["A", "B"]);
  assert.deepEqual(withoutV19PrimaryOverlap(aux, choice(["B"])), { ...aux, selectedOptionIds: ["A"] });
  assert.equal(withoutV19PrimaryOverlap(aux, choice(["C"])), aux, "no overlap returns the same object");
});

test("a draft with the same mechanism in both slots is caught locally, before any request", () => {
  const source = getV04UiCase("aurora");
  if (!source) throw new Error("expected the aurora fixture case to exist");
  const draft = cloneV04UiDraft(source.draft);
  const shared = draft.auxiliaryMechanism.selectedOptionIds[0] ?? "PENDING_NEW_MECHANISM";
  draft.primaryMechanism = { ...draft.primaryMechanism, selectedOptionIds: [shared] };
  draft.auxiliaryMechanism = { ...draft.auxiliaryMechanism, selectedOptionIds: [shared] };
  const violations = listV04ContractViolations(v04UiDraftToPayload(draft));
  assert.ok(violations.some((item) => item.targetKey === "facts.auxiliaryMechanism"));

  draft.auxiliaryMechanism = withoutV19PrimaryOverlap(draft.auxiliaryMechanism, draft.primaryMechanism);
  assert.deepEqual(listV04ContractViolations(v04UiDraftToPayload(draft))
    .filter((item) => item.targetKey === "facts.auxiliaryMechanism"), []);
});

test("violation notice names the field: short chip, full toast, stable dedupe signature", () => {
  const one = describeV19ContractViolations([
    { targetKey: "facts.auxiliaryMechanism", targetLabel: "辅助机制", message: "与主导机制选了同一项；主辅机制必须互斥" },
  ]);
  assert.equal(one.chip, "「辅助机制」不符合固定规则，改正后自动保存");
  assert.match(one.toast, /辅助机制——与主导机制选了同一项/);
  const two = describeV19ContractViolations([
    { targetKey: "facts.auxiliaryMechanism", targetLabel: "辅助机制", message: "x" },
    { targetKey: "path.auxiliaryTypes", targetLabel: "辅助路径", message: "y" },
  ]);
  assert.equal(two.chip, "2 处不符合固定规则，改正后自动保存");
  assert.notEqual(one.signature, two.signature);
});

test("studio wiring: primary setters strip the auxiliary, auxiliary pickers hide the primary, save prechecks", () => {
  assert.match(documentSource, /next\.auxiliaryMechanism = withoutV19PrimaryOverlap\(next\.auxiliaryMechanism, value\)/);
  assert.match(documentSource, /group\.auxiliaryRole = withoutV19PrimaryOverlap\(group\.auxiliaryRole, value\)/);
  assert.match(documentSource, /V04_UI_MECHANISM_OPTIONS\.filter\(\(option\) => !draft\.primaryMechanism\.selectedOptionIds\.includes/);
  assert.match(documentSource, /V04_UI_BRIDGE_OPTIONS\.filter\(\(option\) => !group\.primaryRole\.selectedOptionIds\.includes/);
  assert.match(documentSource, /已是辅助路径/);
  assert.match(clientSource, /listV04ContractViolations\(afterPayload\)/);
  assert.match(clientSource, /reason\.code === "CHOICE_RULE_VIOLATION"/);
});

function auroraDraft() {
  const source = getV04UiCase("aurora");
  if (!source) throw new Error("expected the aurora fixture case to exist");
  return cloneV04UiDraft(source.draft);
}

test("resolveV04ExclusiveOverlaps: primary wins in all three pairs, and a valid payload is returned untouched", () => {
  const draft = auroraDraft();
  const valid = v04UiDraftToPayload(draft);
  assert.equal(resolveV04ExclusiveOverlaps(valid).payload, valid);
  assert.deepEqual(resolveV04ExclusiveOverlaps(valid).adjustments, []);

  const payload = structuredClone(valid);
  const group = payload.script.shotGroups[0];
  group.auxiliaryCreativeRole = { ...group.auxiliaryCreativeRole, selectedOptionIds: [...group.primaryCreativeRole.selectedOptionIds] };
  payload.perceptionPath.primaryType = "FUN";
  payload.perceptionPath.auxiliaryTypes = [
    { type: "FUN", description: "x", creativeRole: "y" },
    { type: "PERCEPTION", description: "", creativeRole: "" },
  ];
  payload.factsAndCoreJudgement.mainMechanism = { ...payload.factsAndCoreJudgement.mainMechanism, selectedOptionIds: ["INSIGHT_RESONANCE"] };
  payload.factsAndCoreJudgement.auxiliaryMechanism = { ...payload.factsAndCoreJudgement.auxiliaryMechanism, selectedOptionIds: ["INSIGHT_RESONANCE"] };
  assert.ok(listV04ContractViolations(payload).length >= 3);

  const resolved = resolveV04ExclusiveOverlaps(payload);
  assert.deepEqual(listV04ContractViolations(resolved.payload), []);
  assert.deepEqual(resolved.adjustments.map((item) => item.targetKey), [
    `shotGroup:${group.id}.auxiliaryCreativeRole`, "facts.auxiliaryMechanism", "path.auxiliaryTypes",
  ]);
  assert.deepEqual(resolved.payload.factsAndCoreJudgement.mainMechanism.selectedOptionIds, ["INSIGHT_RESONANCE"]);
  assert.deepEqual(resolved.payload.perceptionPath.auxiliaryTypes.map((item) => item.type), ["PERCEPTION"]);
  assert.equal(payload.perceptionPath.auxiliaryTypes.length, 2, "input is not mutated");
});

test("foldV04ExclusiveAdjustments: one record per target, a trim of an incoming change rewrites its afterValue", () => {
  const before = choice([]);
  const incoming = { targetKey: "facts.auxiliaryMechanism", targetLabel: "auxiliaryMechanism", valueType: "CHOICE_WITH_CUSTOM" as const, beforeValue: before, afterValue: choice(["A", "B"]) };
  const trimmed = choice(["B"]);
  const folded = foldV04ExclusiveAdjustments([incoming], [
    { targetKey: "facts.auxiliaryMechanism", targetLabel: "auxiliaryMechanism", valueType: "CHOICE_WITH_CUSTOM", beforeValue: choice(["A", "B"]), afterValue: trimmed },
    { targetKey: "path.auxiliaryTypes", targetLabel: "辅助路径", valueType: "STRUCTURE", beforeValue: [1], afterValue: [] },
  ]);
  assert.equal(folded.length, 2);
  assert.deepEqual(folded[0].afterValue, trimmed);
  assert.deepEqual(folded[0].beforeValue, before);
  assert.equal(incoming.afterValue.selectedOptionIds.length, 2, "input changes are not mutated");
  assert.match(folded[1].reason ?? "", /主辅互斥/);
});

test("applyV19AdjustedTargets syncs only fields this page has not touched since the save was sent", () => {
  const sent = auroraDraft();
  sent.auxiliaryMechanism = choice(["INSIGHT_RESONANCE", "METAPHOR_TRANSLATION"]);
  const saved = v04UiDraftToPayload(sent);
  saved.factsAndCoreJudgement.auxiliaryMechanism = choice(["METAPHOR_TRANSLATION"]);

  const untouched = applyV19AdjustedTargets(cloneV04UiDraft(sent), sent, saved, ["facts.auxiliaryMechanism"]);
  assert.deepEqual(untouched.auxiliaryMechanism.selectedOptionIds, ["METAPHOR_TRANSLATION"]);

  const retyped = cloneV04UiDraft(sent);
  retyped.auxiliaryMechanism = choice(["REVERSAL_REINTERPRETATION"]);
  const kept = applyV19AdjustedTargets(retyped, sent, saved, ["facts.auxiliaryMechanism"]);
  assert.deepEqual(kept.auxiliaryMechanism.selectedOptionIds, ["REVERSAL_REINTERPRETATION"]);
});

test("studio applies server adjustments to what it remembers as saved", () => {
  assert.match(clientSource, /applyV04PayloadValues\(afterPayload, adjusted\)/);
  assert.match(clientSource, /savedPayloadRef\.current = savedPayload;/);
});
