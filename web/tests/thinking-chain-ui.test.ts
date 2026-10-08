import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cloneV04UiDraft } from "../lib/v04-ui-model.ts";
import { getV04UiCase } from "../lib/v04-ui-fixture.ts";
import type { V19BaseDiff } from "../lib/v19-base-diff.ts";

// 与 tests/v19-studio-document.test.ts 同样的做法：把 .css 换成空模块，直接渲染真实组件。
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

const Flow = (await import("../components/v04/V19ThinkingChainFlow.tsx")).default;
const Field = (await import("../components/v04/V19ThinkingChainField.tsx")).default;
const V19StudioDocument = (await import("../components/v04/V19StudioDocument.tsx")).default;

const SAMPLE = `商业问题与洞察
  - 问题：如何打破冰冷感？
  - 品牌：Kate Spade
    - 理念：乐观
      - 俏皮
创意主张
  - 快乐并不遥远`;

test("the flow renders each chain as an ordered list: centre first, numbered steps, forks under their step", () => {
  const html = renderToStaticMarkup(createElement(Flow, { text: SAMPLE }));
  assert.equal(html.match(/<ol/g)?.length, 2, "one ordered list per chain");
  assert.match(html, /aria-label="思维链：商业问题与洞察"/);
  assert.ok(html.indexOf("商业问题与洞察") < html.indexOf("第 1 步"));
  assert.ok(html.indexOf("第 1 步") < html.indexOf("第 2 步"));
  assert.match(html, /<b>品牌<\/b>：Kate Spade/);
  // forks are a nested list under 第 2 步, the deeper fork nested once more
  const forks = html.slice(html.indexOf("第 2 步"));
  assert.ok(forks.indexOf("<b>理念</b>：乐观") < forks.indexOf("俏皮"));
  assert.equal((forks.slice(0, forks.indexOf("创意主张")).match(/<ul/g) ?? []).length, 2);
  // no bullet glyphs in the reading view
  assert.doesNotMatch(html, /[•·◦]/);
});

test("legacy text gets the case title as its centre and loses the duplicated step numbers", () => {
  const html = renderToStaticMarkup(createElement(Flow, { text: "1）问题一\n2）品牌理念：乐观", caseTitle: "捉迷藏" }));
  assert.match(html, /捉迷藏<span[^>]*>创意思维链<\/span>/);
  assert.doesNotMatch(html, /1）问题一/);
  assert.match(html, />问题一</);
  assert.match(html, /<b>品牌理念<\/b>：乐观/);
  const untitled = renderToStaticMarkup(createElement(Flow, { text: "1）问题一\n2）品牌" }));
  assert.match(untitled, />创意思维链</);
  assert.equal(renderToStaticMarkup(createElement(Flow, { text: "  " })), "<span>—</span>");
});

test("the field follows the same read-only / locked / editable rules as every other entry", () => {
  const base = { value: SAMPLE, ariaLabel: "创意思维链", onCommit: () => undefined };
  const readOnly = renderToStaticMarkup(createElement(Field, { ...base, readOnly: true }));
  assert.doesNotMatch(readOnly, /role="button"/);
  const editable = renderToStaticMarkup(createElement(Field, base));
  assert.match(editable, /role="button"/);
  assert.match(editable, /aria-label="创意思维链"/);
  assert.match(editable, /title="点击编辑"/);
  assert.match(editable, /点击编辑大纲/);
  const locked = renderToStaticMarkup(createElement(Field, { ...base, readOnly: true, locked: true, sourceHint: "v2·老孙" }));
  assert.match(locked, /role="button"/);
  assert.match(locked, /title="集成版只有老孙可以编辑 · 来自 v2·老孙"/);
  assert.doesNotMatch(locked, /点击编辑大纲/);
  const withBase = renderToStaticMarkup(createElement(Field, { ...base, baseValue: "旧的\n  - 一步" }));
  assert.match(withBase, /已修改/);
  assert.match(withBase, /基版：旧的\n {2}- 一步/);
});

test("module 1 keeps its order with the chain full-width and the three choice cards on one row after it", () => {
  const source = getV04UiCase("aurora");
  if (!source) throw new Error("expected the aurora fixture case to exist");
  const draft = cloneV04UiDraft(source.draft);
  draft.creativeThinkingChain = SAMPLE;
  const html = renderToStaticMarkup(createElement(V19StudioDocument, {
    draft,
    caseTitle: "极光",
    diff: null as V19BaseDiff | null,
    readOnly: false,
    collapsedModules: new Set<number>(),
    onToggleModule: () => undefined,
    onChange: () => undefined,
    onInsertShotAfter: () => undefined,
    onInsertBridgeAfter: () => undefined,
    onDeleteShot: () => undefined,
    onDeleteBridge: () => undefined,
    onInsertFirstShot: () => undefined,
    pendingDeleteId: null,
    onCancelDelete: () => undefined,
    nonCompliantStartCount: 0,
    onNormalizeTimeline: () => undefined,
    onInvalid: () => undefined,
  }));
  const at = (needle: string) => {
    const index = html.indexOf(needle);
    assert.ok(index >= 0, `expected ${needle} to render`);
    return index;
  };
  const order = [
    at('id="field-tensionButton"'),
    at('id="field-creativeThinkingChain"'),
    at('aria-label="思维链：商业问题与洞察"'),
    at('id="field-storyReference"'),
    at(">创意机制<"),
    at(">创意手法<"),
    at('id="field-carriers"'),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // the old plain-text editor is gone for this field
  assert.doesNotMatch(html.slice(order[1], order[3]), /<textarea/);
});
