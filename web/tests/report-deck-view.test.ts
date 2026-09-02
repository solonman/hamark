import assert from "node:assert/strict";
import test from "node:test";
import {
  blockCommentKey,
  boxLabel,
  clampColumnWidth,
  clampFloatingPosition,
  deckSummary,
  describePlanMove,
  drawnBlockRect,
  fabDescriptor,
  guideStepIndex,
  insertMarkerPageNo,
  isDrawnBlockTooSmall,
  marqueeHits,
  moduleCommentKey,
  moveToastText,
  navStripCell,
  pageCommentKey,
  pageMarkKind,
  placeAnchoredPanel,
  placeFloatingToolbar,
  pointToStagePercent,
  rangeLabelForPageNumbers,
  rectsIntersect,
  resolveMarqueeSelection,
  resolveRangeSelection,
  resolveShiftExtend,
  sortBlocksByPosition,
  toggleOrReplaceSingle,
  unitCommentKey,
} from "../components/report/studio/deck/deck-view.ts";
import {
  emptyReportAnnotation,
  type ReportAnnotation,
  type ReportModule,
  type ReportPage,
  type ReportUnit,
} from "../lib/report-structure.ts";

/* ============================ Fixture ============================ */
// Small, hand-built annotation (not the full 50-page honggutan case) so each
// test only needs to reason about a handful of pages. Shape: M1 = p1-6
// (U1 = p1-3, U1a child = p2-3), free pages p7-10, all inside a 12-page deck.

function page(n: number, overrides: Partial<ReportPage> = {}): ReportPage {
  return { n, mid: null, uid: null, transition: false, func: "", org: "", blocks: [], ...overrides };
}

function buildFixture(): ReportAnnotation {
  const modules: ReportModule[] = [
    { id: "M1", name: "营销命题", rel: "推导", role: "" },
  ];
  const units: ReportUnit[] = [
    { id: "U1", mid: "M1", pid: null, name: "前言", rel: "推导", task: "", role: "", psy: "", concl: "" },
    { id: "U1a", mid: "M1", pid: "U1", name: "子段", rel: "并列", task: "", role: "", psy: "", concl: "" },
  ];
  const pages: ReportPage[] = [
    page(1, { mid: "M1", uid: "U1" }),
    page(2, { mid: "M1", uid: "U1a" }),
    page(3, { mid: "M1", uid: "U1a" }),
    page(4, { mid: "M1" }),
    page(5, { mid: "M1" }),
    page(6, { mid: "M1" }),
    page(7),
    page(8),
    page(9),
    page(10),
  ];
  return {
    background: { city: "", developer: "", projectBackground: "", businessBackground: "" },
    strategy: { narrative: "", model: "" },
    modules,
    units,
    pages,
  };
}

/* ============================ rects / marquee ============================ */

test("rectsIntersect is a standard AABB overlap test", () => {
  assert.equal(rectsIntersect({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 5, top: 5, right: 15, bottom: 15 }), true);
  assert.equal(rectsIntersect({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 10, top: 10, right: 20, bottom: 20 }), false);
  assert.equal(rectsIntersect({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 20, top: 20, right: 30, bottom: 30 }), false);
});

test("marqueeHits returns only cards whose rect overlaps the marquee, any order", () => {
  const cards = [
    { n: 1, rect: { left: 0, top: 0, right: 10, bottom: 10 } },
    { n: 2, rect: { left: 20, top: 0, right: 30, bottom: 10 } },
    { n: 3, rect: { left: 5, top: 5, right: 15, bottom: 15 } },
  ];
  const hits = marqueeHits(cards, { left: 0, top: 0, right: 12, bottom: 12 });
  assert.deepEqual(hits.sort(), [1, 3]);
});

/* ============================ range / shift-click selection ============================ */

test("resolveRangeSelection accepts a span entirely open in the target box", () => {
  const a = buildFixture();
  assert.deepEqual(resolveRangeSelection(a, "free", 7, 9), [7, 8, 9]);
  assert.deepEqual(resolveRangeSelection(a, "free", 9, 7), [7, 8, 9], "order-independent (lo/hi normalized)");
});

