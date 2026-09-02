import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cloneV04UiDraft } from "../lib/v04-ui-model.ts";
import { getV04UiCase } from "../lib/v04-ui-fixture.ts";
import type { V19BaseDiff } from "../lib/v19-base-diff.ts";

// Same technique as `tests/v19-editable-value.test.ts`: stub any `.css` specifier
// so the real component (and everything it imports — `V19EditableValue.tsx`,
// `V04ChoiceField.tsx`, both of which also import `V04Surface.module.css`) can
// be `import()`-ed and rendered with `react-dom/server`, instead of falling
// back to hand-copied stand-ins.
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

const componentModule = await import("../components/v04/V19StudioDocument.tsx");
const V19StudioDocument = componentModule.default;
const { V19_CARRIER_OPTIONS } = componentModule;
const {
  V19_FIELD_TARGET_KEYS,
  computeV19ShotTimelineWarnings,
  V19_SHOT_TIME_OVERLAP_WARNING,
  V19_SHOT_TIME_INVERTED_WARNING,
} = componentModule;

function fixtureDraft() {
  const source = getV04UiCase("aurora");
  if (!source) throw new Error("expected the aurora fixture case to exist");
  return cloneV04UiDraft(source.draft);
}

function noopProps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    draft: fixtureDraft(),
    diff: null as V19BaseDiff | null,
    readOnly: false,
    collapsedModules: new Set<number>(),
    onToggleModule: () => undefined,
    onChange: () => undefined,
    onInsertShotAfter: () => undefined,
    onInsertBridgeAfter: () => undefined,
    onInvalid: () => undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Module order and where 整体创意评价／评价理由 land
// ---------------------------------------------------------------------------

test("module order is 全片事实与核心判断 → 脚本反写 → 主导感知类型发生路径与整体评价", () => {
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps()));
  assert.match(html, /id="module-1"/);
  assert.match(html, /id="module-2"/);
  assert.match(html, /id="module-3"/);
  const factsIndex = html.indexOf("全片事实与核心判断");
  const scriptIndex = html.indexOf("脚本反写");
  const pathIndex = html.indexOf("主导感知类型发生路径与整体评价");
  assert.ok(factsIndex >= 0, "expected module 1 title to render");
  assert.ok(scriptIndex >= 0, "expected module 2 title to render");
  assert.ok(pathIndex >= 0, "expected module 3 title to render");
  assert.ok(factsIndex < scriptIndex, "module 1 must render before module 2");
  assert.ok(scriptIndex < pathIndex, "module 2 must render before module 3");
});

test("整体创意评价 and 评价理由 render inside module 3, after its heading", () => {
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps()));
  const module3Index = html.indexOf('id="module-3"');
  const gradeIndex = html.indexOf("整体创意评价");
  const reasonIndex = html.indexOf("评价理由");
  assert.ok(module3Index >= 0);
  assert.ok(gradeIndex > module3Index, "整体创意评价 must render after the module-3 marker");
  assert.ok(reasonIndex > module3Index, "评价理由 must render after the module-3 marker");
});

// ---------------------------------------------------------------------------
// UI field -> payload target key mapping (lib/v04-ui-model.ts's
// v04UiDraftToPayload / v04PayloadChanges are the authority; several UI field
// names differ from their payload counterparts).
// ---------------------------------------------------------------------------

test("V19_FIELD_TARGET_KEYS resolves the known-tricky UI-field -> payload-key pairs", () => {
  assert.equal(V19_FIELD_TARGET_KEYS.facts.storySummary, "facts.storySynopsis");
  assert.equal(V19_FIELD_TARGET_KEYS.facts.creativeContract, "facts.acceptanceContract");
  assert.equal(V19_FIELD_TARGET_KEYS.facts.primaryMechanism, "facts.mainMechanism");
  assert.equal(V19_FIELD_TARGET_KEYS.facts.carriers, "facts.creativeCarriers");
});

