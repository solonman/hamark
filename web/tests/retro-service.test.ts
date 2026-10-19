// 客户需求复盘库服务层的集成测试：直接跑在本机的 Postgres 上（.env.development.local 里的 DATABASE_URL，
// 只认回环地址），数据一律带 TEST_ONLY 前缀、跑完清理。连不上、不是本机库、或 retro_ 表还没建时整组跳过。
// 对象存储用内存假桶，转写用 fake 提供方 + 模拟时钟（sleep 只拨时钟，不真等），不碰任何付费服务。
import assert from "node:assert/strict";
import { after, before, describe, test, type TestContext } from "node:test";
import pg from "pg";
import { DbClient } from "../db";
import { createFakeRetroAsr, type RetroAsrProvider } from "../lib/retro/asr";
import { addRetroAssets, completeRetroAssets, loadRetroAssetTranscript, removeRetroAsset, retryRetroAssetTranscription, signRetroAssetUpload } from "../lib/retro/assets";
import { createRetroCase, listRetroLibrary, loadRetroCaseDetail, patchRetroCase, restoreRetroCase, trashRetroCase } from "../lib/retro/cases";
import { RetroError } from "../lib/retro/errors";
import { createRetroRecording, loadRetroRecording, resolveRetroRecordingAudioUrl, runRetroRecordingAction } from "../lib/retro/recordings";
import { addRetroRound, deleteRetroRound, patchRetroRound, putRetroRoundLinks, reorderRetroRounds } from "../lib/retro/rounds";
import { advanceRetroTranscription, listAdvanceableRetroTranscriptions, type RetroTranscribeDeps } from "../lib/retro/transcription";
import type { VideoBucket } from "../storage/types";

const PREFIX = "TEST_ONLY";
const month = "2026-10";

type Actor = { userId: string; displayName: string; isAdmin: boolean };
const OWNER: Actor = { userId: `${PREFIX}_u_owner`, displayName: `${PREFIX} 上传人`, isAdmin: false };
const OTHER: Actor = { userId: `${PREFIX}_u_other`, displayName: `${PREFIX} 同事`, isAdmin: false };
const ADMIN: Actor = { userId: `${PREFIX}_u_admin`, displayName: `${PREFIX} 管理员`, isAdmin: true };
/** 没有任何权限的陌生人（不是上传者、不是案例上传者、不是管理员）。 */
const ADMIN_LESS: Actor = { userId: `${PREFIX}_u_stranger`, displayName: `${PREFIX} 陌生人`, isAdmin: false };
const NOW = new Date("2026-10-19T04:00:00.000Z");

class MemoryBucket {
  objects = new Map<string, number>();
  deleted: string[] = [];
  async head(key: string) {
    const size = this.objects.get(key);
    return size === undefined ? null : { size };
  }
  async delete(key: string) {
    this.deleted.push(key);
    this.objects.delete(key);
  }
  async createPresignedPutUrl(key: string) {
    return `http://local/put?key=${encodeURIComponent(key)}`;
  }
  async createPresignedGetUrl(key: string, options?: { responseContentDisposition?: string }) {
    return `http://local/get?key=${encodeURIComponent(key)}${options?.responseContentDisposition ? `&d=1` : ""}`;
  }
}

let pool: pg.Pool | null = null;
let db: DbClient;
let skipReason: string | false = "尚未连接数据库";

async function connect(): Promise<string | false> {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(new URL("../.env.development.local", import.meta.url));
    } catch {
      return "没有 DATABASE_URL，也没有 .env.development.local";
    }
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return "没有 DATABASE_URL";
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return "DATABASE_URL 不是合法的连接串";
  }
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) return "DATABASE_URL 不是本机库，集成测试只在本机库上跑";
  pool = new pg.Pool({ connectionString, ssl: false, max: 4, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1 FROM retro_cases LIMIT 1");
    await pool.query("SELECT 1 FROM retro_recordings LIMIT 1");
    await pool.query("SELECT 1 FROM retro_case_assets LIMIT 1");
  } catch (error) {
    await pool.end().catch(() => undefined);
    pool = null;
    return `连不上本机库或 retro_ 表还没建：${error instanceof Error ? error.message : String(error)}`;
  }
  db = new DbClient(pool);
  return false;
}