test("resolveRangeSelection refuses a span that crosses a taken page", () => {
  const a = buildFixture();
  // p1-6 belong to M1, not open in "free"; p7-10 are open.
  assert.equal(resolveRangeSelection(a, "free", 5, 8), null);
});

test("resolveRangeSelection only sees a container's own open (not-yet-claimed) pages", () => {
  const a = buildFixture();
  // Inside mod:M1, p1-3 are claimed by unit U1 — only p4-6 are open.
  assert.deepEqual(resolveRangeSelection(a, "mod:M1", 4, 6), [4, 5, 6]);
  assert.equal(resolveRangeSelection(a, "mod:M1", 3, 5), null);
  // Inside unit:U1, p1 is open (its own direct page) but p2-3 belong to child U1a.
  assert.deepEqual(resolveRangeSelection(a, "unit:U1", 1, 1), [1]);
  assert.equal(resolveRangeSelection(a, "unit:U1", 1, 2), null);
});

test("resolveMarqueeSelection resolves the drag-box hits through the same open/contiguous rule", () => {
  const a = buildFixture();
  const cards = [
    { n: 8, rect: { left: 0, top: 0, right: 10, bottom: 10 } },
    { n: 9, rect: { left: 0, top: 20, right: 10, bottom: 30 } },
    { n: 7, rect: { left: 0, top: 40, right: 10, bottom: 50 } },
  ];
  const ids = resolveMarqueeSelection(a, "free", cards, { left: -5, top: -5, right: 15, bottom: 55 });
  assert.deepEqual(ids, [7, 8, 9]);
  assert.equal(resolveMarqueeSelection(a, "free", [], { left: 0, top: 0, right: 1, bottom: 1 }), null);
});

test("resolveMarqueeSelection trims a claimed page merely grazed at one edge, instead of refusing outright", () => {
  const a = buildFixture();
  // p6 belongs to M1 (claimed, not open in "free"); p7-p8 are free. A drag
  // box whose bottom edge only grazes p6's last pixel still registers p6 as
  // a "hit" (marqueeHits is a plain rect-overlap test) — this reproduces the
  // acceptance repro (p03-p04 drag grazing taken p02 by ~1px selected
  // nothing). Trimming should drop the grazed p6 and keep [7, 8].
  const cards = [
    { n: 6, rect: { left: 0, top: 0, right: 10, bottom: 10 } },
    { n: 7, rect: { left: 0, top: 20, right: 10, bottom: 30 } },
    { n: 8, rect: { left: 0, top: 40, right: 10, bottom: 50 } },
  ];
  const ids = resolveMarqueeSelection(a, "free", cards, { left: -5, top: 9, right: 15, bottom: 55 });
  assert.deepEqual(ids, [7, 8]);
});

test("resolveMarqueeSelection trims claimed pages grazed at both edges", () => {
  // Dedicated fixture: p1 claimed, p2-p3 free, p4 claimed — an open span
  // bracketed on both sides. A drag box that grazes both p1 and p4 (fully
  // covering p2-p3) must trim from *both* ends and keep just [2, 3].
  const a: ReportAnnotation = {
    background: { city: "", developer: "", projectBackground: "", businessBackground: "" },
    strategy: { narrative: "", model: "" },
    modules: [{ id: "M1", name: "", rel: "推导", role: "" }],
    units: [],
    pages: [page(1, { mid: "M1" }), page(2), page(3), page(4, { mid: "M1" })],
  };
  const cards = [
    { n: 1, rect: { left: 0, top: 0, right: 10, bottom: 10 } },
    { n: 2, rect: { left: 0, top: 20, right: 10, bottom: 30 } },
    { n: 3, rect: { left: 0, top: 40, right: 10, bottom: 50 } },
    { n: 4, rect: { left: 0, top: 60, right: 10, bottom: 70 } },
  ];
  const ids = resolveMarqueeSelection(a, "free", cards, { left: -5, top: 9, right: 15, bottom: 61 });
  assert.deepEqual(ids, [2, 3]);
});

