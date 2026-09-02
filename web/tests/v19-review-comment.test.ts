import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CaseReviewComment } from "../lib/case-review.ts";

// 评论跨版本展示：docs/20_最终版与评论跨版本_实施规格_V0.1.md 一之 A、五之 20。
// 同样的 CSS 存根手法见 tests/v19-editable-value.test.ts / v19-studio-document.test.ts——
// V19ReviewComment.tsx 直接 import 了 V04Surface.module.css，用 react-dom/server 渲染前
// 得先把 .css 换成一个空模块。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".css")) return { url: `css-stub:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("css-stub:")) return { format: "module", source: "export default {};", shortCircuit: true };
    return nextLoad(url, context);
  },
});

const componentModule = await import("../components/v04/V19ReviewComment.tsx");
const V19ReviewComment = componentModule.default;

function comment(overrides: Partial<CaseReviewComment> = {}): CaseReviewComment {
  return {
    targetKey: "facts.commercialIntent",
    targetLabel: "商业意图",
    body: "再具体一点",
    authorName: "老孙",
    updatedAt: "2026-09-01T09:00:00Z",
    versionId: "version_2",
    versionLabel: "v2",
    ...overrides,
  };
}

function noopProps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    targetKey: "facts.commercialIntent",
    targetLabel: "商业意图",
    comments: [] as CaseReviewComment[],
    currentVersionId: null as string | null,
    canReview: false,
    onSave: async () => undefined,
    ...overrides,
  };
}

// react-dom/server 只渲染初始（CLOSED）状态，气泡展开靠点击/悬停触发的 state，
// 这里断言的是源码层面的行为分支，与 v19-studio-document.test.ts 的 source: 用例同法。

test("no comments and no review permission renders nothing", () => {
  const html = renderToStaticMarkup(createElement(V19ReviewComment, noopProps()));
  assert.equal(html, "");
});

test("a read-only viewer still sees the marker once a comment exists, closed by default", () => {
  const html = renderToStaticMarkup(createElement(V19ReviewComment, noopProps({
    comments: [comment()],
    currentVersionId: "version_2",
    canReview: false,
  })));
  assert.match(html, /<button/);
  assert.doesNotMatch(html, /role="dialog"/, "popover starts closed");
});

test("the marker is present for the reviewer even with zero comments, so they can start writing", () => {
  const html = renderToStaticMarkup(createElement(V19ReviewComment, noopProps({ canReview: true })));
  assert.match(html, /<button/);
});

test("source: each item is prefixed with its version label, and the current-version one is highlighted 本版", async () => {
  const source = await (await import("node:fs/promises")).readFile(
    new URL("../components/v04/V19ReviewComment.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /item\.versionLabel\}\{here \? "·本版" : ""\}/);
  assert.match(source, /const here = item\.versionId === currentVersionId;/);
  assert.match(source, /data-here=\{here \? "true" : undefined\}/);
});

test("source: a non-reviewer never sees a write area, on this version or any other", async () => {
  const source = await (await import("node:fs/promises")).readFile(
    new URL("../components/v04/V19ReviewComment.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const showWritePanel = canReview && \(mode === "EDITING" \|\| !hereHasComment\);/);
  // 非本版的条目：老孙看到「切到该版可改」，其他人一律「只读」。
  assert.match(source, /\{here \? "只读" : \(canReview \? "切到该版可改" : "只读"\)\}/);
});

test("source: the reviewer's own item on this version gets an 编辑 action; other versions do not", async () => {
  const source = await (await import("node:fs/promises")).readFile(
    new URL("../components/v04/V19ReviewComment.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const isMine = canReview && here;/);
  assert.match(source, /isMine \? \(\s*<button type="button" onClick=\{startEditing\}>编辑<\/button>/);
});

test("source: the marker's count is every version's comments, and it gets a solid outline once this version has one", async () => {
  const source = await (await import("node:fs/promises")).readFile(
    new URL("../components/v04/V19ReviewComment.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /data-here=\{hereHasComment \? "true" : undefined\}/);
  assert.match(source, /\{comments\.length \? <span>\{comments\.length\}<\/span> : null\}/);
  const css = await (await import("node:fs/promises")).readFile(
    new URL("../components/v04/V04Surface.module.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.commentMarker\[data-here="true"\][^}]*border-color: var\(--v04-accent\)/);
});

// 返工三点：docs/20_..._V0.1.md 五之 20——时间不再是原始 ISO 字符串、写入区有
// 「取消」、本版已有评论时保留老版本那个显式的「删除」按钮。
test("source: item timestamps go through formatShortDateTime, never the raw updatedAt ISO string", async () => {
  const source = await (await import("node:fs/promises")).readFile(
    new URL("../components/v04/V19ReviewComment.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /import \{ formatShortDateTime \} from "@\/lib\/date-format";/);
  assert.match(source, /<span className=\{styles\.commentItemTime\}>\{formatShortDateTime\(item\.updatedAt\)\}<\/span>/);
  // 不能改在组件里手搓一份格式化逻辑——必须复用 lib/date-format.ts 里已有的实现。
  assert.doesNotMatch(source, /getFullYear\(\)|getMonth\(\)|padStart/, "must not hand-roll date formatting in the component");
});

test("source: the write panel has a 取消 button that discards the draft, left of 发布/保存", async () => {
  const source = await (await import("node:fs/promises")).readFile(
    new URL("../components/v04/V19ReviewComment.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const cancelWrite = \(\) => \{[\s\S]*close\(\);\s*\};/);
  assert.match(
    source,
    /<button type="button" disabled=\{busy\} onClick=\{cancelWrite\}>取消<\/button>\s*<button type="button" className=\{styles\.commentSubmit\}/,
    "取消 must sit immediately to the left of 发布/保存",
  );
});

test("source: an existing current-version comment keeps an explicit 删除 button next to clear-to-delete", async () => {
  const source = await (await import("node:fs/promises")).readFile(
    new URL("../components/v04/V19ReviewComment.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /\{mine \? \(\s*<button type="button" className=\{styles\.commentDelete\} disabled=\{busy\} onClick=\{\(\) => void submit\(""\)\}>删除<\/button>\s*\) : null\}/);
  const css = await (await import("node:fs/promises")).readFile(
    new URL("../components/v04/V04Surface.module.css", import.meta.url),
    "utf8",
  );
  // commentDelete 样式还在，没被这次改动删掉。
  assert.match(css, /\.commentDelete \{/);
});
