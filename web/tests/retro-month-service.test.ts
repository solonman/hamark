// 月度整理服务层的 TEST_ONLY PostgreSQL 测试（docs/26 6.1–6.7、12 验收 6–10 的后端部分）：
// 完整流水线、逐案缓存只重算变了的案例、租约互斥、时间不够不开模型、失败两次转 FAILED、
// RETRY 从失败案例继续、ABANDON、接力令牌一次性与伪造、草稿权限与乐观锁、发布事务与版本号、
// REVISE_PUBLISHED 不调模型、非老孙 403 与读不到草稿、生成前提、接缝三函数。
//
// 需要一个本机回环地址上、已建好 retro_* 表的库：
//   RETRO_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/hamark_retro_b2 \
//     node --import tsx --test tests/retro-month-*.test.ts
// 没给就跳过。测试数据一律 TEST_ONLY 前缀、月份 2091-xx，跑前跑后都清理。
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import pg from "pg";
import { DbClient } from "../db";
import type { LlmOutcome } from "../lib/audio-review/deepseek";
import { loadRetroCaseInMinutes, loadRetroMonthAiState, loadRetroMonthBadges } from "../lib/retro/month-ai";
import { RetroError } from "../lib/retro/errors";
import { buildFakeRetroOutput } from "../lib/retro/month-fake";
import type { RetroLlmProvider, RetroStepContext } from "../lib/retro/month-providers";
import { advanceAndRelay, consumeRetroRelayToken, issueRetroRelayToken, signRetroRelayToken } from "../lib/retro/month-relay";
import {
  advanceRetroMonthJob,
  loadRetroJob,
  patchRetroDraft,
  runRetroMonthJobAction,
  startRetroMonthJob,
  type RetroMonthActor,
  type RetroMonthDeps,
} from "../lib/retro/month-service";
import { loadRetroMonthView, loadRetroPublication, toRetroJobView } from "../lib/retro/month-view";
import type { RetroTranscriptSegment } from "../lib/retro-model";

const url = process.env.RETRO_TEST_DATABASE_URL ?? "";
const loopback = (() => {
  try {
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
})();
const skip = url && loopback ? false : "RETRO_TEST_DATABASE_URL (loopback TEST_ONLY database) not provided";

const SUN: RetroMonthActor = { userId: "TEST_ONLY-month-u-sun", displayName: "老孙", identityKey: "TEST_ONLY:sun" };
const LIU: RetroMonthActor = { userId: "TEST_ONLY-month-u-liu", displayName: "刘梦娜", identityKey: "TEST_ONLY:liu" };
const START = Date.parse("2091-06-01T08:00:00.000Z");
const SECRET = "TEST_ONLY_relay_secret_0123456789abcdef";

let pool: pg.Pool;
let db: DbClient;

async function cleanup() {
  const months = `month_key LIKE '2091-%'`;
  await db.prepare(`DELETE FROM retro_method_candidates WHERE ${months}`).run();
  await db.prepare(`DELETE FROM retro_month_publications WHERE ${months}`).run();
  await db.prepare(`DELETE FROM retro_month_jobs WHERE ${months}`).run();
  await db.prepare(`DELETE FROM retro_recordings WHERE ${months}`).run();
  await db.prepare(`DELETE FROM retro_round_links WHERE round_id IN (SELECT r.id FROM retro_case_rounds r JOIN retro_cases c ON c.id = r.case_id WHERE c.${months})`).run();
  await db.prepare(`DELETE FROM retro_case_assets WHERE case_id IN (SELECT id FROM retro_cases WHERE ${months})`).run();
  await db.prepare(`DELETE FROM retro_case_rounds WHERE case_id IN (SELECT id FROM retro_cases WHERE ${months})`).run();
  await db.prepare(`DELETE FROM retro_cases WHERE ${months}`).run();
  await db.prepare(`DELETE FROM audit_logs WHERE detail_json LIKE '%"monthKey":"2091-%'`).run();
  // 只删自己的两个用户：另一组集成测试（retro-service.test.ts）可能同时在跑，用的是 TEST_ONLY_ 前缀。
  await db.prepare(`DELETE FROM users WHERE id IN (?, ?)`).bind(SUN.userId, LIU.userId).run();
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: url, ssl: false, max: 4 });
  db = new DbClient(pool);
  await cleanup();
  for (const user of [SUN, LIU]) {
    await db.prepare(
      `INSERT INTO users (id, wecom_corp_id, wecom_user_id, identity_key, display_name, status, last_login_at, last_synced_at, created_at, updated_at)
      VALUES (?, 'TEST_ONLY', ?, ?, ?, 'ACTIVE', '', '', '', '')`,
    ).bind(user.userId, user.userId, user.identityKey, user.displayName).run();
  }
});

