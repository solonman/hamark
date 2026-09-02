import assert from "node:assert/strict";
import test from "node:test";
import {
  formatV19VersionLabel,
  nextV19VersionNumber,
  pickV19ActorVersion,
  resolveV19DefaultVersion,
} from "../lib/v19-version-chain.ts";

test("nextV19VersionNumber advances past the highest existing number, gaps included", () => {
  assert.equal(nextV19VersionNumber([]), 1);
  assert.equal(nextV19VersionNumber([1]), 2);
  assert.equal(nextV19VersionNumber([1, 3]), 4, "a gap at 2 must not be reused");
  assert.equal(nextV19VersionNumber([5, 2, 9, 1]), 10, "unordered input still finds the true max");
});

test("resolveV19DefaultVersion picks the most recently updated version", () => {
  const versions = [
    { number: 1, updatedAt: "2026-08-20T10:00:00.000Z" },
    { number: 2, updatedAt: "2026-08-22T09:00:00.000Z" },
    { number: 3, updatedAt: "2026-08-21T09:00:00.000Z" },
  ];
  assert.equal(resolveV19DefaultVersion(versions).number, 2);
});

test("resolveV19DefaultVersion breaks updatedAt ties by the highest version number", () => {
  const versions = [
    { number: 1, updatedAt: "2026-08-20T10:00:00.000Z" },
    { number: 4, updatedAt: "2026-08-20T10:00:00.000Z" },
    { number: 2, updatedAt: "2026-08-20T10:00:00.000Z" },
  ];
  assert.equal(resolveV19DefaultVersion(versions).number, 4);
});

test("resolveV19DefaultVersion works with a single version", () => {
  const versions = [{ number: 7, updatedAt: "2026-01-01T00:00:00.000Z" }];
  assert.equal(resolveV19DefaultVersion(versions).number, 7);
});

test("resolveV19DefaultVersion rejects an empty list rather than guessing", () => {
  assert.throws(() => resolveV19DefaultVersion([]), /EMPTY_VERSION_LIST/);
});

test("formatV19VersionLabel renders an initial version owned by the uploader", () => {
  assert.equal(
    formatV19VersionLabel({ number: 1, baseNumber: null, ownerName: "王大明", ownerIsUploader: true }),
    "v1（初始版本，王大明·上传者）",
  );
});

test("formatV19VersionLabel renders a version based on an earlier one for a non-uploader owner", () => {
  assert.equal(
    formatV19VersionLabel({ number: 3, baseNumber: 1, ownerName: "张三", ownerIsUploader: false }),
    "v3（基于v1，张三）",
  );
});

test("formatV19VersionLabel can combine a base reference with an uploader owner", () => {
  assert.equal(
    formatV19VersionLabel({ number: 2, baseNumber: 1, ownerName: "李雷", ownerIsUploader: true }),
    "v2（基于v1，李雷·上传者）",
  );
});

test("formatV19VersionLabel renders 基于最终版 when baseIsFinal is set, regardless of baseNumber", () => {
  assert.equal(
    formatV19VersionLabel({ number: 5, baseNumber: null, ownerName: "老孙", ownerIsUploader: false, baseIsFinal: true }),
    "v5（基于最终版，老孙）",
  );
});

test("pickV19ActorVersion finds the version owned by the actor", () => {
  const versions = [{ ownerUserId: "user_a" }, { ownerUserId: "user_b" }];
  const found = pickV19ActorVersion(versions, "user_b");
  assert.notEqual(found, null);
  assert.equal(found?.ownerUserId, "user_b");
});

test("pickV19ActorVersion returns null when the actor owns no version", () => {
  const versions = [{ ownerUserId: "user_a" }];
  assert.equal(pickV19ActorVersion(versions, "user_z"), null);
});

test("pickV19ActorVersion returns null for an empty version list", () => {
  assert.equal(pickV19ActorVersion([], "user_a"), null);
});
