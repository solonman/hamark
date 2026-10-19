// 客户需求复盘库的请求校验、权限判定和纯函数（docs/26 4.2、4.3、4.5、5）：字段长度与中文原因、月份范围、
// 附件分类与数量上限、段号分配、卡片录音标记、热词、缺表识别、假转写提供方。不碰数据库。
import assert from "node:assert/strict";
import test from "node:test";
import { canEditRetroCase, canRemoveRetroRecording } from "../lib/retro/access";
import { createFakeRetroAsr, fakeRetroTranscript, resolveRetroAiProvider } from "../lib/retro/asr";
import { retroRecordingBadge } from "../lib/retro/cases";
import {
  RETRO_MISSING_SCHEMA_MESSAGE,
  RetroError,
  isMissingRetroSchema,
  isUniqueViolation,
} from "../lib/retro/errors";
import { retroAssetOpenPath, retroAssetOriginalKey, retroRecordingObjectKey } from "../lib/retro/keys";
import { nextRetroPartNo } from "../lib/retro/recordings";
import { retroAttachmentDisposition } from "../lib/retro/assets";
import { buildRetroHotwords, shouldAdvanceRetroTranscription } from "../lib/retro/transcription";
import {
  assertRetroAssetCapacity,
  validateRetroCaseBasics,
  validateRetroCasePatch,
  validateRetroLinks,
  validateRetroNewAssets,
  validateRetroNewRoundTitle,
  validateRetroRecordingAction,
  validateRetroRecordingRequest,
  validateRetroRoundOrder,
  validateRetroRoundPatch,
} from "../lib/retro/validate";

const NOW = new Date("2026-10-19T04:00:00.000Z"); // 北京时间 2026-10-19，当前复盘月份 2026-10
const GOOD = { monthKey: "2026-10", department: "创意部", clientName: "某食品客户", title: "年货节主视觉三次被否", sceneTags: "改稿，客户情绪" };

function rejects(run: () => unknown, pattern: RegExp) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof RetroError, "should be a RetroError");
    assert.equal(error.status, 400);
    assert.match(error.message, pattern);
    return true;
  });
}

// ---------------------------------------------------------------------------
// 案例基本信息
// ---------------------------------------------------------------------------

test("a valid basics body is trimmed and the scene tags are normalised and de-duplicated", () => {
  const basics = validateRetroCaseBasics({ ...GOOD, department: "  创意部 ", sceneTags: "改稿, 客户情绪，改稿 ,ＡＢＣ" }, NOW);
  assert.equal(basics.department, "创意部");
  assert.deepEqual(basics.sceneTags, ["改稿", "客户情绪", "ABC"]);
  assert.deepEqual(validateRetroCaseBasics({ ...GOOD, sceneTags: undefined }, NOW).sceneTags, []);
});

test("basics are checked in the dialog's order: month, department, client, title, tags", () => {
  rejects(() => validateRetroCaseBasics({}, NOW), /复盘月份/);
  rejects(() => validateRetroCaseBasics({ monthKey: "2026-10" }, NOW), /部门/);
  rejects(() => validateRetroCaseBasics({ monthKey: "2026-10", department: "创意部" }, NOW), /客户/);
  rejects(() => validateRetroCaseBasics({ monthKey: "2026-10", department: "创意部", clientName: "客户" }, NOW), /案例标题/);
  rejects(() => validateRetroCaseBasics({ ...GOOD, department: "   " }, NOW), /请填写部门/);
});

test("length limits come straight from RETRO_LIMITS and the message says which field", () => {
  rejects(() => validateRetroCaseBasics({ ...GOOD, department: "部".repeat(31) }, NOW), /部门最多 30/);
  rejects(() => validateRetroCaseBasics({ ...GOOD, clientName: "客".repeat(61) }, NOW), /客户最多 60/);
  rejects(() => validateRetroCaseBasics({ ...GOOD, title: "题".repeat(81) }, NOW), /案例标题最多 80/);
  assert.equal(validateRetroCaseBasics({ ...GOOD, title: "题".repeat(80) }, NOW).title.length, 80);
  rejects(() => validateRetroCaseBasics({ ...GOOD, sceneTags: "a,b,c,d,e,f,g,h,i" }, NOW), /最多 8 个/);
  rejects(() => validateRetroCaseBasics({ ...GOOD, sceneTags: ["标".repeat(21)] }, NOW), /最多 20 个字/);
});

