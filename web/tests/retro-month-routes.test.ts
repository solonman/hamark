// /api/retro-months/** 的检查顺序（docs/26 九）：读源码断言，不接真数据库（导入路由会拉起 @/db）。
// 每个处理函数第一句是开关检查；写操作先同源、再登录、再判老孙，然后才是业务；接力接口不认登录态，
// 只认令牌；会推进的路由 maxDuration = 300。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const codeOnly = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*/gm, "");

const ROOT = "app/api/retro-months/[month]";
type Spec = { file: string; method: "GET" | "POST" | "PATCH"; kind: "read" | "reviewer" | "relay"; maxDuration: boolean };
const ROUTES: Spec[] = [
  { file: `${ROOT}/route.ts`, method: "GET", kind: "read", maxDuration: true },
  { file: `${ROOT}/publications/[n]/route.ts`, method: "GET", kind: "read", maxDuration: false },
  { file: `${ROOT}/jobs/route.ts`, method: "POST", kind: "reviewer", maxDuration: true },
  { file: `${ROOT}/jobs/[jobId]/route.ts`, method: "POST", kind: "reviewer", maxDuration: true },
  { file: `${ROOT}/jobs/[jobId]/draft/route.ts`, method: "PATCH", kind: "reviewer", maxDuration: false },
  { file: `${ROOT}/jobs/[jobId]/advance/route.ts`, method: "POST", kind: "relay", maxDuration: true },
];

function handler(text: string, name: string) {
  const start = text.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `expected an exported ${name} handler`);
  const next = text.indexOf("\nexport ", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

function inOrder(text: string, markers: string[], label: string) {
  let cursor = -1;
  for (const marker of markers) {
    const at = text.indexOf(marker, cursor + 1);
    assert.ok(at > cursor, `${label}: "${marker}" should come after the previous check`);
    cursor = at;
  }
}

for (const route of ROUTES) {
  test(`${route.file} ${route.method}: the feature flag is the first statement`, async () => {
    const body = handler(codeOnly(await source(route.file)), route.method);
    const first = body.slice(body.indexOf(") {") + 3).trim().split("\n")[0].trim();
    assert.equal(first, "if (!isRetroFeatureEnabled()) return retroFeatureDisabledResponse();");
  });

  test(`${route.file} ${route.method}: checks run in the documented order`, async () => {
    const body = handler(codeOnly(await source(route.file)), route.method);
    if (route.kind === "read") {
      inOrder(body, ["isRetroFeatureEnabled()", "requireApiUser(request)", "retroMonthHandle("], route.file);
      assert.equal(body.includes("requireSameOriginMutation"), false);
    } else if (route.kind === "reviewer") {
      inOrder(body, [
        "isRetroFeatureEnabled()",
        "requireSameOriginMutation(request)",
        "requireApiUser(request)",
        "if (!isCaseReviewer(user.displayName)) return retroMonthErrorResponse(retroMonthForbidden());",
        "retroMonthHandle(",
        "readRetroJsonBody(request)",
      ], route.file);
    } else {
      inOrder(body, ["isRetroFeatureEnabled()", "request.headers.get(RETRO_RELAY_HEADER)", "consumeRetroRelayToken(", "if (!consumed) return notFound();", "scheduleRetroMonthAdvance("], route.file);
      assert.equal(body.includes("requireApiUser"), false, "the relay endpoint must not depend on a login session");
    }
  });

  test(`${route.file}: maxDuration`, async () => {
    const text = codeOnly(await source(route.file));
    assert.equal(/export const maxDuration = 300;/.test(text), route.maxDuration);
  });
}

test("services re-check 老孙 themselves, so a forgotten route check still answers 403", async () => {
  const service = codeOnly(await source("lib/retro/month-service.ts"));
  for (const name of ["startRetroMonthJob", "runRetroMonthJobAction", "publishRetroMonthJob", "patchRetroDraft"]) {
    const body = handler(service, name);
    assert.ok(body.indexOf("if (!isCaseReviewer(actor.displayName)) throw retroMonthForbidden();") >= 0, name);
  }
});

test("the month page schedules advancing after the response, and draft content is gated on 老孙", async () => {
  const page = codeOnly(await source(`${ROOT}/route.ts`));
  inOrder(page, ["loadRetroMonthView(", "if (advanceJobId) scheduleRetroMonthAdvance("], "month page");
  const view = codeOnly(await source("lib/retro/month-view.ts"));
  assert.match(view, /if \(options\.isReviewer && row\.status === "PENDING_REVIEW"\)/);
  assert.match(view, /failReason: options\.isReviewer \? row\.fail_reason : null/);
});

test("background advancing uses after(), a 280 s deadline and relays to the same origin", async () => {
  const shell = codeOnly(await source("lib/retro/month-route.ts"));
  assert.match(shell, /after\(async \(\) => \{/);
  assert.match(shell, /deadline: input\.startedAt \+ RETRO_MONTH_DEADLINE_MS/);
  assert.match(shell, /new URL\(input\.request\.url\)\.origin/);
});
