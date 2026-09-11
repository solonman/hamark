import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmVideoUpload,
  UploadConfirmationError,
} from "../app/components/confirm-video-upload.ts";
import { uploadCompletionFailure } from "../lib/upload-completion-failure.ts";
import { CosVideoBucket } from "../storage/cos.ts";

function scriptedFetch(outcomes: Array<Response | Error>) {
  const calls: Array<{ url: string; method?: string }> = [];
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    const next = outcomes.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { send, calls };
}

const noWait = async () => undefined;

test("a blip on the confirmation step is retried in place instead of recreating the entry", async () => {
  const { send, calls } = scriptedFetch([
    new Response(null, { status: 500 }),
    Response.json({ ok: true, videoId: "video_1" }),
  ]);
  const waits: number[] = [];
  const result = await confirmVideoUpload("video_1", {
    fetch: send,
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.equal(result, "confirmed");
  assert.deepEqual(calls, [
    { url: "/api/videos/video_1/complete", method: "POST" },
    { url: "/api/videos/video_1/complete", method: "POST" },
  ]);
  assert.deepEqual(waits, [1000]);
});

test("a dropped connection is retried too", async () => {
  const { send, calls } = scriptedFetch([
    new TypeError("Failed to fetch"),
    Response.json({ ok: true }),
  ]);
  assert.equal(await confirmVideoUpload("video_1", { fetch: send, wait: noWait }), "confirmed");
  assert.equal(calls.length, 2);
});

test("after the retry budget the failure stays retryable so the dialog only re-confirms", async () => {
  const { send, calls } = scriptedFetch([
    new Response(null, { status: 500 }),
    new Response(null, { status: 502 }),
    new Response(null, { status: 500 }),
  ]);
  await assert.rejects(
    confirmVideoUpload("video_1", { fetch: send, wait: noWait }),
    (error) => {
      assert(error instanceof UploadConfirmationError);
      assert.equal(error.retryable, true);
      assert.match(error.message, /确认视频上传完成失败：服务器返回了空响应（HTTP 500）/);
      return true;
    },
  );
  assert.equal(calls.length, 3);
});

test("a server-side rejection is not retried and tells the dialog to start over", async () => {
  const { send, calls } = scriptedFetch([
    Response.json({ error: "未检测到已上传的视频文件，请重试。" }, { status: 409 }),
  ]);
  await assert.rejects(
    confirmVideoUpload("video_1", { fetch: send, wait: noWait }),
    (error) => {
      assert(error instanceof UploadConfirmationError);
      assert.equal(error.retryable, false);
      assert.equal(error.message, "未检测到已上传的视频文件，请重试。");
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("an expired session is handed back for the login redirect without retrying", async () => {
  const { send, calls } = scriptedFetch([new Response(null, { status: 401 })]);
  assert.equal(await confirmVideoUpload("video_1", { fetch: send, wait: noWait }), "unauthorized");
  assert.equal(calls.length, 1);
});

async function quietly<T>(operation: () => Promise<T>) {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await operation();
  } finally {
    console.error = original;
  }
}

test("a COS outage during confirmation comes back as readable JSON, not an empty 500", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
  let storageError: unknown;
  try {
    await new CosVideoBucket({
      region: "ap-guangzhou",
      bucket: "hamark-videos-1250000000",
      secretId: "test-only-secret-id",
      secretKey: "test-only-secret-key",
      endpoint: "https://cos.ap-guangzhou.myqcloud.com",
    }).head("videos/test-only/original");
  } catch (error) {
    storageError = error;
  } finally {
    globalThis.fetch = original;
  }
  assert(storageError, "COS HEAD must throw on a 503 rather than report the file missing");

  const response = await quietly(async () => uploadCompletionFailure("video_1", storageError));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.retryable, true);
  assert.match(body.error, /暂时连不上视频存储/);
  assert.doesNotMatch(body.error, /videos\/|test-only|https?:/);
});

test("a database failure during confirmation also comes back as readable JSON", async () => {
  const response = await quietly(async () =>
    uploadCompletionFailure("video_1", new Error("Connection terminated due to connection timeout")));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.retryable, true);
  assert.match(body.error, /入库记录暂时没写进去/);
  assert.doesNotMatch(body.error, /Connection terminated/);
});
