import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cloneV04UiDraft } from "../lib/v04-ui-model.ts";
import { getV04UiCase } from "../lib/v04-ui-fixture.ts";
import type { V19BaseDiff } from "../lib/v19-base-diff.ts";
import { formatShortDateTime } from "../lib/date-format.ts";

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
// 溯源视图简化（用户看了线上效果后的要求，以及看了线上溯源模式后的两点调整）：
// 每个字段都显示「当前采用 · …」一行（包括没变过的字段，如「当前采用 ·
// v1 赵雅诗 原稿」），紧跟正文；有历史的才多几行可展开摘要，排在当前采用
// 之后。逻辑本身在 lib/v19-final-trace.ts 里单测过（tests/v19-final-trace.
// test.ts）；这里只验证 `V19StudioDocument` 真的按 `final` prop 接出对应的
// 渲染与顺序。
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

test("溯源视图：字段没有历史（合并后只剩当前采用一行且就是原稿）时仍显示当前采用行，但没有旧写法/未纳入列表", () => {
  const draft = fixtureDraft();
  draft.commercialIntent = "没有人改过的商业意图";
  const originPayload = v04UiDraftToPayload(draft);
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({
    draft,
    final: finalContextFor({ originPayload, originOwnerName: "赵雅诗", intakes: [] }),
  })));
  assert.match(html, /当前采用 · v1 赵雅诗 原稿/,
    "溯源视图本身就是这一行——即使字段没变过也要显示，不显示会让人以为漏了");
  assert.doesNotMatch(html, /没有人改过的商业意图[\s\S]*没有人改过的商业意图/,
    "the field's own text must appear exactly once — no duplicated trace value");
  assert.doesNotMatch(html, /采纳这一版/, "an unchanged field still has no history/pending list to show");
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
  // 「当前采用」必须紧跟正文——排在旧写法摘要列表之前，不是之后。
  const currentIndex = html.indexOf("当前采用");
  const overriddenIndex = html.indexOf("v1 王大明 原稿");
  assert.ok(currentIndex >= 0 && overriddenIndex >= 0, "both the current line and the overridden summary must render");
  assert.ok(currentIndex < overriddenIndex, "当前采用 must appear before the 旧写法 summary in the markup, right under the field");
});

test("溯源视图：当前采用行排在旧写法与未纳入列表之前——用 markup 出现顺序断言", () => {
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
      canAdopt: true,
      intakes: [
        {
          id: "i1", seq: 1, kind: "FIELD", targetKey: "facts.commercialIntent", targetLabel: "商业意图",
          value: "李晓芸改的内容", source: "VERSION", sourceVersionNumber: 2,
          actorName: "李晓芸", applied: true, createdAt: "2026-08-23T09:47:00.000Z",
        },
        {
          id: "i2", seq: 2, kind: "FIELD", targetKey: "facts.commercialIntent", targetLabel: "商业意图",
          value: "最新的商业意图", source: "VERSION", sourceVersionNumber: 3, actorName: "张三",
          applied: true, createdAt: "2026-08-24T11:20:00.000Z",
        },
        {
          id: "i3", seq: 3, kind: "FIELD", targetKey: "facts.commercialIntent", targetLabel: "商业意图",
          value: "老王想改成这样，还没被采纳", source: "VERSION", sourceVersionNumber: 4,
          actorName: "老王", applied: false, createdAt: "2026-09-02T05:00:00.000Z",
        },
      ],
    }),
  })));
  const currentIndex = html.indexOf("当前采用 · v3 张三");
  const overriddenIndex = html.indexOf("v1 王大明 原稿"); // the oldest 旧写法 summary row
  const pendingIndex = html.indexOf("老王想改成这样，还没被采纳");
  assert.ok(currentIndex >= 0, "expected the 当前采用 line to render");
  assert.ok(overriddenIndex >= 0, "expected an 旧写法 summary row to render");
  assert.ok(pendingIndex >= 0, "expected the 未纳入 row to render");
  assert.ok(currentIndex < overriddenIndex, "当前采用 must come before 旧写法");
  assert.ok(overriddenIndex < pendingIndex, "旧写法 must come before 未纳入 (unchanged ordering)");
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