test("resolveMarqueeSelection collapses to a single open page when trimming both ends meets in the middle", () => {
  const a = buildFixture();
  // unit:U1's only *open* direct page is p1 (p2-3 belong to child unit
  // U1a). Hitting p1-3: the low end (p1) is already open, the high end
  // trims 3 -> 2 -> 1, landing on the single open page.
  const cards = [
    { n: 1, rect: { left: 0, top: 0, right: 10, bottom: 10 } },
    { n: 2, rect: { left: 0, top: 20, right: 10, bottom: 30 } },
    { n: 3, rect: { left: 0, top: 40, right: 10, bottom: 50 } },
  ];
  const ids = resolveMarqueeSelection(a, "unit:U1", cards, { left: -5, top: -5, right: 15, bottom: 55 });
  assert.deepEqual(ids, [1]);
});

test("resolveMarqueeSelection still refuses when a claimed page sits strictly inside the trimmed span", () => {
  // A dedicated 3-page fixture with the middle page claimed by a module and
  // both neighbors free — the demo's original rule ("would split into two
  // disconnected open segments") must still apply once trimming can no
  // longer help, i.e. the claimed page isn't at either edge.
  const a: ReportAnnotation = {
    background: { city: "", developer: "", projectBackground: "", businessBackground: "" },
    strategy: { narrative: "", model: "" },
    modules: [{ id: "M1", name: "", rel: "推导", role: "" }],
    units: [],
    pages: [page(1), page(2, { mid: "M1" }), page(3)],
  };
  const cards = [
    { n: 1, rect: { left: 0, top: 0, right: 10, bottom: 10 } },
    { n: 2, rect: { left: 0, top: 20, right: 10, bottom: 30 } },
    { n: 3, rect: { left: 0, top: 40, right: 10, bottom: 50 } },
  ];
  // Neither edge (p1, p3) is claimed, so there's nothing to trim — p2 sits
  // strictly in the middle of the span and the whole selection is refused.
  const ids = resolveMarqueeSelection(a, "free", cards, { left: -5, top: -5, right: 15, bottom: 55 });
  assert.equal(ids, null);
});

test("resolveMarqueeSelection refuses when trimming both ends leaves nothing open", () => {
  const a = buildFixture();
  // p1-3 are all claimed from "free"'s perspective (mid=M1); a drag box that
  // only ever touches those has nothing left after trimming from either end.
  const cards = [
    { n: 1, rect: { left: 0, top: 0, right: 10, bottom: 10 } },
    { n: 2, rect: { left: 0, top: 20, right: 10, bottom: 30 } },
    { n: 3, rect: { left: 0, top: 40, right: 10, bottom: 50 } },
  ];
  assert.equal(resolveMarqueeSelection(a, "free", cards, { left: -5, top: -5, right: 15, bottom: 55 }), null);
});

test("resolveShiftExtend extends from the anchor toward the clicked page", () => {
  const a = buildFixture();
  const sel = { key: "free" as const, ids: [8] };
  const extended = resolveShiftExtend(a, sel, 8, "free", 10);
  assert.deepEqual(extended, { ids: [8, 9, 10], anchor: 8 });
});

test("resolveShiftExtend with no anchor extends from whichever selection end is farther from the click", () => {
  const a = buildFixture();
  const sel = { key: "free" as const, ids: [7, 8, 9] }; // marquee-born, no anchor
  const towardHigh = resolveShiftExtend(a, sel, null, "free", 10);
  assert.deepEqual(towardHigh, { ids: [7, 8, 9, 10], anchor: 7 }, "click above the high end extends from the low end");
});

test("resolveShiftExtend refuses across boxes or through a taken page", () => {
  const a = buildFixture();
  assert.equal(resolveShiftExtend(a, { key: "free", ids: [7] }, 7, "mod:M1", 4), null, "different box");
  assert.equal(resolveShiftExtend(a, { key: "free", ids: [] }, null, "free", 5), null, "nothing selected yet");
  assert.equal(resolveShiftExtend(a, { key: "mod:M1", ids: [4] }, 4, "mod:M1", 2), null, "would cross claimed p1-3");
});