after(async () => {
  if (skip) return;
  await cleanup();
  await pool.end();
});

// ---------------------------------------------------------------------------
// 种子数据：案例 1 已删除（只占序号），案例 2 有两段点评录音和一段客户录音，案例 3 一段录音，
// 案例 4 没有录音；另有一段整场总结。
// ---------------------------------------------------------------------------

const segs = (lines: Array<[number, string, string]>): RetroTranscriptSegment[] =>
  lines.map(([seconds, speakerId, text], index) => ({ id: index + 1, startMs: seconds * 1000, endMs: seconds * 1000 + 3000, speakerId, text }));

type Seed = { month: string; caseD: string; caseA: string; caseB: string; caseC: string; roundA1: string; roundB1: string; recA1: string; recA2: string; recB1: string; recSum: string; asset: string };

async function insertRecording(month: string, id: string, caseId: string | null, partNo: number, status: string, segments: RetroTranscriptSegment[] | null, createdAt: string) {
  await db.prepare(
    `INSERT INTO retro_recordings (id, month_key, case_id, part_no, status, audio_object_key, audio_file_name, audio_content_type,
      audio_size_bytes, audio_duration_ms, transcript_json, uploaded_by_user_id, uploaded_by_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'audio/mp4', 1000, 600000, ?::jsonb, ?, ?, ?::timestamptz, now())`,
  ).bind(id, month, caseId, partNo, status, `retro/recordings/${id}/original`, `${id}.m4a`,
    segments ? JSON.stringify({ segments, durationMs: 600000, engine: "fake" }) : null, LIU.userId, LIU.displayName, createdAt).run();
}

async function seedMonth(month: string): Promise<Seed> {
  const p = `TEST_ONLY-month-${month}`;
  const seed: Seed = {
    month,
    caseD: `${p}_rtc_d`, caseA: `${p}_rtc_a`, caseB: `${p}_rtc_b`, caseC: `${p}_rtc_c`,
    roundA1: `${p}_rnd_a1`, roundB1: `${p}_rnd_b1`,
    recA1: `${p}_rtr_a1`, recA2: `${p}_rtr_a2`, recB1: `${p}_rtr_b1`, recSum: `${p}_rtr_sum`, asset: `${p}_ast_voice`,
  };
  const at = (minutes: number) => new Date(Date.now() - 86400000 + minutes * 60000).toISOString();
  const cases: Array<[string, string, string, number, boolean]> = [
    [seed.caseD, "已删除的部门", "已删客户", 0, true],
    [seed.caseA, "策略部", "乳企", 1, false],
    [seed.caseB, "客户部", "茶饮", 2, false],
    [seed.caseC, "设计部", "文旅", 3, false],
  ];
  for (const [id, department, client, minute, deleted] of cases) {
    await db.prepare(
      `INSERT INTO retro_cases (id, month_key, department, client_name, title, background, outcome, created_by_user_id, created_by_name, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, '客户最初要团圆感', '第三版通过', ?, ?, ?::timestamptz, now(), ${deleted ? "now()" : "NULL"})`,
    ).bind(id, month, department, client, `TEST_ONLY ${client}案例`, LIU.userId, LIU.displayName, at(minute)).run();
  }
  const rounds: Array<[string, string, number, string]> = [
    [seed.roundA1, seed.caseA, 1, "第 1 版"], [`${p}_rnd_a2`, seed.caseA, 2, "第 2 版"], [seed.roundB1, seed.caseB, 1, "比稿"],
  ];
  for (const [id, caseId, position, title] of rounds) {
    await db.prepare(
      `INSERT INTO retro_case_rounds (id, case_id, position, title, delivery_text, feedback_text) VALUES (?, ?, ?, ?, '我们交了一版', '客户说太像去年')`,
    ).bind(id, caseId, position, title).run();
  }
  await db.prepare(
    `INSERT INTO retro_case_assets (id, case_id, round_id, type, position, object_key, original_name, content_type, upload_status,
      derivative_status, transcribe_status, transcript_json, created_by_user_id)
    VALUES (?, ?, ?, 'AUDIO', 1, ?, '客户语音.m4a', 'audio/mp4', 'READY', 'READY', 'READY', ?::jsonb, ?)`,
  ).bind(seed.asset, seed.caseA, seed.roundA1, `retro/cases/${seed.caseA}/assets/${seed.asset}/original`,
    JSON.stringify({ segments: segs([[5, "S0", "你们这个太像去年了。"], [20, "S0", "年轻一点。"]]) }), LIU.userId).run();
  await insertRecording(month, seed.recA1, seed.caseA, 1, "READY", segs([[15, "S1", "我讲一下乳企这个案子。"], [760, "S0", "你们有没有问他为什么要年轻一点？"], [845, "S0", "这是生意问题，不是画风问题。"], [930, "S2", "第二版方向也不算错吧？"]]), at(10));
  await insertRecording(month, seed.recA2, seed.caseA, 2, "READY", segs([[20, "S2", "接着说。"], [310, "S0", "堆头才是年轻人碰到礼盒的地方。"]]), at(11));
  await insertRecording(month, seed.recB1, seed.caseB, 1, "READY", segs([[20, "S1", "茶饮这个是新品上市。"], [920, "S0", "客户为什么提刷屏？"], [2050, "S0", "刚换了市场总监，先别争。"]]), at(12));
  await insertRecording(month, seed.recSum, null, 1, "READY", segs([[15, "S0", "我最后说几句。"], [195, "S0", "客户的要求都先问一句为什么。"]]), at(13));
  return seed;
}

