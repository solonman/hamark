import assert from "node:assert/strict";
import test from "node:test";
import { VISUAL_LIMITS } from "../lib/visual-contract.ts";
import {
  canManageVisualCase,
  computeVisualCarrierCounts,
  countVisualAssetsByType,
  formatVisualOversizeReason,
  isOversizedForVisualDerivative,
  isValidVisualAssetOrder,
  isVisualUpdatedAtStale,
  pickVisualCover,
  validateNewVisualAssets,
  validateVisualCaseFields,
  visualCoverObjectKey,
  visualDisplayObjectKey,
  visualObjectExtension,
  visualOriginalObjectKey,
  visualThumbObjectKey,
  VisualServiceError,
} from "../lib/visual-model.ts";

const baseFields = () => ({
  subdomain: "OOH" as const,
  title: "地铁互动装置",
  location: "上海 · 人民广场站",
  tags: ["互动装置"],
  metadata: {},
});

// ---------------------------------------------------------------------------
// 文本字段校验：顺序与提示跟前端一致（规格五）。
// ---------------------------------------------------------------------------

test("a service error carries its own HTTP status so routes don't have to guess", () => {
  const withStatus = new VisualServiceError("案例不存在。", 404);
  assert.equal(withStatus.status, 404);
  assert.equal(withStatus.message, "案例不存在。");
  const defaulted = new VisualServiceError("参数不对。");
  assert.equal(defaulted.status, 400);
});

test("subdomain must be one of the fixed three, checked first", () => {
  assert.deepEqual(validateVisualCaseFields({ ...baseFields(), subdomain: "SPACE" as never }), {
    ok: false,
    error: "请选择子领域。",
  });
});

test("title is required before location, tags, or anything else", () => {
  assert.deepEqual(validateVisualCaseFields({ ...baseFields(), title: "" }), {
    ok: false,
    error: "请填写标题。",
  });
  assert.deepEqual(validateVisualCaseFields({ ...baseFields(), title: "   " }), {
    ok: false,
    error: "请填写标题。",
  });
});

test("location (采集地点) is required, checked after title", () => {
  assert.deepEqual(validateVisualCaseFields({ ...baseFields(), location: "" }), {
    ok: false,
    error: "请填写采集地点，写到城市即可。",
  });
});

test("tags: at least one, at most 10, each at most 20 characters — in that order", () => {
  assert.deepEqual(validateVisualCaseFields({ ...baseFields(), tags: [] }), {
    ok: false,
    error: "至少填一个标签。",
  });
  // tags 在接口边界已经是数组（约定文件 VisualCaseFieldsInput.tags: string[]）；
  // 逗号分隔字符串的拆分是 parseVisualTags 对“单个字符串”输入的行为，这里给的是
  // 全部 trim 后为空的数组元素，验证空白标签仍然会被过滤到「一个都没有」。
  assert.deepEqual(validateVisualCaseFields({ ...baseFields(), tags: ["", "   ", "\n"] }), {
    ok: false,
    error: "至少填一个标签。",
  });
  const tooMany = Array.from({ length: VISUAL_LIMITS.tagsMax + 1 }, (_, index) => `标签${index}`);
  assert.deepEqual(validateVisualCaseFields({ ...baseFields(), tags: tooMany }), {
    ok: false,
    error: `标签最多 ${VISUAL_LIMITS.tagsMax} 个。`,
  });
  assert.deepEqual(
    validateVisualCaseFields({ ...baseFields(), tags: ["字".repeat(VISUAL_LIMITS.tagLengthMax + 1)] }),
    { ok: false, error: `每个标签不超过 ${VISUAL_LIMITS.tagLengthMax} 个字。` },
  );
});

test("tags are normalized through parseVisualTags: trimmed, deduplicated case/space-insensitively, keeping the first-written form", () => {
  const result = validateVisualCaseFields({ ...baseFields(), tags: ["裸眼 3D", "裸眼3d", "", "互动"] });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.fields.tags, ["裸眼 3D", "互动"]);
});

