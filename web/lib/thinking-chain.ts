/**
 * 创意思维链（`facts.creativeThinkingChain`）的纯函数：存储文字 ⇄ 大纲行 ⇄ 思维链，
 * 流程图的列数／落位／连线计算，以及大纲编辑器的每一种改动。
 *
 * 规格：`docs/24_创意思维链流程图_实施规格_V0.1.md`；交互 demo：
 * `docs/demos/2026-10-08-创意思维链流程图demo.html`（这里的算法与 demo 同源）。
 * 不碰 React、DOM、网络，服务端与客户端都能用，便于单测。
 */

// ---------------------------------------------------------------------------
// 存储格式
// ---------------------------------------------------------------------------

/** 大纲里的一行：level 0 是一条思维链的中心，1 是步骤，2 起是分叉。 */
export type ThinkingChainRow = { level: number; text: string };

export type ThinkingChainNode = { text: string; kids: ThinkingChainNode[] };

/** `implicit` 为 true 时没有中心文字——旧写法挂在默认中心下。 */
export type ThinkingChain = ThinkingChainNode & { implicit: boolean };

const LEADING_SPACE = /^[ \t　]*/;
const LIST_MARK = /^[-–·•*]\s+/;

/**
 * 读入：逐行，空行忽略；缩进比上一层深就是它的下级（Tab、全角空格记两格），
 * 跳级按「上一个更浅的行」挂靠；行首的列表记号只是记号，去掉。
 */
export function parseThinkingChainRows(text: string): ThinkingChainRow[] {
  const rows: ThinkingChainRow[] = [];
  const stack: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let indent = 0;
    for (const ch of line.match(LEADING_SPACE)?.[0] ?? "") indent += ch === " " ? 1 : 2;
    while (stack.length && stack[stack.length - 1] >= indent) stack.pop();
    rows.push({ level: stack.length, text: line.trim().replace(LIST_MARK, "") });
    stack.push(indent);
  }
  return rows;
}

/** 写出：中心顶格不加记号；下级 `- ` 开头，每深一级多两格缩进；空节点不写。 */
export function thinkingChainRowsToText(rows: readonly ThinkingChainRow[]): string {
  return rows
    .filter((row) => row.text.trim())
    .map((row) => (row.level ? `${"  ".repeat(row.level)}- ${row.text.trim()}` : row.text.trim()))
    .join("\n");
}

/** 按写出规则规范化，用来判断编辑前后到底有没有改。 */
export function normalizeThinkingChainText(text: string): string {
  return thinkingChainRowsToText(parseThinkingChainRows(text));
}

/**
 * 读成思维链。全文多于一行且一行缩进都没有，是线上现有的旧写法（「1）…5）」），
 * 视为一条：挂在默认中心下，每行一步。
 */
export function parseThinkingChains(text: string): ThinkingChain[] {
  const rows = parseThinkingChainRows(text);
  const roots: ThinkingChainNode[] = [];
  const stack: ThinkingChainNode[] = [];
  for (const row of rows) {
    const node: ThinkingChainNode = { text: row.text, kids: [] };
    stack.length = row.level;
    const parent = row.level ? stack[row.level - 1] : undefined;
    if (parent) parent.kids.push(node);
    else roots.push(node);
    stack[row.level] = node;
  }
  const legacy = rows.length > 1 && rows.every((row) => row.level === 0);
  if (legacy) return [{ text: "", implicit: true, kids: roots }];
  return roots.map((root) => ({ ...root, implicit: false }));
}

/**
 * 进编辑器时的大纲行。旧写法（多行、全无缩进）在图上是默认中心下的一条链，进编辑器也换成同样的
 * 结构——中心一行、每行一步——保存即为新格式（docs/24 第三节）。没改就关上不算修改，由编辑器判断。
 */
