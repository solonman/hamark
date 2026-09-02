import assert from "node:assert/strict";
import test from "node:test";
import {
  canManageReport,
  canRetryReportStatus,
  isReportFeatureEnabled,
  isReportReady,
  isReportStatus,
  isValidTaskType,
  normalizeReportTags,
  REPORT_MAX_TAGS,
  REPORT_MAX_UPLOAD_BYTES,
  ReportServiceError,
  sourceFormatOf,
  tagsFromJson,
  TASK_TYPES,
  validateReportUpload,
} from "../lib/report-model.ts";

test("only PPT/PPTX/PDF are recognised, extension first and content-type as fallback", () => {
  assert.equal(sourceFormatOf("红谷滩策略.ppt", "application/octet-stream"), "PPT");
  assert.equal(sourceFormatOf("浦江镇提报.pptx", ""), "PPTX");
  assert.equal(sourceFormatOf("北蔡月度总结.PDF", null), "PDF");
  // 扩展名认不出来时才看 content-type。
  assert.equal(sourceFormatOf("没有扩展名的文件", "application/pdf"), "PDF");
  assert.equal(
    sourceFormatOf("没有扩展名", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    "PPTX",
  );
  assert.equal(sourceFormatOf("没有扩展名", "application/vnd.ms-powerpoint"), "PPT");
  // 两边都对不上已知格式，拒绝。
  assert.equal(sourceFormatOf("笔记.docx", "application/msword"), null);
  assert.equal(sourceFormatOf("archive.zip", "application/zip"), null);
  assert.equal(sourceFormatOf("", ""), null);
});

test("report status names and the two gates derived from them", () => {
  assert.ok(isReportStatus("UPLOADING"));
  assert.ok(isReportStatus("READY"));
  assert.equal(isReportStatus("DONE"), false);
  assert.equal(isReportStatus(""), false);

  // 只有就绪的报告可以收藏／进入工作台。
  assert.ok(isReportReady("READY"));
  for (const status of ["UPLOADING", "QUEUED", "PROCESSING", "FAILED"]) {
    assert.equal(isReportReady(status), false, status);
  }

  // 只有失败的报告可以重试。
  assert.ok(canRetryReportStatus("FAILED"));
  for (const status of ["UPLOADING", "QUEUED", "PROCESSING", "READY"]) {
    assert.equal(canRetryReportStatus(status), false, status);
  }
});

test("task type is a fixed five-way choice, decided at upload time", () => {
  assert.deepEqual(TASK_TYPES, ["宣发企划", "故事线", "宣发阶段性提报", "月度总结报告", "专项宣发方案"]);
  for (const type of TASK_TYPES) {
    assert.ok(isValidTaskType(type), type);
  }
  assert.equal(isValidTaskType("其他"), false);
  assert.equal(isValidTaskType(""), false);
  assert.equal(isValidTaskType(undefined), false);
  assert.equal(isValidTaskType(3), false);
});

test("upload validation rejects before anything touches the database", () => {
  const ok = validateReportUpload({ originalName: "浦江镇提报.pptx", contentType: "", fileSize: 1024 });
  assert.deepEqual(ok, { ok: true, sourceFormat: "PPTX" });

  assert.deepEqual(
    validateReportUpload({ originalName: "  ", contentType: "", fileSize: 1024 }),
    { ok: false, error: "请选择要上传的报告文件。" },
  );
  assert.deepEqual(
    validateReportUpload({ originalName: "a.pdf", contentType: "", fileSize: 0 }),
    { ok: false, error: "无法识别文件大小，请重新选择文件。" },
  );
  assert.deepEqual(
    validateReportUpload({ originalName: "a.pdf", contentType: "", fileSize: Number.NaN }),
    { ok: false, error: "无法识别文件大小，请重新选择文件。" },
  );
  assert.deepEqual(
    validateReportUpload({ originalName: "a.pdf", contentType: "", fileSize: REPORT_MAX_UPLOAD_BYTES + 1 }),
    { ok: false, error: "原件不能超过 200 MB，版式要求高的建议直接传 PDF。" },
  );
  // 刚好 200 MB 是允许的，只有超过才拒绝。
  assert.equal(
    validateReportUpload({ originalName: "a.pdf", contentType: "", fileSize: REPORT_MAX_UPLOAD_BYTES }).ok,
    true,
  );
  assert.deepEqual(
    validateReportUpload({ originalName: "笔记.docx", contentType: "application/msword", fileSize: 1024 }),
    { ok: false, error: "只接受 PPT、PPTX 或 PDF 格式的报告文件。" },
  );
});

test("tags are trimmed, deduplicated of blanks, and capped", () => {
  assert.deepEqual(normalizeReportTags(["  住宅  ", "", "  ", "商业"]), ["住宅", "商业"]);
  assert.equal(normalizeReportTags(null).length, 0);
  assert.equal(normalizeReportTags(undefined).length, 0);
  const many = Array.from({ length: REPORT_MAX_TAGS + 5 }, (_, index) => `标签${index}`);
  assert.equal(normalizeReportTags(many).length, REPORT_MAX_TAGS);
});

test("tags_json parses defensively, same contract as the video list route", () => {
  assert.deepEqual(tagsFromJson('["住宅","商业"]'), ["住宅", "商业"]);
  assert.deepEqual(tagsFromJson('["住宅", 1, null, "商业"]'), ["住宅", "商业"]);
  assert.deepEqual(tagsFromJson("not json"), []);
  assert.deepEqual(tagsFromJson("{}"), []);
});

test("only the uploader or an admin may manage a report", () => {
  const report = { createdByEmail: "owner@example.com" };
  assert.ok(canManageReport(report, { identityKey: "owner@example.com" }));
  assert.equal(canManageReport(report, { identityKey: "someone-else@example.com" }), false);
  assert.ok(canManageReport(report, { identityKey: "someone-else@example.com", isAdmin: true }));
});

test("the feature flag is an exact string match against the environment, nothing else enables it", () => {
  const original = process.env.REPORT_LIBRARY_UI_ENABLED;
  try {
    delete process.env.REPORT_LIBRARY_UI_ENABLED;
    assert.equal(isReportFeatureEnabled(), false);
    process.env.REPORT_LIBRARY_UI_ENABLED = "false";
    assert.equal(isReportFeatureEnabled(), false);
    process.env.REPORT_LIBRARY_UI_ENABLED = "1";
    assert.equal(isReportFeatureEnabled(), false);
    process.env.REPORT_LIBRARY_UI_ENABLED = "true";
    assert.equal(isReportFeatureEnabled(), true);
  } finally {
    if (original === undefined) delete process.env.REPORT_LIBRARY_UI_ENABLED;
    else process.env.REPORT_LIBRARY_UI_ENABLED = original;
  }
});

test("a service error carries its own HTTP status so routes don't have to guess", () => {
  const withStatus = new ReportServiceError("报告不存在。", 404);
  assert.equal(withStatus.status, 404);
  assert.equal(withStatus.message, "报告不存在。");
  const defaulted = new ReportServiceError("参数不对。");
  assert.equal(defaulted.status, 400);
});
