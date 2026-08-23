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

test("bridge and shot ids never collide, and a draft that already collides heals itself", async () => {
  const { ensureUniqueV04DraftIds, mintV04LocalId, blankV04Shot } = await import("../lib/v04-ui-client-state.ts");
  const { emptyV04UiDraft } = await import("../lib/v04-ui-model.ts");
  assert.notEqual(mintV04LocalId("shot"), mintV04LocalId("shot"));
  assert.match(mintV04LocalId("bridge"), /^bridge-[0-9a-f-]{36}$/);

  // The 李国明 case: a per-mount counter minted "shot-_r_0_-1" twice across a
  // reload. The diff pairs shots by id, so the second one could never save.
  const draft = emptyV04UiDraft();
  const group = { id: "bridge-1", title: "", primaryRole: { selectedOptionIds: [], customText: "", vocabularyVersion: "V1" }, auxiliaryRole: { selectedOptionIds: [], customText: "", vocabularyVersion: "V1" }, creativeDescription: "", shots: [blankV04Shot("shot-_r_0_-1"), blankV04Shot("shot-_r_0_-1")] };
  draft.shotGroups = [group as never, { ...group, id: "bridge-1", shots: [blankV04Shot("shot-_r_0_-2")] } as never];
  const replaced = ensureUniqueV04DraftIds(draft);
  assert.deepEqual(replaced, ["shot-_r_0_-1", "bridge-1"], "only later occurrences are re-keyed; the first keeps its id");
  const ids = draft.shotGroups.flatMap((entry) => [entry.id, ...entry.shots.map((shot) => shot.id)]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(draft.shotGroups[0].shots[0].id, "shot-_r_0_-1");
  assert.deepEqual(ensureUniqueV04DraftIds(draft), [], "a healed draft is stable across saves");

  const source = await readFile(new URL("../components/v04/V04WorkspaceClient.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /useId\(\)/, "no id derives from a render-position counter");
  assert.match(source, /blankV04Shot\(mintV04LocalId\("shot"\)\)/);
  assert.match(source, /mutate\(next\);\s*ensureUniqueV04DraftIds\(next\);/, "every edit leaves the draft uniquely keyed");
  assert.match(source, /ensureUniqueV04DraftIds\(recordDraft\)/, "a recovery copy is healed before it is merged");
});

test("a blocked navigation always offers an explicit way out once the local copy is written", async () => {
  const source = await readFile(new URL("../components/v04/V04WorkspaceClient.tsx", import.meta.url), "utf8");
  assert.match(source, /data-v04-force-leave/, "the escape is a visible control on the navigation alert");
  const escape = source.slice(source.indexOf("data-v04-force-leave"));
  assert.match(escape.slice(0, 700), /persistRecovery\(draftRef\.current\);\s*forceLeaveRef\.current = true;/,
    "the recovery copy is written before the unload guard is lifted");
  assert.match(source, /forceLeaveRef\.current \|\| !shouldProtectV04Unload/,
    "the beforeunload guard yields to the explicit choice");
});

test("the V1.9 detail surface offers a reversible delete only to who may actually delete", async () => {
  const detail = await readFile(new URL("../components/v04/V04DetailClient.tsx", import.meta.url), "utf8");
  assert.match(detail, /model\.viewerCapabilities\.canTrash && <button[^>]*data-v04-trash-case/,
    "the control is gated on the server's own capability, not re-derived in the page");
  assert.match(detail, /data-v04-trash-confirm/, "deleting takes a second, explicit confirmation");
  assert.match(detail, /保留 90 天/, "the confirmation states that the case is recoverable");
  assert.match(detail, /原始视频文件不会被清理/);
  assert.match(detail, /v04UiApi\.trash\(videoId, \{ reason: [^}]+\}, trashKey\.current\)/,
    "it goes through the product's own trash route with a stable idempotency key");
  assert.doesNotMatch(detail, /purge|PURGE/, "the read surface never offers an irreversible purge");

  const readModels = await readFile(new URL("../lib/v04-read-models.ts", import.meta.url), "utf8");
  assert.match(readModels, /canTrash: roles\.member && \(uploader \|\| roles\.systemAdmin\)/,
    "capability matches the rule trashVideo enforces");

  const lifecycle = await readFile(new URL("../lib/v04-video-lifecycle.ts", import.meta.url), "utf8");
  assert.match(lifecycle, /if \(!isUploader && !admin\) \{\s*throw new V04ServiceError\("FORBIDDEN"/,
    "the service still fails closed regardless of what the page offers");
});
