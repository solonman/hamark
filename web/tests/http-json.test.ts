import assert from "node:assert/strict";
import test from "node:test";
import { readJsonResponse } from "../lib/http-json.ts";

test("core fetch diagnostics parse JSON without changing API errors", async () => {
  const value = await readJsonResponse<{ error: string }>(
    Response.json({ error: "服务端业务错误" }, { status: 409 }),
    "作品读取",
  );
  assert.equal(value.error, "服务端业务错误");
});

test("core fetch diagnostics explain an empty server response in Chinese", async () => {
  await assert.rejects(
    readJsonResponse(new Response(null, { status: 500 }), "作品读取"),
    /作品读取失败：服务器返回了空响应（HTTP 500）/,
  );
});

test("core fetch diagnostics explain a non-JSON server response in Chinese", async () => {
  await assert.rejects(
    readJsonResponse(new Response("upstream failure", { status: 502 }), "视频上传"),
    /视频上传失败：服务器返回了无法识别的响应（HTTP 502）/,
  );
});
