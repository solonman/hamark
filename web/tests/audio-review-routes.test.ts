// 录音点评路由：读源码断言检查顺序（同源 → 登录 → 老孙 → 业务）、maxDuration、after() 推进、
// 错误信封与 503，以及访问闸门认得 /audio-reviews 路径。导入路由模块会在加载时拉起 @/db，
// 所以同 tests/agent-api.test.ts 的做法按文本断言。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { v04GrayVideoIdFromRequest } from "../lib/v04-gray-access";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const codeOnly = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const ROUTES = {
  create: "../app/api/videos/[id]/audio-reviews/route.ts",
  review: "../app/api/videos/[id]/audio-reviews/[reviewId]/route.ts",
  audio: "../app/api/videos/[id]/audio-reviews/[reviewId]/audio/route.ts",
};

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
  assert.ok(start >= 0, name);
  const next = text.indexOf("export ", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

test("every audio review route runs for up to 300 s", async () => {
  for (const path of Object.values(ROUTES)) {
    assert.match(codeOnly(await source(path)), /export const maxDuration = 300;/, path);
  }
});

test("the shared shell checks same-origin before login and only then runs the business code", async () => {
  const api = codeOnly(await source("../lib/v04-api.ts"));
  inOrder(handler(api, "requireV04Actor"), ["requireSameOriginMutation(request)", "getCurrentUserFromRequest(request)", "auth_sessions"]);
  inOrder(handler(api, "v04Route"), ["requireV04Actor(request, options)", "operation(access.actor, access.requestId)"]);
  const shell = codeOnly(await source("../lib/audio-review/route.ts"));
  inOrder(shell, ["v04Route(request, { mutation: options.mutation }", "operation({ actor, requestId, startedAt })"]);
});

test("POST create: same-origin + login (mutation shell) → 老孙 → configured → business", async () => {
  const code = handler(codeOnly(await source(ROUTES.create)), "POST");
  inOrder(code, [
    "audioReviewRoute(request, { mutation: true }",
    "isCaseReviewer(actor.displayName)",
    "readAudioReviewConfig().configured",
    "readJsonBody(request)",
    "createAudioReview(",
  ]);
  assert.match(code, /new AudioReviewError\(403, "FORBIDDEN"/);
  assert.match(code, /new AudioReviewError\(503, "AUDIO_REVIEW_NOT_CONFIGURED"/);
  assert.match(code, /status: 201/);
});

test("POST action: mutation shell → 老孙 → body → service; advancing is scheduled after the response", async () => {
  const code = handler(codeOnly(await source(ROUTES.review)), "POST");
  inOrder(code, [
    "audioReviewRoute(request, { mutation: true }",
    "isCaseReviewer(actor.displayName)",
    "readJsonBody(request)",
    "runAudioReviewAction(",
    "scheduleAudioReviewAdvance(",
  ]);
  assert.match(code, /new AudioReviewError\(403, "FORBIDDEN"/);
  assert.match(code, /reviewVersionId: result\.reviewVersionId/);
});

test("GET review and GET audio: read shell → visibility check before anything is returned", async () => {
  const review = handler(codeOnly(await source(ROUTES.review)), "GET");
  inOrder(review, [
    "audioReviewRoute(request, { mutation: false }",
    "loadAudioReviewForViewer(",
    "shouldAdvanceAudioReview(row, Date.now())",
    "scheduleAudioReviewAdvance(",
    "toAudioReviewView(",
  ]);
  const audio = handler(codeOnly(await source(ROUTES.audio)), "GET");
  inOrder(audio, [
    "audioReviewRoute(request, { mutation: false }",
    "loadAudioReviewForViewer(",
    "createPresignedGetUrl(",
    "status: 307",
  ]);
  assert.match(audio, /expiresInSeconds: AUDIO_REVIEW_AUDIO_URL_TTL_SECONDS/);
  assert.match(audio, /"Cache-Control": "no-store"/);
});

test("the shell answers with the v04 error envelope, 503 for a missing migration, no-store, and advances via after()", async () => {
  const shell = codeOnly(await source("../lib/audio-review/route.ts"));
  assert.match(shell, /import \{ after \} from "next\/server"/);
  assert.match(shell, /after\(async \(\) =>/);
  assert.match(shell, /deadline: startedAt \+ AUDIO_REVIEW_DEADLINE_MS/);
  assert.match(shell, /isMissingAudioReviewSchema\(error\)/);
  assert.match(shell, /"AUDIO_REVIEW_NOT_READY", AUDIO_REVIEW_MISSING_SCHEMA_MESSAGE, requestId\),\s*\{ status: 503 \}/);
  assert.match(shell, /response\.headers\.set\("Cache-Control", "no-store"\)/);
  const errors = codeOnly(await source("../lib/audio-review/errors.ts"));
  assert.match(errors, /return \{ error: \{ code, message, requestId \} \};/);
});

test("the studio read fills audioReviews and audioReviewAvailable from the pipeline (degrading when unmigrated)", async () => {
  const v19 = codeOnly(await source("../app/api/videos/[id]/analysis/v19/route.ts"));
  assert.match(v19, /loadAudioReviewStudioState\(db, id, actor, readAudioReviewConfig\(\)\)/);
  assert.match(v19, /audioReviews: audioReview\.audioReviews/);
  assert.match(v19, /audioReviewAvailable: audioReview\.audioReviewAvailable/);
  assert.doesNotMatch(v19, /audioReviews: \[\]/);
});

test("the access gate reads the case id from /audio-reviews paths, so the routes are not refused as unidentifiable", () => {
  const read = (path: string) => v04GrayVideoIdFromRequest(new Request(`https://example.test${path}`));
  assert.equal(read("/api/videos/video_1/audio-reviews"), "video_1");
  assert.equal(read("/api/videos/video_1/audio-reviews/arv_1"), "video_1");
  assert.equal(read("/api/videos/video_1/audio-reviews/arv_1/audio"), "video_1");
  assert.equal(read("/api/videos/video%20a/audio-reviews"), "video a");
  assert.equal(read("/api/videos/video_1/analysis/v19"), "video_1");
  assert.equal(read("/api/videos/video_1/audio-reviewsx"), undefined);
  assert.equal(read("/api/videos/video_1/stream"), undefined);
});