async function cleanup() {
  if (!pool) return;
  const owned = `SELECT id FROM retro_cases WHERE created_by_user_id LIKE '${PREFIX}\\_%'`;
  await pool.query(`DELETE FROM retro_round_links WHERE round_id IN (SELECT id FROM retro_case_rounds WHERE case_id IN (${owned}))`);
  await pool.query(`DELETE FROM retro_case_assets WHERE case_id IN (${owned})`);
  await pool.query(`DELETE FROM retro_recordings WHERE case_id IN (${owned}) OR uploaded_by_user_id LIKE '${PREFIX}\\_%'`);
  await pool.query(`DELETE FROM retro_case_rounds WHERE case_id IN (${owned})`);
  await pool.query(`DELETE FROM retro_cases WHERE created_by_user_id LIKE '${PREFIX}\\_%'`);
  await pool.query(`DELETE FROM reports WHERE id LIKE '${PREFIX}\\_%'`);
  await pool.query(`DELETE FROM visual_cases WHERE id LIKE '${PREFIX}\\_%'`).catch(() => undefined);
  await pool.query(`DELETE FROM users WHERE id LIKE '${PREFIX}\\_%'`);
}

async function seedUsers() {
  const stamp = new Date().toISOString();
  for (const actor of [OWNER, OTHER, ADMIN, ADMIN_LESS]) {
    await pool!.query(
      `INSERT INTO users (id, wecom_corp_id, wecom_user_id, identity_key, display_name, status, last_login_at, last_synced_at, created_at, updated_at)
       VALUES ($1, $2, $1, $1, $3, 'ACTIVE', $4, $4, $4, $4) ON CONFLICT (id) DO NOTHING`,
      [actor.userId, PREFIX, actor.displayName, stamp],
    );
  }
}

async function expectError(run: () => Promise<unknown>, status: number, code: string | RegExp) {
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof RetroError, `expected RetroError, got ${String(error)}`);
    assert.equal(error.status, status, error.message);
    if (typeof code === "string") assert.equal(error.code, code);
    else assert.match(error.message, code);
    return true;
  });
}

const basics = (title = `${PREFIX} 年货节主视觉`) => ({ monthKey: month, department: `${PREFIX} 创意部`, clientName: `${PREFIX} 客户`, title, sceneTags: "改稿" });

async function newCase(actor: Actor = OWNER, title?: string) {
  return createRetroCase(db, actor, basics(title), NOW);
}

function makeDeps(asr: RetroAsrProvider, bucket: MemoryBucket, clock: { now: number }): RetroTranscribeDeps {
  return {
    asr,
    bucket,
    sleep: async (ms) => {
      clock.now += ms;
    },
    clock: () => clock.now,
    log: () => undefined,
  };
}

before(async () => {
  skipReason = await connect();
  if (skipReason) {
    console.warn(`[retro-service] 跳过集成测试：${skipReason}`);
    return;
  }
  await cleanup();
  await seedUsers();
});

after(async () => {
  if (!pool) return;
  await cleanup().catch((error) => console.error("[retro-service] 清理失败", error));
  await pool.end();
});

/** 数据库连不上就在运行时跳过（skip 选项在注册时就定了，那时还没连）。 */
function dbTest(name: string, run: () => Promise<void>) {
  test(name, async (t: TestContext) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    await run();
  });
}