test("V19_FIELD_TARGET_KEYS resolves the direct-named facts, shotGroup, and shot targets", () => {
  assert.equal(V19_FIELD_TARGET_KEYS.facts.commercialIntent, "facts.commercialIntent");
  assert.equal(V19_FIELD_TARGET_KEYS.facts.auxiliaryMechanism, "facts.auxiliaryMechanism");
  assert.equal(V19_FIELD_TARGET_KEYS.facts.overallGrade, "facts.overallCreativeRating");
  assert.equal(V19_FIELD_TARGET_KEYS.facts.gradeReason, "facts.ratingReason");
  assert.equal(V19_FIELD_TARGET_KEYS.shotGroupField("b1", "bridgeName"), "shotGroup:b1.bridgeName");
  assert.equal(V19_FIELD_TARGET_KEYS.shotGroupField("b1", "keyCreativeDescription"), "shotGroup:b1.keyCreativeDescription");
  assert.equal(V19_FIELD_TARGET_KEYS.shotField("s1", "startTime"), "shot:s1.startTime");
});

// ---------------------------------------------------------------------------
// Timeline warning helper (spec rule 6) — pure function, exported for testing.
// ---------------------------------------------------------------------------

test("a shot whose start time overlaps the previous shot's end time gets the overlap warning", () => {
  const result = computeV19ShotTimelineWarnings({ startTime: "00:05", endTime: "00:09" }, { endTime: "00:09" });
  assert.deepEqual(result, { startWarning: V19_SHOT_TIME_OVERLAP_WARNING, endWarning: undefined });
});

test("a shot whose start time is strictly after the previous shot's end time gets no warning", () => {
  const result = computeV19ShotTimelineWarnings({ startTime: "00:10", endTime: "00:14" }, { endTime: "00:09" });
  assert.deepEqual(result, { startWarning: undefined, endWarning: undefined });
});

test("a shot whose end time is earlier than its own start time gets the inverted warning", () => {
  const result = computeV19ShotTimelineWarnings({ startTime: "00:10", endTime: "00:05" }, null);
  assert.deepEqual(result, { startWarning: undefined, endWarning: V19_SHOT_TIME_INVERTED_WARNING });
});

test("unparseable timecodes on either side produce no warning", () => {
  assert.deepEqual(
    computeV19ShotTimelineWarnings({ startTime: "", endTime: "00:05" }, { endTime: "00:09" }),
    { startWarning: undefined, endWarning: undefined },
  );
  assert.deepEqual(
    computeV19ShotTimelineWarnings({ startTime: "00:05", endTime: "00:09" }, { endTime: "not-a-time" }),
    { startWarning: undefined, endWarning: undefined },
  );
});

// ---------------------------------------------------------------------------
// readOnly
// ---------------------------------------------------------------------------

test("editable mode renders the insert-shot and insert-bridge affordances", () => {
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({ readOnly: false })));
  assert.match(html, /在此镜头后插入镜头/);
  assert.match(html, /在此桥段后插入桥段/);
});

test("readOnly renders no insert buttons", () => {
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({ readOnly: true })));
  assert.doesNotMatch(html, /在此镜头后插入镜头/);
  assert.doesNotMatch(html, /在此桥段后插入桥段/);
});

// ---------------------------------------------------------------------------
// The three controlled-vocabulary fields must go through V04ChoiceField, never
// a plain <select> (spec: 组件边界 / 五之三). react-dom/server never renders
// the editing-state markup of V19EditableValue (it always starts in reading
// state), so this is asserted at the source level, as the task allows.
// ---------------------------------------------------------------------------

test("source: story reference, main/auxiliary mechanism, and bridge primary/auxiliary role render V04ChoiceField", async () => {
  const source = await readFile(new URL("../components/v04/V19StudioDocument.tsx", import.meta.url), "utf8");
  for (const label of ["故事参照类型", "创意主导手法及机制", "创意辅助手法及机制", "桥段主创意作用", "桥段辅助创意作用"]) {
    assert.match(source, new RegExp(`<V04ChoiceField label="${label}"`), `expected ${label} to render <V04ChoiceField>`);
  }
  assert.doesNotMatch(source, /<select\b/, "must never hand-roll a <select> for a vocabulary field");
});

// ---------------------------------------------------------------------------
// 创意承重载体 is a fixed three-option multi-select, not free text. The frozen
// contract rejects more than three entries and rejects duplicates, so a text
// box would let a person write something the save silently refuses — the exact
// failure this refactor exists to remove.
// ---------------------------------------------------------------------------

test("carriers stay a fixed three-option toggle rather than free text", async () => {
  const source = await readFile(new URL("../components/v04/V19StudioDocument.tsx", import.meta.url), "utf8");
  assert.deepEqual([...V19_CARRIER_OPTIONS], ["故事", "文案", "视听规则"]);
  assert.match(source, /V19_CARRIER_OPTIONS\.map/, "carriers must render one button per fixed option");
  assert.doesNotMatch(source, /textToCarriers/, "carriers must not be parsed back out of typed text");

  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({})));
  for (const option of V19_CARRIER_OPTIONS) {
    assert.match(html, new RegExp(`aria-pressed="[a-z]+"[^>]*>${option}<|>${option}<`), `expected a toggle for ${option}`);
  }
});

