// 客户需求复盘库路由的门禁顺序断言（docs/26 九）：读源码，不接真数据库（同 tests/visual-routes.test.ts、
// tests/audio-review-routes.test.ts 的做法）。检查顺序同源 → 登录 → 开关 → 业务，由共用外壳 lib/retro/route.ts 保证；
// 每个路由都必须走这个外壳，写操作声明 mutation: true，会调外部服务（存储、转写）的写 maxDuration = 300。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const codeOnly = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const CASES = "app/api/retro-cases";
const RECORDINGS = "app/api/retro-recordings";

type RouteSpec = { file: string; methods: Array<{ name: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; mutation: boolean }>; external: boolean };

const ROUTES: RouteSpec[] = [
  { file: `${CASES}/route.ts`, methods: [{ name: "GET", mutation: false }, { name: "POST", mutation: true }], external: true },
  { file: `${CASES}/[id]/route.ts`, methods: [{ name: "GET", mutation: false }, { name: "PATCH", mutation: true }], external: true },
  { file: `${CASES}/[id]/trash/route.ts`, methods: [{ name: "POST", mutation: true }], external: false },
  { file: `${CASES}/[id]/restore/route.ts`, methods: [{ name: "POST", mutation: true }], external: false },
  { file: `${CASES}/[id]/rounds/route.ts`, methods: [{ name: "POST", mutation: true }], external: false },
  { file: `${CASES}/[id]/rounds/[roundId]/route.ts`, methods: [{ name: "PATCH", mutation: true }, { name: "DELETE", mutation: true }], external: false },
  { file: `${CASES}/[id]/rounds/[roundId]/links/route.ts`, methods: [{ name: "PUT", mutation: true }], external: true },
  { file: `${CASES}/[id]/round-order/route.ts`, methods: [{ name: "PATCH", mutation: true }], external: false },
  { file: `${CASES}/[id]/assets/route.ts`, methods: [{ name: "POST", mutation: true }], external: false },
  { file: `${CASES}/[id]/assets/complete/route.ts`, methods: [{ name: "POST", mutation: true }], external: true },
  { file: `${CASES}/[id]/assets/[assetId]/route.ts`, methods: [{ name: "DELETE", mutation: true }], external: true },
  { file: `${CASES}/[id]/assets/[assetId]/upload-url/route.ts`, methods: [{ name: "POST", mutation: true }], external: true },
  { file: `${CASES}/[id]/assets/[assetId]/stream/route.ts`, methods: [{ name: "GET", mutation: false }], external: true },
  { file: `${CASES}/[id]/assets/[assetId]/transcript/route.ts`, methods: [{ name: "GET", mutation: false }, { name: "POST", mutation: true }], external: true },
  { file: `${RECORDINGS}/route.ts`, methods: [{ name: "POST", mutation: true }], external: true },
  { file: `${RECORDINGS}/[id]/route.ts`, methods: [{ name: "GET", mutation: false }, { name: "POST", mutation: true }], external: true },
  { file: `${RECORDINGS}/[id]/audio/route.ts`, methods: [{ name: "GET", mutation: false }], external: true },
];

function inOrder(text: string, markers: string[]) {
  let cursor = -1;
  for (const marker of markers) {
    const at = text.indexOf(marker, cursor + 1);
    assert.ok(at > cursor, `"${marker}" should come after the previous check`);
    cursor = at;
  }
}