test("a single comma-separated string (as parseVisualTags would receive from a raw text field) is also split and normalized", () => {
  const result = validateVisualCaseFields({ ...baseFields(), tags: "裸眼 3D，裸眼3d, ,互动" as unknown as string[] });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.fields.tags, ["裸眼 3D", "互动"]);
});

test("length caps are checked after the required fields and tags, before the source URL format", () => {
  assert.deepEqual(
    validateVisualCaseFields({ ...baseFields(), title: "字".repeat(VISUAL_LIMITS.titleMax + 1) }),
    { ok: false, error: `标题最多 ${VISUAL_LIMITS.titleMax} 字。` },
  );
  assert.deepEqual(
    validateVisualCaseFields({ ...baseFields(), location: "字".repeat(VISUAL_LIMITS.locationMax + 1) }),
    { ok: false, error: `采集地点最多 ${VISUAL_LIMITS.locationMax} 字。` },
  );
  assert.deepEqual(
    validateVisualCaseFields({ ...baseFields(), creator: "字".repeat(VISUAL_LIMITS.creatorMax + 1) }),
    { ok: false, error: `创作方／品牌最多 ${VISUAL_LIMITS.creatorMax} 字。` },
  );
  assert.deepEqual(
    validateVisualCaseFields({ ...baseFields(), summary: "字".repeat(VISUAL_LIMITS.summaryMax + 1) }),
    { ok: false, error: `一句话摘要最多 ${VISUAL_LIMITS.summaryMax} 字。` },
  );
  assert.deepEqual(
    validateVisualCaseFields({ ...baseFields(), textBody: "字".repeat(VISUAL_LIMITS.textBodyMax + 1) }),
    { ok: false, error: `案例简介最多 ${VISUAL_LIMITS.textBodyMax} 字。` },
  );
  assert.deepEqual(
    validateVisualCaseFields({ ...baseFields(), sourceUrl: `https://example.com/${"a".repeat(VISUAL_LIMITS.sourceUrlMax)}` }),
    { ok: false, error: `来源链接最多 ${VISUAL_LIMITS.sourceUrlMax} 字。` },
  );
});

test("source URL only accepts http:// or https://, checked last", () => {
  assert.deepEqual(validateVisualCaseFields({ ...baseFields(), sourceUrl: "javascript:alert(1)" }), {
    ok: false,
    error: "来源链接只收 http:// 或 https:// 开头的网址。",
  });
  assert.deepEqual(validateVisualCaseFields({ ...baseFields(), sourceUrl: "ftp://example.com/a" }), {
    ok: false,
    error: "来源链接只收 http:// 或 https:// 开头的网址。",
  });
  assert.equal(validateVisualCaseFields({ ...baseFields(), sourceUrl: "https://example.com" }).ok, true);
  // 留空不校验协议。
  assert.equal(validateVisualCaseFields({ ...baseFields(), sourceUrl: "" }).ok, true);
});

test("rights note defaults to the standard sentence when left blank, but keeps a custom rewrite", () => {
  const defaulted = validateVisualCaseFields({ ...baseFields(), rightsNote: "" });
  assert.equal(defaulted.ok, true);
  if (defaulted.ok) assert.equal(defaulted.fields.rightsNote, "仅公司内部学习使用");

  const custom = validateVisualCaseFields({ ...baseFields(), rightsNote: "版权归原作者所有" });
  assert.equal(custom.ok, true);
  if (custom.ok) assert.equal(custom.fields.rightsNote, "版权归原作者所有");
});

test("a fully valid submission normalizes every field", () => {
  const result = validateVisualCaseFields({
    subdomain: "RETAIL",
    title: "  橱窗陈列  ",
    location: "  成都 · 太古里  ",
    tags: ["橱窗", "圣诞"],
    textBody: "现场很好看\n第二行",
    summary: "冬季主题橱窗",
    creator: "某品牌",
    occurredAt: "2026-12",
    sourceUrl: "https://example.com/case",
    rightsNote: "",
    metadata: {},
  });
  assert.deepEqual(result, {
    ok: true,
    fields: {
      subdomain: "RETAIL",
      title: "橱窗陈列",
      location: "成都 · 太古里",
      tags: ["橱窗", "圣诞"],
      textBody: "现场很好看\n第二行",
      summary: "冬季主题橱窗",
      creator: "某品牌",
      occurredAt: "2026-12",
      sourceUrl: "https://example.com/case",
      rightsNote: "仅公司内部学习使用",
    },
  });
});