// ---------------------------------------------------------------------------
// 可控的模型提供方
// ---------------------------------------------------------------------------

type Call = { step: RetroStepContext["step"]; caseId?: string; effort: string };

function testLlm(script?: (context: RetroStepContext, call: Call, index: number) => LlmOutcome | null) {
  const calls: Call[] = [];
  const provider: RetroLlmProvider = {
    kind: "fake",
    model: "test-model",
    async complete(_messages, context, options) {
      const call: Call = { step: context.step, ...(context.step === "EXTRACT" ? { caseId: context.item.caseId } : {}), effort: options.reasoningEffort };
      calls.push(call);
      const override = script?.(context, call, calls.length - 1);
      if (override) return override;
      return { ok: true, content: JSON.stringify(buildFakeRetroOutput(context)), finishReason: "stop", usage: { total_tokens: 1 }, model: "test-model", durationMs: 5 };
    },
  };
  return { calls, provider };
}

const deps = (llm: RetroLlmProvider): RetroMonthDeps => ({ llm, clock: () => START, log: () => {} });
const fullWindow = START + 280_000;

async function runToEnd(jobId: string, llm: RetroLlmProvider, limit = 30) {
  const results = [];
  for (let index = 0; index < limit; index += 1) {
    const result = await advanceRetroMonthJob(db, jobId, { deadline: fullWindow, deps: deps(llm) });
    results.push(result);
    if (!result.relay) break;
  }
  return results;
}

async function generate(month: string, llm: RetroLlmProvider) {
  const { jobId } = await startRetroMonthJob(db, SUN, { monthKey: month, body: { mode: "GENERATE" }, llmModel: llm.model });
  return jobId;
}

const failure = (reason: string, retryable = true): LlmOutcome => ({ ok: false, reason, retryable, status: 503, durationMs: 1 });

function rejectsWith(promise: Promise<unknown>, status: number, pattern?: RegExp) {
  return assert.rejects(promise, (error: unknown) => error instanceof RetroError && error.status === status && (!pattern || pattern.test(error.message)));
}

// ---------------------------------------------------------------------------

test("the full fake pipeline reaches PENDING_REVIEW with one model call per advance", { skip }, async () => {
  const seed = await seedMonth("2091-01");
  const { calls, provider } = testLlm();
  const jobId = await generate(seed.month, provider);
  const results = await runToEnd(jobId, provider);
  assert.ok(results.every((result) => Number(result.llmCalled) <= 1));
  assert.deepEqual(calls.map((call) => [call.step, call.caseId ?? null, call.effort]), [
    ["EXTRACT", seed.caseA, "high"], ["EXTRACT", seed.caseB, "high"], ["SUMMARIZE", null, "high"], ["DISTILL", null, "high"],
  ]);
  const row = (await loadRetroJob(db, jobId))!;
  assert.equal(row.status, "PENDING_REVIEW");
  assert.equal(row.llm_model, "test-model");
  assert.deepEqual(Object.keys(row.prompt_versions_json as object).sort(), ["extract", "methods", "minutes"]);
  assert.match(String(row.input_content_hash), /^[0-9a-f]{64}$/);
  assert.equal((row.llm_usage_json as { calls: unknown[] }).calls.length, 4);
  const snapshot = row.input_snapshot_json as { caseNumbers: Record<string, number>; cases: Array<{ caseId: string; number: number }> };
  assert.deepEqual(snapshot.caseNumbers, { [seed.caseD]: 1, [seed.caseA]: 2, [seed.caseB]: 3, [seed.caseC]: 4 });
  assert.deepEqual(snapshot.cases.map((item) => item.caseId), [seed.caseA, seed.caseB, seed.caseC]);
  const store = row.extractions_json as { cases: Record<string, { dropped: string[] }> };
  assert.ok(store.cases[seed.caseA].dropped.length > 0, "dropped reasons are kept for troubleshooting");

  const view = toRetroJobView(row, { isReviewer: true, revisingFromVersion: null });
  assert.deepEqual(view.progress, { done: 2, total: 2 });
  const draft = view.draft!;
  assert.deepEqual(draft.minutes.cases.map((item) => item.caseId), [seed.caseA, seed.caseB]);
  assert.deepEqual(draft.minutes.unanalyzedCaseIds, [seed.caseC]);
  assert.deepEqual([...new Set(draft.methods.candidates.map((candidate) => candidate.kind))].sort(), ["INTUITION", "METHOD", "SITUATIONAL"]);
  const merged = draft.methods.candidates.find((candidate) => candidate.title.startsWith("先问客户为什么"))!;
  assert.deepEqual([...new Set(merged.sources.map((source) => source.caseId))], [seed.caseA, seed.caseB]);
  assert.ok(draft.methods.observations.length >= 1);
  assert.ok(draft.minutes.cases[0].processSources.some((source) => source.kind === "CLIENT"));
  // 引文由服务端按片段号取，说话人换成 AI 认出的称呼。
  const quotes = draft.quotedSegments[`R:${seed.recA1}`];
  assert.ok(quotes.some((quote) => quote.speakerLabel === "老孙" && quote.text.includes("为什么要年轻一点")));
  assert.equal(draft.caseNumbers[seed.caseA], 2);
  assert.deepEqual(draft.recordingRefs[seed.recA2], { caseId: seed.caseA, caseNumber: 2, partNo: 2, partCount: 2 });
  assert.deepEqual(draft.recordingRefs[seed.recSum], { caseId: null, caseNumber: null, partNo: 1, partCount: 1 });
});

