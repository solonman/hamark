import assert from "node:assert/strict";
import test from "node:test";
import {
  hasV04MemberCapability,
  hasV04UploaderCapability,
  previewV04UploaderMappings,
  type V04LegacyUploaderReference,
  type V04StableUserIdentity,
} from "../lib/v04-role-preview.ts";

const users: V04StableUserIdentity[] = [
  { id: "user-active", email: "owner@example.com", status: "ACTIVE" },
  { id: "user-disabled", email: "disabled@example.com", status: "DISABLED" },
  { id: "user-duplicate-a", email: "duplicate@example.com", status: "ACTIVE" },
  { id: "user-duplicate-b", email: "DUPLICATE@example.com", status: "DISABLED" },
];

const references: V04LegacyUploaderReference[] = [
  { videoId: "video-unique", createdByEmail: " Owner@Example.com " },
  { videoId: "video-ambiguous", createdByEmail: "duplicate@example.com" },
  { videoId: "video-missing", createdByEmail: "missing@example.com" },
  { videoId: "video-disabled", createdByEmail: "disabled@example.com" },
  { videoId: "video-empty", createdByEmail: null },
];

test("V0.4 uploader preview classifies stable identity evidence without leaking legacy identity", () => {
  const beforeUsers = structuredClone(users);
  const beforeReferences = structuredClone(references);
  const preview = previewV04UploaderMappings(users, references);

  assert.deepEqual(preview.map((item) => item.classification), [
    "UNIQUE",
    "AMBIGUOUS",
    "MISSING",
    "DISABLED",
    "MISSING",
  ]);
  assert.deepEqual(preview[0].candidateUserIds, ["user-active"]);
  assert.deepEqual(preview[1].candidateUserIds, ["user-duplicate-a", "user-duplicate-b"]);
  assert.deepEqual(users, beforeUsers, "preview must not mutate stable users");
  assert.deepEqual(references, beforeReferences, "preview must not mutate legacy evidence");

  const serialized = JSON.stringify(preview);
  for (const reference of references) {
    if (reference.createdByEmail) assert(!serialized.includes(reference.createdByEmail));
  }
  assert(!serialized.includes("@"), "preview output must not expose any email address");
});

test("MEMBER and UPLOADER remain derived capabilities instead of persisted memberships", () => {
  assert.equal(hasV04MemberCapability({ status: "ACTIVE" }), true);
  assert.equal(hasV04MemberCapability({ status: "DISABLED" }), false);
  assert.equal(hasV04UploaderCapability("user-active", { createdByUserId: "user-active" }), true);
  assert.equal(hasV04UploaderCapability("user-active", { createdByUserId: "someone-else" }), false);
  assert.equal(hasV04UploaderCapability("user-active", { createdByUserId: null }), false);
});