// ---------------------------------------------------------------------------
// 素材数量与格式校验（规格 3.2、3.8、五）。
// ---------------------------------------------------------------------------

const video = (name = "a.mp4") => ({ type: "VIDEO" as const, originalName: name, contentType: "video/mp4", fileSize: 1000 });
const image = (name = "a.jpg") => ({ type: "IMAGE" as const, originalName: name, contentType: "image/jpeg", fileSize: 1000 });

test("at least one video or image is required — the very first gate, before subdomain/title/etc.", () => {
  assert.deepEqual(validateNewVisualAssets([]), { ok: false, error: "请先选择视频或图片，至少一个。" });
});

test("adding assets to an already-populated case only requires the combined total, not a fresh non-empty batch", () => {
  assert.deepEqual(validateNewVisualAssets([], { videos: 1, images: 0 }), { ok: true });
});

test("asset type must be VIDEO or IMAGE", () => {
  const result = validateNewVisualAssets([{ ...video(), type: "AUDIO" as never }]);
  assert.deepEqual(result, { ok: false, error: "素材类型只能是视频或图片。" });
});

test("images must pass the allowed-format check (isAllowedVisualImage)", () => {
  const svg = { type: "IMAGE" as const, originalName: "logo.svg", contentType: "image/svg+xml", fileSize: 100 };
  const result = validateNewVisualAssets([svg]);
  assert.deepEqual(result, { ok: false, error: "不支持的图片格式：logo.svg。" });

  const heic = { type: "IMAGE" as const, originalName: "photo.heic", contentType: "", fileSize: 100 };
  assert.equal(validateNewVisualAssets([heic]).ok, true);
});

test("caps: at most 12 videos, 24 images, 36 combined, counted as existing + new", () => {
  const thirteenVideos = Array.from({ length: 13 }, (_, index) => video(`v${index}.mp4`));
  assert.deepEqual(validateNewVisualAssets(thirteenVideos), {
    ok: false,
    error: `每条案例最多 ${VISUAL_LIMITS.videos} 段视频。`,
  });

  const twentyFiveImages = Array.from({ length: 25 }, (_, index) => image(`i${index}.jpg`));
  assert.deepEqual(validateNewVisualAssets(twentyFiveImages), {
    ok: false,
    error: `每条案例最多 ${VISUAL_LIMITS.images} 张图片。`,
  });

  // 各自没超上限，但加上已有的会超过合计 36（这里放宽个别上限走合计分支不现实，
  // 因为 12+24=36 恰好等于合计上限；用「已有」把合计推过界来触发这一分支）。
  assert.deepEqual(validateNewVisualAssets([video("v1.mp4")], { videos: 12, images: 24 }), {
    ok: false,
    error: `每条案例最多 ${VISUAL_LIMITS.videos} 段视频。`,
  });

  // 恰好 12/24/36 是允许的。
  const exactVideos = Array.from({ length: 12 }, (_, index) => video(`v${index}.mp4`));
  assert.equal(validateNewVisualAssets(exactVideos).ok, true);
});

test("countVisualAssetsByType tallies videos and images independently", () => {
  assert.deepEqual(countVisualAssetsByType([video(), video(), image()]), { videos: 2, images: 1 });
  assert.deepEqual(countVisualAssetsByType([]), { videos: 0, images: 0 });
});

// ---------------------------------------------------------------------------
// 权限判定（规格 3.6）。
// ---------------------------------------------------------------------------