// ---------------------------------------------------------------------------
// 溯源视图（用户反馈第二轮）：第三模块（主导感知类型发生路径）此前遗漏了
// 主导路径细项／辅助路径描述·创意作用／固定选项字段（故事参照类型等）的
// 「当前采用」——这些字段现在都走 finalPrimaryDetailExtras /
// finalAuxiliaryPathExtras / finalChoiceFieldExtras（lib/v19-final-trace.ts
// 里的 deriveV19PrimaryDetailTrace / deriveV19AuxiliaryPathTrace /
// deriveV19ChoiceFieldTrace 已单测过），这里只验证组件层真的把每一个细项都
// 接上了，而不是仍旧漏掉。aurora 夹具的 primaryPath 是 LOVE，五个细项、一个
// 辅助路径（PERCEPTION）、故事参照类型都取了各自独一无二的文本，用来定位
// 「当前采用」是否紧跟在它自己那一条内容附近。
// ---------------------------------------------------------------------------

test("溯源视图：第三模块每一条主导路径细项都渲染了「当前采用」，紧跟在它自己的文本旁边", () => {
  const draft = fixtureDraft();
  assert.equal(draft.primaryPath, "LOVE", "this test's per-detail unique strings assume the aurora fixture's LOVE path");
  const originPayload = v04UiDraftToPayload(draft);
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({
    draft,
    final: finalContextFor({ originPayload, originOwnerName: "赵雅诗", intakes: [] }),
  })));
  const module3Html = html.slice(html.indexOf('id="module-3"'));
  assert.ok(module3Html.length > 0, "expected module 3 to render");
  for (const detailText of draft.primaryPathAnswers.LOVE) {
    const valueIndex = module3Html.indexOf(detailText);
    assert.ok(valueIndex >= 0, `expected the detail text "${detailText}" to render in module 3`);
    // 「当前采用」渲在这一条细项自己的正文之后不远处（同一个字段的 after 插槽），
    // 不是随便哪里出现过就算数——从这条文本往后开一个小窗口找。
    const nearby = module3Html.slice(valueIndex, valueIndex + 400);
    assert.match(nearby, /当前采用 · v1 赵雅诗 原稿/,
      `expected "${detailText}" to be followed by its own 当前采用 line`);
  }
});

test("溯源视图：第三模块的辅助路径描述／创意作用也各自渲染了「当前采用」", () => {
  const draft = fixtureDraft();
  assert.deepEqual(draft.auxiliaryPaths, ["PERCEPTION"], "this test's unique strings assume the aurora fixture's single PERCEPTION auxiliary path");
  const originPayload = v04UiDraftToPayload(draft);
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({
    draft,
    final: finalContextFor({ originPayload, originOwnerName: "赵雅诗", intakes: [] }),
  })));
  const module3Html = html.slice(html.indexOf('id="module-3"'));
  const perceptionAuxDetail = draft.auxiliaryPathDetails.PERCEPTION ?? { description: "", role: "" };
  for (const auxText of [perceptionAuxDetail.description, perceptionAuxDetail.role]) {
    const valueIndex = module3Html.indexOf(auxText);
    assert.ok(valueIndex >= 0, `expected the auxiliary-path text "${auxText}" to render in module 3`);
    const nearby = module3Html.slice(valueIndex, valueIndex + 400);
    assert.match(nearby, /当前采用 · v1 赵雅诗 原稿/,
      `expected "${auxText}" to be followed by its own 当前采用 line`);
  }
});

test("溯源视图：固定选项字段（故事参照类型）也渲染了「当前采用」，文案是选项的中文标签", () => {
  const draft = fixtureDraft();
  assert.deepEqual(draft.storyReference.selectedOptionIds, ["GROWTH_COMPANIONSHIP"], "this test's expected label assumes the aurora fixture's story reference selection");
  const originPayload = v04UiDraftToPayload(draft);
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({
    draft,
    final: finalContextFor({ originPayload, originOwnerName: "赵雅诗", intakes: [] }),
  })));
  const storyIndex = html.indexOf("故事参照类型");
  assert.ok(storyIndex >= 0, "expected the 故事参照类型 field to render");
  const nearby = html.slice(storyIndex, storyIndex + 600);
  assert.match(nearby, /成长陪伴片/, "expected the selected option's 中文 label, not its raw id");
  assert.match(nearby, /当前采用 · v1 赵雅诗 原稿/,
    "expected the 故事参照类型 field to show its own 当前采用 line, formatted via describeV19ChoiceValue");
});