export function thinkingChainEditorRows(text: string, centre: string): ThinkingChainRow[] {
  const rows = parseThinkingChainRows(text);
  if (!rows.length) return [{ level: 0, text: "" }];
  if (rows.length > 1 && rows.every((row) => row.level === 0)) {
    return [{ level: 0, text: centre }, ...rows.map((row) => ({ level: 1, text: row.text }))];
  }
  return rows;
}

/** 「短标题：说明」：冒号前 1–16 字、不含句读时，短标题单独加粗显示。 */
export function splitThinkingChainTitle(text: string): { title: string; detail: string } {
  const match = text.match(/^([^：:。？！?!，,]{1,16})[：:]\s*([\s\S]+)$/);
  return match ? { title: match[1].trim(), detail: match[2].trim() } : { title: "", detail: text };
}

/** 步骤文字开头若是与序号相同的「n）」，序号圈已经表达了，显示时去掉；库里原文不动。 */
export function stripThinkingChainStepNumber(text: string, stepNumber: number): string {
  return text.replace(new RegExp(`^${stepNumber}\\s*[）)．.、]\\s*`), "");
}

// ---------------------------------------------------------------------------
// 流程图排版
// ---------------------------------------------------------------------------

export const THINKING_CHAIN_FLOW = {
  /** 相邻两格之间的水平间距（px），与 CSS 的 column-gap 一致。 */
  gap: 34,
  /** 一格最窄多宽（em），用来算每行放几格。 */
  minEm: 13.5,
  /** 一格最宽多宽（em），步骤很少时不至于拉成一长条。 */
  maxEm: 30,
  /** 右侧留给 U 形弯的宽度（px）。 */
  reserve: 24,
  /** U 形弯伸出格子外侧的距离（px）。 */
  bulge: 18,
  radius: 10,
  /** 连线对准框里第一行文字：框顶往下这么多（px）。 */
  anchor: 17,
} as const;

/** 先按最窄宽度算一行放几格，再把这一行宽度平分给各格。中心是第 0 格，也算一格。 */
export function computeThinkingChainFlowColumns(
  width: number,
  itemCount: number,
  fontSize: number,
): { columns: number; columnWidth: number } {
  const { gap, minEm, maxEm, reserve } = THINKING_CHAIN_FLOW;
  const base = minEm * fontSize;
  const room = Math.max(0, width - reserve);
  const columns = Math.max(1, Math.min(Math.max(1, itemCount), Math.floor((room + gap) / (base + gap))));
  const columnWidth = Math.max(110, Math.min(maxEm * fontSize, (room - (columns - 1) * gap) / columns));
  return { columns, columnWidth };
}

/** 蛇形落位：第 1、3…行从左往右，第 2、4…行从右往左；只有一列时都算从左往右。 */
export function placeThinkingChainFlowItem(index: number, columns: number): { row: number; column: number; leftToRight: boolean } {
  const row = Math.floor(index / columns);
  const offset = index % columns;
  const leftToRight = columns === 1 || row % 2 === 0;
  return { row, column: leftToRight ? offset + 1 : columns - offset, leftToRight };
}

export type ThinkingChainFlowRect = { left: number; right: number; top: number; bottom: number };
export type ThinkingChainFlowConnector = { line: string; tip: string };

const fmt = (value: number) => String(Math.round(value * 10) / 10);

/** 箭头三角：dir 1 朝右，-1 朝左，尖端落在 (x, y)。 */
function arrowTip(x: number, y: number, dir: 1 | -1): string {
  return `M${fmt(x)},${fmt(y)} l${-8 * dir},-5 v10 z`;
}

/**
 * 按落位顺序（中心、第 1 步、第 2 步…）连线：同一行相邻两格是直线箭头；换行处从上一行
 * 最后一格的外侧绕一个圆角 U 形弯，接进下一行第一格同一侧。rect 是步骤框（不含下面挂的分叉）。
 */