test("only the uploader or an admin may manage a case", () => {
  const visualCase = { createdByEmail: "owner@example.com" };
  assert.ok(canManageVisualCase(visualCase, { identityKey: "owner@example.com" }));
  assert.equal(canManageVisualCase(visualCase, { identityKey: "someone-else@example.com" }), false);
  assert.ok(canManageVisualCase(visualCase, { identityKey: "someone-else@example.com", isAdmin: true }));
});

// ---------------------------------------------------------------------------
// 封面取舍（规格 3.2 第 4、5 条；决定 #13）：第一位已传完的素材，没有别的规则。
// ---------------------------------------------------------------------------

test("the cover is the first-position READY asset, regardless of type", () => {
  const assets = [
    { id: "a", position: 2, uploadStatus: "READY" },
    { id: "b", position: 0, uploadStatus: "UPLOADING" },
    { id: "c", position: 1, uploadStatus: "READY" },
  ];
  assert.equal(pickVisualCover(assets)?.id, "c");
});

test("no cover when nothing has finished uploading yet", () => {
  assert.equal(pickVisualCover([{ position: 0, uploadStatus: "UPLOADING" }]), null);
  assert.equal(pickVisualCover([]), null);
});

test("moving an asset to position 0 makes it the cover — 'set as cover' is just a reorder", () => {
  const before = [
    { id: "video", position: 0, uploadStatus: "READY" },
    { id: "image", position: 1, uploadStatus: "READY" },
  ];
  assert.equal(pickVisualCover(before)?.id, "video");
  const after = [
    { id: "video", position: 1, uploadStatus: "READY" },
    { id: "image", position: 0, uploadStatus: "READY" },
  ];
  assert.equal(pickVisualCover(after)?.id, "image");
});

// ---------------------------------------------------------------------------
// 载体计数（规格 3.2 第 2 条）：READY 按已传完的算；UPLOADING 按计划上传的全部算。
// ---------------------------------------------------------------------------

test("carrier counts: multi-video, image-only, and mixed cases", () => {
  const multiVideo = [
    { type: "VIDEO" as const, uploadStatus: "READY" as const },
    { type: "VIDEO" as const, uploadStatus: "READY" as const },
  ];
  assert.deepEqual(computeVisualCarrierCounts(multiVideo, "READY", false), { videos: 2, images: 0, hasBrief: false });

  const imageOnly = [
    { type: "IMAGE" as const, uploadStatus: "READY" as const },
    { type: "IMAGE" as const, uploadStatus: "READY" as const },
    { type: "IMAGE" as const, uploadStatus: "READY" as const },
  ];
  assert.deepEqual(computeVisualCarrierCounts(imageOnly, "READY", false), { videos: 0, images: 3, hasBrief: false });

  const mixed = [
    { type: "VIDEO" as const, uploadStatus: "READY" as const },
    { type: "IMAGE" as const, uploadStatus: "READY" as const },
    { type: "IMAGE" as const, uploadStatus: "READY" as const },
  ];
  assert.deepEqual(computeVisualCarrierCounts(mixed, "READY", true), { videos: 1, images: 2, hasBrief: true });
});

test("an UPLOADING case counts every planned asset, including ones still mid-upload", () => {
  const assets = [
    { type: "VIDEO" as const, uploadStatus: "READY" as const },
    { type: "IMAGE" as const, uploadStatus: "UPLOADING" as const },
  ];
  assert.deepEqual(computeVisualCarrierCounts(assets, "UPLOADING", false), { videos: 1, images: 1, hasBrief: false });
});

test("a READY case only counts READY assets — new assets added afterward don't show up until they finish", () => {
  const assets = [
    { type: "VIDEO" as const, uploadStatus: "READY" as const },
    { type: "IMAGE" as const, uploadStatus: "UPLOADING" as const },
  ];
  assert.deepEqual(computeVisualCarrierCounts(assets, "READY", false), { videos: 1, images: 0, hasBrief: false });
});

// ---------------------------------------------------------------------------
// 乐观锁（规格五 PATCH）：updatedAt 对不上库里当前值就是冲突。
// ---------------------------------------------------------------------------

