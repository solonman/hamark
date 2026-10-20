// 复盘库文档逐页预览与卡片封面的纯函数（docs/26 4.3「全部在站内弹层预览」、10.2「封面图」，2026-10-20）：
// 数据万象提交计划的对象键、两个任务结果的收口（复用报告库的 mergeCiJobResults）、轮询节流、
// pages_json 读回时的键校验、封面选择顺序。不碰数据库和网络。
import assert from "node:assert/strict";
import test from "node:test";
import type { DocJobResult } from "../lib/report-ci";
import { CI_POLL_THROTTLE_MS, LARGE_IMAGE_PARAMS, SMALL_IMAGE_PARAMS, mergeCiJobResults } from "../lib/report-converter";
import { pickRetroCaseCover, type RetroCoverCandidate } from "../lib/retro/cover";
import {
  planRetroDocSubmission,
  retroDocPagesFromCi,
  retroDocPagesFromStored,
  shouldPollRetroDoc,
} from "../lib/retro/doc-preview";

const CASE = "rtc_1";
const ASSET = "rta_9";
const dir = `retro/cases/${CASE}/assets/${ASSET}/pages`;

test("the doc_jobs plan writes 1600w and 480w pages under the asset's own pages/ folder, source type from the file name", () => {
  const plan = planRetroDocSubmission({
    caseId: CASE,
    assetId: ASSET,
    objectKey: `retro/cases/${CASE}/assets/${ASSET}/original.pptx`,
    originalName: "提案 V3.PPTX",
  });
  assert.equal(plan.large.srcObjectKey, `retro/cases/${CASE}/assets/${ASSET}/original.pptx`);
  assert.equal(plan.large.srcType, "pptx");
  assert.equal(plan.small.srcType, "pptx");
  assert.equal(plan.large.outputObjectTemplate, `${dir}/p\${Number}@2x.jpg`);
  assert.equal(plan.small.outputObjectTemplate, `${dir}/p\${Number}.jpg`);
  assert.equal(plan.large.imageParams, LARGE_IMAGE_PARAMS);
  assert.equal(plan.small.imageParams, SMALL_IMAGE_PARAMS);
  assert.match(LARGE_IMAGE_PARAMS, /thumbnail\/1600x/);
  assert.match(SMALL_IMAGE_PARAMS, /thumbnail\/480x/);
  for (const [name, type] of [["brief.pdf", "pdf"], ["需求.doc", "doc"], ["报价.xlsx", "xlsx"], ["旧版.ppt", "ppt"]]) {
    assert.equal(planRetroDocSubmission({ caseId: CASE, assetId: ASSET, objectKey: "k", originalName: name }).large.srcType, type);
  }
});

const success = (pages: number[], total = pages.length, fail = 0): DocJobResult => ({
  state: "Success",
  totalPageCount: total,
  succPageCount: pages.length,
  failPageCount: fail,
  pages: pages.map((pageNo) => ({ pageNo, tgtUri: `/${dir}/p${pageNo}.jpg` })),
});
const successLarge = (pages: number[], total = pages.length): DocJobResult => ({
  state: "Success",
  totalPageCount: total,
  succPageCount: pages.length,
  failPageCount: 0,
  pages: pages.map((pageNo) => ({ pageNo, tgtUri: `${dir}/p${pageNo}@2x.jpg` })),
});

test("closing the two jobs: pending until both are terminal, any failed job fails the document, success stores per-page keys", () => {
  assert.deepEqual(mergeCiJobResults(ASSET, { state: "Running" }, success([1])), { kind: "pending" });
  assert.deepEqual(mergeCiJobResults(ASSET, successLarge([1]), { state: "Submitted" }), { kind: "pending" });

  const failed = mergeCiJobResults(ASSET, { state: "Failed", code: "DocProcessFailed", message: "文件已加密" }, success([1]));
  assert.equal(failed.kind, "failed");
  assert.match(failed.kind === "failed" ? failed.reason : "", /大图任务失败：文件已加密/);

  const merged = mergeCiJobResults(ASSET, successLarge([1, 2, 3], 3), success([1, 3], 3, 1));
  assert.equal(merged.kind, "ready");
  if (merged.kind !== "ready") return;
  assert.equal(merged.pageCount, 3);
  const stored = retroDocPagesFromCi(merged.pages);
  assert.deepEqual(stored, [
    { pageNo: 1, ok: true, thumbKey: `${dir}/p1.jpg`, largeKey: `${dir}/p1@2x.jpg` },
    { pageNo: 2, ok: false },
    { pageNo: 3, ok: true, thumbKey: `${dir}/p3.jpg`, largeKey: `${dir}/p3@2x.jpg` },
  ], "leading slash from TgtUri is dropped; a page missing either size is marked not ok and carries no keys");
});

test("reading pages_json back: own keys are kept, foreign or traversing keys fall back to the conventional names, junk is dropped", () => {
  const pages = retroDocPagesFromStored(JSON.stringify([
    { pageNo: 2, ok: true, thumbKey: "reports/other/pages/p2.jpg", largeKey: `${dir}/../../x@2x.jpg` },
    { pageNo: 1, ok: true, thumbKey: `${dir}/p1.jpg`, largeKey: `${dir}/p1@2x.jpg` },
    { pageNo: 3, ok: false },
    { pageNo: 1, ok: true },
    { pageNo: 0, ok: true },
    "garbage",
  ]), CASE, ASSET);
  assert.deepEqual(pages, [
    { pageNo: 1, ok: true, thumbKey: `${dir}/p1.jpg`, largeKey: `${dir}/p1@2x.jpg` },
    { pageNo: 2, ok: true, thumbKey: `${dir}/p2.jpg`, largeKey: `${dir}/p2@2x.jpg` },
    { pageNo: 3, ok: false, thumbKey: null, largeKey: null },
  ]);
  assert.deepEqual(retroDocPagesFromStored(null, CASE, ASSET), []);
  assert.deepEqual(retroDocPagesFromStored("{not json", CASE, ASSET), []);
});

