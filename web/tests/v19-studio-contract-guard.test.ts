import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { emptyV04ChoiceValue } from "../lib/v04-domain.ts";
import { listV04ContractViolations } from "../lib/v04-contract-rules.ts";
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
const { describeV19ContractViolations } = await import("../components/v04/V04StudioClient.tsx");
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
