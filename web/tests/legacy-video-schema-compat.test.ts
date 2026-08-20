import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { videoUploaderMatches } from "../lib/legacy-video-schema-compat.ts";

const actor = { userId: "user_owner", identityKey: "corp:owner" };

test("stable uploader id is authoritative when present", () => {
  assert.equal(videoUploaderMatches({
    created_by_user_id: "user_owner",
    created_by_email: "someone-else@example.com",
  }, actor), true);
  assert.equal(videoUploaderMatches({
    created_by_user_id: "user_other",
    created_by_email: "corp:owner",
  }, actor), false);
});

test("legacy uploader identity is used only when stable id is absent", () => {
  assert.equal(videoUploaderMatches({
    created_by_user_id: null,
    created_by_email: "corp:owner",
  }, actor), true);
  assert.equal(videoUploaderMatches({
    created_by_user_id: "",
    created_by_email: "corp:owner",
  }, actor), true);
  assert.equal(videoUploaderMatches({
    created_by_user_id: null,
    created_by_email: "corp:other",
  }, actor), false);
});

test("deployed legacy video routes negotiate 1A capabilities before writes", async () => {
  const [collectionRoute, detailRoute, restoreRoute] = await Promise.all([
    readFile(new URL("../app/api/videos/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/[id]/restore/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(collectionRoute, /loadLegacyVideoSchemaCapabilities/);
  assert.match(collectionRoute, /createVideoWithSchemaCompatibility/);
  assert.doesNotMatch(collectionRoute, /INSERT INTO videos[\s\S]*created_by_user_id/);
  assert.match(detailRoute, /to_jsonb\(v\)->>'created_by_user_id'/);
  assert.doesNotMatch(detailRoute, /v\.created_by_user_id/);
  assert.match(detailRoute, /trashVideoWithSchemaCompatibility/);
  assert.match(restoreRoute, /restoreVideoWithSchemaCompatibility/);
});

test("core legacy clients diagnose empty and non-JSON failures without exposing Response.json syntax", async () => {
  const files = [
    "../app/components/HomeClient.tsx",
    "../app/components/UploadDialog.tsx",
    "../app/videos/[id]/VideoDetailClient.tsx",
    "../app/videos/[id]/EditVideoDialog.tsx",
    "../app/videos/[id]/DeleteVideoDialog.tsx",
    "../app/videos/[id]/ReplaceVideoDialog.tsx",
    "../app/videos/[id]/practice/PracticeClient.tsx",
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /readJsonResponse/);
  }
});