test("creating only allows last, this or next month; editing allows any past month but not beyond next month", () => {
  assert.equal(validateRetroCaseBasics({ ...GOOD, monthKey: "2026-09" }, NOW).monthKey, "2026-09");
  assert.equal(validateRetroCaseBasics({ ...GOOD, monthKey: "2026-11" }, NOW).monthKey, "2026-11");
  rejects(() => validateRetroCaseBasics({ ...GOOD, monthKey: "2026-08" }, NOW), /上月、本月或下月/);
  rejects(() => validateRetroCaseBasics({ ...GOOD, monthKey: "2026-12" }, NOW), /最晚只能选到下个月/);
  rejects(() => validateRetroCaseBasics({ ...GOOD, monthKey: "2026-13" }, NOW), /复盘月份/);
  assert.equal(validateRetroCasePatch({ monthKey: "2025-03", revision: 1 }, NOW).fields.monthKey, "2025-03");
  rejects(() => validateRetroCasePatch({ monthKey: "2026-12", revision: 1 }, NOW), /最晚只能选到下个月/);
});

test("the month is judged on Beijing time, not UTC", () => {
  // UTC 2026-09-30 17:00 已经是北京时间 10 月 1 日。
  const edge = new Date("2026-09-30T17:00:00.000Z");
  assert.equal(validateRetroCaseBasics({ ...GOOD, monthKey: "2026-11" }, edge).monthKey, "2026-11");
  rejects(() => validateRetroCaseBasics({ ...GOOD, monthKey: "2026-12" }, edge), /最晚只能选到下个月/);
});

test("PATCH takes only the fields sent, needs a revision, and rejects an empty change", () => {
  const { fields, revision } = validateRetroCasePatch({ revision: 3, background: "  客户最开始要什么  ", outcome: "" }, NOW);
  assert.equal(revision, 3);
  assert.deepEqual(fields, { background: "客户最开始要什么", outcome: "" });
  rejects(() => validateRetroCasePatch({ background: "x" }, NOW), /版本号/);
  rejects(() => validateRetroCasePatch({ revision: 0, background: "x" }, NOW), /版本号/);
  rejects(() => validateRetroCasePatch({ revision: 1.5, background: "x" }, NOW), /版本号/);
  rejects(() => validateRetroCasePatch({ revision: 1 }, NOW), /没有要保存的内容/);
  rejects(() => validateRetroCasePatch({ revision: 1, title: "" }, NOW), /请填写案例标题/);
  rejects(() => validateRetroCasePatch({ revision: 1, background: 5 }, NOW), /任务与最初需求要是文字/);
});

test("the long-text fields use their own limits", () => {
  const at = (field: string, max: number) => {
    assert.ok(validateRetroCasePatch({ revision: 1, [field]: "字".repeat(max) }, NOW));
    assert.throws(() => validateRetroCasePatch({ revision: 1, [field]: "字".repeat(max + 1) }, NOW), RetroError);
  };
  at("background", 5000);
  at("outcome", 3000);
  at("turningPoints", 3000);
  at("discussionQuestions", 2000);
});

// ---------------------------------------------------------------------------
// 回合
// ---------------------------------------------------------------------------

test("round fields: title 1-40, time up to 40, three texts up to 5000", () => {
  const ok = validateRetroRoundPatch({ revision: 2, title: "比稿", occurredOn: "9 月中", deliveryText: "核心想法", feedbackText: "客户原话", responseText: "" });
  assert.equal(ok.revision, 2);
  assert.equal(ok.fields.title, "比稿");
  rejects(() => validateRetroRoundPatch({ revision: 1, title: "题".repeat(41) }), /回合标题最多 40/);
  rejects(() => validateRetroRoundPatch({ revision: 1, title: " " }), /请填写回合标题/);
  rejects(() => validateRetroRoundPatch({ revision: 1, occurredOn: "时".repeat(41) }), /回合时间最多 40/);
  rejects(() => validateRetroRoundPatch({ revision: 1, deliveryText: "字".repeat(5001) }), /我们交了什么最多 5000/);
  rejects(() => validateRetroRoundPatch({ revision: 1, feedbackText: "字".repeat(5001) }), /客户怎么反馈最多 5000/);
  rejects(() => validateRetroRoundPatch({ revision: 1, responseText: "字".repeat(5001) }), /我们怎么应对最多 5000/);
  rejects(() => validateRetroRoundPatch({ revision: 1 }), /没有要保存的内容/);
});

