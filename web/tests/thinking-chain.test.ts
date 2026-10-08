import assert from "node:assert/strict";
import test from "node:test";
import {
  computeThinkingChainFlowColumns,
  normalizeThinkingChainText,
  outlineBackspace,
  outlineBlockEnd,
  outlineDeleteRange,
  outlineIndent,
  outlineMove,
  outlineMoveRange,
  outlineOutdent,
  outlinePaste,
  outlineRangeText,
  outlineReplaceRange,
  outlineSelectionRange,
  outlineShiftRange,
  outlineSplit,
  parseThinkingChainRows,
  parseThinkingChains,
  placeThinkingChainFlowItem,
  splitThinkingChainTitle,
  stripThinkingChainStepNumber,
  thinkingChainFlowConnectors,
  thinkingChainRowsToText,
  type ThinkingChainRow,
} from "../lib/thinking-chain.ts";

const SAMPLE = `商业问题与洞察
  - 问题：如何打破传统时尚广告的冰冷感？
  - 品牌：Kate Spade
    - 理念：乐观、俏皮
    - 基因：美式复古
  - 客群：20–40 岁女性
    - 偏好：色彩明快
      - 食物、花卉、童趣主题
创意主张
  - 快乐并不遥远`;

const LEGACY = `1）如何打破一贯的传统时尚广告高冷?
2）Kate Spade 品牌理念：乐观、俏皮
3）从客群出发，寻找快乐`;

const rows = (spec: string): ThinkingChainRow[] => parseThinkingChainRows(spec);
const levels = (list: readonly ThinkingChainRow[]) => list.map((row) => row.level).join("");
const texts = (list: readonly ThinkingChainRow[]) => list.map((row) => row.text);

test("parses the Markdown list into levelled rows and writes it back unchanged", () => {
  const parsed = rows(SAMPLE);
  assert.equal(levels(parsed), "0112212301");
  assert.equal(parsed[1].text, "问题：如何打破传统时尚广告的冰冷感？");
  assert.equal(thinkingChainRowsToText(parsed), SAMPLE);
});

test("reads tabs, full-width spaces, bare indentation and odd list marks, and skips blank lines", () => {
  const parsed = rows("中心\n\t步骤一\n\t\t· 分叉\n\n　步骤二\n   * 分叉二");
  assert.deepEqual(texts(parsed), ["中心", "步骤一", "分叉", "步骤二", "分叉二"]);
  assert.equal(levels(parsed), "01212");
});

test("a jump of several indentation levels hangs on the nearest shallower row", () => {
  assert.equal(levels(rows("中心\n        深跳\n  - 回来")), "011");
});

test("writing drops empty rows and trims every node", () => {
  const text = thinkingChainRowsToText([{ level: 0, text: " 中心 " }, { level: 1, text: "" }, { level: 1, text: "步骤 " }]);
  assert.equal(text, "中心\n  - 步骤");
});

test("normalising makes a hand-written outline compare equal to what the editor would save", () => {
  assert.equal(normalizeThinkingChainText("中心\n\t- 步骤\n\t\t分叉"), "中心\n  - 步骤\n    - 分叉");
  assert.equal(normalizeThinkingChainText(SAMPLE), SAMPLE);
});

test("several centres make several chains; nodes nest under their parents", () => {
  const chains = parseThinkingChains(SAMPLE);
  assert.equal(chains.length, 2);
  assert.equal(chains[0].implicit, false);
  assert.deepEqual(chains[0].kids.map((kid) => kid.text.slice(0, 2)), ["问题", "品牌", "客群"]);
  assert.equal(chains[0].kids[2].kids[0].kids[0].text, "食物、花卉、童趣主题");
});

test("legacy text with no indentation becomes one implicit chain, one step per line", () => {
  const chains = parseThinkingChains(LEGACY);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].implicit, true);
  assert.equal(chains[0].kids.length, 3);
  // a single line is just a centre
  const single = parseThinkingChains("只有一句");
  assert.equal(single.length, 1);
  assert.equal(single[0].implicit, false);
  assert.equal(single[0].kids.length, 0);
  assert.deepEqual(parseThinkingChains("   "), []);
});

