import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// `V19EditableValue.tsx` imports `./V04Surface.module.css`. Node's ESM loader
// (even under `tsx`) has no CSS handling and throws ERR_UNKNOWN_FILE_EXTENSION
// on it, so — same as every other CSS-module-importing component in this repo
// (see `V04ShotEditor.tsx`, `V04ChoiceField.tsx`, `V04WorkspaceClient.tsx`,
// which existing tests only ever `readFile` for source assertions, never
// `import`) — a plain `import` of the component is not runnable here. Rather
// than falling back to source-regex checks for the actual decision logic
// (`resolveV19CommitValue`) or the rendered structure, register a same-process
// module hook (Node built-in, no new dependency, no jsdom) that stubs any
// `.css` specifier to an empty module, then really `import()` the component.
// This exercises the shipped code directly instead of a hand-copied stand-in.
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

const componentModule = await import("../components/v04/V19EditableValue.tsx");
const V19EditableValue = componentModule.default;
const { V19SystemValue, resolveV19CommitValue, V19_TIMECODE_INVALID_MESSAGE } = componentModule;

// ---------------------------------------------------------------------------
// Pure decision logic: resolveV19CommitValue
// ---------------------------------------------------------------------------

test("resolveV19CommitValue: text field skips a no-op blur, including whitespace-only edits", () => {
  assert.deepEqual(resolveV19CommitValue("text", "全景", "全景"), { status: "unchanged" });
  assert.deepEqual(resolveV19CommitValue("text", "  全景  ", "全景"), { status: "unchanged" });
});

test("resolveV19CommitValue: text field commits a real change, trimmed", () => {
  assert.deepEqual(resolveV19CommitValue("text", "  中景  ", "全景"), { status: "commit", value: "中景" });
});

test("resolveV19CommitValue: textarea follows the same trimmed-compare rule", () => {
  assert.deepEqual(resolveV19CommitValue("textarea", "战乱背景下恋人重逢", "战乱背景下恋人重逢"), { status: "unchanged" });
  assert.deepEqual(
    resolveV19CommitValue("textarea", "战乱背景下恋人重逢又将分离", "战乱背景下恋人重逢"),
    { status: "commit", value: "战乱背景下恋人重逢又将分离" },
  );
});

test("resolveV19CommitValue: select field commits when the chosen option changes", () => {
  assert.deepEqual(resolveV19CommitValue("select", "S", "A"), { status: "commit", value: "S" });
  assert.deepEqual(resolveV19CommitValue("select", "A", "A"), { status: "unchanged" });
});

test("resolveV19CommitValue: timecode speed-entry digits parse, format, and commit", () => {
  assert.deepEqual(resolveV19CommitValue("timecode", "0102", "00:00"), { status: "commit", value: "01:02" });
  assert.deepEqual(resolveV19CommitValue("timecode", "45", "00:00"), { status: "commit", value: "00:45" });
});

test("resolveV19CommitValue: timecode rejects seconds over 59 without committing", () => {
  assert.deepEqual(resolveV19CommitValue("timecode", "75", "00:00"), {
    status: "invalid",
    message: V19_TIMECODE_INVALID_MESSAGE,
  });
});

test("resolveV19CommitValue: clearing a timecode commits empty only when it was previously set", () => {
  assert.deepEqual(resolveV19CommitValue("timecode", "", "01:02"), { status: "commit", value: "" });
  assert.deepEqual(resolveV19CommitValue("timecode", "", ""), { status: "unchanged" });
  assert.deepEqual(resolveV19CommitValue("timecode", "   ", ""), { status: "unchanged" });
});

test("resolveV19CommitValue: a re-typed timecode that formats back to the stored value is a no-op", () => {
  // "0102" and "01:02" both parse to the same 62 seconds as the stored value.
  assert.deepEqual(resolveV19CommitValue("timecode", "0102", "01:02"), { status: "unchanged" });
});

// ---------------------------------------------------------------------------
// Rendered structure (real component, via react-dom/server — no jsdom needed
// for a static markup snapshot; matches the technique already used for
// V04BrowserCompatibilityMessage in tests/v04-browser-compatibility.test.ts)
// ---------------------------------------------------------------------------