test("a new round defaults to 「第 N 版」 and the order must be exactly the live rounds", () => {
  assert.equal(validateRetroNewRoundTitle(null, "第 3 版"), "第 3 版");
  assert.equal(validateRetroNewRoundTitle({ title: "电话沟通" }, "第 3 版"), "电话沟通");
  rejects(() => validateRetroNewRoundTitle({ title: "" }, "第 3 版"), /请填写回合标题/);
  assert.deepEqual(validateRetroRoundOrder({ roundIds: ["b", "a"] }, ["a", "b"]), ["b", "a"]);
  rejects(() => validateRetroRoundOrder({ roundIds: ["a"] }, ["a", "b"]), /对不上/);
  rejects(() => validateRetroRoundOrder({ roundIds: ["a", "a"] }, ["a", "b"]), /对不上/);
  rejects(() => validateRetroRoundOrder({ roundIds: ["a", "c"] }, ["a", "b"]), /对不上/);
  rejects(() => validateRetroRoundOrder({}, ["a"]), /格式不对/);
});

// ---------------------------------------------------------------------------
// 附件
// ---------------------------------------------------------------------------

const asset = (originalName: string, extra: Record<string, unknown> = {}) => ({ roundId: null, originalName, contentType: "", fileSize: 1000, ...extra });

test("attachments are classified image / video / audio / document and everything else is refused with the hint", () => {
  const cases: Array<[string, string, string, string | null]> = [
    ["v1.png", "image/png", "IMAGE", null],
    ["照片.HEIC", "", "IMAGE", null],
    ["demo.mp4", "video/mp4", "VIDEO", null],
    ["客户电话.m4a", "", "AUDIO", null],
    ["brief.pdf", "application/pdf", "DOC", "PDF"],
    ["方案.docx", "", "DOC", "WORD"],
    ["预算.xlsx", "", "DOC", "EXCEL"],
    ["提案.key", "", "DOC", "PPT"],
  ];
  for (const [name, type, kind, format] of cases) {
    const [normalised] = validateRetroNewAssets({ assets: [asset(name, { contentType: type })] });
    assert.equal(normalised.type, kind, name);
    assert.equal(normalised.docFormat, format, name);
  }
  for (const name of ["动图.gif", "logo.svg", "压缩包.zip", "脚本.js", "无扩展名"]) {
    rejects(() => validateRetroNewAssets({ assets: [asset(name)] }), /支持图片、视频、音频，以及 PDF、Word、Excel、PPT 文档/);
  }
});

test("the browser's content type is stored untouched because the presigned PUT signs it", () => {
  const [plain] = validateRetroNewAssets({ assets: [asset("客户电话.m4a")] });
  assert.equal(plain.contentType, "application/octet-stream");
  const [typed] = validateRetroNewAssets({ assets: [asset("客户电话.m4a", { contentType: "audio/x-m4a" })] });
  assert.equal(typed.contentType, "audio/x-m4a");
});

test("attachment size, audio cap and batch size are checked", () => {
  rejects(() => validateRetroNewAssets({ assets: [asset("a.png", { fileSize: 0 })] }), /文件大小无效/);
  rejects(() => validateRetroNewAssets({ assets: [asset("a.mp3", { fileSize: 500 * 1024 * 1024 + 1 })] }), /500MB/);
  assert.ok(validateRetroNewAssets({ assets: [asset("a.mp3", { fileSize: 500 * 1024 * 1024 })] }));
  rejects(() => validateRetroNewAssets({ assets: [] }), /请先选择/);
  rejects(() => validateRetroNewAssets({}), /请先选择/);
  rejects(() => validateRetroNewAssets({ assets: Array.from({ length: 37 }, (_, i) => asset(`${i}.png`)) }), /一次最多/);
});

test("each owner (the need module, and each round) holds at most 12 attachments", () => {
  const label = (key: string) => (key === "NEED" ? "「任务与最初需求」" : `「${key}」`);
  const twelve = Array.from({ length: 12 }, () => ({ roundId: null }));
  assert.doesNotThrow(() => assertRetroAssetCapacity(new Map(), twelve, label));
  rejects(() => assertRetroAssetCapacity(new Map(), [...twelve, { roundId: null }], label), /「任务与最初需求」最多放 12 个/);
  rejects(() => assertRetroAssetCapacity(new Map([["r1", 11]]), [{ roundId: "r1" }, { roundId: "r1" }], label), /「r1」最多放 12 个附件，已经有 11 个/);
  // 别的归属不受影响。
  assert.doesNotThrow(() => assertRetroAssetCapacity(new Map([["r1", 12]]), [{ roundId: "r2" }], label));
});