test("short titles before a colon are split out; long or punctuated ones are not", () => {
  assert.deepEqual(splitThinkingChainTitle("品牌：Kate Spade"), { title: "品牌", detail: "Kate Spade" });
  assert.deepEqual(splitThinkingChainTitle("Kate Spade 品牌理念：乐观"), { title: "Kate Spade 品牌理念", detail: "乐观" });
  assert.equal(splitThinkingChainTitle("如何打破，冰冷感：不行").title, "");
  assert.equal(splitThinkingChainTitle("没有冒号").title, "");
});

test("a leading step number equal to the step's own number is hidden, other numbers stay", () => {
  assert.equal(stripThinkingChainStepNumber("2）Kate Spade", 2), "Kate Spade");
  assert.equal(stripThinkingChainStepNumber("2. 品牌", 2), "品牌");
  assert.equal(stripThinkingChainStepNumber("3）品牌", 2), "3）品牌");
  assert.equal(stripThinkingChainStepNumber("20 岁女性", 2), "20 岁女性");
});

test("columns: as many minimum-width cells as fit, then the row is shared out evenly", () => {
  // 14px font: minimum 189px per cell; 4 cells need 4*189 + 3*34 = 858 (+24 reserve)
  assert.deepEqual(computeThinkingChainFlowColumns(1054, 9, 14), { columns: 4, columnWidth: (1030 - 3 * 34) / 4 });
  assert.equal(computeThinkingChainFlowColumns(800, 9, 14).columns, 3);
  // never more columns than cells, capped at 30em wide
  assert.deepEqual(computeThinkingChainFlowColumns(1054, 2, 14), { columns: 2, columnWidth: 420 });
  // narrow: one column filling the room
  assert.deepEqual(computeThinkingChainFlowColumns(300, 6, 14), { columns: 1, columnWidth: 276 });
  assert.equal(computeThinkingChainFlowColumns(100, 6, 14).columnWidth, 110);
});

test("snake placement alternates direction row by row; a single column always reads left to right", () => {
  const cells = Array.from({ length: 8 }, (_, i) => placeThinkingChainFlowItem(i, 3));
  assert.deepEqual(cells.map((cell) => `${cell.row}/${cell.column}`), ["0/1", "0/2", "0/3", "1/3", "1/2", "1/1", "2/1", "2/2"]);
  assert.deepEqual(cells.map((cell) => cell.leftToRight), [true, true, true, false, false, false, true, true]);
  assert.ok([0, 1, 2].every((i) => placeThinkingChainFlowItem(i, 1).leftToRight));
});

test("connectors: straight arrows inside a row, a U-turn on the outer side at each row change", () => {
  const box = (row: number, column: number) => ({ left: column * 200, right: column * 200 + 160, top: row * 100, bottom: row * 100 + 60 });
  const rects = [box(0, 0), box(0, 1), box(1, 1), box(1, 0), box(2, 0)];
  const connectors = thinkingChainFlowConnectors(rects, 2);
  assert.equal(connectors.length, 4);
  assert.equal(connectors[0].line, "M160,17 H193"); // left to right
  assert.match(connectors[1].line, /^M360,17 H368 Q378,17 378,27 V107 Q378,117 368,117 H367$/); // right-side U-turn
  assert.match(connectors[1].tip, /^M360,117 l8,-5/); // arrives pointing left
  assert.equal(connectors[2].line, "M200,117 H167"); // right to left
  assert.match(connectors[3].line, /^M0,117 H-8 Q-18,117 -18,127/); // left-side U-turn
  assert.match(connectors[3].tip, /^M0,217 l-8,-5/); // arrives pointing right
});

test("indent and outdent carry the whole branch and refuse impossible moves", () => {
  const base = rows(SAMPLE);
  assert.equal(outlineIndent(base, 0), null);
  assert.equal(outlineIndent(base, 3), null); // already one deeper than the row above
  const indented = outlineIndent(base, 5); // 客群 under 品牌, with its children
  assert.ok(indented);
  assert.equal(levels(indented.rows), "0112223401");
  const back = outlineOutdent(indented.rows, 5);
  assert.equal(thinkingChainRowsToText(back!.rows), SAMPLE);
  assert.equal(outlineOutdent(base, 0), null);
  assert.equal(outlineBlockEnd(base, 2), 5);
});