test("readOnly renders plain reading text: no role, no tabIndex, never an editor", () => {
  const html = renderToStaticMarkup(createElement(V19EditableValue, {
    value: "中景",
    ariaLabel: "景别",
    readOnly: true,
    onCommit: () => { throw new Error("must not be reachable"); },
  }));
  assert.match(html, /^<span[^>]*>中景<\/span>$/);
  assert.doesNotMatch(html, /role="button"/);
  assert.doesNotMatch(html, /tabindex/i);
  assert.doesNotMatch(html, /<input|<textarea|<select/);
});

test("readOnly still shows the placeholder for an empty value, still with no affordance", () => {
  const html = renderToStaticMarkup(createElement(V19EditableValue, {
    value: "",
    ariaLabel: "景别",
    readOnly: true,
    onCommit: () => { throw new Error("must not be reachable"); },
  }));
  assert.match(html, />—<\/span>$/);
  assert.doesNotMatch(html, /role="button"/);
});

// ---------------------------------------------------------------------------
// locked (spec 五、16/19): a final-version field for a viewer who isn't 老孙.
// Unlike plain readOnly, it must still look clickable — real content stays
// reachable by click/keyboard so `onBeforeEdit` gets a chance to veto and
// toast — but it carries the locked class and a different tooltip.
// ---------------------------------------------------------------------------

test("locked (readOnly + locked) still renders the clickable reading affordance, not the plain readOnly span", () => {
  const html = renderToStaticMarkup(createElement(V19EditableValue, {
    value: "中景",
    ariaLabel: "景别",
    readOnly: true,
    locked: true,
    onCommit: () => { throw new Error("must not be reachable"); },
  }));
  assert.match(html, /role="button"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /title="最终版只有老孙可以编辑"/);
});

test("locked never opens the editor even if onBeforeEdit returns true — it only gets a chance to veto/toast", () => {
  let beforeEditCalls = 0;
  const html = renderToStaticMarkup(createElement(V19EditableValue, {
    value: "中景",
    ariaLabel: "景别",
    readOnly: true,
    locked: true,
    onBeforeEdit: () => { beforeEditCalls += 1; return true; },
    onCommit: () => { throw new Error("must not be reachable"); },
  }));
  // react-dom/server never fires click handlers — this only proves the
  // markup itself never renders an <input>/<textarea>/<select> for a locked
  // field, i.e. it always starts (and, since it's server-rendered once,
  // stays) in the reading state. The onBeforeEdit-gating logic itself is
  // covered by the source-level assertions below.
  assert.doesNotMatch(html, /<input|<textarea|<select/);
  assert.equal(beforeEditCalls, 0);
});

test("locked field's hover title appends the source hint after the locked reason", () => {
  const html = renderToStaticMarkup(createElement(V19EditableValue, {
    value: "中景",
    ariaLabel: "景别",
    readOnly: true,
    locked: true,
    sourceHint: "v2·李晓芸 08-24 11:05",
    onCommit: () => { throw new Error("must not be reachable"); },
  }));
  assert.match(html, /title="最终版只有老孙可以编辑 · 来自 v2·李晓芸 08-24 11:05"/);
});

test("source: startEditing never enters edit mode for a locked field, even if onBeforeEdit somehow returned true", async () => {
  const source = await readFile(new URL("../components/v04/V19EditableValue.tsx", import.meta.url), "utf8");
  const guardMatch = source.match(/const startEditing = \(\) => \{([\s\S]*?)\n {2}\};/);
  assert.ok(guardMatch, "expected to find startEditing");
  assert.match(guardMatch[1], /if \(readOnly\) return; \/\/ locked:/);
});

test("editable reading state exposes the keyboard affordance and the empty placeholder", () => {
  const html = renderToStaticMarkup(createElement(V19EditableValue, {
    value: "",
    ariaLabel: "景别",
    onCommit: () => undefined,
  }));
  assert.match(html, /role="button"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /aria-label="景别"/);
  assert.match(html, /title="点击编辑"/);
  assert.match(html, />—<\/span>$/);
});

test("a warning replaces the default tooltip and never touches an on-value field", () => {
  const warned = renderToStaticMarkup(createElement(V19EditableValue, {
    value: "00:05",
    ariaLabel: "开始时间",
    warning: "时间线待校对",
    onCommit: () => undefined,
  }));
  assert.match(warned, /title="时间线待校对"/);
  assert.doesNotMatch(warned, /点击编辑/);

  const unwarned = renderToStaticMarkup(createElement(V19EditableValue, {
    value: "00:05",
    ariaLabel: "开始时间",
    onCommit: () => undefined,
  }));
  assert.match(unwarned, /title="点击编辑"/);
});