test("keys live under retro/ and the open path depends on the type", () => {
  assert.equal(retroAssetOriginalKey("rtc_1", "rta_1", "客户电话.M4A"), "retro/cases/rtc_1/assets/rta_1/original.m4a");
  assert.equal(retroRecordingObjectKey("rtr_9"), "retro/recordings/rtr_9/original");
  assert.equal(retroAssetOpenPath("c", "a", "IMAGE"), "/api/retro-cases/c/assets/a/original");
  assert.equal(retroAssetOpenPath("c", "a", "DOC"), "/api/retro-cases/c/assets/a/original");
  assert.equal(retroAssetOpenPath("c", "a", "VIDEO"), "/api/retro-cases/c/assets/a/stream");
  assert.equal(retroAssetOpenPath("c", "a", "AUDIO"), "/api/retro-cases/c/assets/a/stream");
});

test("office documents download with an ASCII fallback and a UTF-8 file name", () => {
  const header = retroAttachmentDisposition("方案 v2.docx");
  assert.match(header, /^attachment; filename="__ v2\.docx"; filename\*=UTF-8''%E6%96%B9%E6%A1%88%20v2\.docx$/);
  assert.doesNotMatch(retroAttachmentDisposition('a";b.docx'), /filename="a";/);
});

// ---------------------------------------------------------------------------
// 关联作品
// ---------------------------------------------------------------------------

test("links are de-duplicated, limited to 6 and must name a known library", () => {
  const links = validateRetroLinks({ links: [{ kind: "VIDEO", targetId: "v1" }, { kind: "VIDEO", targetId: "v1" }, { kind: "REPORT", targetId: "r1" }] });
  assert.deepEqual(links, [{ kind: "VIDEO", targetId: "v1" }, { kind: "REPORT", targetId: "r1" }]);
  assert.deepEqual(validateRetroLinks({ links: [] }), []);
  const seven = Array.from({ length: 7 }, (_, i) => ({ kind: "VISUAL", targetId: `x${i}` }));
  rejects(() => validateRetroLinks({ links: seven }), /最多关联 6 个/);
  assert.equal(validateRetroLinks({ links: seven.slice(0, 6) }).length, 6);
  rejects(() => validateRetroLinks({ links: [{ kind: "BLOG", targetId: "x" }] }), /格式不对/);
  rejects(() => validateRetroLinks({ links: [{ kind: "VIDEO", targetId: "" }] }), /格式不对/);
  rejects(() => validateRetroLinks({}), /格式不对/);
});

// ---------------------------------------------------------------------------
// 点评录音
// ---------------------------------------------------------------------------

test("a review recording request normalises the audio type and enforces format and the 500MB cap", () => {
  const request = { monthKey: "2026-10", caseId: "rtc_1", fileName: "点评.m4a", contentType: "", sizeBytes: 1000 };
  assert.deepEqual(validateRetroRecordingRequest(request), { ...request, contentType: "audio/mp4" });
  assert.equal(validateRetroRecordingRequest({ ...request, caseId: null }).caseId, null);
  assert.equal(validateRetroRecordingRequest({ ...request, caseId: undefined }).caseId, null);
  rejects(() => validateRetroRecordingRequest({ ...request, monthKey: "2026/10" }), /复盘月份无效/);
  rejects(() => validateRetroRecordingRequest({ ...request, fileName: "" }), /缺少录音文件名/);
  rejects(() => validateRetroRecordingRequest({ ...request, fileName: "x.txt", contentType: "text/plain" }), /只能上传录音文件/);
  rejects(() => validateRetroRecordingRequest({ ...request, sizeBytes: 0 }), /大小无效/);
  rejects(() => validateRetroRecordingRequest({ ...request, sizeBytes: 500 * 1024 * 1024 + 1 }), /500MB/);
  assert.equal(validateRetroRecordingRequest({ ...request, sizeBytes: 500 * 1024 * 1024 }).sizeBytes, 500 * 1024 * 1024);
});

test("recording actions are UPLOADED, RETRY or REMOVE", () => {
  assert.equal(validateRetroRecordingAction({ action: "REMOVE" }), "REMOVE");
  rejects(() => validateRetroRecordingAction({ action: "ABANDON" }), /不支持的操作/);
  rejects(() => validateRetroRecordingAction(null), /不支持的操作/);
});