test("Enter splits at the caret, opens a first child at the end of a parent, and lifts an empty node", () => {
  const base = rows(SAMPLE);
  const split = outlineSplit(base, 1, 3, 3)!;
  assert.deepEqual(texts(split.rows).slice(1, 3), ["问题：", "如何打破传统时尚广告的冰冷感？"]);
  assert.deepEqual(split.focus, { row: 2, caret: 0 });
  const child = outlineSplit(base, 2, base[2].text.length, base[2].text.length)!;
  assert.equal(child.rows[3].level, 2);
  assert.equal(child.rows[3].text, "");
  const lifted = outlineSplit(child.rows, 3, 0, 0)!;
  assert.equal(lifted.rows[3].level, 1);
});

test("Backspace at the start deletes empty nodes, lifts filled ones, merges a centre into the row above", () => {
  const base: ThinkingChainRow[] = [{ level: 0, text: "中心" }, { level: 1, text: "" }, { level: 2, text: "孙" }, { level: 0, text: "第二条" }];
  const removed = outlineBackspace(base, 1)!;
  assert.deepEqual(removed.rows, [{ level: 0, text: "中心" }, { level: 1, text: "孙" }, { level: 0, text: "第二条" }]);
  assert.deepEqual(removed.focus, { row: 0, caret: "end" });
  assert.equal(outlineBackspace(removed.rows, 1)!.rows[1].level, 0);
  const merged = outlineBackspace(removed.rows, 2)!;
  assert.equal(merged.rows[1].text, "孙第二条");
  assert.deepEqual(merged.focus, { row: 1, caret: 1 });
  assert.equal(outlineBackspace([{ level: 0, text: "" }], 0), null);
});

test("moving a branch swaps it with the neighbouring sibling branch only", () => {
  const base = rows(SAMPLE);
  const up = outlineMove(base, 5, -1)!; // 客群 above 品牌
  assert.deepEqual(texts(up.rows).slice(1, 8).map((text) => text.slice(0, 2)), ["问题", "客群", "偏好", "食物", "品牌", "理念", "基因"]);
  assert.deepEqual(up.focus, { row: 2, caret: "end" });
  assert.equal(outlineMove(base, 1, -1), null); // first step: nothing above at its level
  assert.equal(outlineMove(base, 5, 1), null); // last step of the chain
});

test("pasting several lines splits them into nodes at the right depth", () => {
  const base: ThinkingChainRow[] = [{ level: 0, text: "中心" }, { level: 1, text: "步骤尾巴" }];
  const pasted = outlinePaste(base, 1, 2, 2, "A\n  - A1\nB")!;
  assert.deepEqual(pasted.rows, [
    { level: 0, text: "中心" },
    { level: 1, text: "步骤A" },
    { level: 2, text: "A1" },
    { level: 1, text: "B尾巴" },
  ]);
  assert.deepEqual(pasted.focus, { row: 3, caret: 1 });
});

test("a cross-node selection always takes the children along, copies as an outline and edits as a block", () => {
  const base = rows(SAMPLE);
  const range = outlineSelectionRange(base, { anchor: 5, focus: 2 });
  assert.deepEqual(range, { start: 2, end: 8 });
  assert.equal(outlineRangeText(base, { start: 3, end: 5 }), "理念：乐观、俏皮\n基因：美式复古");
  assert.equal(outlineRangeText(base, range).split("\n")[0], "品牌：Kate Spade");

  const deleted = outlineDeleteRange(base, range);
  assert.deepEqual(texts(deleted.rows), ["商业问题与洞察", "问题：如何打破传统时尚广告的冰冷感？", "创意主张", "快乐并不遥远"]);

  const replaced = outlineReplaceRange(base, { start: 3, end: 5 }, "新理念\n  - 细节")!;
  assert.deepEqual(replaced.rows.slice(3, 5), [{ level: 2, text: "新理念" }, { level: 3, text: "细节" }]);

});

test("block shift and block move respect the same limits as single nodes", () => {
  const base = rows(SAMPLE);
  const range = outlineSelectionRange(base, { anchor: 2, focus: 5 });
  const shifted = outlineShiftRange(base, range, 1);
  assert.ok(shifted);
  assert.equal(levels(shifted), "0123323401");
  assert.equal(outlineShiftRange(base, { start: 0, end: 2 }, -1), null);
  const moved = outlineMoveRange(base, { start: 5, end: 8 }, -1)!;
  assert.deepEqual(moved.selection, { anchor: 2, focus: 4 });
  assert.equal(moved.rows[2].text.slice(0, 2), "客群");
  // a range starting deeper than it ends cannot move as one block
  assert.equal(outlineMoveRange(base, { start: 3, end: 8 }, -1), null);
});