test("toggleOrReplaceSingle clears on re-clicking the sole selected page, else replaces", () => {
  assert.equal(toggleOrReplaceSingle({ key: "free", ids: [5] }, "free", 5), null);
  assert.deepEqual(toggleOrReplaceSingle({ key: "free", ids: [5] }, "free", 6), { ids: [6], anchor: 6 });
  assert.deepEqual(toggleOrReplaceSingle({ key: "free", ids: [5, 6] }, "free", 5), { ids: [5], anchor: 5 });
});

/* ============================ insert marker ============================ */

test("insertMarkerPageNo finds the first not-moving shown page past the moving set", () => {
  assert.equal(insertMarkerPageNo([1, 2, 3, 5, 6], [2, 3]), 5);
  assert.equal(insertMarkerPageNo([1, 2, 3], [1, 2, 3]), null, "moving set reaches the end -> append");
  assert.equal(insertMarkerPageNo([], [1]), null);
  assert.equal(insertMarkerPageNo([1, 2], []), null, "nothing moving");
});

/* ============================ floating toolbar ============================ */

test("fabDescriptor offers '设为模块 N' for a free-tray selection, numbered by insertion position", () => {
  const a = buildFixture();
  const d = fabDescriptor(a, "free", [7, 8]);
  assert.deepEqual(d, { available: true, kind: "module", label: "设为模块 2" });
});

test("fabDescriptor offers '设为单元' inside a module tray and '设为子单元' inside a unit tray", () => {
  const a = buildFixture();
  const unitFab = fabDescriptor(a, "mod:M1", [4, 5]);
  assert.equal(unitFab.available, true);
  if (unitFab.available) {
    assert.equal(unitFab.kind, "unit");
    assert.equal(unitFab.label, "设为单元 1-2");
  }
  // U1's own direct page (p1) is still open — U1a only claimed p2-3 — so a
  // selection of just p1 can become a second child unit under U1.
  const subunitFab = fabDescriptor(a, "unit:U1", [1]);
  assert.deepEqual(subunitFab, { available: true, kind: "subunit", label: "设为子单元 1-1-1" });
});

test("fabDescriptor rejects an empty, non-contiguous, or already-claimed selection with a reason", () => {
  const a = buildFixture();
  assert.equal(fabDescriptor(a, "free", []).available, false);
  const nonContig = fabDescriptor(a, "free", [7, 9]);
  assert.equal(nonContig.available, false);
  if (!nonContig.available) assert.match(nonContig.reason, /连续/);
  const taken = fabDescriptor(a, "free", [5, 6]);
  assert.equal(taken.available, false, "p5-6 belong to M1, not open in free");
});

/* ============================ page mark / nav strip ============================ */

test("pageMarkKind reflects done/在标/未标注", () => {
  assert.equal(pageMarkKind(page(1)), "none");
  assert.equal(pageMarkKind(page(1, { func: "写了一半" })), "partial");
  assert.equal(
    pageMarkKind(page(1, {
      func: "页面作用",
      blocks: [{ id: "b1", name: "", x: 0, y: 0, w: 10, h: 10, type: "标题", roles: ["核心观点"], style: "理性", rel: "展开", narr: "", mark: "" }],
    })),
    "done",
  );
});

test("navStripCell colors an ungrouped page neutrally and a grouped page by its module", () => {
  const a = buildFixture();
  const free = navStripCell(a, page(7), 7);
  assert.equal(free.color, null);
  assert.equal(free.isModuleStart, false);

  const first = navStripCell(a, a.pages[0], 1); // p1, module start, root unit U1 (index 0)
  assert.equal(first.isModuleStart, true);
  assert.equal(first.isCurrent, true);
  assert.equal(first.brightness, 1);
  assert.ok(first.color);

  const notCurrent = navStripCell(a, a.pages[3], 1); // p4, current is p1
  assert.equal(notCurrent.isCurrent, false);
});

/* ============================ guide step ============================ */

test("guideStepIndex walks 划模块 -> 划单元 -> 标注 as structure fills in", () => {
  const empty = emptyReportAnnotation([1, 2, 3]);
  assert.equal(guideStepIndex(empty), 0);
  const withModule: ReportAnnotation = { ...empty, modules: [{ id: "M1", name: "", rel: "推导", role: "" }] };
  assert.equal(guideStepIndex(withModule), 1);
  assert.equal(guideStepIndex(buildFixture()), 2);
});

