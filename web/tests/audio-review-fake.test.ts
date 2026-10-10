// 配置（docs/25 4.7）与本地假实现（4.10）：入口开关、fake/real 的选择、密钥兜底；
// 假转写的节奏、假理解按真实快照生成的提案覆盖各类字段并能套用。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_TENCENT_ASR_ENGINE,
  isAudioReviewAvailable,
  readAudioReviewConfig,
  resolveAudioReviewProvider,
} from "../lib/audio-review/config";
import {
  FAKE_ASR_READY_MS,
  buildFakeModelOutput,
  createFakeAsr,
  createFakeLlm,
  fakeTranscriptSegments,
} from "../lib/audio-review/fake";
import { buildAudioReviewChangeSet, normalizeAudioReviewProposal } from "../lib/audio-review/proposal";
import type { AudioReviewTranscriptSegment } from "../lib/audio-review/transcript";
import type { V04DraftPayloadV1 } from "../lib/v04-contract";
import { assertV04PayloadContract, emptyV04DraftPayload } from "../lib/v04-domain";

const sample = JSON.parse(readFileSync(new URL("../scripts/fixtures/audio-review-sample.json", import.meta.url), "utf8")) as {
  snapshot: V04DraftPayloadV1;
  transcript: AudioReviewTranscriptSegment[];
};

const FULL_ENV = {
  DEEPSEEK_API_KEY: "sk-x",
  COS_REGION: "ap-guangzhou",
  COS_BUCKET: "bucket-1",
  COS_SECRET_ID: "cos-id",
  COS_SECRET_KEY: "cos-key",
};

test("provider: explicit fake wins; local demo defaults to fake; anything else is real", () => {
  assert.equal(resolveAudioReviewProvider({ AUDIO_REVIEW_PROVIDER: "fake" }, false), "fake");
  assert.equal(resolveAudioReviewProvider({ AUDIO_REVIEW_PROVIDER: " FAKE " }, false), "fake");
  assert.equal(resolveAudioReviewProvider({}, true), "fake");
  assert.equal(resolveAudioReviewProvider({ AUDIO_REVIEW_PROVIDER: "real" }, true), "real");
  assert.equal(resolveAudioReviewProvider({}, false), "real");
});

test("real provider needs the DeepSeek key and the full COS set; defaults fill in model, base URL and engine", () => {
  const missing = readAudioReviewConfig({ COS_REGION: "r" }, false);
  assert.equal(missing.configured, false);
  assert.deepEqual(missing.missing, ["DEEPSEEK_API_KEY", "COS_BUCKET", "COS_SECRET_ID", "COS_SECRET_KEY"]);
  const full = readAudioReviewConfig({ ...FULL_ENV, DEEPSEEK_BASE_URL: "https://proxy.test/v1/" }, false);
  assert.equal(full.configured, true);
  assert.equal(full.deepseek.model, DEFAULT_DEEPSEEK_MODEL);
  assert.equal(full.deepseek.baseUrl, "https://proxy.test/v1");
  assert.equal(full.asr.engine, DEFAULT_TENCENT_ASR_ENGINE);
  assert.equal(readAudioReviewConfig(FULL_ENV, false).deepseek.baseUrl, DEFAULT_DEEPSEEK_BASE_URL);
  // fake 不需要任何密钥。
  assert.equal(readAudioReviewConfig({}, true).configured, true);
});

test("ASR keys: the dedicated pair when both are set, otherwise the COS pair (never a mixed pair)", () => {
  assert.deepEqual(readAudioReviewConfig(FULL_ENV, false).asr, { secretId: "cos-id", secretKey: "cos-key", engine: DEFAULT_TENCENT_ASR_ENGINE });
  assert.deepEqual(
    readAudioReviewConfig({ ...FULL_ENV, TENCENT_ASR_SECRET_ID: "asr-id", TENCENT_ASR_SECRET_KEY: "asr-key", TENCENT_ASR_ENGINE: "16k_zh" }, false).asr,
    { secretId: "asr-id", secretKey: "asr-key", engine: "16k_zh" },
  );
  assert.equal(readAudioReviewConfig({ ...FULL_ENV, TENCENT_ASR_SECRET_ID: "asr-id" }, false).asr.secretId, "cos-id");
});

test("the entry is available only to 老孙 and only when configured", () => {
  const configured = readAudioReviewConfig(FULL_ENV, false);
  const unconfigured = readAudioReviewConfig({}, false);
  assert.equal(isAudioReviewAvailable("老孙", configured), true);
  assert.equal(isAudioReviewAvailable(" 老孙 ", configured), true);
  assert.equal(isAudioReviewAvailable("刘梦娜", configured), false);
  assert.equal(isAudioReviewAvailable("老孙", unconfigured), false);
});