test("溯源视图：固定选项字段变更后，「当前采用」跟着换成新记录的来源，正文也变成新选项的中文标签", () => {
  const draft = fixtureDraft();
  const originPayload = v04UiDraftToPayload(draft); // unchanged origin — draft.storyReference is what v1 wrote
  draft.storyReference = { ...draft.storyReference, selectedOptionIds: ["FAMILY_AFFECTION"] }; // 集成版这边已经改了
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({
    draft,
    final: finalContextFor({
      originPayload,
      originOwnerName: "赵雅诗",
      intakes: [{
        id: "i1", seq: 1, kind: "FIELD", targetKey: "facts.storyReference", targetLabel: "故事参照类型",
        value: { selectedOptionIds: ["FAMILY_AFFECTION"], customText: "", advancedText: "", vocabularyVersion: "AD_VIDEO_VOCAB_V1" },
        source: "VERSION", sourceVersionNumber: 2, actorName: "老孙", applied: true, createdAt: "2026-09-02T03:00:00.000Z",
      }],
    }),
  })));
  const storyIndex = html.indexOf("故事参照类型");
  const nearby = html.slice(storyIndex, storyIndex + 600);
  assert.match(nearby, /家庭亲情片/, "the field's own rendered text is the new selection's label");
  assert.match(nearby, /当前采用 · v2 老孙/, "当前采用 attributes to the record that actually changed the selection");
});

test("默认视图（非溯源模式）下，第三模块的主导路径细项与固定选项字段也带上了来源 hover title——不再是之前遗漏的两类字段", () => {
  const draft = fixtureDraft();
  const originDraft = fixtureDraft();
  originDraft.primaryPathAnswers.LOVE[0] = "王大明写的原稿细项";
  const originPayload = v04UiDraftToPayload(originDraft);
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({
    draft,
    final: finalContextFor({
      originPayload,
      originOwnerName: "王大明",
      traceMode: false, // 默认视图，不是溯源视图——这里只测 hover title，不测展开的旧写法/未纳入列表
      intakes: [{
        id: "i1", seq: 1, kind: "FIELD", targetKey: "path.primaryDetails", targetLabel: "主导路径细项",
        value: { emotionalBase: draft.primaryPathAnswers.LOVE[0] },
        source: "VERSION", sourceVersionNumber: 2, actorName: "李晓芸", applied: true, createdAt: "2026-08-23T09:47:00.000Z",
      }],
    }),
  })));
  assert.doesNotMatch(html, /当前采用/, "default mode must not render the 溯源 line list, only the hover title");
  assert.match(html, new RegExp(`title="点击编辑 · 来自 v2·李晓芸 ${formatShortDateTime("2026-08-23T09:47:00.000Z")}"`),
    "the primary-detail field must carry the default-mode hover title too, per spec 五、19");
});

test("默认视图（非溯源模式）下，固定选项字段（故事参照类型）改过之后触发按钮也带上了来源 hover title", () => {
  // An unchanged field's current row *is* the origin row, and
  // describeV19FinalTraceHoverSource deliberately returns undefined for an
  // origin row (原稿本身不算 hover 来源 — see the pure-function test in
  // tests/v19-final-trace.test.ts), so this needs an actual change to prove
  // the hover title wiring, same as the primary-detail test above.
  const draft = fixtureDraft();
  const originPayload = v04UiDraftToPayload(draft); // v1 wrote draft.storyReference as-is
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({
    draft,
    final: finalContextFor({
      originPayload,
      originOwnerName: "王大明",
      traceMode: false,
      intakes: [{
        id: "i1", seq: 1, kind: "FIELD", targetKey: "facts.storyReference", targetLabel: "故事参照类型",
        value: { selectedOptionIds: ["FAMILY_AFFECTION"], customText: "", advancedText: "", vocabularyVersion: "AD_VIDEO_VOCAB_V1" },
        source: "VERSION", sourceVersionNumber: 2, actorName: "老孙", applied: true, createdAt: "2026-09-02T03:00:00.000Z",
      }],
    }),
  })));
  assert.doesNotMatch(html, /当前采用/, "default mode must not render the 溯源 line list, only the hover title");
  assert.match(html, new RegExp(`title="点击选择 · 来自 v2·老孙 ${formatShortDateTime("2026-09-02T03:00:00.000Z")}"`),
    "the choice field's trigger must carry the default-mode hover title too, per spec 五、19");
});