/* ============================ column width / floating position ============================ */

test("clampColumnWidth keeps the splitter inside its 150-680 range", () => {
  assert.equal(clampColumnWidth(50), 150);
  assert.equal(clampColumnWidth(900), 680);
  assert.equal(clampColumnWidth(300), 300);
});

test("placeAnchoredPanel sits below the anchor when it fits", () => {
  const pos = placeAnchoredPanel({
    anchor: { top: 100, bottom: 120, left: 50 },
    width: 300, height: 200, viewportWidth: 1000, viewportHeight: 800,
  });
  assert.equal(pos.x, 50);
  assert.equal(pos.y, 128); // bottom(120) + gap(8)
});

test("placeAnchoredPanel flips above the anchor when there isn't room below", () => {
  const pos = placeAnchoredPanel({
    anchor: { top: 600, bottom: 620, left: 50 },
    width: 300, height: 200, viewportWidth: 1000, viewportHeight: 800,
  });
  // below would be 620+8+200=828 > 800-10 -> flips: top(600) - gap(8) - height(200) = 392
  assert.equal(pos.y, 392);
});

test("placeAnchoredPanel still clamps into the viewport when even the flipped position would overflow", () => {
  // Anchor near the top of a short viewport: below overflows (60+8+600=668 > 490),
  // and flipping above would go negative (40-8-600) — the final clamp must win either way.
  const tight = placeAnchoredPanel({
    anchor: { top: 40, bottom: 60, left: 50 },
    width: 300, height: 600, viewportWidth: 1000, viewportHeight: 500,
  });
  assert.ok(tight.y >= 72, "never goes above the sticky top bar's minTop");
});

test("placeFloatingToolbar reproduces the acceptance repro: p01-p03 selected, 1280x1800 viewport, no scroll", () => {
  // Exact repro from acceptance feedback: viewport 1280x1800, page not scrolled,
  // free-column selection p01-p03 whose combined card rect is y 792-1170 in
  // viewport coordinates. The old bug (no top/left ever set — `.fab` just sat
  // at its static-flow position below the whole 50-page deck) produced
  // top=2159, nowhere near the selection and off-screen entirely.
  const cardRects = [
    { left: 20, top: 792, right: 214, bottom: 918 },
    { left: 20, top: 924, right: 214, bottom: 1044 },
    { left: 20, top: 1050, right: 214, bottom: 1170 },
  ];
  const pos = placeFloatingToolbar({
    cardRects, toolbarWidth: 220, viewportWidth: 1280, viewportHeight: 1800,
  });
  assert.ok(pos, "must place the toolbar once there are selected cards");
  // y = clamp(72, 1800-56=1744, bottom(1170)+gap(8)=1178) = 1178 — just under
  // the selection, and nowhere near the buggy 2159.
  assert.equal(pos!.y, 1178);
  assert.ok(pos!.y < 1800, "must stay inside the 1800px-tall viewport");
  // Centering under the union (left=20, right=214) would put x at 7, which is
  // inside the 10px margin — clamps to 10 (a narrow left column, as in this
  // repro, routinely pins the toolbar to the margin rather than true center).
  assert.equal(pos!.x, 10);
});

test("placeFloatingToolbar output doesn't balloon with viewport height the way the bug did", () => {
  // Acceptance feedback: growing the viewport to 2400 tall moved the buggy
  // top from 2159 to 2644 even though the on-screen selection hadn't moved —
  // proof the old number tracked document flow, not the viewport. The fixed
  // version, given the *same* card rects, must land at the same y regardless
  // of viewport height (as long as it still fits).
  const cardRects = [{ left: 20, top: 792, right: 214, bottom: 1170 }];
  const at1800 = placeFloatingToolbar({ cardRects, toolbarWidth: 220, viewportWidth: 1280, viewportHeight: 1800 });
  const at2400 = placeFloatingToolbar({ cardRects, toolbarWidth: 220, viewportWidth: 1280, viewportHeight: 2400 });
  assert.equal(at1800!.y, at2400!.y);
  assert.equal(at1800!.y, 1178);
});