// ---------------------------------------------------------------------------
// 删除会带走内容，所以要按两次；两处「加回去」的入口必须常驻，否则删空之后
// 就再也回不来了。
// ---------------------------------------------------------------------------

test("delete asks twice, and names what a bridge takes with it", async () => {
  const source = await readFile(new URL("../components/v04/V19StudioDocument.tsx", import.meta.url), "utf8");
  // 第一次点击只亮出确认，标签随之改变。
  assert.match(source, /pendingDeleteId === shot\.id \? "再点一次删除此镜头"/);
  assert.match(source, /pendingDeleteId === group\.id/);
  assert.match(source, /及其 \$\{group\.shots\.length\} 个镜头/,
    "confirming a bridge must say how many shots go with it");

  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({})));
  assert.match(html, /－ 删除此镜头/);
  assert.match(html, /－ 删除此桥段/);
  assert.doesNotMatch(html, /再点一次/, "nothing is in a confirming state until it is asked for");
});

test("emptying a bridge or the script always leaves a way back", async () => {
  const source = await readFile(new URL("../components/v04/V19StudioDocument.tsx", import.meta.url), "utf8");
  // 空桥段里没有镜头可供「在其后插入」，空脚本里没有桥段可供「在其后插入」。
  assert.match(source, /group\.shots\.length === 0[\s\S]{0,200}onInsertFirstShot/);
  assert.match(source, /draft\.shotGroups\.length === 0[\s\S]{0,400}onInsertFirstBridge/);

  const css = await readFile(new URL("../components/v04/V04Surface.module.css", import.meta.url), "utf8");
  // 这两个入口不能只在悬停时出现——它们是唯一的回头路。
  assert.match(css, /\.insertShotRow\[data-v19-empty-bridge\][^}]*opacity:\s*1/);
  assert.match(css, /\.insertBridgeRow\[data-v19-first-bridge\][^}]*opacity:\s*1/);
});

test("readOnly renders no delete controls", () => {
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({ readOnly: true })));
  assert.doesNotMatch(html, /删除镜头/);
  assert.doesNotMatch(html, /删除桥段/);
});

test("a pending deletion always offers a way out", async () => {
  const source = await readFile(new URL("../components/v04/V19StudioDocument.tsx", import.meta.url), "utf8");
  // 取消按钮只在确认态出现，且两处都要有。
  assert.equal((source.match(/data-v19-cancel-delete/g) ?? []).length, 2,
    "both the shot and the bridge confirmation need a cancel");

  const shell = await readFile(new URL("../components/v04/V04StudioClient.tsx", import.meta.url), "utf8");
  // 除了按钮，Esc 与点击别处也要能退出——只有一条退路等于没有退路可发现。
  assert.match(shell, /event\.key === "Escape"[\s\S]{0,80}setPendingDeleteId\(null\)/);
  assert.match(shell, /closest\("\[data-v19-confirming\], \[data-v19-cancel-delete\]"\)/);
});

// ---------------------------------------------------------------------------
// 溯源视图简化（用户看了线上效果后的要求）：一个字段通常只多一行小字来源，
// 有历史的才多几行可展开摘要。逻辑本身在 lib/v19-final-trace.ts 里单测过
// （tests/v19-final-trace.test.ts）；这里只验证 `V19StudioDocument` 真的按
// `final` prop 接出对应的渲染（有 trace 数据时渲染什么、没有时什么都不渲染）。
// ---------------------------------------------------------------------------

const { v04UiDraftToPayload } = await import("../lib/v04-ui-model.ts");

function finalContextFor(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    locked: false,
    traceMode: true,
    originPayload: null,
    intakes: [],
    canAdopt: false,
    onAdopt: () => undefined,
    originOwnerName: "",
    ...overrides,
  };
}

test("溯源视图：字段没有历史（合并后只剩当前采用一行且就是原稿）时不渲染任何东西", () => {
  const draft = fixtureDraft();
  draft.commercialIntent = "没有人改过的商业意图";
  const originPayload = v04UiDraftToPayload(draft);
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({
    draft,
    final: finalContextFor({ originPayload, intakes: [] }),
  })));
  assert.doesNotMatch(html, /当前采用/, "unchanged field must not show a current-source line");
  assert.doesNotMatch(html, /没有人改过的商业意图[\s\S]*没有人改过的商业意图/,
    "the field's own text must appear exactly once — no duplicated trace value");
});

