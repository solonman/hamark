import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createV04UiApiClient, V04UiApiError } from "../lib/v04-ui-api-client.ts";

test("V0.4 UI client sends same-origin no-store requests and stable request proofs", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const api = createV04UiApiClient(async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({ ok: true });
  });
  await api.save("video /一", { changes: [] }, "tab-proof");
  await api.submit("video /一", { lease: {} }, "submit-key", "tab-proof");
  await api.cards(["video /一", "视频二"], "tab-proof");
  assert.equal(calls[0].url, "/api/videos/video%20%2F%E4%B8%80/analysis/v04/workspace");
  assert.equal(calls[0].init?.credentials, "same-origin");
  assert.equal(calls[0].init?.cache, "no-store");
  assert.equal(new Headers(calls[0].init?.headers).get("x-v04-tab-token"), "tab-proof");
  assert.equal(new Headers(calls[1].init?.headers).get("idempotency-key"), "submit-key");
  assert.match(new Headers(calls[0].init?.headers).get("x-request-id") ?? "", /^v04-ui-/);
  assert.equal(calls[2].url, "/api/videos/analysis/v04/cards?videoId=video+%2F%E4%B8%80&videoId=%E8%A7%86%E9%A2%91%E4%BA%8C");
  assert.equal(new Headers(calls[2].init?.headers).get("x-v04-tab-token"), "tab-proof");
});

test("V0.4 UI client turns empty and non-JSON failures into diagnostic errors", async () => {
  const empty = createV04UiApiClient(async () => new Response(null, { status: 500 }));
  await assert.rejects(empty.cards(), (error: unknown) => {
    assert(error instanceof V04UiApiError);
    assert.equal(error.code, "HTTP_ERROR");
    assert.match(error.message, /未返回错误详情/);
    return true;
  });
  const html = createV04UiApiClient(async () => new Response("<html>failure</html>", { status: 500 }));
  await assert.rejects(html.cards(), (error: unknown) => {
    assert(error instanceof V04UiApiError);
    assert.equal(error.code, "HTTP_ERROR");
    assert.doesNotMatch(error.message, /html|failure/i);
    return true;
  });
  const conflict = createV04UiApiClient(async () => Response.json({ error: { code: "REVISION_CONFLICT", message: "版本冲突", requestId: "req-1", details: { serverRevision: 4 } } }, { status: 409 }));
  await assert.rejects(conflict.cards(), (error: unknown) => {
    assert(error instanceof V04UiApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "REVISION_CONFLICT");
    assert.equal(error.requestId, "req-1");
    assert.deepEqual(error.details, { serverRevision: 4 });
    return true;
  });
});

test("all V0.4 GET adapters are no-store and shadow pages no longer load case fixtures", () => {
  const roots = [
    "../app/api/videos/analysis/v04/cards/route.ts",
    "../app/api/videos/[id]/analysis/v04/route.ts",
    "../app/api/videos/[id]/analysis/v04/workspace/route.ts",
    "../app/api/videos/[id]/analysis/v04/submissions/route.ts",
    "../app/api/videos/[id]/analysis/v04/history/route.ts",
    "../app/api/videos/[id]/analysis/v04/comments/route.ts",
  ];
  for (const path of roots) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /Cache-Control["'],\s*["']no-store/);
  }
  for (const path of [
    "../app/v04-shadow/page.tsx",
    "../app/v04-shadow/videos/[id]/page.tsx",
    "../app/v04-shadow/videos/[id]/workspace/page.tsx",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /getV04UiCase|V04_UI_CASES/);
  }
});