test("placeFloatingToolbar reproduces the module-tray shift-select repro (p01-p02)", () => {
  // Acceptance feedback: shift-selecting p01-p02 inside a module tray reported
  // top=2036 under the buggy build. With made-up but representative card
  // rects for that selection, the fix must land well inside the viewport.
  const cardRects = [
    { left: 320, top: 210, right: 404, bottom: 300 },
    { left: 320, top: 306, right: 404, bottom: 396 },
  ];
  const pos = placeFloatingToolbar({ cardRects, toolbarWidth: 220, viewportWidth: 1280, viewportHeight: 1800 });
  assert.equal(pos!.y, 396 + 8);
  assert.ok(pos!.y < 1800);
});

test("placeFloatingToolbar returns null with no selected cards, and clamps at the viewport edges", () => {
  assert.equal(placeFloatingToolbar({ cardRects: [], toolbarWidth: 220, viewportWidth: 1280, viewportHeight: 1800 }), null);
  // Selection right at the bottom edge: toolbar must clamp to minTop/vh-56, never spill past either.
  const nearBottom = placeFloatingToolbar({
    cardRects: [{ left: 10, top: 1790, right: 100, bottom: 1798 }],
    toolbarWidth: 220, viewportWidth: 1280, viewportHeight: 1800,
  });
  assert.equal(nearBottom!.y, 1800 - 56);
  // Selection hugging the left edge: x must not go negative.
  const nearLeft = placeFloatingToolbar({
    cardRects: [{ left: 0, top: 100, right: 20, bottom: 140 }],
    toolbarWidth: 220, viewportWidth: 1280, viewportHeight: 1800,
  });
  assert.equal(nearLeft!.x, 10);
});

test("clampFloatingPosition keeps a panel inside the viewport and below the sticky top bar", () => {
  const pos = clampFloatingPosition({
    x: -50, y: 0, width: 200, height: 100, viewportWidth: 800, viewportHeight: 600,
  });
  assert.equal(pos.x, 10);
  assert.equal(pos.y, 72);
  const overflowing = clampFloatingPosition({
    x: 790, y: 590, width: 200, height: 100, viewportWidth: 800, viewportHeight: 600,
  });
  assert.equal(overflowing.x, 800 - 200 - 10);
  assert.equal(overflowing.y, 600 - 100 - 10);
});

/* ============================ comment target keys ============================ */

test("comment target key builders follow the module:/unit:/page: <field> convention", () => {
  assert.equal(moduleCommentKey("M1", "name"), "module:M1:name");
  assert.equal(unitCommentKey("U1", "concl"), "unit:U1:concl");
  assert.equal(pageCommentKey(5, "func"), "page:5:func");
  assert.equal(blockCommentKey("b1", "narr"), "block:b1:narr");
});

/* ============================ move preview / toast ============================ */

test("boxLabel names the free tray, a module, or a unit by its derived number", () => {
  const a = buildFixture();
  assert.equal(boxLabel(a, "free"), "左边的页序");
  assert.equal(boxLabel(a, "mod:M1"), "模块 1");
  assert.equal(boxLabel(a, "unit:U1a"), "单元 1-1-1");
});

test("describePlanMove previews a plain move as '<段> → <目标>'", () => {
  const a = buildFixture();
  const plan = describePlanMove(a, "free", "mod:M1", 7, [7]);
  assert.equal(plan.ok, true);
  if (plan.ok) assert.equal(plan.text, "p07 → 模块 1");
});

test("describePlanMove prefixes a boundary-carry move with '边界挪到 pNN：'", () => {
  const a = buildFixture();
  // Dragging p5 (the open mod:M1 run is p4-6; free encloses it, p5 sits
  // strictly inside) retreats the nearer end — here the right edge, p5-6 —
  // rather than moving just the single dragged page.
  const plan = describePlanMove(a, "mod:M1", "free", 5, [5]);
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.equal(plan.text, "边界挪到 p05：p05–p06 → 左边的页序");
    assert.deepEqual(plan.ids, [5, 6]);
  }
});

