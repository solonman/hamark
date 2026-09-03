import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// DeleteConfirmDialog（components/shared/DeleteConfirmDialog.tsx）是「删除」从页内
// 确认条改成弹出式确认对话框之后的共用组件——最初只有报告线一份
// （components/report/ReportDeleteDialog.tsx，报告库卡片与拆解工作台两处入口共用），
// 现在提炼进 components/shared，视频侧二合一工作台的「删除案例」与只读成果页的内联
// 确认条也接了进来（见 tests/report-trash.test.ts、tests/report-library-view.test.ts、
// tests/v04-contract-violations.test.ts、tests/v19-studio-client.test.ts 对各调用点的
// 断言）。这里跟 tests/report-trash.test.ts、tests/upload-dialog-contrast.test.ts 一样，
// 不接真实 DOM 渲染（项目里没有 jsdom/@testing-library 的先例）——照抄现有做法，用源码
// 正则核对结构、门禁条件与文案，不是渲染后断言。

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("DeleteConfirmDialog is a client component that portals to document.body, mounted-gated for SSR", async () => {
  const dialog = await source("../components/shared/DeleteConfirmDialog.tsx");
  assert.match(dialog, /^"use client";/);
  assert.match(dialog, /import \{ createPortal \} from "react-dom";/);
  assert.match(dialog, /const \[mounted, setMounted\] = useState\(false\);/);
  assert.match(dialog, /useEffect\(\(\) => \{ setMounted\(true\); \}, \[\]\);/);
  assert.match(dialog, /if \(!open \|\| !mounted\) return null;/);
  assert.match(dialog, /return createPortal\(/);
  assert.match(dialog, /,\s*\n\s*document\.body,\s*\n\s*\);/);
});

test("DeleteConfirmDialog exposes the props every call site relies on, including the caller-supplied heading", async () => {
  const dialog = await source("../components/shared/DeleteConfirmDialog.tsx");
  for (const prop of ["open: boolean", "heading: string", "title: string", "lines: string\\[\\]", "error\\?: string", "pending: boolean", "onConfirm: \\(\\) => void", "onCancel: \\(\\) => void"]) {
    assert.match(dialog, new RegExp(prop));
  }
});

test("DeleteConfirmDialog is an alertdialog labelled by the caller-supplied heading, titled with the given case/report name", async () => {
  const dialog = await source("../components/shared/DeleteConfirmDialog.tsx");
  assert.match(dialog, /role="alertdialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /aria-labelledby=\{titleId\}/);
  assert.match(dialog, /<b id=\{titleId\}>\{heading\}<\/b>/);
  assert.match(dialog, /<b>把《\{title\}》移入回收站？<\/b>/);
  assert.match(dialog, /lines\.map\(\(line, index\) => <span key=\{index\} className=\{styles\.deleteDialogLine\}>\{line\}<\/span>\)/);
  assert.match(dialog, /\{error \? <p className=\{styles\.formError\} role="alert">\{error\}<\/p> : null\}/);
});

test("DeleteConfirmDialog: Esc and backdrop-click close it, but never while pending; the × is hidden while pending", async () => {
  const dialog = await source("../components/shared/DeleteConfirmDialog.tsx");
  assert.match(dialog, /if \(event\.key === "Escape" && !pending\) onCancel\(\);/);
  assert.match(dialog, /onMouseDown=\{\(event\) => \{ if \(event\.target === event\.currentTarget && !pending\) onCancel\(\); \}\}/);
  assert.match(dialog, /\{pending \? null : \(\s*\n\s*<button type="button" className=\{styles\.uploadClose\}/);
});

test("DeleteConfirmDialog: confirm button carries the accent class and both buttons disable while pending", async () => {
  const dialog = await source("../components/shared/DeleteConfirmDialog.tsx");
  assert.match(dialog, /<button type="button" ref=\{cancelRef\} disabled=\{pending\} onClick=\{onCancel\}>取消<\/button>/);
  assert.match(
    dialog,
    /<button type="button" className=\{styles\.deleteDialogConfirm\} disabled=\{pending\} onClick=\{onConfirm\}>\s*\n\s*\{pending \? "正在移入回收站…" : "确认移入回收站"\}/,
  );
});

test("DeleteConfirmDialog locks body scroll while open and focuses the Cancel button on open", async () => {
  const dialog = await source("../components/shared/DeleteConfirmDialog.tsx");
  assert.match(dialog, /document\.body\.style\.overflow = "hidden";/);
  assert.match(dialog, /if \(open && mounted && !pending\) cancelRef\.current\?\.focus\(\);/);
});

test("all four entry points (report library card, report studio header, video studio header, video read-only detail) render the shared DeleteConfirmDialog, not their own inline markup", async () => {
  const [card, reportStudio, videoStudio, videoDetail] = await Promise.all([
    source("../components/report/library/ReportCard.tsx"),
    source("../components/report/studio/ReportStudioClient.tsx"),
    source("../components/v04/V04StudioClient.tsx"),
    source("../components/v04/V04DetailClient.tsx"),
  ]);
  for (const [name, mod] of [["card", card], ["reportStudio", reportStudio], ["videoStudio", videoStudio], ["videoDetail", videoDetail]] as const) {
    assert.match(mod, /import DeleteConfirmDialog from "@\/components\/shared\/DeleteConfirmDialog";/, `${name} should import the shared dialog`);
    assert.match(mod, /<DeleteConfirmDialog/, `${name} should render the shared dialog`);
  }
  // 没有任何一处还留着旧的报告专属组件。
  for (const [name, mod] of [["card", card], ["reportStudio", reportStudio]] as const) {
    assert.doesNotMatch(mod, /ReportDeleteDialog/, `${name} should no longer reference the retired ReportDeleteDialog`);
  }
});

test("the dialog's chrome (backdrop/box/head/body/footer) lives in the component's own CSS module, plus three delete-specific classes", async () => {
  const [dialog, css] = await Promise.all([
    source("../components/shared/DeleteConfirmDialog.tsx"),
    source("../components/shared/DeleteConfirmDialog.module.css"),
  ]);
  assert.match(dialog, /import styles from "\.\/DeleteConfirmDialog\.module\.css";/);
  assert.match(dialog, /className=\{styles\.uploadBackdrop\}/);
  assert.match(dialog, /className=\{`\$\{styles\.uploadDialog\} \$\{styles\.deleteDialog\}`\}/);
  assert.match(dialog, /className=\{styles\.uploadHead\}/);
  assert.match(dialog, /className=\{styles\.uploadBody\}/);
  assert.match(dialog, /className=\{styles\.uploadFooter\}/);

  // 三个专属类只加宽度/字色/强调色，不改动既有的上传对话框规则。
  assert.match(css, /\.deleteDialog \{ width: min\(460px, 100%\); \}/);
  assert.match(css, /\.deleteDialogLine \{ margin: 0; color: var\(--v04-muted\); font-size: 11\.5px; line-height: 1\.6; \}/);
  // .surface button{font:inherit}（V04Surface.module.css）是 (0,1,1)，单类选择器会被压过
  // （见「报告线 CSS 优先级教训」）；确认按钮的强调色借 .uploadFooter 把特异性提到 (0,2,0)。
  assert.match(css, /\.uploadFooter \.deleteDialogConfirm \{ border-color: rgba\(223,255,79,\.55\); color: var\(--v04-accent\); \}/);

  // 报告库自己的 CSS 不再持有这套已经搬走的规则。
  const reportLibraryCss = await source("../components/report/library/ReportLibrary.module.css");
  assert.doesNotMatch(reportLibraryCss, /\.deleteDialog\b/);
});