test("regenerating only re-runs the cases whose input changed", { skip }, async () => {
  const seed = await seedMonth("2091-02");
  const first = testLlm();
  const jobId = await generate(seed.month, first.provider);
  await runToEnd(jobId, first.provider);
  await runRetroMonthJobAction(db, SUN, { monthKey: seed.month, jobId, body: { action: "ABANDON" } });
  await db.prepare(`UPDATE retro_case_rounds SET feedback_text = '客户改口了' WHERE id = ?`).bind(seed.roundB1).run();
  const second = testLlm();
  const jobId2 = await generate(seed.month, second.provider);
  await runToEnd(jobId2, second.provider);
  assert.deepEqual(second.calls.map((call) => [call.step, call.caseId ?? null]), [["EXTRACT", seed.caseB], ["SUMMARIZE", null], ["DISTILL", null]]);
  assert.equal((await loadRetroJob(db, jobId2))!.status, "PENDING_REVIEW");
});

test("a held lease keeps a second advance out", { skip }, async () => {
  const seed = await seedMonth("2091-03");
  const { calls, provider } = testLlm();
  const jobId = await generate(seed.month, provider);
  await db.prepare(`UPDATE retro_month_jobs SET lease_until = now() + interval '1 minute' WHERE id = ?`).bind(jobId).run();
  const result = await advanceRetroMonthJob(db, jobId, { deadline: fullWindow, deps: deps(provider) });
  assert.deepEqual([result.advanced, result.relay, calls.length], [false, false, 0]);
  await db.prepare(`UPDATE retro_month_jobs SET lease_until = NULL WHERE id = ?`).bind(jobId).run();
  const next = await advanceRetroMonthJob(db, jobId, { deadline: fullWindow, deps: deps(provider) });
  assert.equal(next.advanced, true);
  assert.equal(calls.length, 1);
  assert.equal((await loadRetroJob(db, jobId))!.lease_until, null, "the lease is released on exit");
});

test("with less than 245 s left no model call is started, and the job asks for a relay", { skip }, async () => {
  const seed = await seedMonth("2091-04");
  const { calls, provider } = testLlm();
  const jobId = await generate(seed.month, provider);
  const result = await advanceRetroMonthJob(db, jobId, { deadline: START + 244_000, deps: deps(provider) });
  assert.deepEqual([result.advanced, result.llmCalled, result.relay, result.status], [true, false, true, "EXTRACTING"]);
  assert.equal(calls.length, 0);
});