test("describePlanMove rejects a move that would split a segment, with the same reason as planMove", () => {
  const a = buildFixture();
  const plan = describePlanMove(a, "unit:U1a", "free", 2, [2]);
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.match(plan.text, /两截/);
});

test("moveToastText notes cleaned-up empty segments only when there were any", () => {
  assert.equal(moveToastText(3, 0), "已移动 3 页。");
  assert.equal(moveToastText(3, 2), "已移动 3 页。（2 个空段自动撤销）");
});

test("rangeLabelForPageNumbers formats a single page, a span, or an empty list", () => {
  assert.equal(rangeLabelForPageNumbers([5]), "p05");
  assert.equal(rangeLabelForPageNumbers([9, 5, 7]), "p05–p09");
  assert.equal(rangeLabelForPageNumbers([]), "空");
});

/* ============================ page-image block drawing ============================ */
// Restored box-draw feature ("＋ 框选") — the coordinator corrected an
// earlier misreading of "页面坐标取消" (that meant don't *display* x/y/w/h
// as numbers, not drop the draw interaction). These mirror the demo's
// `wireDraw()` pointer math (docs/demos 第 1181-1198 行).

test("pointToStagePercent converts a viewport point to a percentage of the stage rect", () => {
  const stage = { left: 100, top: 50, width: 400, height: 200 };
  assert.deepEqual(pointToStagePercent(100, 50, stage), { x: 0, y: 0 });
  assert.deepEqual(pointToStagePercent(500, 250, stage), { x: 100, y: 100 });
  assert.deepEqual(pointToStagePercent(300, 150, stage), { x: 50, y: 50 });
});

test("drawnBlockRect normalizes a drag in either direction and rounds to one decimal", () => {
  assert.deepEqual(drawnBlockRect({ x: 10, y: 20 }, { x: 30, y: 25 }), { x: 10, y: 20, w: 20, h: 5 });
  // Dragged up-and-left of the start point: x/y should still be the min corner.
  assert.deepEqual(drawnBlockRect({ x: 30, y: 25 }, { x: 10, y: 20 }), { x: 10, y: 20, w: 20, h: 5 });
  assert.deepEqual(drawnBlockRect({ x: 1.23, y: 1.26 }, { x: 4.56, y: 1.26 }), { x: 1.2, y: 1.3, w: 3.3, h: 0 });
});

test("isDrawnBlockTooSmall matches the demo's w<3||h<2 refusal threshold", () => {
  assert.equal(isDrawnBlockTooSmall(2.9, 10), true, "too narrow");
  assert.equal(isDrawnBlockTooSmall(10, 1.9), true, "too short");
  assert.equal(isDrawnBlockTooSmall(3, 2), false, "right at the threshold is accepted");
  assert.equal(isDrawnBlockTooSmall(10, 10), false);
});

test("sortBlocksByPosition orders top-to-bottom then left-to-right, matching the demo's post-draw sort", () => {
  const blocks = [
    { id: "c", x: 10, y: 50 },
    { id: "a", x: 5, y: 10 },
    { id: "b", x: 60, y: 10 },
  ];
  assert.deepEqual(sortBlocksByPosition(blocks).map((b) => b.id), ["a", "b", "c"]);
  // Doesn't mutate the input.
  assert.equal(blocks[0].id, "c");
});

/* ============================ header summary ============================ */

test("deckSummary counts modules/units/blocks and splits pages into done/在标/untouched", () => {
  const a = buildFixture();
  const withBlock: ReportAnnotation = {
    ...a,
    pages: a.pages.map((p) => (p.n === 1
      ? { ...p, func: "作用", blocks: [{ id: "b1", name: "", x: 0, y: 0, w: 1, h: 1, type: "标题", roles: ["核心观点"], style: "理性", rel: "展开", narr: "", mark: "" }] }
      : p.n === 2 ? { ...p, func: "写了一半" } : p)),
  };
  const summary = deckSummary(withBlock);
  assert.equal(summary.moduleCount, 1);
  assert.equal(summary.unitCount, 2);
  assert.equal(summary.blockCount, 1);
  assert.equal(summary.totalPages, 10);
  assert.equal(summary.donePages, 1);
  assert.equal(summary.inProgressPages, 1);
});
