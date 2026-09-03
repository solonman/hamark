import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { emptyCaseEngagement, type CaseEngagement } from "../lib/case-engagement.ts";
import type { ReportListItem } from "../lib/report-model.ts";
import {
  applyFrozenReportOrder,
  filterReports,
  formatReportCardTime,
  freezeReportOrder,
  hasPendingConversion,
  matchesReportQuery,
  reportEnterLabel,
  reportEngagementFallback,
  reportFormatBadgeLabel,
  reportProcessingPercent,
  reportStatusLabel,
  reportVersionSummaryLabel,
  reportWeeklyGroups,
} from "../lib/report-library-view.ts";

/** 造一份最小可用的 ReportListItem，测试只关心用到的字段。 */
function makeReport(overrides: Partial<ReportListItem>): ReportListItem {
  return {
    id: "rpt-1",
    title: "测试报告",
    taskType: "宣发企划",
    tags: [],
    status: "READY",
    sourceFormat: "PDF",
    originalName: "a.pdf",
    contentType: "application/pdf",
    fileSize: 100,
    pageCount: 10,
    pagesDone: 10,
    failReason: null,
    coverUrl: null,
    versionSummary: { count: 0, latestOwnerName: null, latestUpdatedAt: null },
    createdByName: "老孙",
    createdAt: "2026-09-01T02:00:00.000Z",
    updatedAt: "2026-09-01T02:00:00.000Z",
    ...overrides,
  };
}

test("search matches title, task type, uploader and tags, not other fields", () => {
  const report = makeReport({
    title: "世纪地产红谷滩项目推广案 CBD",
    taskType: "宣发企划",
    createdByName: "王策划",
    tags: ["城市综合体", "竞标提报"],
  });
  assert.ok(matchesReportQuery(report, "红谷滩"));
  assert.ok(matchesReportQuery(report, "宣发企划"));
  assert.ok(matchesReportQuery(report, "王策划"));
  assert.ok(matchesReportQuery(report, "竞标"));
  // 大小写、半角全角都不该影响命中（与 lib/v04-ui-client-state.ts 同一归一化）。
  assert.ok(matchesReportQuery(report, "cbd"));
  assert.ok(matchesReportQuery(report, "ＣＢＤ"));
  assert.ok(matchesReportQuery(report, ""));
  assert.equal(matchesReportQuery(report, "浦江镇"), false);

  const filtered = filterReports([report, makeReport({ id: "rpt-2", title: "不相关的报告" })], "红谷滩");
  assert.deepEqual(filtered.map((item) => item.id), ["rpt-1"]);
});

test("status and enter-button copy never leak the English state codes", () => {
  const labels = {
    READY: reportStatusLabel("READY"),
    QUEUED: reportStatusLabel("QUEUED"),
    PROCESSING: reportStatusLabel("PROCESSING"),
    FAILED: reportStatusLabel("FAILED"),
    UPLOADING: reportStatusLabel("UPLOADING"),
  };
  assert.deepEqual(labels, {
    READY: "可拆解",
    QUEUED: "排队中",
    PROCESSING: "转换中",
    FAILED: "转换失败",
    UPLOADING: "上传未完成",
  });
  for (const label of Object.values(labels)) {
    assert.doesNotMatch(label, /READY|QUEUED|PROCESSING|FAILED|UPLOADING/);
  }

  assert.equal(reportEnterLabel("READY"), "进入工作台");
  assert.equal(reportEnterLabel("PROCESSING"), "生成页图中");
  assert.equal(reportEnterLabel("QUEUED"), "等待转换");
  assert.equal(reportEnterLabel("FAILED"), "转换失败");
  // UPLOADING 是「文件没传完」，不是「排完队等转换」，按钮文案不能跟 QUEUED 混用。
  assert.equal(reportEnterLabel("UPLOADING"), "上传未完成");
});

test("processing percent is clamped between 3 and 100, and never divides by zero", () => {
  assert.equal(reportProcessingPercent(0, 50), 3);
  assert.equal(reportProcessingPercent(25, 50), 50);
  assert.equal(reportProcessingPercent(50, 50), 100);
  // 页数还没转出来（0 或非法值）时不报 NaN，退回占位的 3%。
  assert.equal(reportProcessingPercent(5, 0), 3);
  assert.equal(reportProcessingPercent(5, Number.NaN), 3);
  assert.equal(reportProcessingPercent(-1, 50), 3);
});

test("engagement fallback derives the week from createdAt so grouping still works before favorites load", () => {
  const fallback = reportEngagementFallback({ createdAt: "2026-08-30T16:30:00.000Z" });
  assert.equal(fallback.weekKey, "2026-W36");
  assert.equal(fallback.favoriteCount, 0);
  assert.equal(fallback.viewerFavorited, false);
});

