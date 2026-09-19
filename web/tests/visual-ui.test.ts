import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateUploadPercent,
  applyFrozenFlatOrder,
  buildCaseNumberMap,
  countAssetsByType,
  countCompletedUploads,
  countFilledMetadata,
  filterBySubdomain,
  filterFavoritedOnly,
  formatUploadProgressLabel,
  freezeFlatOrder,
  hasPendingVisualWork,
  matchesVisualQuery,
  pruneVisualMetadata,
  rankByFavorite,
  remainingVisualSlots,
  validateVisualDraft,
} from "../lib/visual-ui.ts";

function makeCase(overrides: Partial<{
  title: string; summary: string; textBody: string; tags: string[]; location: string; creator: string; createdByName: string;
}> = {}) {
  return {
    title: "南京西路裸眼 3D 巨幕",
    summary: "整点开箱的裸眼 3D 内容",
    textBody: "内容按整点循环",
    tags: ["裸眼3D", "大屏"],
    location: "上海 · 南京西路",
    creator: "某商业地产",
    createdByName: "老孙",
    ...overrides,
  };
}

test("matchesVisualQuery: empty query matches everything", () => {
  assert.equal(matchesVisualQuery(makeCase(), ""), true);
  assert.equal(matchesVisualQuery(makeCase(), "   "), true);
});

test("matchesVisualQuery: hits title / summary / textBody / tags / location / creator / uploader", () => {
  const item = makeCase();
  assert.equal(matchesVisualQuery(item, "南京西路"), true);
  assert.equal(matchesVisualQuery(item, "整点开箱"), true);
  assert.equal(matchesVisualQuery(item, "循环"), true);
  assert.equal(matchesVisualQuery(item, "裸眼3D"), true);
  assert.equal(matchesVisualQuery(item, "上海"), true);
  assert.equal(matchesVisualQuery(item, "商业地产"), true);
  assert.equal(matchesVisualQuery(item, "老孙"), true);
  assert.equal(matchesVisualQuery(item, "不存在的词"), false);
});

test("matchesVisualQuery: NFKC-normalizes and ignores case (fullwidth digit, case-insensitive)", () => {
  const item = makeCase({ tags: ["裸眼3D"] });
  // fullwidth "３" should match halfwidth "3" after NFKC normalization
  assert.equal(matchesVisualQuery(item, "裸眼３d"), true);
  assert.equal(matchesVisualQuery(item, "裸眼3d"), true);
});

test("filterBySubdomain: ALL keeps everything, a specific key filters", () => {
  const items = [
    { id: "a", subdomain: "OOH" as const },
    { id: "b", subdomain: "PUBLIC_ART" as const },
    { id: "c", subdomain: "OOH" as const },
  ];
  assert.deepEqual(filterBySubdomain(items, "ALL").map((i) => i.id), ["a", "b", "c"]);
  assert.deepEqual(filterBySubdomain(items, "OOH").map((i) => i.id), ["a", "c"]);
  assert.deepEqual(filterBySubdomain(items, "RETAIL").map((i) => i.id), []);
});

test("filterFavoritedOnly: off keeps everything, on keeps only viewerFavorited", () => {
  const items = [
    { id: "a", viewerFavorited: true },
    { id: "b", viewerFavorited: false },
  ];
  assert.deepEqual(filterFavoritedOnly(items, false).map((i) => i.id), ["a", "b"]);
  assert.deepEqual(filterFavoritedOnly(items, true).map((i) => i.id), ["a"]);
});

test("rankByFavorite: favorite count desc, ties broken by newest createdAt first", () => {
  const items = [
    { id: "a", fav: 2, at: "2026-09-01T00:00:00Z" },
    { id: "b", fav: 4, at: "2026-09-02T00:00:00Z" },
    { id: "c", fav: 2, at: "2026-09-05T00:00:00Z" },
  ];
  const ranked = rankByFavorite(items, (i) => i.fav, (i) => i.at);
  assert.deepEqual(ranked.map((i) => i.id), ["b", "c", "a"]);
});

test("freezeFlatOrder + applyFrozenFlatOrder: keeps frozen positions, flags stale when real order changed", () => {
  const idOf = (item: { id: string }) => item.id;
  const original = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const frozen = freezeFlatOrder(original, idOf);

  // real order changes (b jumps to front) but frozen view keeps the old slots
  const changed = [{ id: "b" }, { id: "a" }, { id: "c" }];
  const applied = applyFrozenFlatOrder(changed, idOf, frozen);
  assert.deepEqual(applied.items.map(idOf), ["a", "b", "c"]);
  assert.equal(applied.stale, true);

  // nothing changed => not stale
  const same = applyFrozenFlatOrder(original, idOf, frozen);
  assert.equal(same.stale, false);

  // no frozen map => passthrough, never stale
  const passthrough = applyFrozenFlatOrder(changed, idOf, null);
  assert.deepEqual(passthrough.items.map(idOf), ["b", "a", "c"]);
  assert.equal(passthrough.stale, false);
});

test("freezeFlatOrder + applyFrozenFlatOrder: items appearing after the freeze sort to the end and count as stale", () => {
  const idOf = (item: { id: string }) => item.id;
  const frozen = freezeFlatOrder([{ id: "a" }, { id: "b" }], idOf);
  const withNewcomer = [{ id: "new" }, { id: "a" }, { id: "b" }];
  const applied = applyFrozenFlatOrder(withNewcomer, idOf, frozen);
  assert.deepEqual(applied.items.map(idOf), ["a", "b", "new"]);
  assert.equal(applied.stale, true);
});