test("two failures on a case end in FAILED(EXTRACT); RETRY resumes from that case", { skip }, async () => {
  const seed = await seedMonth("2091-05");
  let failB = true;
  const { calls, provider } = testLlm((context) => (failB && context.step === "EXTRACT" && context.item.caseId === seed.caseB ? failure("DeepSeek 服务繁忙") : null));
  const jobId = await generate(seed.month, provider);
  await runToEnd(jobId, provider);
  let row = (await loadRetroJob(db, jobId))!;
  assert.deepEqual([row.status, row.failed_step, Number(row.progress_index)], ["FAILED", "EXTRACT", 1]);
  assert.match(String(row.fail_reason), /案例 3.*DeepSeek 服务繁忙/);
  assert.deepEqual(calls.map((call) => [call.caseId ?? null, call.effort]), [[seed.caseA, "high"], [seed.caseB, "high"], [seed.caseB, "low"]]);
  assert.equal(toRetroJobView(row, { isReviewer: true, revisingFromVersion: null }).progress.done, 1);

  failB = false;
  const retry = await runRetroMonthJobAction(db, SUN, { monthKey: seed.month, jobId, body: { action: "RETRY" } });
  assert.equal(retry.advance, true);
  calls.length = 0;
  await runToEnd(jobId, provider);
  assert.deepEqual(calls.map((call) => [call.step, call.caseId ?? null]), [["EXTRACT", seed.caseB], ["SUMMARIZE", null], ["DISTILL", null]]);
  row = (await loadRetroJob(db, jobId))!;
  assert.equal(row.status, "PENDING_REVIEW");
});

test("a non-retryable failure fails at once; a failed synthesis step retries from that step", { skip }, async () => {
  const seed = await seedMonth("2091-06");
  let breakSummary = true;
  const { calls, provider } = testLlm((context) => (breakSummary && context.step === "SUMMARIZE" ? failure("DeepSeek 密钥无效", false) : null));
  const jobId = await generate(seed.month, provider);
  await runToEnd(jobId, provider);
  const row = (await loadRetroJob(db, jobId))!;
  assert.deepEqual([row.status, row.failed_step], ["FAILED", "SUMMARIZE"]);
  assert.equal(calls.filter((call) => call.step === "SUMMARIZE").length, 1);
  breakSummary = false;
  calls.length = 0;
  await runRetroMonthJobAction(db, SUN, { monthKey: seed.month, jobId, body: { action: "RETRY" } });
  await runToEnd(jobId, provider);
  assert.deepEqual(calls.map((call) => call.step), ["SUMMARIZE", "DISTILL"]);
});

test("ABANDON stops a running job; background writes cannot resurrect it; a new job can start", { skip }, async () => {
  const seed = await seedMonth("2091-07");
  const { calls, provider } = testLlm();
  const jobId = await generate(seed.month, provider);
  await advanceRetroMonthJob(db, jobId, { deadline: fullWindow, deps: deps(provider) });
  await rejectsWith(startRetroMonthJob(db, SUN, { monthKey: seed.month, body: { mode: "GENERATE" }, llmModel: "test-model" }), 409, /已有一个整理任务/);
  await runRetroMonthJobAction(db, SUN, { monthKey: seed.month, jobId, body: { action: "ABANDON" } });
  const before = calls.length;
  const result = await advanceRetroMonthJob(db, jobId, { deadline: fullWindow, deps: deps(provider) });
  assert.equal(result.advanced, false);
  assert.equal(calls.length, before);
  assert.equal((await loadRetroJob(db, jobId))!.status, "ABANDONED");
  const again = await generate(seed.month, provider);
  assert.notEqual(again, jobId);
});

test("relay tokens are single-use; forged, stale or wrong-month tokens are refused", { skip }, async () => {
  const seed = await seedMonth("2091-08");
  const { provider } = testLlm();
  const jobId = await generate(seed.month, provider);
  const token = (await issueRetroRelayToken(db, jobId, SECRET))!;
  const consume = (value: unknown, month = seed.month, secret: string | null = SECRET) => consumeRetroRelayToken(db, { monthKey: month, jobId, token: value, secret });
  assert.equal(await consume(token, "2091-09"), false);
  assert.equal(await consume(token, seed.month, null), false);
  assert.equal(await consume(signRetroRelayToken("forged-secret", jobId, 1)), false);
  assert.equal(await consume(token), true);
  assert.equal(await consume(token), false, "a token works once");
  const older = (await issueRetroRelayToken(db, jobId, SECRET))!;
  const newer = (await issueRetroRelayToken(db, jobId, SECRET))!;
  assert.equal(await consume(older), false, "issuing a new token voids the older one");
  assert.equal(await consume(newer), true);

  const sent: string[] = [];
  const relayed = await advanceAndRelay(db, {
    jobId, monthKey: seed.month, deadline: fullWindow, origin: "http://localhost:3102", secret: SECRET, deps: deps(provider),
    send: async ({ url: target, token: relayToken }) => {
      sent.push(target);
      assert.equal(await consume(relayToken), true);
    },
  });
  assert.equal(relayed.relayed, true);
  assert.deepEqual(sent, [`http://localhost:3102/api/retro-months/${seed.month}/jobs/${jobId}/advance`]);
});