test("weekly grouping puts recent weeks first and sorts each week by favorite count", () => {
  const engagementById: Record<string, CaseEngagement> = {
    a: { ...emptyCaseEngagement("2026-W35"), favoriteCount: 1 },
    b: { ...emptyCaseEngagement("2026-W36"), favoriteCount: 2 },
    c: { ...emptyCaseEngagement("2026-W36"), favoriteCount: 5 },
  };
  const reports = [
    makeReport({ id: "a", createdAt: "2026-08-25T02:00:00.000Z" }),
    makeReport({ id: "b", createdAt: "2026-09-01T02:00:00.000Z" }),
    makeReport({ id: "c", createdAt: "2026-08-31T02:00:00.000Z" }),
  ];
  const groups = reportWeeklyGroups(reports, (report) => engagementById[report.id]);
  assert.deepEqual(groups.map((group) => group.weekKey), ["2026-W36", "2026-W35"]);
  assert.deepEqual(groups[0].items.map((item) => item.id), ["c", "b"]);
});

test("frozen weekly order keeps the vote from moving cards under the cursor, and flags when it goes stale", () => {
  const engagementById: Record<string, CaseEngagement> = {
    a: { ...emptyCaseEngagement("2026-W36"), favoriteCount: 1 },
    b: { ...emptyCaseEngagement("2026-W36"), favoriteCount: 2 },
  };
  const reports = [
    makeReport({ id: "a", createdAt: "2026-09-01T02:00:00.000Z" }),
    makeReport({ id: "b", createdAt: "2026-09-01T03:00:00.000Z" }),
  ];
  const before = reportWeeklyGroups(reports, (report) => engagementById[report.id]);
  assert.deepEqual(before[0].items.map((item) => item.id), ["b", "a"]);
  const frozen = freezeReportOrder(before);

  // a 反超之后，真实名次已经变了，但冻结顺序不该跟着跳。
  engagementById.a = { ...engagementById.a, favoriteCount: 9 };
  const after = reportWeeklyGroups(reports, (report) => engagementById[report.id]);
  const applied = applyFrozenReportOrder(after, frozen);
  assert.deepEqual(applied.groups[0].items.map((item) => item.id), ["b", "a"]);
  assert.equal(applied.stale, true);

  const reFrozen = freezeReportOrder(after);
  const reapplied = applyFrozenReportOrder(after, reFrozen);
  assert.deepEqual(reapplied.groups[0].items.map((item) => item.id), ["a", "b"]);
  assert.equal(reapplied.stale, false);
});