test("buildCaseNumberMap: 1-based index following the given (already newest-first) order", () => {
  const map = buildCaseNumberMap([{ id: "x" }, { id: "y" }, { id: "z" }]);
  assert.equal(map.get("x"), 1);
  assert.equal(map.get("y"), 2);
  assert.equal(map.get("z"), 3);
});

test("hasPendingVisualWork: true when any case is UPLOADING or has a PENDING cover", () => {
  assert.equal(hasPendingVisualWork([{ status: "READY", cover: null }]), false);
  assert.equal(hasPendingVisualWork([{ status: "UPLOADING", cover: null }]), true);
  assert.equal(hasPendingVisualWork([{ status: "READY", cover: { derivativeStatus: "PENDING" } }]), true);
  assert.equal(hasPendingVisualWork([{ status: "READY", cover: { derivativeStatus: "READY" } }]), false);
});

test("countAssetsByType / remainingVisualSlots: video 12 cap, image 24 cap, never negative", () => {
  const assets = [
    { type: "VIDEO" as const }, { type: "VIDEO" as const }, { type: "IMAGE" as const },
  ];
  assert.deepEqual(countAssetsByType(assets), { videos: 2, images: 1 });
  assert.deepEqual(remainingVisualSlots({ videos: 2, images: 1 }), { videos: 10, images: 23 });
  assert.deepEqual(remainingVisualSlots({ videos: 12, images: 30 }), { videos: 0, images: 0 });
});

test("validateVisualDraft: order is asset -> subdomain -> title -> location -> tags -> sourceUrl", () => {
  const base = { assetCount: 0, subdomain: "", title: "", location: "", tagsText: "", sourceUrl: "" };
  assert.equal(validateVisualDraft(base, false), "请先选择视频或图片，至少一个。");
  assert.equal(validateVisualDraft(base, true), "至少要保留一段视频或一张图片。");
  assert.equal(validateVisualDraft({ ...base, assetCount: 1 }, false), "请选择子领域。");
  assert.equal(validateVisualDraft({ ...base, assetCount: 1, subdomain: "OOH" }, false), "请填写标题。");
  assert.equal(
    validateVisualDraft({ ...base, assetCount: 1, subdomain: "OOH", title: "标题" }, false),
    "请填写采集地点，写到城市即可。",
  );
  assert.equal(
    validateVisualDraft({ ...base, assetCount: 1, subdomain: "OOH", title: "标题", location: "上海" }, false),
    "至少填一个标签。",
  );
  assert.equal(
    validateVisualDraft(
      { ...base, assetCount: 1, subdomain: "OOH", title: "标题", location: "上海", tagsText: "a", sourceUrl: "javascript:alert(1)" },
      false,
    ),
    "来源链接只收 http:// 或 https:// 开头的网址。",
  );
  assert.equal(
    validateVisualDraft(
      { ...base, assetCount: 1, subdomain: "OOH", title: "标题", location: "上海", tagsText: "a", sourceUrl: "https://example.com" },
      false,
    ),
    "",
  );
});

test("validateVisualDraft: tag count and per-tag length caps", () => {
  const base = { assetCount: 1, subdomain: "OOH", title: "t", location: "上海", sourceUrl: "" };
  const tooMany = Array.from({ length: 11 }, (_, i) => `t${i}`).join(",");
  assert.equal(validateVisualDraft({ ...base, tagsText: tooMany }, false), "标签最多 10 个。");
  const tooLong = "a".repeat(21);
  assert.equal(validateVisualDraft({ ...base, tagsText: tooLong }, false), "每个标签不超过 20 个字。");
});

test("aggregateUploadPercent: byte-weighted across multiple files", () => {
  assert.equal(aggregateUploadPercent([]), 0);
  assert.equal(
    aggregateUploadPercent([{ size: 100, loaded: 50 }, { size: 300, loaded: 300 }]),
    Math.round((350 / 400) * 100),
  );
  // clamps loaded to [0, size]
  assert.equal(aggregateUploadPercent([{ size: 100, loaded: 999 }]), 100);
});

test("countCompletedUploads: counts files whose loaded reached their size", () => {
  assert.equal(
    countCompletedUploads([{ size: 100, loaded: 100 }, { size: 50, loaded: 10 }, { size: 0, loaded: 0 }]),
    1,
  );
});

test("formatUploadProgressLabel", () => {
  assert.equal(formatUploadProgressLabel(1, 3, "现场_1.mp4"), "已传完 1 / 3 个 · 正在传 现场_1.mp4");
});

test("pruneVisualMetadata: drops keys outside the current subdomain and empty values", () => {
  assert.deepEqual(pruneVisualMetadata("", { mediaFormat: "地铁" }), {});
  assert.deepEqual(
    pruneVisualMetadata("OOH", { mediaFormat: "地铁", interactionType: [], techNotes: "  ", artType: "雕塑" }),
    { mediaFormat: "地铁" },
  );
  assert.deepEqual(
    pruneVisualMetadata("OOH", { mediaFormat: "地铁", interactionType: ["体感", "声音"] }),
    { mediaFormat: "地铁", interactionType: ["体感", "声音"] },
  );
});

test("pruneVisualMetadata: switching subdomain drops the old subdomain's whole field group", () => {
  const oohMeta = { mediaFormat: "地铁", techNotes: "LED" };
  assert.deepEqual(pruneVisualMetadata("RETAIL", oohMeta), {});
});

test("countFilledMetadata: counts non-empty fields for the given subdomain", () => {
  assert.equal(countFilledMetadata("", { mediaFormat: "地铁" }), 0);
  assert.equal(countFilledMetadata("OOH", {}), 0);
  assert.equal(countFilledMetadata("OOH", { mediaFormat: "地铁", interactionType: [] }), 1);
  assert.equal(countFilledMetadata("OOH", { mediaFormat: "地铁", interactionType: ["体感"] }), 2);
});