test("draft review: section rules, optimistic lock, MANUAL additions and edits survive a reload", { skip }, async () => {
  const seed = await seedMonth("2091-09");
  const { provider } = testLlm();
  const jobId = await generate(seed.month, provider);
  await runToEnd(jobId, provider);
  const draftOf = async () => toRetroJobView((await loadRetroJob(db, jobId))!, { isReviewer: true, revisingFromVersion: null }).draft!;
  let draft = await draftOf();
  assert.equal(draft.revision, 1);
  const patch = (body: Record<string, unknown>) => patchRetroDraft(db, SUN, { monthKey: seed.month, jobId, body });

  const insight = draft.minutes.insights[0];
  const r1 = await patch({ section: "insights", itemId: insight.id, op: "UPDATE", value: { text: "老孙改过的核心认识" }, revision: 1 });
  assert.equal(r1.revision, 2);
  await rejectsWith(patch({ section: "insights", itemId: insight.id, op: "UPDATE", value: { text: "过期的修改" }, revision: 1 }), 409, /别处改过/);
  const added = await patch({ section: "actions", op: "ADD", value: { text: "老孙补充的改进事项" }, revision: 2 });
  const dispute = draft.minutes.cases[0].disputes[0];
  await patch({ section: "case.disputes", caseId: seed.caseA, itemId: dispute.id, op: "DELETE", revision: 3 });
  await rejectsWith(patch({ section: "case.process", caseId: seed.caseA, op: "DELETE", revision: 4 }), 400);
  await rejectsWith(patch({ section: "case.founderPoints", caseId: seed.caseA, op: "ADD", value: { text: "x" }, revision: 4 }), 400);
  await rejectsWith(patchRetroDraft(db, LIU, { monthKey: seed.month, jobId, body: { section: "insights", itemId: insight.id, op: "DELETE", revision: 4 } }), 403);

  draft = await draftOf();
  assert.equal(draft.revision, 4);
  assert.deepEqual([draft.minutes.insights[0].text, draft.minutes.insights[0].edited, draft.minutes.insights[0].origin], ["老孙改过的核心认识", true, "AI"]);
  const manual = draft.minutes.actions.find((item) => item.id === added.itemId)!;
  assert.deepEqual([manual.origin, manual.sources.length], ["MANUAL", 0]);
  assert.equal(draft.minutes.cases[0].disputes.some((item) => item.id === dispute.id), false);
});

