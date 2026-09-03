import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// ReportDeleteDialog 是「删除报告」从页内确认条（recoveryBanner）改成弹出式确认对话框
// 之后的共用组件，报告库卡片（ReportCard.tsx）和拆解工作台（ReportStudioClient.tsx）
// 两处入口都用它。这里跟 tests/report-trash.test.ts、tests/upload-dialog-contrast.test.ts
// 一样，不接真实 DOM 渲染（项目里没有 jsdom/@testing-library 的先例）——照抄现有做法，
// 用源码正则核对结构、门禁条件与文案，不是渲染后断言。

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("ReportDeleteDialog is a client component that portals to document.body, mounted-gated for SSR", async () => {
  const dialog = await source("../components/report/ReportDeleteDialog.tsx");
  assert.match(dialog, /^"use client";/);
  assert.match(dialog, /import \{ createPortal \} from "react-dom";/);
  assert.match(dialog, /const \[mounted, setMounted\] = useState\(false\);/);
  assert.match(dialog, /useEffect\(\(\) => \{ setMounted\(true\); \}, \[\]\);/);
  assert.match(dialog, /if \(!open \|\| !mounted\) return null;/);
  assert.match(dialog, /return createPortal\(/);
  assert.match(dialog, /,\s*\n\s*document\.body,\s*\n\s*\);/);
});

test("ReportDeleteDialog exposes the props the two call sites rely on", async () => {
  const dialog = await source("../components/report/ReportDeleteDialog.tsx");
  for (const prop of ["open: boolean", "title: string", "lines: string\\[\\]", "error\\?: string", "pending: boolean", "onConfirm: \\(\\) => void", "onCancel: \\(\\) => void"]) {
    assert.match(dialog, new RegExp(prop));
  }
});

test("ReportDeleteDialog is an alertdialog labelled by its own heading, titled with the given report name", async () => {
  const dialog = await source("../components/report/ReportDeleteDialog.tsx");
  assert.match(dialog, /role="alertdialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /aria-labelledby=\{titleId\}/);
  assert.match(dialog, /<b id=\{titleId\}>删除报告<\/b>/);
  assert.match(dialog, /<b>把《\{title\}》移入回收站？<\/b>/);
  assert.match(dialog, /lines\.map\(\(line, index\) => <span key=\{index\} className=\{styles\.deleteDialogLine\}>\{line\}<\/span>\)/);
  assert.match(dialog, /\{error \? <p className=\{styles\.formError\} role="alert">\{error\}<\/p> : null\}/);
});

test("ReportDeleteDialog: Esc and backdrop-click close it, but never while pending; the × is hidden while pending", async () => {
  const dialog = await source("../components/report/ReportDeleteDialog.tsx");
  assert.match(dialog, /if \(event\.key === "Escape" && !pending\) onCancel\(\);/);
  assert.match(dialog, /onMouseDown=\{\(event\) => \{ if \(event\.target === event\.currentTarget && !pending\) onCancel\(\); \}\}/);
  assert.match(dialog, /\{pending \? null : \(\s*\n\s*<button type="button" className=\{styles\.uploadClose\}/);
});

test("ReportDeleteDialog: confirm button carries the accent class and both buttons disable while pending", async () => {
  const dialog = await source("../components/report/ReportDeleteDialog.tsx");
  assert.match(dialog, /<button type="button" ref=\{cancelRef\} disabled=\{pending\} onClick=\{onCancel\}>取消<\/button>/);
  assert.match(
    dialog,
    /<button type="button" className=\{styles\.deleteDialogConfirm\} disabled=\{pending\} onClick=\{onConfirm\}>\s*\n\s*\{pending \? "正在移入回收站…" : "确认移入回收站"\}/,
  );
});

test("ReportDeleteDialog locks body scroll while open and focuses the Cancel button on open", async () => {
  const dialog = await source("../components/report/ReportDeleteDialog.tsx");
  assert.match(dialog, /document\.body\.style\.overflow = "hidden";/);
  assert.match(dialog, /if \(open && mounted && !pending\) cancelRef\.current\?\.focus\(\);/);
});

test("both entry points (library card, studio header) render the shared ReportDeleteDialog, not their own inline markup", async () => {
  const [card, studio] = await Promise.all([
    source("../components/report/library/ReportCard.tsx"),
    source("../components/report/studio/ReportStudioClient.tsx"),
  ]);
  assert.match(card, /import ReportDeleteDialog from "\.\.\/ReportDeleteDialog";/);
  assert.match(studio, /import ReportDeleteDialog from "\.\.\/ReportDeleteDialog";/);
  assert.match(card, /<ReportDeleteDialog/);
  assert.match(studio, /<ReportDeleteDialog/);
});

test("the dialog's chrome (backdrop/box/head/body/footer) reuses ReportLibrary.module.css's upload-dialog classes, plus three delete-specific ones", async () => {
  const [dialog, css] = await Promise.all([
    source("../components/report/ReportDeleteDialog.tsx"),
    source("../components/report/library/ReportLibrary.module.css"),
  ]);
  assert.match(dialog, /import styles from "\.\/library\/ReportLibrary\.module\.css";/);
  assert.match(dialog, /className=\{styles\.uploadBackdrop\}/);
  assert.match(dialog, /className=\{`\$\{styles\.uploadDialog\} \$\{styles\.deleteDialog\}`\}/);
  assert.match(dialog, /className=\{styles\.uploadHead\}/);
  assert.match(dialog, /className=\{styles\.uploadBody\}/);
  assert.match(dialog, /className=\{styles\.uploadFooter\}/);

  // 新增的三个专属类只加宽度/字色/强调色，不改动既有的上传对话框规则。
  assert.match(css, /\.deleteDialog \{ width: min\(460px, 100%\); \}/);
  assert.match(css, /\.deleteDialogLine \{ margin: 0; color: var\(--v04-muted\); font-size: 11\.5px; line-height: 1\.6; \}/);
  // .surface button{font:inherit}（V04Surface.module.css）是 (0,1,1)，单类选择器会被压过
  // （见「报告线 CSS 优先级教训」）；确认按钮的强调色借 .uploadFooter 把特异性提到 (0,2,0)。
  assert.match(css, /\.uploadFooter \.deleteDialogConfirm \{ border-color: rgba\(223,255,79,\.55\); color: var\(--v04-accent\); \}/);
});
