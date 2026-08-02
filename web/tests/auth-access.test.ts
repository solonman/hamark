import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const businessApiRoutes = [
  "app/api/videos/route.ts",
  "app/api/videos/[id]/route.ts",
  "app/api/videos/[id]/content/route.ts",
  "app/api/videos/[id]/replace/route.ts",
  "app/api/videos/[id]/stream/route.ts",
  "app/api/videos/[id]/annotation/route.ts",
  "app/api/videos/[id]/annotation/submit/route.ts",
  "app/api/analyses/[snapshotId]/score/route.ts",
];

const protectedPages = [
  "app/page.tsx",
  "app/videos/[id]/page.tsx",
  "app/videos/[id]/practice/page.tsx",
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

test("protected pages require page sessions", async () => {
  for (const page of protectedPages) {
    const source = await readProjectFile(page);
    assert.match(source, /requirePageUser\(/, `${page} must call requirePageUser`);
  }
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