test("publish writes v1 in one transaction; REVISE_PUBLISHED copies it without the model and publishes v2", { skip }, async () => {
  const seed = await seedMonth("2091-10");
  const { calls, provider } = testLlm();
  const jobId = await generate(seed.month, provider);
  await runToEnd(jobId, provider);
  await rejectsWith(runRetroMonthJobAction(db, LIU, { monthKey: seed.month, jobId, body: { action: "PUBLISH" } }), 403);
  const published = await runRetroMonthJobAction(db, SUN, { monthKey: seed.month, jobId, body: { action: "PUBLISH" } });
  assert.equal(published.publicationVersion, 1);
  const again = await runRetroMonthJobAction(db, SUN, { monthKey: seed.month, jobId, body: { action: "PUBLISH" } });
  assert.equal(again.publicationVersion, 1, "publishing twice is idempotent");

  const v1 = (await loadRetroPublication(db, seed.month, 1))!;
  assert.deepEqual(v1.caseIds, [seed.caseA, seed.caseB, seed.caseC]);
  assert.deepEqual(v1.caseNumbers, { [seed.caseA]: 2, [seed.caseB]: 3, [seed.caseC]: 4 });
  assert.equal(v1.publishedByName, "老孙");
  assert.ok(v1.quotedSegments[`R:${seed.recA1}`].length > 0);
  assert.ok(v1.quotedSegments[`C:${seed.asset}`].length > 0);
  const candidates = (await db.prepare(`SELECT number, origin, sources_json FROM retro_method_candidates WHERE month_key = ? ORDER BY number`)
    .bind(seed.month).all<{ number: number; origin: string; sources_json: unknown }>()).results;
  assert.equal(candidates.length, v1.methods.candidates.length);
  assert.deepEqual(candidates.map((row) => Number(row.number)), v1.methods.candidates.map((candidate) => candidate.number));
  const labels = await db.prepare(`SELECT speaker_labels_json FROM retro_recordings WHERE id = ?`).bind(seed.recA2).first<{ speaker_labels_json: Record<string, string> }>();
  assert.equal(labels!.speaker_labels_json.S0, "老孙");
  const summaryLabels = await db.prepare(`SELECT speaker_labels_json FROM retro_recordings WHERE id = ?`).bind(seed.recSum).first<{ speaker_labels_json: Record<string, string> }>();
  assert.equal(summaryLabels!.speaker_labels_json.S0, "老孙");
  assert.equal((await loadRetroJob(db, jobId))!.status, "PUBLISHED");
  const audit = await db.prepare(`SELECT detail_json FROM audit_logs WHERE action = 'RETRO_MONTH_PUBLISHED' AND object_id = ?`).bind(v1.id).first<{ detail_json: string }>();
  assert.equal(JSON.parse(audit!.detail_json).versionNumber, 1);

  calls.length = 0;
  const revision = await startRetroMonthJob(db, SUN, { monthKey: seed.month, body: { mode: "REVISE_PUBLISHED" }, llmModel: "test-model" });
  assert.equal(revision.advance, false);
  const revisionRow = (await loadRetroJob(db, revision.jobId))!;
  assert.equal(revisionRow.status, "PENDING_REVIEW");
  const revisionView = toRetroJobView(revisionRow, { isReviewer: true, revisingFromVersion: 1 });
  assert.deepEqual(revisionView.draft!.minutes, v1.minutes);
  assert.deepEqual(revisionView.draft!.quotedSegments, v1.quotedSegments);
  const firstCandidate = revisionView.draft!.methods.candidates[0];
  await patchRetroDraft(db, SUN, { monthKey: seed.month, jobId: revision.jobId, body: { section: "candidates", itemId: firstCandidate.id, op: "UPDATE", value: { title: "改了一个错字" }, revision: 1 } });
  const v2result = await runRetroMonthJobAction(db, SUN, { monthKey: seed.month, jobId: revision.jobId, body: { action: "PUBLISH" } });
  assert.equal(v2result.publicationVersion, 2);
  assert.equal(calls.length, 0, "revising never calls the model");

  const v1again = (await loadRetroPublication(db, seed.month, 1))!;
  assert.deepEqual(v1again, v1, "v1 is untouched");
  const v2 = (await loadRetroPublication(db, seed.month, 2))!;
  assert.equal(v2.methods.candidates.find((candidate) => candidate.id === firstCandidate.id)!.title, "改了一个错字");
  assert.deepEqual(v2.caseIds, v1.caseIds);

  // 接缝：案例页「在本月纪要里」只给最新发布版里纳入的案例；发布后新建的案例没有。
  const inMinutes = (await loadRetroCaseInMinutes(db, seed.caseA, seed.month))!;
  assert.equal(inMinutes.publicationVersion, 2);
  assert.equal(inMinutes.caseNumber, 2);
  assert.ok(inMinutes.review);
  assert.ok(inMinutes.methods.length > 0 && inMinutes.methods.every((candidate) => candidate.sources.some((source) => source.caseId === seed.caseA)));
  await db.prepare(
    `INSERT INTO retro_cases (id, month_key, department, client_name, title, created_by_user_id, created_by_name) VALUES (?, ?, '新部门', '新客户', 'TEST_ONLY 发布后新建', ?, ?)`,
  ).bind(`TEST_ONLY-month-${seed.month}_rtc_late`, seed.month, LIU.userId, LIU.displayName).run();
  assert.equal(await loadRetroCaseInMinutes(db, `TEST_ONLY-month-${seed.month}_rtc_late`, seed.month), null);
});

test("non-reviewers get 403 on every reviewer action and never see draft content", { skip }, async () => {
  const seed = await seedMonth("2091-11");
  const { provider } = testLlm();
  await rejectsWith(startRetroMonthJob(db, LIU, { monthKey: seed.month, body: { mode: "GENERATE" }, llmModel: "test-model" }), 403);
  const jobId = await generate(seed.month, provider);
  await rejectsWith(runRetroMonthJobAction(db, LIU, { monthKey: seed.month, jobId, body: { action: "ABANDON" } }), 403);
  await rejectsWith(runRetroMonthJobAction(db, LIU, { monthKey: seed.month, jobId, body: { action: "RETRY" } }), 403);
  await runToEnd(jobId, provider);

  const asLiu = await loadRetroMonthView(db, seed.month, { userId: LIU.userId, displayName: LIU.displayName, isAdmin: false }, START);
  assert.equal(asLiu.view.job!.status, "PENDING_REVIEW");
  assert.equal(asLiu.view.job!.draft, null);
  assert.equal(asLiu.view.viewer.isReviewer, false);
  assert.equal(JSON.stringify(asLiu.view).includes("先问客户为什么"), false, "no draft text leaks anywhere in the month view");
  const asSun = await loadRetroMonthView(db, seed.month, { userId: SUN.userId, displayName: SUN.displayName, isAdmin: false }, START);
  assert.ok(asSun.view.job!.draft);
  const stateForLiu = await loadRetroMonthAiState(db, seed.month, { userId: LIU.userId, isReviewer: false });
  assert.equal(stateForLiu.job!.draft, null);
});

