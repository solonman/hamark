// Source-assertion contract tests for the V1.9 studio API surface (no live
// database), in the style of tests/v04-api-contract.test.ts and
// tests/v04-formal-routes.test.ts: route.ts files are read as text rather
// than imported, since importing a route module pulls in @/db at load time.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

function exportedHttpMethods(routeSource: string) {
  return [...routeSource.matchAll(/^export async function (GET|POST|PUT|PATCH|DELETE)\b/gm)]
    .map((match) => match[1])
    .toSorted();
}

/**
 * Source with comments stripped. These guards are about what the code does, not
 * about the prose around it — a comment explaining that a retired mechanism is
 * switched off must not read as that mechanism being used.
 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("V1.9 PUT contract drops the retired lease / expectedRevision conflict protocol", async () => {
  const route = codeOnly(await source("../app/api/videos/[id]/analysis/v19/route.ts"));
  // Spec 三、3.4 / 四: saveV19VersionChanges takes no expectedRevision and no
  // lease proof — guard against the old v04 conflict protocol being
  // reintroduced onto the new per-editor-version surface. The check targets
  // what is SENT: this surface may still name the retired capabilities in
  // order to switch them off, which is the opposite of reintroducing them.
  assert.doesNotMatch(route, /expectedRevision/i);
  assert.doesNotMatch(route, /\blease\s*[:,]/i, "no lease proof may be forwarded to the service");
  assert.doesNotMatch(route, /acquireV04Lease|requireValidLease|heartbeatV04Lease/);
  assert.match(route, /canEdit: workspace\.viewerCapabilities\.canRead/,
    "edit rights follow read rights here; holding a lease is not a precondition");
});

test("V1.9 versions route also carries no lease / expectedRevision protocol", async () => {
  const route = codeOnly(await source("../app/api/videos/[id]/analysis/v19/versions/route.ts"));
  assert.doesNotMatch(route, /expectedRevision/i);
  assert.doesNotMatch(route, /\blease\s*[:,]/i);
});

test("V1.9 GET disables caching like the existing workspace GET does", async () => {
  const route = codeOnly(await source("../app/api/videos/[id]/analysis/v19/route.ts"));
  assert.match(route, /Cache-Control["'], ["']no-store["']/);
});

test("V1.9 GET never materializes — it only calls read-only load functions", async () => {
  const route = codeOnly(await source("../app/api/videos/[id]/analysis/v19/route.ts"));
  const getBody = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PUT"));
  assert.match(getBody, /loadV19VersionChain/);
  assert.match(getBody, /loadV04WorkspaceReadModel/);
  assert.doesNotMatch(getBody, /materialize/i);
  assert.doesNotMatch(getBody, /saveV19VersionChanges|createV19VersionFrom/);
});

test("V1.9 workspace route exports exactly GET and PUT", async () => {
  const route = codeOnly(await source("../app/api/videos/[id]/analysis/v19/route.ts"));
  assert.deepEqual(exportedHttpMethods(route), ["GET", "PUT"]);
});

test("V1.9 versions route exports exactly POST", async () => {
  const route = codeOnly(await source("../app/api/videos/[id]/analysis/v19/versions/route.ts"));
  assert.deepEqual(exportedHttpMethods(route), ["POST"]);
});

test("V1.9 routes use the shared v04Route wrapper for auth, actor resolution and error mapping", async () => {
  const [workspace, versions] = await Promise.all([
    source("../app/api/videos/[id]/analysis/v19/route.ts"),
    source("../app/api/videos/[id]/analysis/v19/versions/route.ts"),
  ]);
  assert.match(workspace, /v04Route\(request, \{ mutation: false \}/);
  assert.match(workspace, /v04Route\(request, \{ mutation: true \}/);
  assert.match(versions, /v04Route\(request, \{ mutation: true \}/);
});

test("V1.9 PUT and POST request bodies match the frozen spec shape", async () => {
  const [workspace, versions] = await Promise.all([
    source("../app/api/videos/[id]/analysis/v19/route.ts"),
    source("../app/api/videos/[id]/analysis/v19/versions/route.ts"),
  ]);
  assert.match(workspace, /basedOnVersionId/);
  assert.match(workspace, /changeSetId/);
  assert.match(workspace, /changes/);
  assert.match(versions, /baseVersionId/);
});

test("V1.9 ui-model source defines the v19 base path and exposes load/save/createVersion", async () => {
  const model = await source("../lib/v19-ui-model.ts");
  assert.match(model, /\/analysis\/v19/);
  assert.match(model, /load:/);
  assert.match(model, /save:/);
  assert.match(model, /createVersion:/);
  assert.doesNotMatch(model, /expectedRevision/);
});

// ---------------------------------------------------------------------------
// The access gate identifies the case from the request path. A surface it
// cannot read is refused as an unidentifiable object, so the V1.9 routes have
// to be recognised there or every request 403s. Only a live request reveals
// this, hence the explicit guard.
// ---------------------------------------------------------------------------

test("the gray access gate reads the case id from V1.9 studio paths too", async () => {
  const { v04GrayVideoIdFromRequest } = await import("../lib/v04-gray-access.ts");
  const read = (path: string) =>
    v04GrayVideoIdFromRequest(new Request(`https://example.test${path}`));

  assert.equal(read("/api/videos/video_1/analysis/v19"), "video_1");
  assert.equal(read("/api/videos/video_1/analysis/v19/versions"), "video_1");
  assert.equal(read("/api/videos/video_1/analysis/v04/workspace"), "video_1");
  assert.equal(read("/api/videos/video%20a/analysis/v19"), "video a");
  assert.equal(read("/api/videos/video_1/analysis/v20"), undefined);
});

// ---------------------------------------------------------------------------
// Production applies migrations by running the frozen .sql file in the Supabase
// SQL editor, not `npm run db:migrate` — that path replays the whole bootstrap
// script, whose V0.4 contract drift guard requires the contracts to still be
// DRAFT while production activated them long ago. The two definitions of the
// new table therefore have to stay in step.
// ---------------------------------------------------------------------------

test("the frozen production SQL matches the TypeScript schema statements", async () => {
  const sql = await readFile(
    new URL("../db/migrations/2026-08-24-v19-version-chain.sql", import.meta.url), "utf8");
  const { V19_VERSION_CHAIN_SCHEMA_STATEMENTS } = await import("../db/v19-version-chain-schema.ts");

  const normalise = (text: string) => text.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  const normalisedSql = normalise(sql);

  for (const statement of V19_VERSION_CHAIN_SCHEMA_STATEMENTS) {
    // The DO block is re-expressed with the table name inlined, so compare the
    // parts that carry the actual schema decisions.
    if (statement.includes("$v19_revoke_public_roles$")) continue;
    assert.ok(
      normalisedSql.includes(normalise(statement)),
      `frozen SQL is missing: ${normalise(statement).slice(0, 80)}…`,
    );
  }
  assert.match(normalisedSql, /REVOKE ALL ON TABLE analysis_versions FROM anon/);
  assert.match(normalisedSql, /REVOKE ALL ON TABLE analysis_versions FROM authenticated/);
  assert.match(normalisedSql, /BEGIN;/);
  assert.match(normalisedSql, /COMMIT;/);
});
