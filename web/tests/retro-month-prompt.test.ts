// 提示词（docs/26 三、6.8）、运行配置（十一）与接力令牌的纯函数部分（6.3）。
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRetroExtraction } from "../lib/retro/extraction";
import { readRetroAiConfig, RETRO_RELAY_DEV_SECRET, resolveRetroAiProvider, resolveRetroRelaySecret } from "../lib/retro/month-config";
import { parseRetroRelayToken, retroRelayUrl, signRetroRelayToken, verifyRetroRelaySignature } from "../lib/retro/month-relay";
import { hashRetroCaseInput } from "../lib/retro/month-snapshot";
import {
  buildRetroExtractMessages,
  buildRetroMethodsMessages,
  buildRetroMinutesMessages,
  RETRO_EXTRACT_PROMPT_VERSION,
  RETRO_EXTRACT_SYSTEM_PROMPT,
  RETRO_METHODS_PROMPT_VERSION,
  RETRO_METHODS_SYSTEM_PROMPT,
  RETRO_MINUTES_PROMPT_VERSION,
  RETRO_MINUTES_SYSTEM_PROMPT,
} from "../lib/retro/prompt";
import { readFile } from "node:fs/promises";
import { CASE_A, sampleSnapshot } from "./retro-month-fixtures";

test("three prompt version constants exist", () => {
  for (const version of [RETRO_EXTRACT_PROMPT_VERSION, RETRO_MINUTES_PROMPT_VERSION, RETRO_METHODS_PROMPT_VERSION]) assert.match(version, /^\d{4}-\d{2}-\d{2}\.\d+$/);
});

test("every system prompt carries the eight hard rules, and forbids the golden circle and ready-made frameworks", () => {
  for (const system of [RETRO_EXTRACT_SYSTEM_PROMPT, RETRO_MINUTES_SYSTEM_PROMPT, RETRO_METHODS_SYSTEM_PROMPT]) {
    for (const marker of ["1. 只提取录音里有依据的东西", "2. 不替老孙发明理论", "3. 区分三类东西", "4. 只是候选", "5. 出现次数不等于重要性", "6. 不机械凑数", "7. 改进事项只保留能执行的", "8. 录音里汇报人和其他同事的话只用来理解上下文"]) {
      assert.ok(system.includes(marker), marker);
    }
    assert.match(system, /不得整理成黄金圈（Why／What／How）/);
    assert.match(system, /现成框架/);
  }
});

test("the extract and methods prompts explain dimensions, kinds and transfer with the two spec examples", () => {
  for (const system of [RETRO_EXTRACT_SYSTEM_PROMPT, RETRO_METHODS_SYSTEM_PROMPT]) {
    for (const key of ["ENTRY", "INFO", "PATH", "VALUE", "SOLUTION", "INTERACTION", "METHOD", "INTUITION", "SITUATIONAL", "TRANSFERABLE", "CASE_ONLY", "UNSURE"]) assert.ok(system.includes(key), key);
    assert.ok(system.includes("先别急着改，先问清楚他为什么要改」→ dimension=ENTRY，kind=METHOD"));
    assert.ok(system.includes("这种客户你得先让他把火发完」→ dimension=INTERACTION，kind=SITUATIONAL"));
  }
});

test("the prompt file says the definitions are drafted by engineering and need 老孙's review", async () => {
  const head = (await readFile(new URL("../lib/retro/prompt.ts", import.meta.url), "utf8")).split("\n").slice(0, 8).join("\n");
  assert.match(head, /维度和类别的释义由工程起草，请老孙校订/);
});

test("the extract input numbers review segments continuously and cites client audio as c<assetId>:<segmentId>", () => {
  const { user } = buildRetroExtractMessages(CASE_A);
  const payload = JSON.parse(user);
  assert.deepEqual(payload.点评录音文字稿.map((line: { id: number; 段: number }) => [line.id, line.段]), [[1, 1], [2, 1], [3, 1], [4, 1], [5, 2], [6, 2]]);
  assert.deepEqual(payload.客户录音[0].文字稿.map((line: { ref: string }) => line.ref), ["cast_voice:1", "cast_voice:2"]);
  assert.equal(payload.案例.回合[0].id, "rnd_a1");
  assert.equal(payload.案例.回合[1].我们怎么应对, undefined, "empty round fields are left out");
});

