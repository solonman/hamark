import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const businessApiRoutes = [
  "app/api/videos/route.ts",
  "app/api/videos/[id]/route.ts",
  "app/api/videos/[id]/complete/route.ts",
  "app/api/videos/[id]/replace/route.ts",
  "app/api/videos/[id]/replace/complete/route.ts",
  "app/api/videos/[id]/stream/route.ts",
  "app/api/videos/[id]/annotation/route.ts",
  "app/api/videos/[id]/annotation/submit/route.ts",
  "app/api/analyses/[snapshotId]/route.ts",
  "app/api/analyses/[snapshotId]/comments/route.ts",
  "app/api/analyses/[snapshotId]/comments/[commentId]/route.ts",
  "app/api/analyses/[snapshotId]/suggestions/route.ts",
  "app/api/analyses/[snapshotId]/suggestions/[suggestionId]/route.ts",
  "app/api/analyses/[snapshotId]/score/route.ts",
  "app/api/admin/welcome-home-v02-v03-mapping/route.ts",
];

const mutationApiRoutes = [
  "app/api/videos/route.ts",
  "app/api/videos/[id]/route.ts",
  "app/api/videos/[id]/complete/route.ts",
  "app/api/videos/[id]/replace/route.ts",
  "app/api/videos/[id]/replace/complete/route.ts",
  "app/api/videos/[id]/annotation/route.ts",
  "app/api/videos/[id]/annotation/submit/route.ts",
  "app/api/analyses/[snapshotId]/comments/route.ts",
  "app/api/analyses/[snapshotId]/comments/[commentId]/route.ts",
  "app/api/analyses/[snapshotId]/suggestions/route.ts",
  "app/api/analyses/[snapshotId]/suggestions/[suggestionId]/route.ts",
  "app/api/analyses/[snapshotId]/score/route.ts",
  "app/api/admin/welcome-home-v02-v03-mapping/route.ts",
];

const protectedPages = [
  "app/page.tsx",
  "app/videos/[id]/page.tsx",
  "app/videos/[id]/practice/page.tsx",
  "app/admin/welcome-home-v02-v03-mapping/page.tsx",
];

test("every business API route enforces a database-backed authenticated user", async () => {
  for (const route of businessApiRoutes) {
    const source = await readProjectFile(route);
    assert.match(source, /requireApiUser\(/, `${route} must call requireApiUser`);
    assert.doesNotMatch(source, /currentUserFromRequest/, `${route} must not use legacy header auth`);
    assert.doesNotMatch(source, /user\.email\b/, `${route} must use identityKey for identity columns`);
    assert.doesNotMatch(source, /user\.name\b/, `${route} must use displayName for display columns`);
  }
});

test("business API routes do not run database schema setup during requests", async () => {
  for (const route of businessApiRoutes) {
    const source = await readProjectFile(route);
    assert.doesNotMatch(source, /@\/db\/bootstrap/);
    assert.doesNotMatch(source, /ensureSchema\(/);
  }
});

test("protected pages require page sessions", async () => {
  for (const page of protectedPages) {
    const source = await readProjectFile(page);
    assert.match(source, /requirePageUser\(/, `${page} must call requirePageUser`);
  }
});

test("every business mutation route rejects cross-origin requests", async () => {
  for (const route of mutationApiRoutes) {
    const source = await readProjectFile(route);
    assert.match(
      source,
      /requireSameOriginMutation\(request\)|v04Route\(request, \{ mutation: true/,
      `${route} must call a same-origin mutation guard`,
    );
  }
});

test("default video deletion is stable-uploader soft trash and never deletes DB or COS", async () => {
  const [route, lifecycle] = await Promise.all([
    readProjectFile("app/api/videos/[id]/route.ts"),
    readProjectFile("lib/v04-video-lifecycle.ts"),
  ]);

  assert.match(route, /trashVideoWithSchemaCompatibility\(/);
  assert.match(lifecycle, /video\.created_by_user_id\s*\?\s*video\.created_by_user_id === actor\.userId\s*:\s*video\.created_by_email === actor\.identityKey/s);
  assert.match(lifecycle, /restore_until = \?::timestamptz/);
  assert.match(lifecycle, /deletion_state = 'TRASHED'/);
  assert.match(lifecycle, /assetAction: "NONE"/);
  assert.doesNotMatch(route, /bucket\.delete\(/);
  assert.doesNotMatch(route, /DELETE FROM videos/);
  assert.doesNotMatch(route, /DELETE FROM annotations/);
});

test("video management prefers stable uploader id and safely falls back on pre-1A schemas", async () => {
  const [source, compatibility] = await Promise.all([
    readProjectFile("app/api/videos/[id]/route.ts"),
    readProjectFile("lib/legacy-video-schema-compat.ts"),
  ]);

  assert.match(source, /to_jsonb\(v\)->>'created_by_user_id' AS created_by_user_id/);
  assert.match(source, /videoUploaderMatches\(video/);
  assert.match(source, /canTrash: canManage/);
  assert.match(compatibility, /stableUploader\s*\?\s*stableUploader === actor\.userId\s*:\s*video\.created_by_email === actor\.identityKey/s);
  assert.match(compatibility, /fullV04Lifecycle/);
});

test("video metadata updates require the original uploader and normalize tags", async () => {
  const source = await readProjectFile("app/api/videos/[id]/route.ts");

  assert.match(source, /export async function PATCH/);
  assert.match(source, /只有原上传者可以编辑视频信息/);
  assert.match(source, /\.map\(\(tag\) => tag\.trim\(\)\)\s*\.filter\(Boolean\)\s*\.slice\(0, 12\)/s);
  assert.match(source, /UPDATE videos\s+SET title = \?, brand = \?, description = \?, tags_json = \?,\s+updated_at = CURRENT_TIMESTAMP/s);
});

test("READY video details expose a scoped COS playback URL only after authentication", async () => {
  const source = await readProjectFile("app/api/videos/[id]/route.ts");

  assert.match(source, /requireApiUser\(request\)/);
  assert.match(source, /object_key/);
  assert.match(source, /getVideoBucket\(\)\.createPresignedGetUrl\(video\.object_key, \{\s*expiresInSeconds: 3 \* 60 \* 60,?\s*\}\)/s);
  assert.match(source, /playbackUrl/);
});

test("proxy public routes are exact unless explicitly prefix-based", async () => {
  const source = await readProjectFile("proxy.ts");

  assert.match(source, /const publicExact = new Set/);
  assert.match(source, /const publicPrefixes = \["\/_next\/"\]/);
});

test("legacy demo identity fallback is removed", async () => {
  const source = await readProjectFile("lib/current-user.ts");
  assert.doesNotMatch(source, /demo@reverse\.local/);
  assert.doesNotMatch(source, /演示用户/);
  assert.doesNotMatch(source, /oai-authenticated-user/);
});

function readProjectFile(file: string) {
  return readFile(path.join(process.cwd(), file), "utf8");
}