test("polling follows the report library's throttle and only runs for PENDING documents with both jobs submitted", () => {
  const now = new Date("2026-10-20T08:00:00.000Z");
  const base = { derivativeStatus: "PENDING", ciJobLarge: "j-l", ciJobSmall: "j-s", ciCheckedAt: null as string | null };
  assert.equal(shouldPollRetroDoc(base, now), true);
  assert.equal(shouldPollRetroDoc({ ...base, ciCheckedAt: new Date(now.getTime() - 5_000).toISOString() }, now), false);
  assert.equal(shouldPollRetroDoc({ ...base, ciCheckedAt: new Date(now.getTime() - CI_POLL_THROTTLE_MS).toISOString() }, now), true);
  assert.equal(shouldPollRetroDoc({ ...base, ciJobSmall: null }, now), false, "not submitted yet: nothing to poll");
  assert.equal(shouldPollRetroDoc({ ...base, derivativeStatus: "READY" }, now), false);
  assert.equal(shouldPollRetroDoc({ ...base, derivativeStatus: "FAILED" }, now), false);
});

const candidate = (overrides: Partial<RetroCoverCandidate>): RetroCoverCandidate => ({
  id: "a",
  caseId: CASE,
  roundPosition: null,
  position: 0,
  type: "IMAGE",
  uploadStatus: "READY",
  derivativeStatus: "READY",
  thumbnailKey: null,
  firstPage: null,
  ...overrides,
});
const docPage = (assetId: string, ok = true) => ({
  pageNo: 1,
  ok,
  thumbKey: `retro/cases/${CASE}/assets/${assetId}/pages/p1.jpg`,
  largeKey: `retro/cases/${CASE}/assets/${assetId}/pages/p1@2x.jpg`,
});

test("cover order: need evidence first, then rounds by position, each by position; image beats video beats document", () => {
  const roundImage = candidate({ id: "r0img", roundPosition: 0, position: 0, thumbnailKey: "r0img-thumb" });
  const laterNeedImage = candidate({ id: "needImg2", position: 3, thumbnailKey: "needImg2-thumb" });
  const firstNeedImage = candidate({ id: "needImg1", position: 1, thumbnailKey: "needImg1-thumb" });
  const needVideo = candidate({ id: "needVid", type: "VIDEO", position: 0, thumbnailKey: "needVid-cover" });
  const needDoc = candidate({ id: "needDoc", type: "DOC", position: 0, firstPage: docPage("needDoc") });
  assert.deepEqual(pickRetroCaseCover([roundImage, laterNeedImage, needVideo, needDoc, firstNeedImage]), { key: "needImg1-thumb", kind: "IMAGE" });
  // 需求凭证没有图片：第 1 回合的图片仍然排在任何视频前面。
  assert.deepEqual(pickRetroCaseCover([needVideo, needDoc, roundImage]), { key: "r0img-thumb", kind: "IMAGE" });
  // 回合按 position，不按传入顺序。
  const round2Image = candidate({ id: "r2img", roundPosition: 2, position: 0, thumbnailKey: "r2img-thumb" });
  const round1Image = candidate({ id: "r1img", roundPosition: 1, position: 5, thumbnailKey: "r1img-thumb" });
  assert.deepEqual(pickRetroCaseCover([round2Image, round1Image]), { key: "r1img-thumb", kind: "IMAGE" });
  // 没有图片：第一个有截帧的视频。
  const laterVideo = candidate({ id: "r1vid", type: "VIDEO", roundPosition: 1, thumbnailKey: "r1vid-cover" });
  assert.deepEqual(pickRetroCaseCover([needDoc, laterVideo, needVideo]), { key: "needVid-cover", kind: "VIDEO" });
  // 再没有：第一个就绪文档第 1 页的小图。
  const roundDoc = candidate({ id: "rDoc", type: "DOC", roundPosition: 0, firstPage: docPage("rDoc") });
  assert.deepEqual(pickRetroCaseCover([roundDoc, needDoc]), { key: `retro/cases/${CASE}/assets/needDoc/pages/p1.jpg`, kind: "DOC" });
});

test("cover skips anything not ready, images without a thumbnail, videos without a frame and documents whose first page failed", () => {
  const notReady = [
    candidate({ id: "upl", uploadStatus: "UPLOADING", thumbnailKey: "x" }),
    candidate({ id: "pend", derivativeStatus: "PENDING", thumbnailKey: "y" }),
    candidate({ id: "fail", derivativeStatus: "FAILED", thumbnailKey: "z" }),
    candidate({ id: "noThumb", thumbnailKey: null }),
    candidate({ id: "vidNoFrame", type: "VIDEO", thumbnailKey: null }),
    candidate({ id: "docBad", type: "DOC", firstPage: docPage("docBad", false) }),
    candidate({ id: "docNone", type: "DOC", firstPage: null }),
    candidate({ id: "audio", type: "AUDIO", thumbnailKey: "never" }),
  ];
  assert.equal(pickRetroCaseCover(notReady), null);
  assert.equal(pickRetroCaseCover([]), null);
  // pages_json 里存了别的附件目录的键：按约定文件名重算，不签别人的对象。
  const foreign = candidate({ id: "docX", type: "DOC", firstPage: { pageNo: 1, ok: true, thumbKey: "retro/cases/other/assets/y/pages/p1.jpg" } });
  assert.deepEqual(pickRetroCaseCover([foreign]), { key: `retro/cases/${CASE}/assets/docX/pages/p1.jpg`, kind: "DOC" });
});