test("isVisualUpdatedAtStale: a mismatched updatedAt is a conflict, a matching one is not", () => {
  assert.equal(isVisualUpdatedAtStale("2026-09-19T08:00:00.000Z", "2026-09-19T08:00:00.000Z"), false);
  assert.equal(isVisualUpdatedAtStale("2026-09-19T08:00:00.000Z", "2026-09-19T07:59:59.000Z"), true);
  // 别人在打开表单和保存之间又改了一次：库里已经推进到新时间，携带的还是旧时间。
  assert.equal(isVisualUpdatedAtStale("2026-09-19T08:05:00.000Z", "2026-09-19T08:00:00.000Z"), true);
});

// ---------------------------------------------------------------------------
// 素材顺序（规格五 PATCH assetOrder）：必须恰好是当前全部素材 id 的一个排列。
// ---------------------------------------------------------------------------

test("assetOrder must be an exact permutation of the current asset ids", () => {
  assert.ok(isValidVisualAssetOrder(["a", "b", "c"], ["c", "a", "b"]));
  assert.equal(isValidVisualAssetOrder(["a", "b", "c"], ["a", "b"]), false, "missing an id");
  assert.equal(isValidVisualAssetOrder(["a", "b", "c"], ["a", "b", "c", "d"]), false, "extra id");
  assert.equal(isValidVisualAssetOrder(["a", "b", "c"], ["a", "a", "b"]), false, "duplicate id, wrong length anyway");
  assert.equal(isValidVisualAssetOrder(["a", "b"], ["a", "a"]), false, "duplicate id, same length");
  assert.equal(isValidVisualAssetOrder(["a", "b", "c"], ["a", "b", "x"]), false, "unknown id");
  assert.ok(isValidVisualAssetOrder([], []));
});

// ---------------------------------------------------------------------------
// 对象键工具（规格 4.3）。
// ---------------------------------------------------------------------------

test("object key layout: visual/{caseId}/{assetId}/original.{ext}, cover.jpg, thumb.jpg, display.jpg", () => {
  assert.equal(visualOriginalObjectKey("case1", "asset1", "现场视频.MP4"), "visual/case1/asset1/original.mp4");
  assert.equal(visualCoverObjectKey("case1", "asset1"), "visual/case1/asset1/cover.jpg");
  assert.equal(visualThumbObjectKey("case1", "asset1"), "visual/case1/asset1/thumb.jpg");
  assert.equal(visualDisplayObjectKey("case1", "asset1"), "visual/case1/asset1/display.jpg");
});

test("extension is lower-cased and cleaned from the original filename; missing/unrecognizable falls back to bin", () => {
  assert.equal(visualObjectExtension("photo.JPEG"), "jpeg");
  assert.equal(visualObjectExtension("a.b.HEIC"), "heic");
  assert.equal(visualObjectExtension("no-extension"), "bin");
  assert.equal(visualObjectExtension(""), "bin");
  assert.equal(visualObjectExtension(null), "bin");
  assert.equal(visualObjectExtension(undefined), "bin");
  assert.equal(visualObjectExtension("trailing-dot."), "bin");
  // 扩展名里混了奇怪字符也被清洗掉。
  assert.equal(visualObjectExtension("file.m p4"), "mp4");
});

// ---------------------------------------------------------------------------
// 20 MB 派生图上限（规格 3.5）。
// ---------------------------------------------------------------------------

test("images at or under the 20 MB cap are eligible for derivative generation; over it, they are not", () => {
  assert.equal(isOversizedForVisualDerivative(VISUAL_LIMITS.derivativeMaxBytes), false);
  assert.equal(isOversizedForVisualDerivative(VISUAL_LIMITS.derivativeMaxBytes + 1), true);
});

test("the oversize reason reports the original size to one decimal place in MB", () => {
  const bytes = 26.3 * 1024 * 1024;
  assert.equal(formatVisualOversizeReason(bytes), "原图 26.3 MB，超过 20 MB 的处理上限；可以查看原图");
});
