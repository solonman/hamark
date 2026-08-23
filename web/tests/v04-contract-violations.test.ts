import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { listV04ContractViolations } from "../lib/v04-contract-rules.ts";
import { assertV04PayloadContract, emptyV04ChoiceValue, emptyV04DraftPayload } from "../lib/v04-domain.ts";
import { v04SaveFailureMessage } from "../lib/v04-draft-save-state.ts";

test("a contract violation is reported per field with the rule it breaks", () => {
  const payload = emptyV04DraftPayload();
  assert.deepEqual(listV04ContractViolations(payload), []);

  // The 王梓安 case: the same mechanism in both slots. The auxiliary panel
  // hides the primary's option, but an earlier auxiliary pick stays behind.
  payload.factsAndCoreJudgement.mainMechanism.selectedOptionIds = ["MINIATURIZATION_COMPRESSION"];
  payload.factsAndCoreJudgement.auxiliaryMechanism.selectedOptionIds = ["MINIATURIZATION_COMPRESSION"];
  const mechanism = listV04ContractViolations(payload);
  assert.equal(mechanism.length, 1);
  assert.equal(mechanism[0].targetKey, "facts.auxiliaryMechanism");
  assert.match(mechanism[0].message, /互斥/);
  assert.throws(() => assertV04PayloadContract(payload), /CHOICE_RULE_VIOLATION/,
    "the list and the server assertion must agree on what is illegal");

  payload.factsAndCoreJudgement.auxiliaryMechanism.selectedOptionIds = ["A", "B", "C"];
  const tooMany = listV04ContractViolations(payload);
  assert(tooMany.some((item) => /最多选 2 项/.test(item.message)));
  assert(tooMany.some((item) => /不存在的选项/.test(item.message)));

  const bridge = emptyV04DraftPayload();
  bridge.script.shotGroups = [{
    id: "g1", orderIndex: 0, bridgeName: "开场",
    primaryCreativeRole: { ...emptyV04ChoiceValue(), selectedOptionIds: ["ESTABLISH_SCENE_SITUATION"] },
    auxiliaryCreativeRole: { ...emptyV04ChoiceValue(), selectedOptionIds: ["ESTABLISH_SCENE_SITUATION"] },
    keyCreativeDescription: "", shots: [],
  }];
  const role = listV04ContractViolations(bridge);
  assert.equal(role.length, 1);
  assert.equal(role[0].targetKey, "shotGroup:g1.auxiliaryCreativeRole");
  assert.match(role[0].targetLabel, /桥段 1｜开场/);

  const path = emptyV04DraftPayload();
  path.perceptionPath.primaryType = "LOVE";
  path.perceptionPath.auxiliaryTypes = [{ type: "LOVE", description: "", creativeRole: "" }];
  assert.match(listV04ContractViolations(path)[0].message, /与主导路径相同/);
});

test("a rejected draft is never described as retryable", () => {
  for (const code of ["CHOICE_RULE_VIOLATION", "INVALID_PAYLOAD_SCHEMA", "CONTRACT_VIOLATION"]) {
    const message = v04SaveFailureMessage(code);
    assert.match(message, /修正/, code);
    assert.doesNotMatch(message, /可直接重试/, code);
  }
});

test("the workspace stops an illegal draft before sending and recovers an idempotency clash once", async () => {
  const source = await readFile(new URL("../components/v04/V04WorkspaceClient.tsx", import.meta.url), "utf8");
  const commit = source.slice(source.indexOf("const commitSaveAttempt = useCallback"));
  assert.match(commit.slice(0, 2500), /listV04ContractViolations\(originalPayload\)/,
    "the draft is checked against the frozen contract before any request");
  assert.match(commit.slice(0, 2500), /errorCode: "CONTRACT_VIOLATION"/);
  assert.match(source, /data-v04-contract-violations/, "violations render as a named list");
  assert.match(source, /定位/, "each named field can be located");
  assert.match(commit, /IDEMPOTENCY_CONFLICT[\s\S]{0,700}changeSetIdsRef\.current\.delete\(attempt\.version\)/,
    "a used change-set id is replaced exactly once instead of failing forever");
  assert.match(commit, /readV04ContractViolations\(apiError\.details\)/,
    "server-named violations are shown, not a generic failure");

  const choice = source.slice(source.indexOf("const updateChoice"));
  assert.match(choice.slice(0, 900), /field === "primaryMechanism"[\s\S]{0,400}auxiliaryMechanism[\s\S]{0,200}filter/,
    "choosing a primary mechanism drops it from the auxiliary slot");

  const service = await readFile(new URL("../lib/v04-workspace-service.ts", import.meta.url), "utf8");
  assert.match(service, /CHOICE_RULE_VIOLATION[\s\S]{0,600}listV04ContractViolations\(applyV04ChangeSetUnchecked\(before, input\.changes\)\)/,
    "a 422 carries the violated targets");
});
