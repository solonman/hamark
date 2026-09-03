import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalReportPayload,
  hashReportPayload,
  nextReportVersionNumber,
  pickReportActorVersion,
  resolveReportCurrentSelection,
  resolveReportDefaultVersion,
  virtualReportVersion,
} from "../lib/report-version-chain.ts";

test("nextReportVersionNumber advances past the highest existing number, gaps included", () => {
  assert.equal(nextReportVersionNumber([]), 1);
  assert.equal(nextReportVersionNumber([1]), 2);
  assert.equal(nextReportVersionNumber([1, 3]), 4, "a gap at 2 must not be reused");
  assert.equal(nextReportVersionNumber([5, 2, 9, 1]), 10, "unordered input still finds the true max");
});

test("resolveReportDefaultVersion picks the most recently updated version", () => {
  const versions = [
    { number: 1, updatedAt: "2026-08-20T10:00:00.000Z" },
    { number: 2, updatedAt: "2026-08-22T09:00:00.000Z" },
    { number: 3, updatedAt: "2026-08-21T09:00:00.000Z" },
  ];
  assert.equal(resolveReportDefaultVersion(versions).number, 2);
});

test("resolveReportDefaultVersion breaks updatedAt ties by the highest version number", () => {
  const versions = [
    { number: 1, updatedAt: "2026-08-20T10:00:00.000Z" },
    { number: 4, updatedAt: "2026-08-20T10:00:00.000Z" },
    { number: 2, updatedAt: "2026-08-20T10:00:00.000Z" },
  ];
  assert.equal(resolveReportDefaultVersion(versions).number, 4);
});

test("resolveReportDefaultVersion works with a single version", () => {
  const versions = [{ number: 7, updatedAt: "2026-01-01T00:00:00.000Z" }];
  assert.equal(resolveReportDefaultVersion(versions).number, 7);
});

test("resolveReportDefaultVersion rejects an empty list rather than guessing", () => {
  assert.throws(() => resolveReportDefaultVersion([]), /EMPTY_VERSION_LIST/);
});

test("pickReportActorVersion finds the version owned by the actor", () => {
  const versions = [{ ownerUserId: "user_a" }, { ownerUserId: "user_b" }];
  const found = pickReportActorVersion(versions, "user_b");
  assert.notEqual(found, null);
  assert.equal(found?.ownerUserId, "user_b");
});

test("pickReportActorVersion returns null when the actor owns no version", () => {
  const versions = [{ ownerUserId: "user_a" }];
  assert.equal(pickReportActorVersion(versions, "user_z"), null);
});

test("pickReportActorVersion returns null for an empty version list", () => {
  assert.equal(pickReportActorVersion([], "user_a"), null);
});

test("canonicalReportPayload sorts object keys but preserves array element order", () => {
  const payload = { b: 1, a: [3, 1, 2], nested: { z: 1, y: 2 } };
  assert.equal(
    canonicalReportPayload(payload),
    '{"a":[3,1,2],"b":1,"nested":{"y":2,"z":1}}',
  );
});

test("hashReportPayload is stable across object key order and object identity", () => {
  const a = {
    background: { city: "上海", developer: "X" },
    modules: [{ id: "m1", name: "A" }],
  };
  const b = {
    modules: [{ name: "A", id: "m1" }],
    background: { developer: "X", city: "上海" },
  };
  assert.equal(hashReportPayload(a), hashReportPayload(b));
});

test("hashReportPayload changes when content actually changes", () => {
  const a = { background: { city: "上海" } };
  const b = { background: { city: "北京" } };
  assert.notEqual(hashReportPayload(a), hashReportPayload(b));
});

test("hashReportPayload is sensitive to array order (arrays are not sorted)", () => {
  const a = { pages: [1, 2, 3] };
  const b = { pages: [3, 2, 1] };
  assert.notEqual(hashReportPayload(a), hashReportPayload(b));
});

test("virtualReportVersion has id null, version number 1, no base, and is marked virtual", () => {
  const version = virtualReportVersion("user_a", "张三", "user_a", "2026-09-02T00:00:00.000Z");
  assert.equal(version.id, null);
  assert.equal(version.number, 1);
  assert.equal(version.baseNumber, null);
  assert.equal(version.isVirtual, true);
  assert.equal(version.ownerUserId, "user_a");
  assert.equal(version.ownerName, "张三");
  assert.equal(version.createdAt, "2026-09-02T00:00:00.000Z");
  assert.equal(version.updatedAt, "2026-09-02T00:00:00.000Z");
});

test("virtualReportVersion marks isMine true only when the viewer is the attributed owner", () => {
  const mine = virtualReportVersion("user_a", "张三", "user_a", "2026-09-02T00:00:00.000Z");
  assert.equal(mine.isMine, true);

  const someoneElses = virtualReportVersion("user_a", "张三", "user_b", "2026-09-02T00:00:00.000Z");
  assert.equal(someoneElses.isMine, false);
});

// ---------------------------------------------------------------------------
// resolveReportCurrentSelection — 报告侧复用视频侧同一份判断逻辑（见
// tests/v19-version-chain.test.ts 的 resolveV19CurrentSelection），这里只
// 确认报告这个别名确实接到了同一份行为，不重复穷举每一种分支。
// ---------------------------------------------------------------------------

test("resolveReportCurrentSelection: no ?version, viewer owns a version -> their own version", () => {
  const selection = resolveReportCurrentSelection({
    requestedVersionId: undefined,
    mineVersionId: "version_mine",
    isRealVersionId: () => true,
  });
  assert.deepEqual(selection, { kind: "VERSION", id: "version_mine" });
});

test("resolveReportCurrentSelection: no ?version, viewer owns no version -> final", () => {
  const selection = resolveReportCurrentSelection({
    requestedVersionId: undefined,
    mineVersionId: null,
    isRealVersionId: () => true,
  });
  assert.deepEqual(selection, { kind: "FINAL" });
});