test("fake transcript: the demo critique, three speakers, the homophone kept for correction", () => {
  const segments = fakeTranscriptSegments();
  assert.equal(segments.length, 15);
  assert.deepEqual([...new Set(segments.map((segment) => segment.speakerId))], ["S0", "S1", "S2"]);
  assert.match(segments[10].text, /对质生意/);
  for (let index = 1; index < segments.length; index += 1) {
    assert.ok(segments[index].startMs > segments[index - 1].startMs);
    assert.ok(segments[index - 1].endMs <= segments[index].startMs);
  }
});

test("fake ASR answers pending on the first poll and the transcript on the second", async () => {
  let now = 1_000_000;
  const asr = createFakeAsr(() => now);
  const submitted = await asr.submit();
  assert.equal(submitted.ok, true);
  const taskId = submitted.ok ? submitted.taskId : "";
  now += asr.pollIntervalMs;
  assert.deepEqual(await asr.describe(taskId), { kind: "PENDING", status: 1 });
  now += asr.pollIntervalMs;
  assert.ok(2 * asr.pollIntervalMs >= FAKE_ASR_READY_MS);
  const done = await asr.describe(taskId);
  assert.equal(done.kind, "SUCCESS");
});

test("fake understanding uses the snapshot's real ids and covers general, specific, option, rating, detail, shot and unaddressed", () => {
  const raw = buildFakeModelOutput({ snapshot: sample.snapshot, segments: sample.transcript, revieweeName: "刘梦娜" });
  const proposal = normalizeAudioReviewProposal(JSON.parse(JSON.stringify(raw)), { snapshot: sample.snapshot, segments: sample.transcript });
  assert.deepEqual(proposal.dropped, []);
  const types = new Set(proposal.changes.map((change) => change.valueType));
  for (const type of ["TEXT", "CHOICE", "MECHANISM", "RATING", "PATH_DETAIL"]) assert.ok(types.has(type as never), type);
  assert.ok(proposal.changes.some((change) => change.key === "shot:shot-hide-05.visualContent"));
  assert.ok(proposal.changes.some((change) => change.key === "shotGroup:bridge-hide-02.primaryCreativeRole"));
  const general = proposal.opinions.filter((opinion) => opinion.kind === "GENERAL");
  assert.ok(general.length >= 2 && general.every((opinion) => opinion.changeIds.length >= 3));
  assert.ok(proposal.opinions.some((opinion) => opinion.kind === "SPECIFIC" && opinion.changeIds.length === 1));
  assert.ok(proposal.changes.some((change) => change.opinionIds.length === 2));
  assert.ok(proposal.unaddressed.length >= 4);
  assert.deepEqual(proposal.corrections, [{ segmentId: 11, from: "对质生意", to: "对置生义" }]);
  assert.deepEqual(proposal.speakers, {
    reviewer: "S0",
    labels: { S1: "刘梦娜", S2: "王一凡" },
    others: [{ segmentId: 5, speaker: "刘梦娜" }, { segmentId: 10, speaker: "王一凡" }],
  });
  const { payload } = buildAudioReviewChangeSet(sample.snapshot, proposal.changes);
  assertV04PayloadContract(payload);
});

test("fake understanding never collides with the snapshot's own options and survives an empty homework", () => {
  const snapshot = structuredClone(sample.snapshot);
  snapshot.factsAndCoreJudgement.mainMechanism.selectedOptionIds = ["JUXTAPOSITION_CREATES_MEANING"];
  snapshot.script.shotGroups[1].auxiliaryCreativeRole.selectedOptionIds = ["REPEAT_AND_SHIFT_MEANING"];
  snapshot.factsAndCoreJudgement.overallCreativeRating = "A";
  const proposal = normalizeAudioReviewProposal(
    buildFakeModelOutput({ snapshot, segments: sample.transcript, revieweeName: "刘梦娜" }),
    { snapshot, segments: sample.transcript },
  );
  assert.deepEqual(proposal.dropped, []);
  assert.equal(proposal.changes.find((change) => change.key === "facts.overallCreativeRating")!.after, "B");

  const empty = emptyV04DraftPayload();
  const minimal = normalizeAudioReviewProposal(
    buildFakeModelOutput({ snapshot: empty, segments: sample.transcript, revieweeName: "x" }),
    { snapshot: empty, segments: sample.transcript },
  );
  assert.ok(minimal.changes.length >= 5);
  assertV04PayloadContract(buildAudioReviewChangeSet(empty, minimal.changes).payload);
});

test("fake LLM waits, then returns the deterministic output as JSON content", async () => {
  const waits: number[] = [];
  const llm = createFakeLlm(async (ms) => { waits.push(ms); }, () => 0);
  const outcome = await llm.complete({ system: "", user: "" }, {
    snapshot: sample.snapshot, segments: sample.transcript, reviewerName: "老孙", revieweeName: "刘梦娜", baseVersionNumber: 1,
  });
  assert.deepEqual(waits, [3000]);
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(JSON.parse(outcome.content).opinions.length, 5);
});