test("the part number is the smallest free one of 1..3, so a removed part can be reused, and a full set yields none", () => {
  assert.equal(nextRetroPartNo([]), 1);
  assert.equal(nextRetroPartNo([1]), 2);
  assert.equal(nextRetroPartNo([1, 2]), 3);
  assert.equal(nextRetroPartNo([2, 3]), 1);
  assert.equal(nextRetroPartNo([1, 3]), 2);
  assert.equal(nextRetroPartNo([1, 2, 3]), null);
});

test("the card badge: processing beats failed beats ready, uploading counts as processing", () => {
  assert.deepEqual(retroRecordingBadge([]), { state: "NONE" });
  assert.deepEqual(retroRecordingBadge([{ status: "UPLOADING", durationMs: null }]), { state: "PROCESSING" });
  assert.deepEqual(retroRecordingBadge([{ status: "READY", durationMs: 1000 }, { status: "TRANSCRIBING", durationMs: null }]), { state: "PROCESSING" });
  assert.deepEqual(retroRecordingBadge([{ status: "READY", durationMs: 1000 }, { status: "FAILED", durationMs: null }]), { state: "FAILED" });
  assert.deepEqual(
    retroRecordingBadge([{ status: "READY", durationMs: 1_000_000 }, { status: "READY", durationMs: 1_880_000 }]),
    { state: "READY", parts: 2, durationMs: 2_880_000 },
  );
});

// ---------------------------------------------------------------------------
// 权限
// ---------------------------------------------------------------------------

test("only the case uploader or an admin edits a case; 老孙 gets no exception", () => {
  const retroCase = { createdByUserId: "u-owner" };
  assert.equal(canEditRetroCase(retroCase, { userId: "u-owner", isAdmin: false }), true);
  assert.equal(canEditRetroCase(retroCase, { userId: "u-other", isAdmin: true }), true);
  assert.equal(canEditRetroCase(retroCase, { userId: "u-other", isAdmin: false }), false);
  assert.equal(canEditRetroCase(retroCase, { userId: "u-sun", isAdmin: false }), false);
});

test("a recording is removable by its uploader, the case uploader or an admin; a summary has no case uploader", () => {
  const recording = { uploadedByUserId: "u-up" };
  const retroCase = { createdByUserId: "u-owner" };
  assert.equal(canRemoveRetroRecording(recording, retroCase, { userId: "u-up", isAdmin: false }), true);
  assert.equal(canRemoveRetroRecording(recording, retroCase, { userId: "u-owner", isAdmin: false }), true);
  assert.equal(canRemoveRetroRecording(recording, retroCase, { userId: "u-x", isAdmin: true }), true);
  assert.equal(canRemoveRetroRecording(recording, retroCase, { userId: "u-x", isAdmin: false }), false);
  assert.equal(canRemoveRetroRecording(recording, null, { userId: "u-owner", isAdmin: false }), false);
  assert.equal(canRemoveRetroRecording(recording, null, { userId: "u-up", isAdmin: false }), true);
});

// ---------------------------------------------------------------------------
// 缺表
// ---------------------------------------------------------------------------

test("a missing retro_ table is recognised, any other missing relation is not", () => {
  const missing = (message: string, code = "42P01") => Object.assign(new Error(message), { code });
  assert.equal(isMissingRetroSchema(missing('relation "retro_cases" does not exist')), true);
  assert.equal(isMissingRetroSchema(missing('relation "public.retro_recordings" does not exist')), true);
  assert.equal(isMissingRetroSchema(missing('relation "videos" does not exist')), false);
  assert.equal(isMissingRetroSchema(missing('relation "audio_reviews" does not exist')), false);
  assert.equal(isMissingRetroSchema(missing('relation "retro_cases" does not exist', "42703")), false);
  assert.equal(isMissingRetroSchema(new Error('relation "retro_cases" does not exist')), false);
  assert.equal(isMissingRetroSchema(null), false);
  assert.equal(
    RETRO_MISSING_SCHEMA_MESSAGE,
    "客户需求复盘库的数据表尚未建立：请先在 Supabase 执行 web/db/migrations/2026-10-19-retro-library.sql",
  );
  assert.equal(isUniqueViolation({ code: "23505" }), true);
  assert.equal(isUniqueViolation(new Error("x")), false);
});

// ---------------------------------------------------------------------------
// 转写：热词、提供方选择、假实现
// ---------------------------------------------------------------------------