test("version summary label falls back to conversion status while a report isn't ready yet", () => {
  // 见 demo 第 160-165 行的 mock 数据：QUEUED/PROCESSING/FAILED 三态的「版本」格子里
  // 放的是转换状态说明，不是版本计数——就算 versionSummary.count 恰好是 0。
  const empty = { count: 0, latestOwnerName: null, latestUpdatedAt: null };
  assert.equal(reportVersionSummaryLabel("QUEUED", empty), "等待转换");
  // UPLOADING 单独一档：文件还没传完，跟 QUEUED（已经传完、排队等转换）不是一回事。
  assert.equal(reportVersionSummaryLabel("UPLOADING", empty), "上传未完成");
  assert.equal(reportVersionSummaryLabel("PROCESSING", empty), "页图生成中");
  assert.equal(reportVersionSummaryLabel("FAILED", empty), "转换失败");
  assert.equal(reportVersionSummaryLabel("READY", empty), "尚未开始拆解");

  const withVersions = { count: 2, latestOwnerName: "李工", latestUpdatedAt: "2026-09-01T06:20:00.000Z" };
  const date = new Date(withVersions.latestUpdatedAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  assert.equal(reportVersionSummaryLabel("READY", withVersions), `2 个版本 · 最近 李工 ${time}`);
  // 就绪状态下如果版本数是 0，用户名/时间都还没有意义，落回「尚未开始拆解」。
  assert.equal(reportVersionSummaryLabel("READY", { count: 0, latestOwnerName: "老孙", latestUpdatedAt: null }), "尚未开始拆解");
});

test("format badge maps PPT to the demo's '97-2003' label and leaves PPTX/PDF alone", () => {
  // demo mock 数据（honggutan/pujiang）fmt 字段写的是 "PPT 97-2003"，不是裸 "PPT"；
  // 逐字节核对过，中间是普通连字符 "-"（U+002D），不是 en dash。
  assert.equal(reportFormatBadgeLabel("PPT"), "PPT 97-2003");
  assert.equal(reportFormatBadgeLabel("PPTX"), "PPTX");
  assert.equal(reportFormatBadgeLabel("PDF"), "PDF");
});

test("card time formatting drops seconds and reports an empty string for unparseable input", () => {
  // 卡片按浏览器本地时间显示（和 V04LibraryClient 的 formatV19CardTime 同一做法），
  // 所以期望值从同一个 Date 的本地字段现算，不在测试里写死时区假设。
  const iso = "2026-09-01T06:20:00.000Z";
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  const expected = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  assert.equal(formatReportCardTime(iso), expected);
  assert.equal(formatReportCardTime("not-a-date"), "");
});

test("polling only keeps running while a report is still queued or processing", () => {
  assert.equal(hasPendingConversion([makeReport({ status: "READY" }), makeReport({ status: "FAILED" })]), false);
  assert.equal(hasPendingConversion([makeReport({ status: "READY" }), makeReport({ status: "QUEUED" })]), true);
  assert.equal(hasPendingConversion([makeReport({ status: "PROCESSING" })]), true);
  assert.equal(hasPendingConversion([]), false);
});

test("grouping and freezing carry extra fields (like canManage) through instead of dropping them", () => {
  // GET /api/reports 现在多吐一个 canManage；这三个函数当年是按裸 ReportListItem 写的死类型，
  // 传更宽的形状（ReportListItemView）编译能过，但分组结果的类型会把 canManage 悄悄擦掉——
  // 这道题在 lib/report-library-view.ts 改成泛型后已经修好，这里立个回归测试钉住它。
  const withCanManage = (overrides: Partial<ReportListItem>, canManage: boolean) => ({
    ...makeReport(overrides),
    canManage,
  });
  const reports = [
    withCanManage({ id: "a", createdAt: "2026-09-01T02:00:00.000Z" }, true),
    withCanManage({ id: "b", createdAt: "2026-09-01T03:00:00.000Z" }, false),
  ];
  const engagementByIdMap: Record<string, CaseEngagement> = {
    a: { ...emptyCaseEngagement("2026-W36"), favoriteCount: 1 },
    b: emptyCaseEngagement("2026-W36"),
  };
  const groups = reportWeeklyGroups(reports, (report) => engagementByIdMap[report.id]);
  assert.deepEqual(groups[0].items.map((item) => item.canManage), [true, false]);

  const frozen = freezeReportOrder(groups);
  const { groups: applied } = applyFrozenReportOrder(groups, frozen);
  assert.deepEqual(applied[0].items.map((item) => ({ id: item.id, canManage: item.canManage })), [
    { id: "a", canManage: true },
    { id: "b", canManage: false },
  ]);
});

test("library card's delete confirm is an inline recoverable banner, not the browser's native confirm() nor an irreversible-delete warning", async () => {
  // 后端 trashReport 一直是软删（deleted_at，可 restore）。库首页卡片原来用 window.confirm()
  // 弹一句"确认删除《…》？删除后不可恢复。"——既挡不住脚本化点击、样式不可控，字面上还跟
  // "可恢复"的事实矛盾。改成跟工作台删除报告（ReportStudioClient.tsx）、只读成果页删案例
  // （V04DetailClient.tsx 第 104-116 行）同一套页内确认条：复用 V04Surface.module.css 的
  // recoveryBanner，只在点了「删除」的这张卡片内展开。失败卡片、非就绪卡片（排队中/转换中/
  // 上传未完成）两处触发按钮共用同一条 confirmingDelete 状态和同一个 banner。
  const card = await readFile(new URL("../components/report/library/ReportCard.tsx", import.meta.url), "utf8");

  // 浏览器原生确认框、旧的"不可恢复"措辞都不该再出现。
  assert.doesNotMatch(card, /window\.confirm/);
  assert.doesNotMatch(card, /确认删除《.*》？删除后不可恢复。/);

  // 两处触发删除的按钮只负责打开确认条，真正发请求的是确认条自己的按钮。
  const triggerOpens = card.match(/onClick=\{\(\) => setConfirmingDelete\(true\)\}/g) ?? [];
  assert.equal(triggerOpens.length, 2, "失败卡片、非就绪卡片各一处触发按钮，都应该只是打开确认条");

  // 确认条本体：v04 共享的 recoveryBanner，role/aria-label 与工作台、只读成果页那两处一致。
  assert.match(card, /\{confirmingDelete \? \(/);
  assert.match(card, /<section className=\{v04\.recoveryBanner\} role="alertdialog" aria-label="删除报告">/);
  assert.match(card, /<b>把《\{report\.title\}》移入回收站？<\/b>/);
  assert.match(card, /<span>报告会从报告库中移除，保留 90 天，可由上传者或系统管理员恢复；原始报告文件不会被清理。<\/span>/);
  assert.match(card, /\{deleteError \? <p role="alert">\{deleteError\}<\/p> : null\}/);
  assert.match(card, /onClick=\{\(\) => onDelete\(report\.id\)\}/);
  assert.match(card, /\{deletePending \? "正在移入回收站…" : "确认移入回收站"\}/);
  assert.match(card, /onClick=\{\(\) => setConfirmingDelete\(false\)\}>取消<\/button>/);
});