// ---------------------------------------------------------------------------
// 溯源视图（合并进 main 后的反馈）：创意承重载体（facts.creativeCarriers，
// 第一模块的三选项 chip 组，既不是 V19EditableValue 也不是 V04ChoiceField）
// 是唯一漏掉「当前采用」的字段——补上 finalCarrierExtras，走
// deriveV19CarrierTrace 单测过的同一套格式化/合并逻辑。
// ---------------------------------------------------------------------------

test("溯源视图：创意承重载体也渲染了「当前采用」，文案是选中载体的中文标签用「、」拼接", () => {
  const draft = fixtureDraft();
  assert.deepEqual(draft.carriers, ["故事", "视听规则"], "this test's expected label assumes the aurora fixture's carrier selection");
  const originPayload = v04UiDraftToPayload(draft);
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({
    draft,
    final: finalContextFor({ originPayload, originOwnerName: "赵雅诗", intakes: [] }),
  })));
  const carrierIndex = html.indexOf("创意承重载体");
  assert.ok(carrierIndex >= 0, "expected the 创意承重载体 field to render");
  const nearby = html.slice(carrierIndex, carrierIndex + 800);
  assert.match(nearby, /当前采用 · v1 赵雅诗 原稿/,
    "expected 创意承重载体 to show its own 当前采用 line — this was the one field this round's feedback said was still missing it");
});

test("溯源视图：创意承重载体变更后，「当前采用」换成新记录的来源，旧选择进旧写法", () => {
  const draft = fixtureDraft();
  const originPayload = v04UiDraftToPayload(draft); // unchanged — draft.carriers is what v1 wrote
  const html = renderToStaticMarkup(createElement(V19StudioDocument, noopProps({
    draft,
    final: finalContextFor({
      originPayload,
      originOwnerName: "赵雅诗",
      intakes: [{
        id: "i1", seq: 1, kind: "FIELD", targetKey: "facts.creativeCarriers", targetLabel: "创意承重载体",
        value: ["COPY"], source: "VERSION", sourceVersionNumber: 2, actorName: "老孙",
        applied: true, createdAt: "2026-09-02T03:00:00.000Z",
      }],
    }),
  })));
  const carrierIndex = html.indexOf("创意承重载体");
  const nearby = html.slice(carrierIndex, carrierIndex + 800);
  assert.match(nearby, /当前采用 · v2 老孙/, "当前采用 attributes to the record that actually changed the selection");
  assert.match(nearby, /文案/, "the trace's current value must be formatted through describeV19CarrierListValue's id-to-label mapping");
});

// ---------------------------------------------------------------------------
// 溯源视图样式，第三轮反馈：用户看了线上效果后不满意「当前采用」的样式——
// 1) 颜色跟条目名称（金色 --v04-subject）撞了，改用跟默认视图辅助说明文字
//    同一色阶的 --v04-muted；2) 字号/字重太重（原先刻意做成「比旧写法摘要
//    行更显眼的锚点」），改成 10.5px / 400——它就是紧跟正文的一行来源注释，
//    不是标题，旧写法摘要行也还是 11px 灰字，两者不比谁压过谁；3) 去掉正文
//    与这一组之间的虚线分隔，间距收紧成 4px，读起来是正文的脚注。上一轮
//    "当前采用字号必须严格大于旧写法摘要行" 的比较关系本身被这轮反馈撤销
//    了，所以这里不再断言两者的相对大小，只断言 .finalTraceCurrent 自己的
//    颜色/字重，以及分隔线/间距。
// ---------------------------------------------------------------------------