test("hotwords start with 老孙 and the uploader, skip default round titles, de-duplicate and stop at 128", () => {
  const words = buildRetroHotwords({
    uploaderName: "刘梦娜",
    clientNames: ["某某食品"],
    departments: ["创意部"],
    titles: ["年货节主视觉三次被否"],
    sceneTags: ["改稿", "客户情绪"],
    roundTitles: ["第 1 版", "比稿", "电话沟通"],
  });
  assert.deepEqual(words.slice(0, 4), ["老孙", "刘梦娜", "某某食品", "创意部"]);
  assert.ok(words.includes("改稿") && words.includes("比稿") && words.includes("电话沟通"));
  assert.ok(!words.some((word) => /^第\d+版$/.test(word)), "default round titles are noise");
  assert.ok(words.includes("视觉"), "multi-character title words are included (single characters are not)");
  assert.ok(!words.includes("年"), "single characters make poor hotwords");
  assert.equal(new Set(words).size, words.length);

  const many = buildRetroHotwords({
    uploaderName: "上传人",
    clientNames: Array.from({ length: 200 }, (_, i) => `客户名${i}`),
    departments: [],
    titles: [],
    sceneTags: [],
    roundTitles: [],
  });
  assert.equal(many.length, 128);
  // 超长的热词腾讯云不收（最多 10 个汉字）。
  assert.ok(!buildRetroHotwords({ uploaderName: "x", clientNames: ["超长的客户名称一二三四五六七八"], departments: [], titles: [], sceneTags: [], roundTitles: [] }).includes("超长的客户名称一二三四五六七八"));
});

test("RETRO_AI_PROVIDER picks the fake, defaulting to it in local demo mode", () => {
  assert.equal(resolveRetroAiProvider({ RETRO_AI_PROVIDER: "fake" }, false), "fake");
  assert.equal(resolveRetroAiProvider({ RETRO_AI_PROVIDER: "FAKE" }, false), "fake");
  assert.equal(resolveRetroAiProvider({}, true), "fake");
  assert.equal(resolveRetroAiProvider({}, false), "real");
  assert.equal(resolveRetroAiProvider({ RETRO_AI_PROVIDER: "real" }, true), "real");
});

test("the fake ASR returns the built-in transcript on the second poll, per recording kind", async () => {
  let now = 1_000_000;
  const asr = createFakeRetroAsr(() => now);
  for (const [kind, minSegments, speakers] of [["REVIEW", 20, 3], ["CLIENT", 10, 2], ["SUMMARY", 5, 1]] as const) {
    const submitted = await asr.submit({ audioUrl: "http://x", hotwordList: "", kind });
    assert.ok(submitted.ok);
    if (!submitted.ok) return;
    now += 1_500;
    assert.deepEqual(await asr.describe(submitted.taskId), { kind: "PENDING", status: 1 }, `${kind} first poll`);
    now += 1_500;
    const done = await asr.describe(submitted.taskId);
    assert.equal(done.kind, "SUCCESS", `${kind} second poll`);
    if (done.kind !== "SUCCESS") return;
    assert.ok(done.segments.length >= minSegments, `${kind} has ${done.segments.length} segments`);
    assert.equal(new Set(done.segments.map((segment) => segment.speakerId)).size, speakers);
    assert.deepEqual(done.segments.map((segment) => segment.id), done.segments.map((_, index) => index + 1));
    for (const segment of done.segments) assert.ok(segment.endMs > segment.startMs && segment.text.length > 0);
    assert.equal(done.durationMs, fakeRetroTranscript(kind).durationMs);
  }
  assert.equal((await asr.describe("garbage")).kind, "FAILED");
});

test("the fake review transcript has the founder asking why the client made the request", () => {
  const text = fakeRetroTranscript("REVIEW").segments.filter((segment) => segment.speakerId === "S0").map((segment) => segment.text).join("");
  assert.match(text, /为什么提这个要求/);
  assert.match(text, /这个是我的判断|经验/);
});

test("a transcribing row is advanced only when its lease is free", () => {
  const now = Date.parse("2026-10-19T08:00:00.000Z");
  assert.equal(shouldAdvanceRetroTranscription({ status: "TRANSCRIBING", lease_until: null }, now), true);
  assert.equal(shouldAdvanceRetroTranscription({ status: "TRANSCRIBING", lease_until: new Date(now - 1000) }, now), true);
  assert.equal(shouldAdvanceRetroTranscription({ status: "TRANSCRIBING", lease_until: new Date(now + 1000) }, now), false);
  assert.equal(shouldAdvanceRetroTranscription({ status: "READY", lease_until: null }, now), false);
  assert.equal(shouldAdvanceRetroTranscription({ status: "FAILED", lease_until: null }, now), false);
});
