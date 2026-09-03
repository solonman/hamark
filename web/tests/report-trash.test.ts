import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 报告的「上传者删除」做法与视频侧完全一样（详情见 lib/v04-video-lifecycle.ts 的
// trashVideo/restoreVideo、components/v04/V04DetailClient.tsx 的确认条），但这里跟
// tests/report-review.test.ts 一样不接真数据库——照抄它「读源码断言规则还在」的做法：
// 权限判定、状态分支（404/403/409）、路由门禁、前端入口的显示条件与文案全部用源码
// 正则核对。

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("trashReport only lets the uploader or an admin soft-delete a live report", async () => {
  const server = await source("../lib/report-server.ts");
  assert.match(
    server,
    /export async function trashReport[\s\S]*SELECT id, status, created_by_email FROM reports WHERE id = \? AND deleted_at IS NULL/,
  );
  assert.match(server, /export async function trashReport[\s\S]*报告不存在或已在回收站中。", 404\)/);
  assert.match(
    server,
    /export async function trashReport[\s\S]*canManageReport\(\{ createdByEmail: report\.created_by_email \}, input\.actor\)[\s\S]*只有原上传者或管理员可以删除报告。", 403\)/,
  );
  assert.match(
    server,
    /export async function trashReport[\s\S]*UPDATE reports SET deleted_at = CURRENT_TIMESTAMP[\s\S]*WHERE id = \? AND deleted_at IS NULL/,
  );
  assert.match(server, /export async function trashReport[\s\S]*报告已被删除。", 409\)/);
});

test("restoreReport mirrors trashReport: same permission gate, opposite direction, 404/409 instead of a silent no-op", async () => {
  const server = await source("../lib/report-server.ts");
  // 找行时不再按 deleted_at IS NULL 过滤——要恢复的正是已经软删的那份。
  assert.match(
    server,
    /export async function restoreReport[\s\S]*SELECT id, status, created_by_email FROM reports WHERE id = \?`\)/,
  );
  assert.match(server, /export async function restoreReport[\s\S]*报告不存在。", 404\)/);
  assert.match(
    server,
    /export async function restoreReport[\s\S]*canManageReport\(\{ createdByEmail: report\.created_by_email \}, input\.actor\)[\s\S]*只有原上传者或管理员可以恢复报告。", 403\)/,
  );
  // UPDATE 的 WHERE 子句本身就是并发闸门：真的从「已删」翻回「未删」才算数。
  assert.match(
    server,
    /export async function restoreReport[\s\S]*UPDATE reports SET deleted_at = NULL[\s\S]*WHERE id = \? AND deleted_at IS NOT NULL/,
  );
  assert.match(server, /export async function restoreReport[\s\S]*报告未在回收站中，无需恢复。", 409\)/);
});

test("both the trash and restore routes share the same gate order: feature flag, same-origin, logged-in user", async () => {
  const [trashRoute, restoreRoute] = await Promise.all([
    source("../app/api/reports/[id]/trash/route.ts"),
    source("../app/api/reports/[id]/restore/route.ts"),
  ]);
  for (const route of [trashRoute, restoreRoute]) {
    assert.match(route, /if \(!isReportFeatureEnabled\(\)\) return reportFeatureDisabledResponse\(\);/);
    assert.match(route, /requireSameOriginMutation\(request\)/);
    assert.match(route, /requireApiUser\(request\)/);
    // 错误信封透传 ReportServiceError 自带的状态码，不是路由自己猜一个。
    assert.match(route, /error instanceof ReportServiceError \? error\.status : 400/);
  }
  assert.match(trashRoute, /trashReport\(getDbClient\(\), \{/);
  assert.match(restoreRoute, /restoreReport\(getDbClient\(\), \{/);
  // actor 的 isAdmin 两条路由都要现查，不能复用一份陈旧判断。
  assert.match(trashRoute, /isAdmin: await isAppAdmin\(user\)/);
  assert.match(restoreRoute, /isAdmin: await isAppAdmin\(user\)/);
});

test("report-studio-api exposes trashReport, POSTing to the same /trash route the video side uses for its own case", async () => {
  const client = await source("../components/report/studio/report-studio-api.ts");
  assert.match(
    client,
    /export function trashReport\(reportId: string\): Promise<\{ ok: true \}> \{\s*\n\s*return request\(reportPath\(reportId, "\/trash"\), \{ method: "POST", body: JSON\.stringify\(\{\}\) \}\);/,
  );
});

test("the studio page computes canManage once and hands it to both the READY workbench and the status page", async () => {
  const page = await source("../app/reports/[id]/page.tsx");
  // canManage 只算一次，两个分支（READY 工作台 / 非 READY 状态页）复用同一份判断，
  // 不能各自算一份走样（对应 canManageReport 的唯一权限口径）。
  const canManageDecl = page.match(/const canManage = canManageReport\(\{ createdByEmail: report\.createdByEmail \}, \{[\s\S]*?\}\);/);
  assert.ok(canManageDecl, "canManage should be computed once, before branching on report.status");
  assert.match(page, /<ReportStatusPage reportId=\{id\} initialReport=\{report\} canManage=\{canManage\} libraryHref=\{libraryHref\} \/>/);
  assert.match(page, /<ReportStudioClient[\s\S]*canManage=\{canManage\}/);
});

test("the studio header shows a text \"删除报告\" button only when canManage is true, independent of which version is being viewed", async () => {
  const studio = await source("../components/report/studio/ReportStudioClient.tsx");
  assert.match(studio, /canManage: boolean;/);
  // 按钮放在 siteUtilities 里（叠了本地 studioUtilities 类，见下一条测试）、
  // 版本 pill（versionSplit）之前，且不依赖 readOnly。
  assert.match(
    studio,
    /styles\.studioUtilities\}`\}>\s*\{canManage \? \(\s*<button[\s\S]*?删除报告[\s\S]*?\) : null\}\s*<div className=\{v04styles\.versionSplit\}>/,
  );
});

test("1280 宽下页头右侧不再被中间列（标题＋来源 chip）挤：<nav> 叠了 min-width:0 的本地类，右侧容器叠了 nowrap 的本地类", async () => {
  const [studio, css] = await Promise.all([
    source("../components/report/studio/ReportStudioClient.tsx"),
    source("../components/report/studio/ReportStudio.module.css"),
  ]);
  // 两处都是叠加本地类，不是替换 v04styles 原有的类——不碰视频侧文件。
  assert.match(studio, /<nav className=\{`\$\{v04styles\.siteNav\} \$\{styles\.studioNav\}`\}>/);
  assert.match(
    studio,
    /<div className=\{`\$\{v04styles\.siteUtilities\} \$\{styles\.studioUtilities\}`\}>/,
  );
  assert.match(css, /\.studioNav \{\s*min-width: 0;\s*\}/);
  assert.match(css, /\.studioUtilities \{\s*flex: none;\s*white-space: nowrap;\s*\}/);
});

test("undo/redo match the video workbench exactly: same v04styles.historyControl/historyDivider, same svg icons, same visible \"撤销\"/\"重做\" text", async () => {
  // 外壳已经把报告工作台的撤销/重做改回和 V04StudioClient.tsx 完全一致的写法
  // （svg 图标 + 文字，而不是纯箭头字符），这条测试断言的是"两边一致"，不是
  // "图标独占、不露文字"。
  const [studio, video] = await Promise.all([
    source("../components/report/studio/ReportStudioClient.tsx"),
    source("../components/v04/V04StudioClient.tsx"),
  ]);
  assert.match(studio, /<div className=\{v04styles\.historyControl\} role="group" aria-label="撤销与重做">/);
  assert.match(video, /<div className=\{styles\.historyControl\} role="group" aria-label="撤销与重做">/);
  // 撤销按钮：同一个 title/aria-label、同一套 svg 路径、按钮里露出 <span>撤销</span>。
  for (const source_ of [studio, video]) {
    assert.match(
      source_,
      /title="撤销上一步（⌘\/Ctrl\+Z）" aria-label="撤销上一步">\s*\n\s*<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">\s*\n\s*<path d="M3\.2 6\.6h6\.3a3\.3 3\.3 0 0 1 0 6\.6H6\.1" \/><path d="M5\.8 3\.6 3 6\.6l2\.8 3" \/>\s*\n\s*<\/svg>\s*\n\s*<span>撤销<\/span>/,
    );
  }
  // 重做按钮同理（视频侧的重做快捷键提示是 ⌘/Ctrl+Shift+Z，报告侧照抄，逐字不改）。
  for (const source_ of [studio, video]) {
    assert.match(
      source_,
      /title="重做（⌘\/Ctrl\+Shift\+Z）" aria-label="重做">\s*\n\s*<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">\s*\n\s*<path d="M12\.8 6\.6H6\.5a3\.3 3\.3 0 0 0 0 6\.6h3\.4" \/><path d="M10\.2 3\.6 13 6\.6l-2\.8 3" \/>\s*\n\s*<\/svg>\s*\n\s*<span>重做<\/span>/,
    );
  }
});

test("saveChip is pinned to its content width (flex: none) so it can never be shrunk into truncating \"已保存 23:53\" down to \"已保存 23\"", async () => {
  const [studio, css] = await Promise.all([
    source("../components/report/studio/ReportStudioClient.tsx"),
    source("../components/report/studio/ReportStudio.module.css"),
  ]);
  // 叠加本地类，不改共享的 v04styles.saveChip 本身。
  assert.match(studio, /v04styles\.saveChip,\s*\n[\s\S]*?styles\.studioSaveChip,/);
  // 元素+类的复合选择器（span.studioSaveChip），特异性高于 v04 侧的单类选择器
  // .saveChip，不论落在 ≤1200px 断点内外都确保 flex:none 生效。
  assert.match(css, /span\.studioSaveChip \{\s*flex: none;\s*\}/);
});

test("the trash confirmation is the shared ReportDeleteDialog popup, wired with the studio's own copy and trash flow", async () => {
  const studio = await source("../components/report/studio/ReportStudioClient.tsx");
  // 删除报告不再是页内的 recoveryBanner，是跟报告库卡片共用的弹出式对话框组件。
  assert.match(studio, /import ReportDeleteDialog from "\.\.\/ReportDeleteDialog";/);
  assert.doesNotMatch(studio, /v04styles\.recoveryBanner/);
  assert.match(studio, /<ReportDeleteDialog\s*\n\s*open=\{confirmingTrash\}/);
  assert.match(studio, /title=\{report\.title\}/);
  // 工作台的说明是两行（多一句「已有的拆解版本…」），报告库卡片只有一行——文案原样保留。
  assert.match(studio, /报告会从报告库中移除，保留 90 天，可由上传者或系统管理员恢复；原始报告文件不会被清理。/);
  assert.match(studio, /已有的拆解版本、评分和评论都会一并保留，不会被删除。/);
  assert.match(studio, /error=\{trashError\}/);
  assert.match(studio, /pending=\{trashing\}/);
  assert.match(studio, /onCancel=\{\(\) => setConfirmingTrash\(false\)\}/);
  assert.match(studio, /删除未完成，报告未发生变化，可重试。/);
  // 成功后回报告库，跳的是外壳传入的 navigation.libraryHref（等于 "\/\?library=REPORT"）。
  assert.match(studio, /await trashReport\(reportId\);\s*\n\s*window\.location\.assign\(navigation\.libraryHref\);/);
});