/** 取出某个导出函数的函数体（到下一个 export 为止）。 */
function handler(text: string, name: string) {
  const start = text.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `expected an exported ${name} handler`);
  const next = text.indexOf("\nexport ", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

test("every route is covered by this test (no route file escapes the shell check)", async () => {
  const { globSync } = await import("node:fs");
  const files = [...globSync(`${CASES}/**/route.ts`, { cwd: new URL("..", import.meta.url) }), ...globSync(`${RECORDINGS}/**/route.ts`, { cwd: new URL("..", import.meta.url) })]
    .map((file) => file.replaceAll("\\", "/"))
    .sort();
  assert.deepEqual(files, ROUTES.map((route) => route.file).sort());
});

for (const route of ROUTES) {
  test(`${route.file}: every handler runs inside retroRoute with the right mutation flag`, async () => {
    const text = codeOnly(await source(`../${route.file}`));
    for (const method of route.methods) {
      const body = handler(text, method.name);
      assert.ok(
        body.includes(`return retroRoute(request, { mutation: ${method.mutation} }`),
        `${route.file} ${method.name} should call retroRoute(request, { mutation: ${method.mutation} })`,
      );
      // 业务代码都在外壳的回调里：外壳之前不能有任何别的语句。
      assert.match(body, /\{\s*return retroRoute\(/, `${route.file} ${method.name} must start with retroRoute`);
    }
    if (route.external) assert.match(text, /export const maxDuration = 300;/, `${route.file} calls external services`);
    // 没有哪个路由自己去读开关、会话或身份，统一交给外壳。
    assert.doesNotMatch(text, /isRetroFeatureEnabled|requireApiUser|requireSameOriginMutation/, route.file);
  });
}

test("the shell checks same-origin → login → feature switch → business, in that order", async () => {
  const api = codeOnly(await source("../lib/v04-api.ts"));
  inOrder(handler(api, "requireV04Actor"), ["requireSameOriginMutation(request)", "getCurrentUserFromRequest(request)", "auth_sessions"]);
  inOrder(handler(api, "v04Route"), ["requireV04Actor(request, options)", "operation(access.actor, access.requestId)"]);
  const shell = codeOnly(await source("../lib/retro/route.ts"));
  inOrder(shell, [
    "v04Route(request, { mutation: options.mutation, requireFeature: false }",
    "isRetroFeatureEnabled()",
    "operation({ actor, viewer: await loadRetroViewer(actor), requestId, startedAt })",
  ]);
  // 不要求 V0.4 工作流灰度，开关关着回 404，缺表回 503 并写明迁移文件。
  assert.match(shell, /status: 404/);
  assert.match(shell, /isMissingRetroSchema\(error\)[\s\S]*status: 503/);
  assert.match(shell, /RETRO_MISSING_SCHEMA_MESSAGE/);
  assert.match(shell, /Cache-Control", "no-store"/);
});

test("write routes after() schedule transcription and image derivatives instead of waiting for them", async () => {
  const complete = codeOnly(await source(`../${CASES}/[id]/assets/complete/route.ts`));
  assert.match(complete, /scheduleRetroTranscription\("ASSET", assetId, "CLIENT", startedAt\)/);
  assert.match(complete, /scheduleRetroDerivativesForCase/);
  const recording = codeOnly(await source(`../${RECORDINGS}/[id]/route.ts`));
  assert.match(recording, /shouldAdvanceRetroTranscription\(row, Date\.now\(\)\)/);
  assert.match(recording, /if \(result\.advance\) scheduleRetroTranscription\("RECORDING"/);
  const shell = codeOnly(await source("../lib/retro/route.ts"));
  assert.match(shell, /after\(async \(\) => \{[\s\S]*advanceRetroTranscription\([\s\S]*startedAt \+ RETRO_TRANSCRIBE_DEADLINE_MS/);
});

test("stream redirects with 302, the recording audio with 307; there is no original/download route", async () => {
  assert.match(codeOnly(await source(`../${CASES}/[id]/assets/[assetId]/stream/route.ts`)), /status: 302/);
  await assert.rejects(source(`../${CASES}/[id]/assets/[assetId]/original/route.ts`), "no download path, same as the video and report libraries");
  assert.match(codeOnly(await source(`../${RECORDINGS}/[id]/audio/route.ts`)), /status: 307/);
});

test("creating a case also creates the empty 「第 1 版」 round in the same transaction", async () => {
  const cases = codeOnly(await source("../lib/retro/cases.ts"));
  const create = cases.slice(cases.indexOf("export async function createRetroCase"), cases.indexOf("export async function listRetroLibrary"));
  inOrder(create, ["db.withTransaction", "INSERT INTO retro_cases", "INSERT INTO retro_case_rounds", "第 1 版"]);
});

test("case and recording services only touch their own tables; month results go through the month-ai seam", async () => {
  for (const file of ["cases", "rounds", "assets", "recordings", "views", "case-head", "transcription"]) {
    const text = codeOnly(await source(`../lib/retro/${file}.ts`));
    assert.doesNotMatch(text, /retro_month_jobs|retro_month_publications|retro_method_candidates/, `${file}.ts must not read the month pipeline tables`);
  }
  const cases = codeOnly(await source("../lib/retro/cases.ts"));
  assert.match(cases, /loadRetroMonthBadges\(db, monthKeys\)/);
  assert.match(cases, /loadRetroCaseInMinutes\(db, row\.id, row\.month_key\)/);
});

test("the revision lock is part of the UPDATE, not only a pre-check", async () => {
  const cases = codeOnly(await source("../lib/retro/cases.ts"));
  assert.match(cases, /UPDATE retro_cases SET \$\{assignments\.join\(", "\)\}, revision = revision \+ 1[\s\S]*WHERE id = \? AND revision = \?/);
  const rounds = codeOnly(await source("../lib/retro/rounds.ts"));
  assert.match(rounds, /UPDATE retro_case_rounds SET \$\{assignments\.join\(", "\)\}, revision = revision \+ 1[\s\S]*AND revision = \?/);
});

test("removing an asset deletes the row and every object key; removing a recording only flags it", async () => {
  const assets = codeOnly(await source("../lib/retro/assets.ts"));
  assert.match(assets, /DELETE FROM retro_case_assets WHERE id = \? AND case_id = \?/);
  for (const key of ["target.object_key", "retroAssetCoverKey", "retroAssetThumbKey", "retroAssetDisplayKey"]) assert.ok(assets.includes(key), key);
  const recordings = codeOnly(await source("../lib/retro/recordings.ts"));
  assert.match(recordings, /SET status = 'REMOVED', removed_at = now\(\)/);
  assert.doesNotMatch(recordings, /DELETE FROM retro_recordings|bucket\.delete|\.delete\(/);
});

test("the shared transcription code serves both tables and uses a lease", async () => {
  const text = codeOnly(await source("../lib/retro/transcription.ts"));
  assert.match(text, /table: "retro_recordings"[\s\S]*table: "retro_case_assets"/);
  assert.match(text, /lease_until = date_trunc\('milliseconds', now\(\) \+ interval/);
  assert.match(text, /AND \(lease_until IS NULL OR lease_until < now\(\)\)/);
  assert.match(text, /\$\{spec\.statusColumn\} = 'TRANSCRIBING'/);
});