test("baseValue renders the 已修改 badge and 基版 block; omitting it renders neither", () => {
  const withDiff = renderToStaticMarkup(createElement(V19EditableValue, {
    value: "特写",
    ariaLabel: "景别",
    baseValue: "远景",
    onCommit: () => undefined,
  }));
  assert.match(withDiff, /已修改/);
  // 「基版」是标签，后面跟的是原文，两者之间要有分隔，否则连读成一句话。
  assert.match(withDiff, /基版：远景/);

  const emptyBase = renderToStaticMarkup(createElement(V19EditableValue, {
    value: "特写",
    ariaLabel: "景别",
    baseValue: "",
    onCommit: () => undefined,
  }));
  assert.match(emptyBase, /基版：—/);

  const noDiff = renderToStaticMarkup(createElement(V19EditableValue, {
    value: "特写",
    ariaLabel: "景别",
    onCommit: () => undefined,
  }));
  assert.doesNotMatch(noDiff, /已修改/);
  assert.doesNotMatch(noDiff, /基版/);
});

test("V19SystemValue renders a non-interactive span carrying the tooltip and children", () => {
  // createElement's rest-arg overload can't satisfy V19SystemValue's required
  // `children` prop for the type checker, so it goes in the props object.
  // eslint-disable-next-line react/no-children-prop
  const html = renderToStaticMarkup(createElement(V19SystemValue, { title: "桥段与镜头序号由系统自动维护", children: "桥段01－镜头02" }));
  assert.match(html, /^<span[^>]*title="桥段与镜头序号由系统自动维护"[^>]*>桥段01－镜头02<\/span>$/);
  assert.doesNotMatch(html, /role="button"|tabindex|onclick/i);
});

// ---------------------------------------------------------------------------
// Source-level guarantees for interaction that react-dom/server cannot
// exercise (no event dispatch without jsdom): Escape must never commit, and
// the required V04Surface.module.css class names must actually be wired up.
// ---------------------------------------------------------------------------

test("source: every Escape handler cancels via finish(false, ...), never commits", async () => {
  const source = await readFile(new URL("../components/v04/V19EditableValue.tsx", import.meta.url), "utf8");
  const escapeHandlers = [...source.matchAll(/if \(event\.key === "Escape"\) \{\s*event\.preventDefault\(\);\s*finish\((true|false), [^)]*\);/g)];
  assert.ok(escapeHandlers.length >= 3, "expected an Escape handler for the text/timecode input, the textarea, and the select");
  for (const match of escapeHandlers) {
    assert.equal(match[1], "false", "Escape must always cancel via finish(false, ...), not finish(true, ...)");
  }
  assert.match(source, /const finish = \(commitIt: boolean, raw: string\) => \{[\s\S]*?if \(!commitIt\) return;/);
});

test("source: onCommit only fires through resolveV19CommitValue's \"commit\" branch", async () => {
  const source = await readFile(new URL("../components/v04/V19EditableValue.tsx", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(resolution\.status === "commit"\) \{\s*onCommit\(resolution\.value\);\s*\} else if \(resolution\.status === "invalid"\) \{\s*onInvalid\?\.\(resolution\.message\);\s*\}/,
  );
});

test("source: readOnly short-circuits startEditing and the reading state uses the required class names", async () => {
  const source = await readFile(new URL("../components/v04/V19EditableValue.tsx", import.meta.url), "utf8");
  assert.match(source, /const startEditing = \(\) => \{\s*if \(isEditing\) return;/);
  // Plain readOnly (not `locked` — the final-version-非老孙 case, spec 五、16)
  // still returns before ever calling onBeforeEdit or opening the editor.
  assert.match(source, /if \(readOnly && !locked\) return;/);
  assert.match(source, /"use client";/);
  for (const className of [
    "styles.editable",
    "styles.editableBlock",
    "styles.editableEmpty",
    "styles.editableWarn",
    "styles.editableInput",
    "styles.editableTextarea",
    "styles.editableTimecode",
    "styles.systemField",
    "styles.diffTag",
    "styles.diffBase",
  ]) {
    assert.ok(source.includes(className), `expected ${className} to be referenced from V04Surface.module.css`);
  }
});