test("an omitted client transcript tail is announced in the input", () => {
  const item = structuredClone(CASE_A);
  item.clientAudio[0].omittedSegments = 12;
  const payload = JSON.parse(buildRetroExtractMessages(item).user);
  assert.match(JSON.stringify(payload.客户录音[0].文字稿), /以下省略 12 句/);
});

test("the synthesis inputs only list segments ① cited, plus the summary transcript", () => {
  const snapshot = sampleSnapshot();
  const a = normalizeRetroExtraction({ speakers: { founder: "S0" }, review: { process: "", disputes: [], founderPoints: [{ text: "x", segmentIds: [3] }], suggestions: [] }, methods: [] }, CASE_A).output;
  const ctx = { snapshot, extractions: { rtc_a: a } };
  const minutes = JSON.parse(buildRetroMinutesMessages(ctx).user);
  assert.deepEqual(Object.keys(minutes.quotes), ["2:3"]);
  assert.equal(minutes.quotes["2:3"].speaker, "老孙");
  assert.deepEqual(minutes.整场总结文字稿.map((line: { id: string }) => line.id), ["S1", "S2", "S3"]);
  const methods = JSON.parse(buildRetroMethodsMessages(ctx, "S0").user);
  assert.equal(methods.整场总结里的老孙, "S0");
});

test("the case input hash ignores the frozen number but follows content, model and prompt version", () => {
  const options = { model: "m", promptVersion: "v1" };
  const renumbered = { ...structuredClone(CASE_A), number: 9 };
  assert.equal(hashRetroCaseInput(CASE_A, options), hashRetroCaseInput(renumbered, options));
  const edited = structuredClone(CASE_A);
  edited.rounds[0].feedbackText = "改了一个字";
  assert.notEqual(hashRetroCaseInput(CASE_A, options), hashRetroCaseInput(edited, options));
  assert.notEqual(hashRetroCaseInput(CASE_A, options), hashRetroCaseInput(CASE_A, { ...options, model: "n" }));
  assert.notEqual(hashRetroCaseInput(CASE_A, options), hashRetroCaseInput(CASE_A, { ...options, promptVersion: "v2" }));
});

test("provider: fake by default in local demo, real elsewhere, explicit value wins", () => {
  assert.equal(resolveRetroAiProvider({}, true), "fake");
  assert.equal(resolveRetroAiProvider({}, false), "real");
  assert.equal(resolveRetroAiProvider({ RETRO_AI_PROVIDER: "fake" }, false), "fake");
  assert.equal(resolveRetroAiProvider({ RETRO_AI_PROVIDER: "real" }, true), "real");
  assert.deepEqual(readRetroAiConfig({}, false).missing, ["DEEPSEEK_API_KEY"]);
  assert.equal(readRetroAiConfig({ DEEPSEEK_API_KEY: "k" }, true).provider, "fake", "a configured key is not used in local demo unless asked");
});

test("relay secret: the configured one, a fixed dev secret only in local demo, otherwise none", () => {
  assert.equal(resolveRetroRelaySecret({ RETRO_RELAY_SECRET: "s".repeat(40) }, false), "s".repeat(40));
  assert.equal(resolveRetroRelaySecret({}, true), RETRO_RELAY_DEV_SECRET);
  assert.equal(resolveRetroRelaySecret({}, false), null);
});

test("relay tokens are HMACs of job id + sequence; anything else fails verification", () => {
  const token = signRetroRelayToken("secret", "rtj_1", 3);
  assert.deepEqual(parseRetroRelayToken(token)?.seq, 3);
  assert.equal(verifyRetroRelaySignature("secret", "rtj_1", token), 3);
  assert.equal(verifyRetroRelaySignature("other", "rtj_1", token), null);
  assert.equal(verifyRetroRelaySignature("secret", "rtj_2", token), null);
  assert.equal(verifyRetroRelaySignature("secret", "rtj_1", token.replace(/^3\./, "4.")), null);
  assert.equal(verifyRetroRelaySignature("secret", "rtj_1", "3.zz"), null);
  assert.equal(verifyRetroRelaySignature("secret", "rtj_1", null), null);
  assert.equal(retroRelayUrl("https://example.test/", "2026-10", "rtj_1"), "https://example.test/api/retro-months/2026-10/jobs/rtj_1/advance");
});
