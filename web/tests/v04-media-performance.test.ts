import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createV04MetadataQueue,
  shouldDockV04DetailPlayer,
  V04_DETAIL_DOCK_HEADER_OFFSET,
} from "../lib/v04-media-loading.ts";
import { CosVideoBucket } from "../storage/cos.ts";

const readProjectFile = (relative: string) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushTasks() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("authenticated V0.4 media route redirects an exact READY object to short-lived COS", async () => {
  const source = await readProjectFile("app/api/videos/[id]/stream/route.ts");

  const authIndex = source.indexOf("requireApiUser(request)");
  const queryIndex = source.indexOf("FROM videos v");
  const signIndex = source.indexOf("createPresignedGetUrl(objectKey");
  assert.ok(authIndex >= 0 && authIndex < queryIndex && queryIndex < signIndex);
  assert.match(source, /v\.id = \? AND v\.deleted_at IS NULL/);
  assert.match(source, /video\.status !== "READY"/);
  assert.match(source, /download[\s\S]*status: 403/);
  assert.match(source, /asset && asset !== "thumbnail"/);
  assert.match(source, /PLAYBACK_URL_TTL_SECONDS = 15 \* 60/);
  assert.match(source, /status: 307/);
  assert.match(source, /Location: location/);
  assert.match(source, /Cache-Control": "private, max-age=300, no-transform/);
  assert.doesNotMatch(source, /bucket\.head\(/);
  assert.doesNotMatch(source, /bucket\.get\(/);
  assert.doesNotMatch(source, /Content-Range/);
});

test("short COS playback signature remains object-scoped and permits browser Range headers", async () => {
  const bucket = new CosVideoBucket({
    region: "ap-shanghai",
    bucket: "hamark-videos-1250000000",
    secretId: "test-only-secret-id",
    secretKey: "test-only-secret-key",
    endpoint: "https://cos.ap-shanghai.myqcloud.com",
  });
  const url = await bucket.createPresignedGetUrl("videos/video_fixed/original", {
    expiresInSeconds: 15 * 60,
    now: new Date("2026-08-22T00:00:00Z"),
  });
  const parsed = new URL(url);
  const [start, end] = (parsed.searchParams.get("q-sign-time") ?? "").split(";").map(Number);

  assert.equal(parsed.pathname, "/videos/video_fixed/original");
  assert.equal(end - start, 15 * 60);
  assert.equal(parsed.searchParams.get("q-header-list"), "host");
  assert.equal(parsed.searchParams.get("q-url-param-list"), "");
  assert.match(parsed.searchParams.get("q-signature") ?? "", /^[a-f0-9]{40}$/);
});

test("V0.4 detail and workspace player reuse the real thumbnail as poster", async () => {
  const [readModels, uiModel, player] = await Promise.all([
    readProjectFile("lib/v04-read-models.ts"),
    readProjectFile("lib/v04-ui-model.ts"),
    readProjectFile("components/v04/V04VideoPlayer.tsx"),
  ]);

  assert.match(readModels, /posterPath:[\s\S]*stream\?asset=thumbnail/);
  assert.match(uiModel, /posterPath: video\.thumbnailUrl/);
  assert.match(player, /poster=\{media\?\.posterPath \?\? undefined\}/);
  assert.match(player, /preload="metadata"/);
});

test("library does not fan out metadata requests before explicit card intent", async () => {
  const library = await readProjectFile("components/v04/V04LibraryClient.tsx");

  assert.doesNotMatch(library, /IntersectionObserver/);
  assert.doesNotMatch(library, /rootMargin/);
  assert.match(library, /addEventListener\("pointerenter", load/);
  assert.match(library, /addEventListener\("focusin", load/);
  assert.match(library, /v04MetadataQueue\.schedule/);
  assert.match(library, /removeAttribute\("src"\)/);
});

test("library metadata queue is FIFO, single-concurrency and cancellable", async () => {
  const queue = createV04MetadataQueue(1);
  const first = deferred();
  const second = deferred();
  const events: string[] = [];

  queue.schedule(async () => {
    events.push("first:start");
    await first.promise;
    events.push("first:end");
  });
  queue.schedule(async () => {
    events.push("second:start");
    await second.promise;
    events.push("second:end");
  });
  await flushTasks();
  assert.deepEqual(events, ["first:start"]);

  first.resolve();
  await flushTasks();
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
  second.resolve();
  await flushTasks();

  const blocked = deferred();
  const cancelQueue = createV04MetadataQueue(1);
  let pendingRan = false;
  cancelQueue.schedule(async (signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      blocked.promise.then(resolve);
    });
  });
  const cancelPending = cancelQueue.schedule(async () => { pendingRan = true; });
  cancelPending();
  await flushTasks();
  blocked.resolve();
  await flushTasks();
  assert.equal(pendingRan, false);
});

test("只读成果页的播放器在顶部展示位滚出视野后收进右下角", () => {
  const heroHeight = 700;

  // 展示位还完整停在顶栏下方：留在页面顶部的大画面。
  assert.equal(shouldDockV04DetailPlayer(120, heroHeight), false);
  // 只剩不到四成露在顶栏下方：收进右下角。
  assert.equal(shouldDockV04DetailPlayer(V04_DETAIL_DOCK_HEADER_OFFSET - heroHeight * 0.4 - 1, heroHeight), true);
  // 往回滚一像素就回到展示位，判定没有死区。
  assert.equal(shouldDockV04DetailPlayer(V04_DETAIL_DOCK_HEADER_OFFSET - heroHeight * 0.4 + 1, heroHeight), false);
  // 展示位整个滚过去之后当然保持收起。
  assert.equal(shouldDockV04DetailPlayer(-heroHeight, heroHeight), true);
});

test("只读成果页收起播放器时原地留出占位，工作稿页仍是常驻浮窗", async () => {
  const player = await readProjectFile("components/v04/V04VideoPlayer.tsx");

  assert.match(player, /shouldDockV04DetailPlayer/);
  assert.match(player, /const dockable = surface === "detail" && !video\.floating/);
  assert.match(player, /const floating = surface === "workspace" \|\| video\.floating \|\| docked/);
  // 收起后仍按当前宽度把展示位的高度留在原地，正文不会因为收起而上跳。
  assert.match(player, /slot\.style\.height = next \? `\$\{heroHeight\}px` : ""/);
  assert.match(player, /addEventListener\("scroll", schedule, \{ passive: true \}\)/);
  assert.match(player, /addEventListener\("resize", schedule\)/);
  assert.match(player, /removeEventListener\("scroll", schedule\)/);
  assert.match(player, /cancelAnimationFrame\(frame\)/);
});