// 上一轮的版本只比较了两条规则各自写的数字（.finalTraceCurrent 的
// font-size 字面量 vs .finalTraceSummaryRow 的字面量），根本没算实际的级联
// 结果——真实浏览器里 `.surface button, .surface input, .surface textarea
// { font: inherit; }`（0,1,1）排在 `.finalTraceSummaryRow`（当时是 0,1,0）
// 后面却照样赢，把 font-size 重置成继承 .surface 的 14px，这个纯数字比较
// 的测试完全测不出来。这里换成一个真的算 CSS 优先级（specificity）+ 源码
// 顺序的最小实现，对每个已知会渲染成 <button> 的 className，确认它自己写
// font-size 的那条规则的优先级真的能赢过顶部的按钮重置规则——赢不了就说明
// 浏览器里这条 font-size 会被吃掉，回到 14px。
type CssSpecificity = readonly [id: number, classOrAttrOrPseudoClass: number, typeOrPseudoElement: number];

function compareCssSpecificity(a: CssSpecificity, b: CssSpecificity): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/** Specificity of one compound-selector chain (e.g. ".surface .finalTraceSummaryRow" or "button.finalTraceSummaryRow:hover"). Good enough for this file's selectors — no :not()-argument counting, no shadow-DOM combinators. */
function cssSpecificity(selector: string): CssSpecificity {
  const ids = selector.match(/#[\w-]+/g) ?? [];
  const pseudoElements = selector.match(/::[\w-]+/g) ?? [];
  const withoutPseudoElements = selector.replace(/::[\w-]+/g, " ");
  const classes = withoutPseudoElements.match(/\.[\w-]+/g) ?? [];
  const attrs = withoutPseudoElements.match(/\[[^\]]*\]/g) ?? [];
  const pseudoClasses = withoutPseudoElements.match(/:(?!:)[\w-]+(\([^)]*\))?/g) ?? [];
  const stripped = withoutPseudoElements
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/:(?!:)[\w-]+(\([^)]*\))?/g, " ")
    .replace(/\.[\w-]+/g, " ")
    .replace(/#[\w-]+/g, " ");
  const types = stripped.match(/[a-zA-Z][\w-]*/g) ?? [];
  return [ids.length, classes.length + attrs.length + pseudoClasses.length, types.length + pseudoElements.length];
}

// Every top-level `selector-list { declarations }` rule in `css`, as one entry per comma-separated selector, in source order (source order is what a tie needs). Comments are stripped first — a CSS comment sitting right before a rule is otherwise swallowed into "the selector" by the naive brace-matching regex below, since a comment is just more text between the previous closing brace and the next opening one; unstripped, an explanatory comment's own words and stray dot/hash characters silently inflate that "selector"'s computed specificity into something meaningless.
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

function parseCssRules(css: string): Array<{ selector: string; declarations: string; sourceIndex: number }> {
  const withoutComments = stripCssComments(css);
  const rules: Array<{ selector: string; declarations: string; sourceIndex: number }> = [];
  const ruleRegex = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRegex.exec(withoutComments))) {
    const [, selectorList, declarations] = match;
    for (const selector of selectorList.split(",")) {
      const trimmed = selector.trim();
      if (trimmed) rules.push({ selector: trimmed, declarations, sourceIndex: match.index });
    }
  }
  return rules;
}