export function thinkingChainFlowConnectors(rects: readonly ThinkingChainFlowRect[], columns: number): ThinkingChainFlowConnector[] {
  const { bulge, radius: rd, anchor } = THINKING_CHAIN_FLOW;
  const anchorY = (rect: ThinkingChainFlowRect) => rect.top + Math.min(anchor, (rect.bottom - rect.top) / 2);
  const out: ThinkingChainFlowConnector[] = [];
  for (let i = 1; i < rects.length; i += 1) {
    const a = rects[i - 1];
    const b = rects[i];
    const from = placeThinkingChainFlowItem(i - 1, columns);
    const to = placeThinkingChainFlowItem(i, columns);
    const yb = anchorY(b);
    if (from.row === to.row) {
      if (from.leftToRight) out.push({ line: `M${fmt(a.right)},${fmt(yb)} H${fmt(b.left - 7)}`, tip: arrowTip(b.left, yb, 1) });
      else out.push({ line: `M${fmt(a.left)},${fmt(yb)} H${fmt(b.right + 7)}`, tip: arrowTip(b.right, yb, -1) });
      continue;
    }
    const ya = anchorY(a);
    if (from.leftToRight) {
      const x = Math.max(a.right, b.right) + bulge;
      out.push({
        line: `M${fmt(a.right)},${fmt(ya)} H${fmt(x - rd)} Q${fmt(x)},${fmt(ya)} ${fmt(x)},${fmt(ya + rd)} V${fmt(yb - rd)} Q${fmt(x)},${fmt(yb)} ${fmt(x - rd)},${fmt(yb)} H${fmt(b.right + 7)}`,
        tip: arrowTip(b.right, yb, -1),
      });
    } else {
      const x = Math.min(a.left, b.left) - bulge;
      out.push({
        line: `M${fmt(a.left)},${fmt(ya)} H${fmt(x + rd)} Q${fmt(x)},${fmt(ya)} ${fmt(x)},${fmt(ya + rd)} V${fmt(yb - rd)} Q${fmt(x)},${fmt(yb)} ${fmt(x + rd)},${fmt(yb)} H${fmt(b.left - 7)}`,
        tip: arrowTip(b.left, yb, 1),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 大纲编辑：每种改动都返回新的行数组（不改入参），null 表示这一下什么都没变
// ---------------------------------------------------------------------------

export type OutlineFocus = { row: number; caret: number | "end" };
export type OutlineEdit = { rows: ThinkingChainRow[]; focus: OutlineFocus };
/** 跨节点选择：anchor 是起点行，focus 是当前扩到的行；实际范围连同下级一起算。 */
export type OutlineSelection = { anchor: number; focus: number };
export type OutlineRange = { start: number; end: number };

const copyRows = (rows: readonly ThinkingChainRow[]) => rows.map((row) => ({ ...row }));

/** 每一行属于第几条思维链、（第一层的）是第几步，给大纲标签和序号用。 */
export function outlineRowNumbers(rows: readonly ThinkingChainRow[]): Array<{ chain: number; step: number }> {
  let chain = 0;
  let step = 0;
  return rows.map((row) => {
    if (row.level === 0) { chain += 1; step = 0; }
    if (row.level === 1) step += 1;
    return { chain, step };
  });
}

/** i 这一行连同它所有下级的结束位置（不含）。 */
export function outlineBlockEnd(rows: readonly ThinkingChainRow[], index: number): number {
  let end = index + 1;
  while (end < rows.length && rows[end].level > rows[index].level) end += 1;
  return end;
}

/** 每一行最多比上一行深一级，第一行必须是中心。 */
export function normalizeOutlineLevels(rows: ThinkingChainRow[]): ThinkingChainRow[] {
  rows.forEach((row, index) => {
    row.level = index === 0 ? 0 : Math.max(0, Math.min(row.level, rows[index - 1].level + 1));
  });
  return rows;
}

export function outlineIndent(rows: readonly ThinkingChainRow[], index: number, caret: number | "end" = "end"): OutlineEdit | null {
  if (index === 0 || rows[index].level > rows[index - 1].level) return null;
  const next = copyRows(rows);
  const end = outlineBlockEnd(rows, index);
  for (let k = index; k < end; k += 1) next[k].level += 1;
  return { rows: next, focus: { row: index, caret } };
}

export function outlineOutdent(rows: readonly ThinkingChainRow[], index: number, caret: number | "end" = "end"): OutlineEdit | null {
  if (rows[index].level === 0) return null;
  const next = copyRows(rows);
  const end = outlineBlockEnd(rows, index);
  for (let k = index; k < end; k += 1) next[k].level -= 1;
  return { rows: next, focus: { row: index, caret } };
}

/** 回车：在光标处拆成两个同级节点；有下级的节点末尾回车＝新建第一个下级；空节点回车＝回到上一级。 */
export function outlineSplit(rows: readonly ThinkingChainRow[], index: number, start: number, end: number): OutlineEdit | null {
  const row = rows[index];
  if (!row.text.trim() && row.level > 0) return outlineOutdent(rows, index, 0);
  const next = copyRows(rows);
  const after = row.text.slice(end);
  next[index].text = row.text.slice(0, start);
  const hasKids = index + 1 < rows.length && rows[index + 1].level > row.level;
  const level = after === "" && hasKids ? row.level + 1 : row.level;
  next.splice(index + 1, 0, { level, text: after });
  return { rows: next, focus: { row: index + 1, caret: 0 } };
}

/** 行首退格：空节点删除（下级上提一级）；非空的下级节点回到上一级；中心与上一行合并。 */
export function outlineBackspace(rows: readonly ThinkingChainRow[], index: number): OutlineEdit | null {
  const row = rows[index];
  if (row.text === "") {
    if (rows.length === 1) return null;
    const next = copyRows(rows);
    const end = outlineBlockEnd(rows, index);
    for (let k = index + 1; k < end; k += 1) next[k].level -= 1;
    next.splice(index, 1);
    normalizeOutlineLevels(next);
    return { rows: next, focus: { row: Math.max(0, index - 1), caret: "end" } };
  }
  if (row.level > 0) return outlineOutdent(rows, index, 0);
  if (index === 0) return null;
  const next = copyRows(rows);
  const join = next[index - 1].text.length;
  next[index - 1].text += row.text;
  next.splice(index, 1);
  normalizeOutlineLevels(next);
  return { rows: next, focus: { row: index - 1, caret: join } };
}

/** 一段连续行 [start, end) 作为整体，与同级相邻的一枝对调。返回新行与移动后的起点。 */
function moveGroup(rows: readonly ThinkingChainRow[], start: number, end: number, dir: -1 | 1): { rows: ThinkingChainRow[]; start: number } | null {
  const level = rows[start].level;
  if (rows.slice(start, end).some((row) => row.level < level)) return null;
  const next = copyRows(rows);
  if (dir < 0) {
    let k = start - 1;
    while (k >= 0 && rows[k].level > level) k -= 1;
    if (k < 0 || rows[k].level !== level) return null;
    const group = next.splice(start, end - start);
    next.splice(k, 0, ...group);
    return { rows: next, start: k };
  }
  if (end >= rows.length || rows[end].level !== level) return null;
  const siblingEnd = outlineBlockEnd(rows, end);
  const sibling = next.splice(end, siblingEnd - end);
  next.splice(start, 0, ...sibling);
  return { rows: next, start: start + sibling.length };
}

/** Alt+Shift+↑↓：整枝（含下级）与同级相邻的一枝对调。 */
export function outlineMove(rows: readonly ThinkingChainRow[], index: number, dir: -1 | 1): OutlineEdit | null {
  const moved = moveGroup(rows, index, outlineBlockEnd(rows, index), dir);
  return moved ? { rows: moved.rows, focus: { row: moved.start, caret: "end" } } : null;
}

/** 粘贴多行：按缩进拆成节点，首行并入光标处，相对层级保留，光标停在粘贴内容末尾。 */
export function outlinePaste(rows: readonly ThinkingChainRow[], index: number, start: number, end: number, text: string): OutlineEdit | null {
  const pasted = parseThinkingChainRows(text);
  if (!pasted.length) return null;
  const next = copyRows(rows);
  const row = next[index];
  const tail = row.text.slice(end);
  const shift = row.level - pasted[0].level;
  row.text = row.text.slice(0, start) + pasted[0].text;
  const extra = pasted.slice(1).map((item) => ({ level: Math.max(0, item.level + shift), text: item.text }));
  next.splice(index + 1, 0, ...extra);
  for (let k = index + 1; k <= index + extra.length; k += 1) next[k].level = Math.min(next[k].level, next[k - 1].level + 1);
  const last = index + extra.length;
  const caret = next[last].text.length;
  next[last].text += tail;
  return { rows: next, focus: { row: last, caret } };
}

/** 跨节点选择的实际范围：从较前的一端到较后一端，连同其中每个节点的下级。 */
export function outlineSelectionRange(rows: readonly ThinkingChainRow[], selection: OutlineSelection): OutlineRange {
  const start = Math.min(selection.anchor, selection.focus);
  const last = Math.max(selection.anchor, selection.focus);
  let end = last + 1;
  for (let i = start; i <= last; i += 1) end = Math.max(end, outlineBlockEnd(rows, i));
  return { start, end };
}

/** 复制出去的文字：以选区里最浅的一层为顶格，写成大纲文字。 */
export function outlineRangeText(rows: readonly ThinkingChainRow[], range: OutlineRange): string {
  const part = rows.slice(range.start, range.end);
  const base = Math.min(...part.map((row) => row.level));
  return thinkingChainRowsToText(part.map((row) => ({ level: row.level - base, text: row.text })));
}

export function outlineDeleteRange(rows: readonly ThinkingChainRow[], range: OutlineRange): OutlineEdit {
  const next = copyRows(rows);
  next.splice(range.start, range.end - range.start);
  if (!next.length) next.push({ level: 0, text: "" });
  normalizeOutlineLevels(next);
  return { rows: next, focus: { row: Math.max(0, range.start - 1), caret: "end" } };
}

/** 用粘贴进来的大纲替换选区，第一行接在选区第一行的层级上。 */
export function outlineReplaceRange(rows: readonly ThinkingChainRow[], range: OutlineRange, text: string): OutlineEdit | null {
  const pasted = parseThinkingChainRows(text);
  if (!pasted.length) return null;
  const next = copyRows(rows);
  const shift = rows[range.start].level - pasted[0].level;
  next.splice(range.start, range.end - range.start, ...pasted.map((item) => ({ level: Math.max(0, item.level + shift), text: item.text })));
  normalizeOutlineLevels(next);
  return { rows: next, focus: { row: range.start + pasted.length - 1, caret: "end" } };
}

/** 整个选区一起调层级；第一行最多比上一行深一级，已有中心在选区里时不能再往上。 */
export function outlineShiftRange(rows: readonly ThinkingChainRow[], range: OutlineRange, delta: -1 | 1): ThinkingChainRow[] | null {
  const { start, end } = range;
  if (delta > 0 && (start === 0 || rows[start].level > rows[start - 1].level)) return null;
  if (delta < 0 && Math.min(...rows.slice(start, end).map((row) => row.level)) === 0) return null;
  const next = copyRows(rows);
  for (let k = start; k < end; k += 1) next[k].level += delta;
  return next;
}

/** 整个选区一起移动（选区第一行须是最浅的一层）。返回新行与移动后的选区。 */
export function outlineMoveRange(
  rows: readonly ThinkingChainRow[],
  range: OutlineRange,
  dir: -1 | 1,
): { rows: ThinkingChainRow[]; selection: OutlineSelection } | null {
  const moved = moveGroup(rows, range.start, range.end, dir);
  if (!moved) return null;
  return { rows: moved.rows, selection: { anchor: moved.start, focus: moved.start + (range.end - range.start) - 1 } };
}