test("溯源视图：有历史的字段渲染「当前采用」一行小字来源，正文本身不再重复一遍", () => {
  const draft = fixtureDraft();
  draft.commercialIntent = "老孙改过的商业意图";
  const originDraft = fixtureDraft();
  originDraft.commercialIntent = "王大明写的原稿商业意图";
  const originPayload = v04UiDraftToPayload(originDraft);
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({
    draft,
    final: finalContextFor({
      originPayload,
      originOwnerName: "王大明",
      intakes: [{
        id: "i1", seq: 1, kind: "FIELD", targetKey: "facts.commercialIntent", targetLabel: "商业意图",
        value: "老孙改过的商业意图", source: "VERSION", sourceVersionNumber: 2, actorName: "老孙",
        applied: true, createdAt: "2026-09-02T03:00:00.000Z",
      }],
    }),
  })));
  assert.match(html, /当前采用 · v2 老孙/);
  // The field's current text (rendered once as the field's own content) must
  // not also show up a second time inside a duplicated trace-value block.
  const occurrences = html.split("老孙改过的商业意图").length - 1;
  assert.equal(occurrences, 1, "current value must render exactly once, not repeated in the trace");
});

test("溯源视图：旧写法收成默认收起的摘要行——只显示版本/作者/时间和第一行预览，不吐出全文", () => {
  const draft = fixtureDraft();
  draft.commercialIntent = "最新的商业意图";
  const originDraft = fixtureDraft();
  originDraft.commercialIntent = "王大明写的原稿商业意图";
  const originPayload = v04UiDraftToPayload(originDraft);
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({
    draft,
    final: finalContextFor({
      originPayload,
      originOwnerName: "王大明",
      intakes: [
        {
          id: "i1", seq: 1, kind: "FIELD", targetKey: "facts.commercialIntent", targetLabel: "商业意图",
          value: "李晓芸改的第一行\n李晓芸改的第二行（收起时不该出现）", source: "VERSION", sourceVersionNumber: 2,
          actorName: "李晓芸", applied: true, createdAt: "2026-08-23T09:47:00.000Z",
        },
        {
          id: "i2", seq: 2, kind: "FIELD", targetKey: "facts.commercialIntent", targetLabel: "商业意图",
          value: "最新的商业意图", source: "VERSION", sourceVersionNumber: 3, actorName: "张三",
          applied: true, createdAt: "2026-08-24T11:20:00.000Z",
        },
      ],
    }),
  })));
  assert.match(html, /aria-expanded="false"/, "the overridden summary row starts collapsed");
  assert.match(html, /李晓芸改的第一行/);
  assert.doesNotMatch(html, /李晓芸改的第二行/, "the collapsed summary shows only the first line");
  // 原稿也在旧写法里（v1 王大明），但当前采用（张三改的最新的商业意图）不该
  // 再重复一遍全文——已经在上一条测试验证过，这里只确认摘要行本身出现。
  assert.match(html, /v1 王大明 原稿/);
});

test("溯源视图：未纳入照旧完整展示，带「采纳这一版」按钮", () => {
  const draft = fixtureDraft();
  draft.commercialIntent = "现在的商业意图";
  const originPayload = v04UiDraftToPayload(draft);
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({
    draft,
    final: finalContextFor({
      originPayload,
      canAdopt: true,
      intakes: [{
        id: "i1", seq: 1, kind: "FIELD", targetKey: "facts.commercialIntent", targetLabel: "商业意图",
        value: "老王想改成这样，还没被采纳", source: "VERSION", sourceVersionNumber: 4, actorName: "老王",
        applied: false, createdAt: "2026-09-02T05:00:00.000Z",
      }],
    }),
  })));
  assert.match(html, /老王想改成这样，还没被采纳/, "pending shows the full text unabbreviated");
  assert.match(html, /未纳入/);
  assert.match(html, /采纳这一版/);
});

test("溯源视图：final 缺省时（普通版本／默认视图）行为跟简化前完全一样，不受影响", () => {
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({})));
  assert.doesNotMatch(html, /当前采用/);
  assert.doesNotMatch(html, /采纳这一版/);
});
