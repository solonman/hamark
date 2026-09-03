// Source-assertion contract tests for the report-final-version API surface
// (no live database) — same style as tests/v19-final-api-contract.test.ts:
// route.ts files are read as text rather than imported, since importing a
// route module pulls in @/db at load time.
//
// docs/21_报告集成版_实施规格_V0.1.md 3.3: "GET 不落库（同视频侧 3.3 的
// 守卫，报告侧也要补一条等价测试）" — this file is that equivalent test.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

function exportedHttpMethods(routeSource: string) {
  return [...routeSource.matchAll(/^export async function (GET|POST|PUT|PATCH|DELETE)\b/gm)]
    .map((match) => match[1])
    .toSorted();
}

function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("report annotation route exports exactly GET and PUT", async () => {
  const route = codeOnly(await source("../app/api/reports/[id]/annotation/route.ts"));
  assert.deepEqual(exportedHttpMethods(route), ["GET", "PUT"]);
});

test("report annotation GET never materializes the final version — it only calls read-only load functions", async () => {
  const route = codeOnly(await source("../app/api/reports/[id]/annotation/route.ts"));
  const getBody = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PUT"));
  assert.match(getBody, /loadReportVersionChain/);
  assert.doesNotMatch(getBody, /materialize|ensureReportFinalVersion/i);
  assert.doesNotMatch(
    getBody,
    /saveReportVersion|saveReportFinalVersionDirect|setReportFinalVersionStatus|adoptReportFinalIntakes/,
  );
});

test("loadReportFinalVersion's own body issues no writes — SELECT only, matching loadFinalVersion on the video side", async () => {
  const lib = await source("../lib/report-final-version.ts");
  const start = lib.indexOf("export async function loadReportFinalVersion");
  const end = lib.indexOf("export type ReportFinalTraceIntake");
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = codeOnly(lib.slice(start, end));
  assert.doesNotMatch(body, /\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
  assert.doesNotMatch(body, /ensureReportFinalVersion/);
});

test("report annotation PUT dispatches to saveReportFinalVersionDirect only when versionId is the literal \"final\"", async () => {
  const route = codeOnly(await source("../app/api/reports/[id]/annotation/route.ts"));
  const putBody = route.slice(route.indexOf("export async function PUT"));
  assert.match(putBody, /saveReportFinalVersionDirect/);
  assert.match(putBody, /body\.versionId\.trim\(\) === "final"|versionId === "final"/);
  assert.match(putBody, /saveReportVersion/);
});

test("report annotation/final route exports exactly POST and delegates authorization to the service layer", async () => {
  const route = codeOnly(await source("../app/api/reports/[id]/annotation/final/route.ts"));
  assert.deepEqual(exportedHttpMethods(route), ["POST"]);
  // setReportFinalVersionStatus / adoptReportFinalIntakes throw FORBIDDEN
  // themselves (see lib/report-final-version.ts's requireReportReviewerActor);
  // the route must not duplicate that check or hardcode the reviewer's name.
  assert.doesNotMatch(route, /老孙/);
  assert.match(route, /setReportFinalVersionStatus|adoptReportFinalIntakes/);
  assert.match(route, /"SET_STATUS"/);
  assert.match(route, /"ADOPT"/);
});

test("report annotation GET disables caching", async () => {
  const route = codeOnly(await source("../app/api/reports/[id]/annotation/route.ts"));
  assert.match(route, /Cache-Control["'], ["']no-store["']/);
});
