import assert from "node:assert/strict";
import test from "node:test";
import { validateVisualMetadata, parseStoredVisualMetadataForDisplay, VISUAL_METADATA_TEXT_MAX } from "../lib/visual-metadata.ts";

test("OOH: single-select must be a known option, multi-select must be an array of known options", () => {
  const ok = validateVisualMetadata("OOH", {
    mediaFormat: "地铁",
    interactionType: ["体感", "声音"],
    techNotes: "LED、投影",
    campaignPeriod: "2026-05 至 2026-08",
  });
  assert.deepEqual(ok, {
    ok: true,
    metadata: {
      mediaFormat: "地铁",
      interactionType: ["体感", "声音"],
      techNotes: "LED、投影",
      campaignPeriod: "2026-05 至 2026-08",
    },
  });

  assert.deepEqual(validateVisualMetadata("OOH", { mediaFormat: "火星基地" }), {
    ok: false,
    error: "「媒体形式」的取值不在可选项里。",
  });
  assert.deepEqual(validateVisualMetadata("OOH", { interactionType: "体感" }), {
    ok: false,
    error: "「互动方式」应该是多选，请重新提交。",
  });
  assert.deepEqual(validateVisualMetadata("OOH", { interactionType: ["体感", "隔空取物"] }), {
    ok: false,
    error: "「互动方式」的取值不在可选项里。",
  });
});

test("multi-select values are deduplicated, keeping the first occurrence's order", () => {
  const result = validateVisualMetadata("OOH", { interactionType: ["声音", "体感", "声音", "AR"] });
  assert.deepEqual(result, { ok: true, metadata: { interactionType: ["声音", "体感", "AR"] } });
});

test("unknown keys are rejected and the offending key is named, for every subdomain", () => {
  assert.deepEqual(validateVisualMetadata("OOH", { interactive: "true" }), {
    ok: false,
    error: "补充信息里有一个不认识的字段：interactive。",
  });
  assert.deepEqual(validateVisualMetadata("RETAIL", { brandName: "某品牌" }), {
    ok: false,
    error: "补充信息里有一个不认识的字段：brandName。",
  });
  assert.deepEqual(validateVisualMetadata("PUBLIC_ART", { color: "红色" }), {
    ok: false,
    error: "补充信息里有一个不认识的字段：color。",
  });
});

test("PUBLIC_ART: text fields trim and enforce the length cap, single-select checked against its options", () => {
  const ok = validateVisualMetadata("PUBLIC_ART", {
    artType: "雕塑",
    materials: "  不锈钢  ",
    scale: "12m × 4m × 6m",
    permanence: "永久",
    commissioner: "市政公共艺术办公室",
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.metadata.materials, "不锈钢");
  }

  assert.deepEqual(validateVisualMetadata("PUBLIC_ART", { permanence: "半永久" }), {
    ok: false,
    error: "「是否永久」的取值不在可选项里。",
  });
  assert.deepEqual(
    validateVisualMetadata("PUBLIC_ART", { materials: "字".repeat(VISUAL_METADATA_TEXT_MAX + 1) }),
    { ok: false, error: `「材质」最多 ${VISUAL_METADATA_TEXT_MAX} 字。` },
  );
  // 刚好到上限是允许的。
  assert.equal(
    validateVisualMetadata("PUBLIC_ART", { materials: "字".repeat(VISUAL_METADATA_TEXT_MAX) }).ok,
    true,
  );
});

test("RETAIL: single-select and free-text fields round-trip", () => {
  const ok = validateVisualMetadata("RETAIL", {
    displayVenue: "橱窗",
    displayPeriod: "2026 圣诞季",
    displayMaterials: "亚克力、灯箱布",
    producer: "某展陈公司",
  });
  assert.deepEqual(ok, {
    ok: true,
    metadata: {
      displayVenue: "橱窗",
      displayPeriod: "2026 圣诞季",
      displayMaterials: "亚克力、灯箱布",
      producer: "某展陈公司",
    },
  });
  assert.deepEqual(validateVisualMetadata("RETAIL", { displayVenue: "总部大楼" }), {
    ok: false,
    error: "「展陈位置」的取值不在可选项里。",
  });
});

test("empty values (blank strings, empty arrays, missing keys) do not write a key", () => {
  const result = validateVisualMetadata("OOH", {
    mediaFormat: "   ",
    interactionType: [],
    techNotes: undefined,
  });
  assert.deepEqual(result, { ok: true, metadata: {} });
});

test("an empty/non-object input validates to an empty metadata object, not an error", () => {
  assert.deepEqual(validateVisualMetadata("OOH", {}), { ok: true, metadata: {} });
  assert.deepEqual(validateVisualMetadata("OOH", null), { ok: true, metadata: {} });
  assert.deepEqual(validateVisualMetadata("OOH", undefined), { ok: true, metadata: {} });
  assert.deepEqual(validateVisualMetadata("OOH", "not an object"), { ok: true, metadata: {} });
  // 数组不是纯对象（Array.isArray 命中），按空输入处理，不会把索引当成键名报错。
  assert.deepEqual(validateVisualMetadata("OOH", ["array"]), { ok: true, metadata: {} });
});

// ---------------------------------------------------------------------------
// 读库时的展示口径：未知键（旧版本遗留）保留在库里，但展示只返回已认识的键。
// ---------------------------------------------------------------------------

test("stale unknown keys from a prior schema (e.g. the removed OOH `interactive` field) are dropped from the display view", () => {
  const stored = JSON.stringify({ mediaFormat: "地铁", interactive: "true" });
  assert.deepEqual(parseStoredVisualMetadataForDisplay("OOH", stored), { mediaFormat: "地铁" });
});

test("stale unknown keys from RETAIL's removed `brandName` field are dropped too", () => {
  const stored = JSON.stringify({ displayVenue: "门头", brandName: "某品牌" });
  assert.deepEqual(parseStoredVisualMetadataForDisplay("RETAIL", stored), { displayVenue: "门头" });
});

test("display parsing is defensive: malformed JSON, non-object JSON, and wrong-shaped values for a field type are all skipped instead of throwing", () => {
  assert.deepEqual(parseStoredVisualMetadataForDisplay("OOH", "not json"), {});
  assert.deepEqual(parseStoredVisualMetadataForDisplay("OOH", "[1,2,3]"), {});
  assert.deepEqual(
    parseStoredVisualMetadataForDisplay("OOH", JSON.stringify({ interactionType: "not-an-array" })),
    {},
  );
  assert.deepEqual(
    parseStoredVisualMetadataForDisplay("OOH", JSON.stringify({ mediaFormat: 12345 })),
    {},
  );
});

test("display parsing keeps multi-select arrays, filtering out non-string entries", () => {
  const stored = JSON.stringify({ interactionType: ["体感", 42, "声音", null] });
  assert.deepEqual(parseStoredVisualMetadataForDisplay("OOH", stored), { interactionType: ["体感", "声音"] });
});