describe("retro service (local Postgres)", { concurrency: false }, () => {
  dbTest("creating a case also creates an empty 「第 1 版」 round and the library lists it", async () => {
    const created = await newCase();
    assert.match(created.caseId, /^rtc_/);
    const detail = await loadRetroCaseDetail(db, new MemoryBucket(), created.caseId, OWNER);
    assert.ok(detail);
    assert.equal(detail.rounds.length, 1);
    assert.equal(detail.rounds[0].id, created.firstRoundId);
    assert.equal(detail.rounds[0].title, "第 1 版");
    assert.equal(detail.background, "");
    assert.equal(detail.revision, 1);
    assert.deepEqual(detail.sceneTags, ["改稿"]);
    assert.equal(detail.inMinutes, null);
    assert.deepEqual(detail.viewerCapabilities, { canEdit: true, canTrash: true, canUploadRecording: true });

    const library = await listRetroLibrary(db, OWNER);
    const card = library.cases.find((item) => item.id === created.caseId);
    assert.ok(card);
    assert.equal(card.canManage, true);
    assert.deepEqual(card.roundTrack, [{ title: "第 1 版", hasFeedback: false }]);
    assert.deepEqual(card.recording, { state: "NONE" });
    assert.equal((await listRetroLibrary(db, OTHER)).cases.find((item) => item.id === created.caseId)?.canManage, false);
    const summary = library.months.find((item) => item.monthKey === month);
    assert.ok(summary && summary.caseCount >= 1);
    assert.deepEqual(summary.badge, { state: "NONE" });
  });

  dbTest("PATCH is field by field, bumps the revision, and a stale revision is a 409", async () => {
    const { caseId } = await newCase();
    const first = await patchRetroCase(db, OWNER, caseId, { revision: 1, background: "客户最开始要喜庆有年味", title: `${PREFIX} 改过的标题` }, NOW);
    assert.equal(first.revision, 2);
    assert.equal(first.background, "客户最开始要喜庆有年味");
    assert.equal(first.department, `${PREFIX} 创意部`, "fields not sent are untouched");
    await expectError(() => patchRetroCase(db, OWNER, caseId, { revision: 1, outcome: "x" }, NOW), 409, "REVISION_CONFLICT");
    const second = await patchRetroCase(db, OWNER, caseId, { revision: 2, outcome: "客户接受第三版", sceneTags: ["改稿", "比稿"] }, NOW);
    assert.equal(second.revision, 3);
    assert.deepEqual(second.sceneTags, ["改稿", "比稿"]);
    assert.equal(second.background, "客户最开始要喜庆有年味");
  });

  dbTest("two writers racing on the same revision: exactly one wins", async () => {
    const { caseId } = await newCase();
    const results = await Promise.allSettled([
      patchRetroCase(db, OWNER, caseId, { revision: 1, outcome: "窗口 A" }, NOW),
      patchRetroCase(db, ADMIN, caseId, { revision: 1, outcome: "窗口 B" }, NOW),
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    const loser = results.find((item) => item.status === "rejected") as PromiseRejectedResult;
    assert.ok(loser.reason instanceof RetroError && loser.reason.status === 409);
  });

  dbTest("only the uploader or an admin may edit; everyone may read; trash and restore are soft", async () => {
    const { caseId } = await newCase();
    await expectError(() => patchRetroCase(db, OTHER, caseId, { revision: 1, outcome: "x" }, NOW), 403, "FORBIDDEN");
    await expectError(() => addRetroRound(db, OTHER, caseId, null), 403, "FORBIDDEN");
    await expectError(() => trashRetroCase(db, OTHER, caseId), 403, "FORBIDDEN");
    assert.ok(await loadRetroCaseDetail(db, new MemoryBucket(), caseId, OTHER));
    assert.equal((await patchRetroCase(db, ADMIN, caseId, { revision: 1, outcome: "管理员改的" }, NOW)).outcome, "管理员改的");

    assert.deepEqual(await trashRetroCase(db, OWNER, caseId), { ok: true });
    assert.equal(await loadRetroCaseDetail(db, new MemoryBucket(), caseId, OWNER), null);
    assert.ok(!(await listRetroLibrary(db, OWNER)).cases.some((item) => item.id === caseId));
    await expectError(() => trashRetroCase(db, OWNER, caseId), 404, "NOT_FOUND");
    await expectError(() => restoreRetroCase(db, OTHER, caseId), 403, "FORBIDDEN");
    assert.deepEqual(await restoreRetroCase(db, OWNER, caseId), { ok: true });
    await expectError(() => restoreRetroCase(db, OWNER, caseId), 409, "NOT_TRASHED");
    assert.ok(await loadRetroCaseDetail(db, new MemoryBucket(), caseId, OWNER));
  });

  dbTest("rounds: add (default title, max 20), patch with revision, soft delete renumbers, reorder", async () => {
    const { caseId, firstRoundId } = await newCase();
    const second = await addRetroRound(db, OWNER, caseId, null);
    assert.equal(second.title, "第 2 版");
    assert.equal(second.position, 1);
    const third = await addRetroRound(db, OWNER, caseId, { title: "电话沟通" });
    assert.equal(third.title, "电话沟通");

    const patched = await patchRetroRound(db, OWNER, caseId, firstRoundId, { revision: 1, deliveryText: "红金配色", feedbackText: "太老气" });
    assert.equal(patched.round.revision, 2);
    await expectError(() => patchRetroRound(db, OWNER, caseId, firstRoundId, { revision: 1, responseText: "x" }), 409, "REVISION_CONFLICT");
    await expectError(() => patchRetroRound(db, OTHER, caseId, firstRoundId, { revision: 2, responseText: "x" }), 403, "FORBIDDEN");

    assert.deepEqual(await reorderRetroRounds(db, OWNER, caseId, { roundIds: [third.id, firstRoundId, second.id] }), { ok: true });
    let detail = (await loadRetroCaseDetail(db, new MemoryBucket(), caseId, OWNER))!;
    assert.deepEqual(detail.rounds.map((round) => round.id), [third.id, firstRoundId, second.id]);
    assert.deepEqual(detail.rounds.map((round) => round.position), [0, 1, 2]);
    await expectError(() => reorderRetroRounds(db, OWNER, caseId, { roundIds: [third.id] }), 400, /对不上/);

    await deleteRetroRound(db, OWNER, caseId, firstRoundId);
    detail = (await loadRetroCaseDetail(db, new MemoryBucket(), caseId, OWNER))!;
    assert.deepEqual(detail.rounds.map((round) => [round.id, round.position]), [[third.id, 0], [second.id, 1]]);
    const soft = await pool!.query("SELECT deleted_at FROM retro_case_rounds WHERE id = $1", [firstRoundId]);
    assert.ok(soft.rows[0].deleted_at, "the round row is kept so published 「第 N 版」 markers still resolve");
    await expectError(() => deleteRetroRound(db, OWNER, caseId, firstRoundId), 404, "NOT_FOUND");

    const library = await listRetroLibrary(db, OWNER);
    assert.deepEqual(library.cases.find((item) => item.id === caseId)?.roundTrack.map((item) => item.title), ["电话沟通", "第 2 版"]);
  });

  dbTest("a case holds at most 20 rounds", async () => {
    const { caseId } = await newCase();
    for (let index = 0; index < 19; index += 1) await addRetroRound(db, OWNER, caseId, null);
    await expectError(() => addRetroRound(db, OWNER, caseId, null), 400, /最多 20 个回合/);
  });

  dbTest("attachments: refuse unknown types, cap at 12 per owner, upload → complete (head) → missing is reported", async () => {
    const { caseId, firstRoundId } = await newCase();
    const bucket = new MemoryBucket();
    await expectError(() => addRetroAssets(db, OWNER, caseId, { assets: [{ roundId: null, originalName: "a.zip", contentType: "application/zip", fileSize: 10 }] }), 400, /支持图片、视频、音频/);
    await expectError(() => addRetroAssets(db, OWNER, caseId, { assets: [{ roundId: "rnd_nope", originalName: "a.png", contentType: "image/png", fileSize: 10 }] }), 400, /回合不存在/);
    await expectError(() => addRetroAssets(db, OTHER, caseId, { assets: [{ roundId: null, originalName: "a.png", contentType: "image/png", fileSize: 10 }] }), 403, "FORBIDDEN");

    const twelve = Array.from({ length: 12 }, (_, index) => ({ roundId: firstRoundId, originalName: `p${index}.png`, contentType: "image/png", fileSize: 100 }));
    const added = await addRetroAssets(db, OWNER, caseId, { assets: twelve });
    assert.equal(added.assetIds.length, 12);
    await expectError(() => addRetroAssets(db, OWNER, caseId, { assets: [twelve[0]] }), 400, /最多放 12 个附件/);
    // 需求凭证有自己的 12 个名额。
    const need = await addRetroAssets(db, OWNER, caseId, {
      assets: [
        { roundId: null, originalName: "brief.pdf", contentType: "application/pdf", fileSize: 50 },
        { roundId: null, originalName: "客户电话.m4a", contentType: "", fileSize: 70, durationSeconds: 90 },
        { roundId: null, originalName: "demo.mp4", contentType: "video/mp4", fileSize: 90 },
      ],
    });

    // 签链接：视频另带封面；传完之前 complete 把还没到的列在 missing 里。
    const [pdfId, audioId, videoId] = need.assetIds;
    const signed = await signRetroAssetUpload(db, bucket as unknown as VideoBucket, OWNER, caseId, videoId);
    assert.ok(signed.uploadUrl.includes(encodeURIComponent(`retro/cases/${caseId}/assets/${videoId}/original.mp4`)));
    assert.ok(signed.coverUploadUrl?.includes("cover.jpg"));
    assert.equal((await signRetroAssetUpload(db, bucket as unknown as VideoBucket, OWNER, caseId, pdfId)).coverUploadUrl, null);
    await expectError(() => signRetroAssetUpload(db, bucket as unknown as VideoBucket, OTHER, caseId, pdfId), 403, "FORBIDDEN");

    bucket.objects.set(`retro/cases/${caseId}/assets/${pdfId}/original.pdf`, 50);
    bucket.objects.set(`retro/cases/${caseId}/assets/${audioId}/original.m4a`, 71); // 大小对不上
    bucket.objects.set(`retro/cases/${caseId}/assets/${videoId}/original.mp4`, 90);
    bucket.objects.set(`retro/cases/${caseId}/assets/${videoId}/cover.jpg`, 10);
    const first = await completeRetroAssets(db, bucket, OWNER, caseId, { assetIds: need.assetIds });
    assert.deepEqual(first.missing, [audioId], "size mismatch counts as missing");
    assert.deepEqual(first.transcribingAssetIds, []);
    bucket.objects.set(`retro/cases/${caseId}/assets/${audioId}/original.m4a`, 70);
    const second = await completeRetroAssets(db, bucket, OWNER, caseId, { assetIds: need.assetIds });
    assert.deepEqual(second.missing, [], "assets already ready are skipped");
    // 不带 assetIds 就核对案例里所有还在上传中的：那 12 张图片一直没传，全部列在 missing 里。
    assert.deepEqual((await completeRetroAssets(db, bucket, OWNER, caseId, {})).missing.sort(), [...added.assetIds].sort());
    assert.deepEqual(second.transcribingAssetIds, [audioId], "an uploaded customer recording starts transcribing");

    // 非编辑者只看得到已传完的；编辑者连没传完的也能看到（好重传或去掉）。
    const asEditor = (await loadRetroCaseDetail(db, bucket, caseId, OWNER))!;
    const asReader = (await loadRetroCaseDetail(db, bucket, caseId, OTHER))!;
    assert.equal(asEditor.needAssets.length, 3);
    assert.equal(asEditor.rounds[0].assets.length, 12);
    assert.equal(asReader.needAssets.length, 3);
    assert.equal(asReader.rounds[0].assets.length, 0, "the 12 images were never uploaded");
    const audioView = asEditor.needAssets.find((item) => item.id === audioId)!;
    assert.equal(audioView.transcribe?.status, "TRANSCRIBING");
    assert.equal(audioView.openUrl, `/api/retro-cases/${caseId}/assets/${audioId}/stream`);
    assert.equal(asEditor.needAssets.find((item) => item.id === pdfId)!.openUrl, `/api/retro-cases/${caseId}/assets/${pdfId}/original`);
    const videoView = asEditor.needAssets.find((item) => item.id === videoId)!;
    assert.equal(videoView.derivativeStatus, "READY");
    assert.ok(videoView.thumbnailUrl);

    // 移除是真删：行和对象一并删，剩下的位置重排。
    assert.deepEqual(await removeRetroAsset(db, bucket, OWNER, caseId, pdfId), { ok: true });
    assert.ok(bucket.deleted.includes(`retro/cases/${caseId}/assets/${pdfId}/original.pdf`));
    assert.ok(bucket.deleted.includes(`retro/cases/${caseId}/assets/${pdfId}/thumb.jpg`));
    const left = await pool!.query("SELECT id, position FROM retro_case_assets WHERE case_id = $1 AND round_id IS NULL ORDER BY position", [caseId]);
    assert.deepEqual(left.rows.map((row) => [row.id, row.position]), [[audioId, 0], [videoId, 1]]);
    await expectError(() => removeRetroAsset(db, bucket, OWNER, caseId, pdfId), 404, "NOT_FOUND");
  });

  dbTest("a customer recording transcribes with the fake ASR in two polls and is visible to everyone; FAILED can retry", async () => {
    const { caseId } = await newCase();
    const bucket = new MemoryBucket();
    const { assetIds } = await addRetroAssets(db, OWNER, caseId, { assets: [{ roundId: null, originalName: "客户电话.mp3", contentType: "audio/mpeg", fileSize: 70 }] });
    const assetId = assetIds[0];
    bucket.objects.set(`retro/cases/${caseId}/assets/${assetId}/original.mp3`, 70);
    const outcome = await completeRetroAssets(db, bucket, OWNER, caseId, {});
    assert.deepEqual(outcome.transcribingAssetIds, [assetId]);
    assert.equal((await loadRetroAssetTranscript(db, { caseId, assetId, viewer: OTHER })).response.transcribe.status, "TRANSCRIBING");

    const clock = { now: Date.parse("2026-10-19T08:00:00.000Z") };
    const asr = createFakeRetroAsr(() => clock.now);
    const advanced = await advanceRetroTranscription(db, "ASSET", assetId, { deadline: clock.now + 280_000, deps: makeDeps(asr, bucket, clock), kind: "CLIENT" });
    assert.deepEqual(advanced, { advanced: true, status: "READY" });
    const state = await loadRetroAssetTranscript(db, { caseId, assetId, viewer: OTHER });
    assert.equal(state.response.transcribe.status, "READY");
    assert.ok((state.response.transcribe.segments?.length ?? 0) >= 10);
    assert.equal(state.response.transcribe.durationMs, 124_000);
    assert.equal(state.leaseUntil, null, "the lease is released");
    // 只有失败的才能重试。
    await expectError(() => retryRetroAssetTranscription(db, OWNER, caseId, assetId), 409, "INVALID_STATE");

    // 转写失败：写中文原因，重试后回到转写中。
    await pool!.query("UPDATE retro_case_assets SET transcribe_status = 'TRANSCRIBING', asr_task_id = NULL, transcript_json = NULL WHERE id = $1", [assetId]);
    const failing: RetroAsrProvider = {
      ...asr,
      submit: async () => ({ ok: false, reason: "腾讯云识别失败：测试用", transient: false, code: null }),
    };
    assert.equal((await advanceRetroTranscription(db, "ASSET", assetId, { deadline: clock.now + 280_000, deps: makeDeps(failing, bucket, clock), kind: "CLIENT" })).status, "FAILED");
    const failed = (await loadRetroAssetTranscript(db, { caseId, assetId, viewer: OTHER })).response.transcribe;
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.failReason, "腾讯云识别失败：测试用");
    await expectError(() => retryRetroAssetTranscription(db, OTHER, caseId, assetId), 403, "FORBIDDEN");
    assert.equal(await retryRetroAssetTranscription(db, OWNER, caseId, assetId), true);
    assert.equal((await loadRetroAssetTranscript(db, { caseId, assetId, viewer: OWNER })).response.transcribe.status, "TRANSCRIBING");
  });

  dbTest("review recordings: anyone can upload, at most 3 parts, a removed part number is reused", async () => {
    const { caseId } = await newCase();
    const bucket = new MemoryBucket();
    const request = (name = "点评.m4a") => ({ monthKey: month, caseId, fileName: name, contentType: "", sizeBytes: 1000 });

    const one = await createRetroRecording(db, bucket, OTHER, request());
    assert.equal(one.recording.partNo, 1);
    assert.equal(one.recording.status, "UPLOADING");
    assert.equal(one.recording.uploadedByName, OTHER.displayName);
    assert.equal(one.recording.audioUrl, `/api/retro-recordings/${one.recording.id}/audio`);
    assert.ok(one.uploadUrl.includes(encodeURIComponent(`retro/recordings/${one.recording.id}/original`)));
    const two = await createRetroRecording(db, bucket, OWNER, request());
    const three = await createRetroRecording(db, bucket, OWNER, request());
    assert.deepEqual([two.recording.partNo, three.recording.partNo], [2, 3]);
    await expectError(() => createRetroRecording(db, bucket, OWNER, request()), 409, "RECORDING_PARTS_FULL");

    // 并发上传不会拿到同一个段号（案例行上有锁）。
    // 移除第 1 段（上传者本人）→ 段号空出来，下一次上传复用 1。
    await expectError(() => runRetroRecordingAction(db, bucket, ADMIN_LESS, one.recording.id, { action: "REMOVE" }), 403, "FORBIDDEN");
    const removed = await runRetroRecordingAction(db, bucket, OTHER, one.recording.id, { action: "REMOVE" });
    assert.equal(removed.view.status, "REMOVED");
    assert.equal(removed.view.canRemove, false);
    const again = await createRetroRecording(db, bucket, OTHER, request());
    assert.equal(again.recording.partNo, 1);
    await expectError(() => createRetroRecording(db, bucket, OTHER, request()), 409, "RECORDING_PARTS_FULL");
    // 被移除的行和对象都还在，音频地址照样能签。
    assert.match(await resolveRetroRecordingAudioUrl(db, bucket, one.recording.id), /retro%2Frecordings%2F/);
    assert.equal((await loadRetroRecording(db, OWNER, one.recording.id)).view.status, "REMOVED");

    // 案例上传者可以移除别人传的；陌生人不行。
    assert.equal((await runRetroRecordingAction(db, bucket, OWNER, again.recording.id, { action: "REMOVE" })).view.status, "REMOVED");
    // 页面上只列没被移除的，按段号排。
    const detail = (await loadRetroCaseDetail(db, bucket, caseId, OTHER))!;
    assert.deepEqual(detail.recordings.map((item) => item.partNo), [2, 3]);
    assert.equal(detail.recordings[0].canRemove, false, "OTHER did not upload part 2 and does not own the case");
  });

  dbTest("the summary recording is per month, also capped at 3, and independent of the case parts", async () => {
    const bucket = new MemoryBucket();
    const probe = "2031-01"; // 不会和别的数据混。
    const request = { monthKey: probe, caseId: null, fileName: "总结.mp3", contentType: "audio/mpeg", sizeBytes: 500 };
    const parts: number[] = [];
    for (let index = 0; index < 3; index += 1) parts.push((await createRetroRecording(db, bucket, OTHER, request)).recording.partNo);
    assert.deepEqual(parts, [1, 2, 3]);
    await expectError(() => createRetroRecording(db, bucket, OTHER, request), 409, "RECORDING_PARTS_FULL");
    const nextMonth = await createRetroRecording(db, bucket, OTHER, { ...request, monthKey: "2031-02" });
    assert.equal(nextMonth.recording.partNo, 1);
    await expectError(() => createRetroRecording(db, bucket, OTHER, { ...request, caseId: "rtc_missing" }), 404, "NOT_FOUND");
  });

  dbTest("a recording's month must match its case, and a case that changes month takes its recordings along", async () => {
    const { caseId } = await newCase();
    const bucket = new MemoryBucket();
    await expectError(() => createRetroRecording(db, bucket, OWNER, { monthKey: "2026-09", caseId, fileName: "a.m4a", contentType: "", sizeBytes: 10 }), 400, /月份和案例不一致/);
    const { recording } = await createRetroRecording(db, bucket, OWNER, { monthKey: month, caseId, fileName: "a.m4a", contentType: "", sizeBytes: 10 });
    await patchRetroCase(db, OWNER, caseId, { revision: 1, monthKey: "2026-09" }, NOW);
    assert.equal((await loadRetroRecording(db, OWNER, recording.id)).view.monthKey, "2026-09");
  });

  dbTest("a review recording goes UPLOADING → TRANSCRIBING → READY with the fake ASR; a missing object fails and can be retried", async () => {
    const { caseId } = await newCase();
    const bucket = new MemoryBucket();
    const { recording } = await createRetroRecording(db, bucket, OWNER, { monthKey: month, caseId, fileName: "点评.m4a", contentType: "", sizeBytes: 1234 });
    const key = `retro/recordings/${recording.id}/original`;

    // 对象还没传上来就报「已上传」：核对不过，转 FAILED 并写明原因。
    const missing = await runRetroRecordingAction(db, bucket, OWNER, recording.id, { action: "UPLOADED" });
    assert.equal(missing.view.status, "FAILED");
    assert.equal(missing.view.failReason, "没有找到上传的录音文件，请重新上传。");
    assert.equal(missing.advance, false);
    await expectError(() => runRetroRecordingAction(db, bucket, OWNER, recording.id, { action: "UPLOADED" }), 409, "INVALID_STATE");

    // 大小对不上也不放行。
    bucket.objects.set(key, 99);
    assert.equal((await runRetroRecordingAction(db, bucket, OWNER, recording.id, { action: "RETRY" })).view.failReason, "录音文件不完整（大小与上传前不符），请重新上传。");

    bucket.objects.set(key, 1234);
    const retried = await runRetroRecordingAction(db, bucket, OWNER, recording.id, { action: "RETRY" });
    assert.equal(retried.view.status, "TRANSCRIBING");
    assert.equal(retried.advance, true);
    assert.equal(retried.view.failReason, null);
    // 重复上报：已经在转写了就原样返回。
    assert.equal((await runRetroRecordingAction(db, bucket, OWNER, recording.id, { action: "UPLOADED" })).view.status, "TRANSCRIBING");
    await expectError(() => runRetroRecordingAction(db, bucket, OWNER, recording.id, { action: "RETRY" }), 409, "INVALID_STATE");
    assert.ok((await listAdvanceableRetroTranscriptions(db, { caseId })).some((item) => item.id === recording.id && item.kind === "REVIEW"));

    const clock = { now: Date.parse("2026-10-19T08:00:00.000Z") };
    const asr = createFakeRetroAsr(() => clock.now);
    const deps = makeDeps(asr, bucket, clock);
    // 租约互斥：有人占着租约时，另一次推进直接返回。
    await pool!.query("UPDATE retro_recordings SET lease_until = now() + interval '5 minutes' WHERE id = $1", [recording.id]);
    assert.deepEqual(await advanceRetroTranscription(db, "RECORDING", recording.id, { deadline: clock.now + 280_000, deps, kind: "REVIEW" }), { advanced: false, status: null });
    await pool!.query("UPDATE retro_recordings SET lease_until = NULL WHERE id = $1", [recording.id]);

    assert.deepEqual(await advanceRetroTranscription(db, "RECORDING", recording.id, { deadline: clock.now + 280_000, deps, kind: "REVIEW" }), { advanced: true, status: "READY" });
    const { view, row } = await loadRetroRecording(db, OTHER, recording.id);
    assert.equal(view.status, "READY");
    assert.equal(view.durationMs, 702_000);
    assert.ok((view.segments?.length ?? 0) >= 20);
    assert.equal(view.segments?.[0].id, 1);
    assert.equal(row.lease_until, null);
    assert.equal(view.canRemove, false);
    // 转完之后不再推进。
    assert.deepEqual(await advanceRetroTranscription(db, "RECORDING", recording.id, { deadline: clock.now + 280_000, deps, kind: "REVIEW" }), { advanced: false, status: null });
    // 卡片上的录音标记。
    const card = (await listRetroLibrary(db, OWNER)).cases.find((item) => item.id === caseId)!;
    assert.deepEqual(card.recording, { state: "READY", parts: 1, durationMs: 702_000 });
    const summary = (await listRetroLibrary(db, OWNER)).months.find((item) => item.monthKey === month)!;
    assert.ok(summary.recordedCaseCount >= 1, "a case with a transcribed review recording counts as recorded");
  });

  dbTest("the advance gives up before the deadline instead of overrunning it", async () => {
    const { caseId } = await newCase();
    const bucket = new MemoryBucket();
    const { recording } = await createRetroRecording(db, bucket, OWNER, { monthKey: month, caseId, fileName: "点评.m4a", contentType: "", sizeBytes: 10 });
    bucket.objects.set(`retro/recordings/${recording.id}/original`, 10);
    await runRetroRecordingAction(db, bucket, OWNER, recording.id, { action: "UPLOADED" });
    const clock = { now: Date.parse("2026-10-19T08:00:00.000Z") };
    // 只剩 2 秒：提交之后来不及再等一个轮询间隔，留给下一次推进。
    const result = await advanceRetroTranscription(db, "RECORDING", recording.id, {
      deadline: clock.now + 2_000,
      deps: makeDeps(createFakeRetroAsr(() => clock.now), bucket, clock),
      kind: "REVIEW",
    });
    assert.deepEqual(result, { advanced: true, status: "TRANSCRIBING" });
    const stored = await pool!.query("SELECT asr_task_id, lease_until FROM retro_recordings WHERE id = $1", [recording.id]);
    assert.match(stored.rows[0].asr_task_id, /^fake-REVIEW-/);
    assert.equal(stored.rows[0].lease_until, null);
  });

  dbTest("links are written back as a whole, new ones must exist, and a deleted original shows as deleted", async () => {
    const { caseId, firstRoundId } = await newCase();
    const bucket = new MemoryBucket();
    await pool!.query(
      `INSERT INTO reports (id, title, task_type, object_key, original_name, status, created_by_email, created_by_name)
       VALUES ($1, $2, '提案', 'x', 'x.pdf', 'READY', 't@x', 't')`,
      [`${PREFIX}_report_a`, `${PREFIX} 年货节提案`],
    );
    const links = (kind: string, targetId: string) => ({ kind, targetId });
    const put = await putRetroRoundLinks(db, bucket, OWNER, caseId, firstRoundId, { links: [links("REPORT", `${PREFIX}_report_a`)] });
    assert.equal(put.length, 1);
    assert.equal(put[0].title, `${PREFIX} 年货节提案`);
    assert.equal(put[0].href, `/reports/${PREFIX}_report_a`);
    assert.equal(put[0].deleted, false);
    await expectError(() => putRetroRoundLinks(db, bucket, OWNER, caseId, firstRoundId, { links: [links("REPORT", `${PREFIX}_nope`)] }), 400, /找不到或已被删除/);
    await expectError(() => putRetroRoundLinks(db, bucket, OTHER, caseId, firstRoundId, { links: [] }), 403, "FORBIDDEN");

    await pool!.query("UPDATE reports SET deleted_at = now()::text WHERE id = $1", [`${PREFIX}_report_a`]);
    const detail = (await loadRetroCaseDetail(db, bucket, caseId, OTHER))!;
    assert.equal(detail.rounds[0].links[0].deleted, true);
    assert.equal(detail.rounds[0].links[0].href, null);
    // 整体写回时，原来就挂着的（即使原作品已删）照样保留。
    assert.equal((await putRetroRoundLinks(db, bucket, OWNER, caseId, firstRoundId, { links: [links("REPORT", `${PREFIX}_report_a`)] }))[0].deleted, true);
    assert.deepEqual(await putRetroRoundLinks(db, bucket, OWNER, caseId, firstRoundId, { links: [] }), []);
  });
});
