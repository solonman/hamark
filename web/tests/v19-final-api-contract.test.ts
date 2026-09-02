// Source-assertion contract tests for the final-version API surface (no live
// database) — same style as tests/v19-api-contract.test.ts: route.ts files
// are read as text rather than imported, since importing a route module
// pulls in @/db at load time.
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

test("V1.9 final route exports exactly POST", async () => {
  const route = codeOnly(await source("../app/api/videos/[id]/analysis/v19/final/route.ts"));
  assert.deepEqual(exportedHttpMethods(route), ["POST"]);
});

test("V1.9 final route is a mutation wrapped through the shared v04Route gate", async () => {
  const route = codeOnly(await source("../app/api/videos/[id]/analysis/v19/final/route.ts"));
  assert.match(route, /v04Route\(request, \{ mutation: true \}/);
});

test("V1.9 final route carries no lease / expectedRevision protocol and handles DONE/OPEN/ADOPT", async () => {
  const route = codeOnly(await source("../app/api/videos/[id]/analysis/v19/final/route.ts"));
  assert.doesNotMatch(route, /expectedRevision/i);
  assert.doesNotMatch(route, /\blease\s*[:,]/i);
  assert.match(route, /"DONE"/);
  assert.match(route, /"OPEN"/);
  assert.match(route, /"ADOPT"/);
});

test("V1.9 final route delegates authorization to the service layer rather than re-checking the reviewer name", async () => {
  // requireReviewerActor lives in lib/final-version.ts and throws FORBIDDEN,
  // which v04Route already maps to a 403 — the route must not duplicate that
  // check (and must not hardcode the reviewer's name).
  const route = codeOnly(await source("../app/api/videos/[id]/analysis/v19/final/route.ts"));
  assert.doesNotMatch(route, /老孙/);
  assert.match(route, /setFinalVersionStatus|adoptFinalIntakes/);
});

// ---------------------------------------------------------------------------
// GET on the workspace route must stay read-only even with the final-version
// fields folded in — same guard shape as "V1.9 GET never materializes" in
// tests/v19-api-contract.test.ts, restated here because this file is about
// to add final-version reads to that same GET handler.
// ---------------------------------------------------------------------------

test("V1.9 GET's handler body stays read-only after the final-version fields were folded in: no INSERT/UPDATE, no save/create/status/adopt call", async () => {
  const route = codeOnly(await source("../app/api/videos/[id]/analysis/v19/route.ts"));
  const getBody = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PUT"));
  assert.match(getBody, /loadV19VersionChain/);
  assert.match(getBody, /loadV04WorkspaceReadModel/);
  assert.doesNotMatch(getBody, /materialize/i);
  assert.doesNotMatch(getBody, /\bINSERT\b/i);
  assert.doesNotMatch(getBody, /\bUPDATE\b/i);
  assert.doesNotMatch(getBody, /saveV19VersionChanges|createV19VersionFrom|saveFinalVersionDirect|setFinalVersionStatus|adoptFinalIntakes/);
});

test("V1.9 PUT dispatches to saveFinalVersionDirect only when basedOnVersionId is \"final\"", async () => {
  const route = codeOnly(await source("../app/api/videos/[id]/analysis/v19/route.ts"));
  const putBody = route.slice(route.indexOf("export async function PUT"));
  assert.match(putBody, /saveFinalVersionDirect/);
  assert.match(putBody, /basedOnVersionId === "final"/);
  assert.match(putBody, /saveV19VersionChanges/);
});

// ---------------------------------------------------------------------------
// 本机走查 bug fix: `loadV19VersionChain` defaults `current` to the final
// version whenever no specific real version was requested (versionId is
// undefined) — not only for the explicit `?version=final` — per spec 二、11
// ("进入页面默认展示集成版"). `includeFinalTrace` must follow that same
// condition, or a colleague opening `/videos/<id>` with no `?version` gets
// `current.isFinal === true` but no `finalTrace`: no locked styling, no
// 集成版只有老孙可以编辑 toast, no source chain in 溯源视图.
// ---------------------------------------------------------------------------

test("V1.9 GET requests finalTrace whenever versionId is undefined, not only for the literal \"final\"", async () => {
  const route = codeOnly(await source("../app/api/videos/[id]/analysis/v19/route.ts"));
  const getBody = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PUT"));
  assert.match(getBody, /includeFinalTrace: versionId === undefined \|\| versionId === "final"/);
  // The narrower, buggy condition must not reappear anywhere in GET.
  assert.doesNotMatch(getBody, /includeFinalTrace: versionId === "final",?\s*\n\s*\}\),/);
});