test("month view: rows, numbering, summary recordings, preconditions, badges and change counts", { skip }, async () => {
  const seed = await seedMonth("2091-12");
  const viewer = { userId: LIU.userId, displayName: LIU.displayName, isAdmin: false };
  let { view } = await loadRetroMonthView(db, seed.month, viewer, START);
  assert.deepEqual(view.cases.map((row) => [row.id, row.number, row.recording.state]), [
    [seed.caseA, 2, "READY"], [seed.caseB, 3, "READY"], [seed.caseC, 4, "NONE"],
  ]);
  assert.deepEqual(view.cases[0].recording, { state: "READY", parts: 2, durationMs: 1_200_000 });
  assert.equal(view.cases[0].roundCount, 2);
  assert.equal(view.summaryRecordings.length, 1);
  assert.equal(view.summaryRecordings[0].audioUrl, `/api/retro-recordings/${seed.recSum}/audio`);
  assert.equal(view.summaryRecordings[0].canRemove, true, "the uploader can remove");
  assert.equal(view.totalDurationMs, 4 * 600_000);
  assert.deepEqual(view.preconditions, {
    caseCount: 3, recordedCaseCount: 2, unrecordedCaseCount: 1, reviewRecordingsProcessing: 0, summaryParts: 1,
    clientAudio: { total: 1, ready: 1, transcribing: 0, failed: 0 }, canGenerate: true, blockedReason: null,
  });
  assert.deepEqual(await loadRetroMonthBadges(db, [seed.month, "2090-01"]), { [seed.month]: { state: "NONE" }, "2090-01": { state: "NONE" } });

  // 有录音在转写、有客户录音在转写：按钮灰掉，后端也拒绝。
  await insertRecording(seed.month, `TEST_ONLY-month-${seed.month}_rtr_c1`, seed.caseC, 1, "TRANSCRIBING", null, new Date(Date.now() - 3600000).toISOString());
  ({ view } = await loadRetroMonthView(db, seed.month, viewer, START));
  assert.equal(view.preconditions.canGenerate, false);
  assert.match(view.preconditions.blockedReason!, /1 段点评录音还在上传或转写/);
  await rejectsWith(startRetroMonthJob(db, SUN, { monthKey: seed.month, body: { mode: "GENERATE" }, llmModel: "test-model" }), 409, /点评录音/);
  await db.prepare(`UPDATE retro_recordings SET status = 'REMOVED', removed_at = now() WHERE id = ?`).bind(`TEST_ONLY-month-${seed.month}_rtr_c1`).run();
  await db.prepare(`UPDATE retro_case_assets SET transcribe_status = 'TRANSCRIBING' WHERE id = ?`).bind(seed.asset).run();
  ({ view } = await loadRetroMonthView(db, seed.month, viewer, START));
  assert.deepEqual(view.preconditions.clientAudio, { total: 1, ready: 0, transcribing: 1, failed: 0 });
  assert.match(view.preconditions.blockedReason!, /客户录音/);
  await db.prepare(`UPDATE retro_case_assets SET transcribe_status = 'FAILED' WHERE id = ?`).bind(seed.asset).run();
  ({ view } = await loadRetroMonthView(db, seed.month, viewer, START));
  assert.equal(view.preconditions.canGenerate, true, "failed client audio does not block (it is just left out)");
  assert.equal(view.preconditions.clientAudio.failed, 1);

  const { provider } = testLlm();
  const jobId = await generate(seed.month, provider);
  assert.deepEqual((await loadRetroMonthBadges(db, [seed.month]))[seed.month], { state: "RUNNING", publishedVersion: null });
  ({ view } = await loadRetroMonthView(db, seed.month, viewer, START));
  assert.equal(view.preconditions.canGenerate, false);
  await runToEnd(jobId, provider);
  await runRetroMonthJobAction(db, SUN, { monthKey: seed.month, jobId, body: { action: "PUBLISH" } });
  assert.deepEqual((await loadRetroMonthBadges(db, [seed.month]))[seed.month], { state: "PUBLISHED", version: 1, changed: false });

  // 发布后：新传一段、移除一段 → 2 段变动，badge 带「有更新」。
  await insertRecording(seed.month, `TEST_ONLY-month-${seed.month}_rtr_c2`, seed.caseC, 1, "READY", segs([[1, "S0", "补录"]]), new Date(Date.now() + 1000).toISOString());
  await db.prepare(`UPDATE retro_recordings SET status = 'REMOVED', removed_at = now() + interval '1 second' WHERE id = ?`).bind(seed.recB1).run();
  ({ view } = await loadRetroMonthView(db, seed.month, viewer, START));
  assert.equal(view.changedSincePublish, 2);
  assert.deepEqual(view.publicationVersions, [1]);
  assert.equal(view.latestPublication!.versionNumber, 1);
  assert.equal(view.job, null);
  assert.deepEqual((await loadRetroMonthBadges(db, [seed.month]))[seed.month], { state: "PUBLISHED", version: 1, changed: true });
});