test("样式：旧写法摘要行与「采纳这一版」按钮各自的 font-size 规则，优先级真的高过 .surface 顶部的按钮字体重置规则", async () => {
  const [css, component] = await Promise.all([
    readFile(new URL("../components/v04/V04Surface.module.css", import.meta.url), "utf8"),
    readFile(new URL("../components/v04/V19StudioDocument.tsx", import.meta.url), "utf8"),
  ]);
  const rules = parseCssRules(css);

  // 找到真正会命中 <button> 的那条重置规则的具体分支（选择器列表里以
  // "button" 收尾、且规则体里有 "font: inherit" 的那一支），而不是硬编码
  // ".surface button" 这串文字——这样如果将来这条重置规则本身被改写，测试
  // 还是量的是真实规则，不是复述一遍我们期望它长什么样。
  const resetRule = rules.find((rule) => /(^|\s)button$/.test(rule.selector) && /font:\s*inherit/.test(rule.declarations));
  assert.ok(resetRule, "expected to find the .surface button { font: inherit; } reset rule this whole bug is about");
  const resetSpecificity = cssSpecificity(resetRule!.selector);

  for (const className of ["finalTraceSummaryRow", "finalTraceAdopt"]) {
    assert.match(component, new RegExp(`<button[\\s\\S]{0,80}?className=\\{styles\\.${className}\\}`),
      `expected .${className} to still be applied directly to a <button> element — if this ever changes to a non-button element, the reset rule this test guards against no longer applies and this test's premise needs revisiting`);

    // 这个 class 自己声明 font-size 的规则（跳过 :hover 等不设 font-size 的
    // 变体——它们不参与这场优先级之战）。
    const ownFontSizeRule = rules.find((rule) => new RegExp(`\\.${className}(?![\\w-])`).test(rule.selector) && /font-size\s*:/.test(rule.declarations)
      && new RegExp(`^\\.${className}([:[].*)?$`).test(rule.selector.replace(/\s+/g, " ").split(" ").pop() ?? ""));
    assert.ok(ownFontSizeRule, `expected to find a rule that sets .${className}'s own font-size`);
    const ownSpecificity = cssSpecificity(ownFontSizeRule!.selector);

    assert.ok(compareCssSpecificity(ownSpecificity, resetSpecificity) > 0,
      `.${className}'s font-size rule (selector "${ownFontSizeRule!.selector}", specificity ${JSON.stringify(ownSpecificity)}) must outrank the reset rule (selector "${resetRule!.selector}", specificity ${JSON.stringify(resetSpecificity)}) — otherwise the browser recomputes this button's font-size as "inherit" and it silently becomes .surface's 14px regardless of what this file says here`);
  }
});

test("样式：当前采用行不再用条目名称的金色 --v04-subject，字重也降到 400——它是紧跟正文的一行来源注释，不是标题", async () => {
  const css = await readFile(new URL("../components/v04/V04Surface.module.css", import.meta.url), "utf8");
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const currentRule = withoutComments.match(/\.finalTraceCurrent\s*\{([^}]*)\}/);
  assert.ok(currentRule, "expected to find the .finalTraceCurrent rule");
  const declarations = currentRule![1];
  assert.doesNotMatch(declarations, /--v04-subject/,
    "当前采用 must not use --v04-subject — that's the field label's gold, and reusing it here reads as a second heading");
  assert.match(declarations, /color:\s*var\(--v04-muted\)/,
    "当前采用 must use the same muted gray as ordinary hint/助 text in the default view");
  assert.match(declarations, /font-weight:\s*400/,
    "当前采用 must not be bold (font-weight: 400, not 700) — it's a footnote, not a heading");
});

test("样式：正文与「当前采用」之间不再有虚线分隔，间距收紧成脚注的样子——.editableLocked 的锁定态虚线 hover 不受影响", async () => {
  const css = await readFile(new URL("../components/v04/V04Surface.module.css", import.meta.url), "utf8");
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const finalTraceRule = withoutComments.match(/\.finalTrace\s*\{([^}]*)\}/);
  assert.ok(finalTraceRule, "expected to find the .finalTrace rule");
  const declarations = finalTraceRule![1];
  assert.doesNotMatch(declarations, /border-top/,
    "the dashed separator between the field's body text and the 溯源 group must be gone");
  assert.doesNotMatch(declarations, /padding-top/,
    "no leftover padding-top standing in for the removed border-top's spacing");
  assert.match(declarations, /margin-top:\s*4px/,
    "the group should sit close under the body text, like a footnote, not floating in its own box");
  // 锁定态（非老孙）字段 hover 出来的琥珀色虚线是完全不同的一套东西
  // （V19EditableValue/V04ChoiceField 的 .editableLocked / .choiceTriggerLocked），
  // 这轮反馈明确说了不要动它。
  assert.match(css, /\.editableLocked:hover \{ border-bottom-color: rgba\(255, 174, 120, \.55\); background: rgba\(255, 174, 120, \.08\); \}/,
    "the locked-field amber dashed hover treatment must remain untouched");
});
