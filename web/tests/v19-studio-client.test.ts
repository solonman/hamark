import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Same technique as `tests/v19-editable-value.test.ts` and
// `tests/v19-studio-document.test.ts`: stub any `.css` specifier so the real
// component (and its transitive imports — V19StudioDocument.tsx,
// V04VideoPlayer.tsx, V04VideoSessionProvider.tsx, ...) can be `import()`-ed
// under plain `tsx --test`, without jsdom.
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

const componentModule = await import("../components/v04/V04StudioClient.tsx");
const V04StudioClient = componentModule.default;
const {
  resolveV19EditGuard, countV19CascadedShots, buildV19VersionTree, describeV19FinalIntakeToast,
  formatV19CurrentVersionShortLabel,
} = componentModule;

const { formatV19VersionLabel } = await import("../lib/v19-ui-model.ts");

const source = await readFile(new URL("../components/v04/V04StudioClient.tsx", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// 1. No lease / expectedRevision anywhere — guards against reintroducing the
//    old V0.4 optimistic-lock protocol that V1.9 explicitly deleted (spec §六).
// ---------------------------------------------------------------------------

test("source: the save request body carries no lease and no expectedRevision", () => {
  assert.doesNotMatch(source, /\blease\b/i, "the old edit-lease protocol must not reappear");
  assert.doesNotMatch(source, /expectedRevision/, "the old optimistic-lock revision check must not reappear");
  // Positive check: the actual save call only carries the V1.9 shape.
  assert.match(
    source,
    /v19Api\.save\(videoId, \{\s*basedOnVersionId: isFinalSave \? "final" : currentModel\.current\.id,\s*changeSetId,\s*changes,\s*\}\)/,
  );
});

// ---------------------------------------------------------------------------
// 1b. 最终版视角（spec 五、14/16）：老孙直接改最终版时保存请求带字面量
//     "final"，不是最终版那一行的 id；比较基版在最终版视角不出现（它已经靠
//     baseNumber 恒为 null 天然隐藏，这里额外确认没有另起一段绕过这条规则）；
//     定稿／取消定稿按钮只在最终版视角出现。
// ---------------------------------------------------------------------------

test("source: a final-version save sends the literal string \"final\", not the row's own id", () => {
  assert.match(source, /const isFinalSave = currentModel\.current\.isFinal;/);
});

test("source: the 比较 (compare) control is gated on baseNumber, which is null on the final version — it is never shown independent of that", () => {
  const compareBlock = source.match(/\{model\.current\.baseNumber !== null && \(\s*<>\s*<i className=\{styles\.versionSplitDivider\}/);
  assert.ok(compareBlock, "expected the 比较 segment to still be gated on model.current.baseNumber !== null");
});

test("source: 定稿／取消定稿 only renders for the final version view", () => {
  assert.match(source, /isFinalVersionView && !readOnly && model\.final && \(/);
  assert.match(source, /✓ 定稿/);
  assert.match(source, /取消定稿/);
});

// ---------------------------------------------------------------------------
// 本机走查 bug fix: `finalContext` (and so `locked`) must not be gated on
// `model.finalTrace` existing — that field is optional on the GET response,
// and a colleague opening the case with no `?version` used to land on the
// final version (spec 二、11) with `finalTrace` present-or-not depending on
// a route bug now fixed server-side, but the client must be robust to it
// independently: locked styling is purely "final version, viewer can't edit
// it", trace-derived extras (hover source, 溯源 chain) degrade gracefully
// when absent instead of the whole `final` context disappearing.
// ---------------------------------------------------------------------------

test("source: finalContext is gated only on isFinalVersionView, never on model.finalTrace being present", () => {
  const contextMatch = source.match(
    /const finalContext: V19StudioFinalContext \| undefined = isFinalVersionView\s*\? \{/,
  );
  assert.ok(contextMatch, "expected finalContext to be built whenever isFinalVersionView is true, with no additional && model.finalTrace gate");
  assert.doesNotMatch(source, /isFinalVersionView && model\.finalTrace/, "locked must not depend on finalTrace having loaded");
});

test("source: finalContext's trace fields degrade to null/empty instead of requiring model.finalTrace", () => {
  assert.match(source, /originPayload: model\.finalTrace\?\.originPayload \?\? null/);
  assert.match(source, /intakes: model\.finalTrace\?\.intakes \?\? \[\]/);
});

test("source: interceptForeignEdit toasts the exact spec 五、16 message for a blocked final-version edit, and never redirects it", () => {
  const guardMatch = source.match(
    /const interceptForeignEdit = useCallback\(\(\): boolean => \{([\s\S]*?)\n {2}\}, \[switchToVersion, pushToast\]\);/,
  );
  assert.ok(guardMatch, "expected to find interceptForeignEdit");
  const body = guardMatch[1];
  assert.match(body, /"最终版只有老孙可以编辑。你的修改请写在自己的版本里，进行态下会自动汇入最终版"/);
  const blockedBranch = body.match(/if \(decision\.action === "BLOCKED_FINAL"\) \{([\s\S]*?)\n {4}\}/);
  assert.ok(blockedBranch, "expected a dedicated BLOCKED_FINAL branch");
  assert.doesNotMatch(blockedBranch[1], /switchToVersion/, "a blocked final edit must never redirect to another version");
});

test("source: a normal version save's finalIntake toast is dedupe-gated through describeV19FinalIntakeToast, not fired unconditionally", () => {
  assert.match(source, /describeV19FinalIntakeToast\(changes, response\.finalIntake, finalIntakeSignatureRef\.current\)/);
});

// ---------------------------------------------------------------------------
// 走查 3: every short version label built as `v${number}` must say "最终版"
// instead when `current` is the final version — its `number` is a fixed `0`
// placeholder (spec 四、4.1), never a real version number to show.
// ---------------------------------------------------------------------------

test("formatV19CurrentVersionShortLabel says 最终版 for the final version, not v0", () => {
  assert.equal(formatV19CurrentVersionShortLabel({ isFinal: true, number: 0 }), "最终版");
});

test("formatV19CurrentVersionShortLabel renders vN for an ordinary version", () => {
  assert.equal(formatV19CurrentVersionShortLabel({ isFinal: false, number: 3 }), "v3");
});

test("source: the save-status chip and the assignment-rating版本标签 both go through formatV19CurrentVersionShortLabel, not a raw v${model.current.number}", () => {
  assert.match(source, /已自动保存至 \$\{formatV19CurrentVersionShortLabel\(model\.current\)\} · \$\{formatV19Clock\(saveStatus\.at\)\}/);
  assert.match(source, /versionLabel=\{`\$\{formatV19CurrentVersionShortLabel\(model\.current\)\} · \$\{model\.current\.ownerName\}`\}/);
  assert.doesNotMatch(source, /已自动保存至 v\$\{model\.current\.number\}/, "the raw v${number} form must not reappear for the save chip");
  assert.doesNotMatch(source, /versionLabel=\{`v\$\{model\.current\.number\}/, "the raw v${number} form must not reappear for the rating label");
});

// ---------------------------------------------------------------------------
// 走查 4: a direct final-version save must refresh finalTrace afterward
// (without touching current/draft), or the field 老孙 just edited keeps
// showing only its v1 原稿 row as 当前采用 in 溯源视图, and the default
// view's hover source never picks up the new 最终版·直接修改 entry.
// ---------------------------------------------------------------------------

test("source: refreshFinalTrace only merges final/finalTrace into the model, never current or the draft", () => {
  const functionMatch = source.match(
    /const refreshFinalTrace = useCallback\(async \(\) => \{([\s\S]*?)\n {2}\}, \[videoId\]\);/,
  );
  assert.ok(functionMatch, "expected to find refreshFinalTrace");
  const body = functionMatch[1];
  assert.match(body, /v19Api\.load\(videoId, "final"\)/);
  assert.match(body, /final: fresh\.final/);
  assert.match(body, /fresh\.finalTrace/);
  assert.doesNotMatch(body, /current:/, "refreshFinalTrace must never touch `current`");
  assert.doesNotMatch(body, /setDraftState|draftRef\.current\s*=|applyLoadedModel/, "refreshFinalTrace must never touch the local draft");
});

test("source: commitSaveAttempt calls refreshFinalTrace after a successful direct final-version save (the isFinalSave branch), not after an ordinary version save", () => {
  const elseBranch = source.match(/\} else \{\s*\/\/ 本机走查 bug fix: refresh finalTrace([\s\S]*?)\n {6}\}/);
  assert.ok(elseBranch, "expected an else branch (isFinalSave) calling refreshFinalTrace");
  assert.match(elseBranch[1], /void refreshFinalTrace\(\);/);
});

// ---------------------------------------------------------------------------
// 走查 5: 定稿／取消定稿／采纳 failing (e.g. a 404) must still surface a
// toast — it used to fail silently, leaving the status pill looking
// unchanged with no indication anything went wrong.
// ---------------------------------------------------------------------------

test("source: runFinalAction's catch always toasts — the server's error message, or a dedicated 最终版 fallback", () => {
  const functionMatch = source.match(
    /const runFinalAction = useCallback\(async \(body: V19FinalActionRequestBody\) => \{([\s\S]*?)\n {2}\}, \[videoId, finalActionBusy, applyLoadedModel, pushToast\]\);/,
  );
  assert.ok(functionMatch, "expected to find runFinalAction");
  const catchMatch = functionMatch[1].match(/\} catch \(reason\) \{([\s\S]*?)\n {4}\} finally \{/);
  assert.ok(catchMatch, "expected to find runFinalAction's catch block");
  assert.match(catchMatch[1], /pushToast\(reason instanceof V04UiApiError \? reason\.message : "最终版操作失败，请重试。"\);/);
});

// ---------------------------------------------------------------------------
// 2. A failed save never clears local draft state.
// ---------------------------------------------------------------------------

test("source: commitSaveAttempt's catch path never touches draftRef or draft state", () => {
  // Two-stage extraction: first isolate `commitSaveAttempt`'s own body (there
  // are other `catch` blocks in this file, e.g. in `switchToVersion`), then
  // find its single catch block within that isolated body.
  const functionMatch = source.match(
    /const commitSaveAttempt = useCallback\(async \(attempt: \{ version: number; draft: V04UiDraft \}\): Promise<boolean> => \{([\s\S]*?)\n {2}\}, \[videoId, viewerName, viewerUserId, refreshVersionList, refreshFinalTrace, pushToast\]\);/,
  );
  assert.ok(functionMatch, "expected to find commitSaveAttempt");
  const functionBody = functionMatch[1];
  const catchMatch = functionBody.match(/\} catch \(reason\) \{([\s\S]*?)\n {4}\}/);
  assert.ok(catchMatch, "expected to find commitSaveAttempt's catch block");
  const catchBody = catchMatch[1];
  assert.doesNotMatch(catchBody, /setDraftState/, "the catch path must not reset the draft");
  assert.doesNotMatch(catchBody, /draftRef\.current\s*=/, "the catch path must not reassign draftRef");
  assert.doesNotMatch(catchBody, /applyLoadedModel/, "the catch path must not reload/replace the model+draft");
  assert.match(catchBody, /setSaveStatus\(\{ kind: "ERROR", message \}\);/, "it must still surface the failure");
});

// ---------------------------------------------------------------------------
// 3. The edit guard: switches to the viewer's own version when they're
//    looking at someone else's and already own one (spec rule 4).
// ---------------------------------------------------------------------------

test("resolveV19EditGuard proceeds when the current version is already the viewer's own", () => {
  assert.deepEqual(resolveV19EditGuard({ isMine: true }, null), { action: "PROCEED" });
  assert.deepEqual(resolveV19EditGuard({ isMine: true }, "v-mine"), { action: "PROCEED" });
});

test("resolveV19EditGuard proceeds (first edit auto-forks server-side) when the viewer has no version yet", () => {
  assert.deepEqual(resolveV19EditGuard({ isMine: false }, null), { action: "PROCEED" });
});

test("resolveV19EditGuard switches to the viewer's own version when isMine is false and myVersionId is set", () => {
  assert.deepEqual(
    resolveV19EditGuard({ isMine: false }, "v-owned-by-viewer"),
    { action: "SWITCH_TO_OWN", versionId: "v-owned-by-viewer" },
  );
});

// ---------------------------------------------------------------------------
// 3b. The final-version branch (spec 五、16): 老孙 always proceeds and is
//     never redirected to his own per-editor version, even when he owns one
//     (the final version has no owner, so `isMine` is always false there —
//     the ordinary fork-redirect must not fire for it). Anyone else is
//     refused outright, never redirected either.
// ---------------------------------------------------------------------------

test("resolveV19EditGuard proceeds on the final version when the viewer can edit it (老孙), with no version of their own", () => {
  assert.deepEqual(
    resolveV19EditGuard({ isMine: false, isFinal: true }, null, true),
    { action: "PROCEED" },
  );
});

test("resolveV19EditGuard proceeds on the final version for 老孙 even though he owns a per-editor version — he must not be switched to it", () => {
  assert.deepEqual(
    resolveV19EditGuard({ isMine: false, isFinal: true }, "v-owned-by-reviewer", true),
    { action: "PROCEED" },
  );
});

test("resolveV19EditGuard blocks (never redirects) a non-老孙 viewer on the final version", () => {
  assert.deepEqual(
    resolveV19EditGuard({ isMine: false, isFinal: true }, null, false),
    { action: "BLOCKED_FINAL" },
  );
});

test("resolveV19EditGuard blocks a non-老孙 viewer on the final version even when they own a per-editor version", () => {
  assert.deepEqual(
    resolveV19EditGuard({ isMine: false, isFinal: true }, "v-owned-by-someone-else", false),
    { action: "BLOCKED_FINAL" },
  );
});

// ---------------------------------------------------------------------------
// 4. No 保存 or 提交 button anywhere on the page.
// ---------------------------------------------------------------------------

test("source: 提交 never appears anywhere in the shell", () => {
  assert.doesNotMatch(source, /提交/);
});

test("source: no <button> is labelled 保存 (save-status text like 已自动保存/保存中… is not a button label)", () => {
  assert.doesNotMatch(source, /<button[^>]*>\s*保存\s*<\/button>/);
  // The only "保存"-bearing strings are inside the non-interactive status text.
  const saveTextLines = source.match(/^.*保存.*$/gm) ?? [];
  for (const line of saveTextLines) {
    assert.ok(
      !/^\s*<button/.test(line.trim()),
      `expected no button-opening line to carry 保存 as its own label, got: ${line}`,
    );
  }
});

test("rendered: the synchronous (pre-load) markup contains neither a 保存 button nor 提交", () => {
  // react-dom/server never runs effects, so this renders exactly the
  // loading-state branch (no network call is ever attempted) — a safe,
  // deterministic slice of the real component's output.
  const html = renderToStaticMarkup(createElement(V04StudioClient, {
    videoId: "video-1",
    viewerName: "李晓芸",
    viewerUserId: "user-1",
  }));
  assert.doesNotMatch(html, /<button[^>]*>保存<\/button>/);
  assert.doesNotMatch(html, /提交/);
});

// ---------------------------------------------------------------------------
// 5. Version label formatting for 初始版本 and 基于版本.
// ---------------------------------------------------------------------------

test("formatV19VersionLabel renders 初始版本 for a root version", () => {
  assert.equal(
    formatV19VersionLabel({ number: 1, baseNumber: null, ownerName: "王大明", ownerIsUploader: false }),
    "v1（初始版本，王大明）",
  );
});

test("formatV19VersionLabel renders 基于vN for a forked version", () => {
  assert.equal(
    formatV19VersionLabel({ number: 3, baseNumber: 1, ownerName: "李晓芸", ownerIsUploader: false }),
    "v3（基于v1，李晓芸）",
  );
});

// ---------------------------------------------------------------------------
// Bonus: the other pure helpers co-located in this file, same technique.
// ---------------------------------------------------------------------------

function shot(id: string, startTime: string, endTime: string) {
  return { id, startTime, endTime };
}
function draftOf(shots: Array<{ id: string; startTime: string; endTime: string }>) {
  return { shotGroups: [{ id: "b1", shots }] } as unknown as Parameters<typeof countV19CascadedShots>[0];
}

test("countV19CascadedShots is 0 when nothing changed", () => {
  const before = draftOf([shot("s1", "00:00", "00:04"), shot("s2", "00:05", "00:09")]);
  assert.equal(countV19CascadedShots(before, before), 0);
});

test("countV19CascadedShots counts shots after the edited one whose start time shifted", () => {
  const before = draftOf([
    shot("s1", "00:00", "00:04"),
    shot("s2", "00:05", "00:09"),
    shot("s3", "00:10", "00:14"),
  ]);
  // s1's end time changes from 00:04 to 00:08: s2 and s3 cascade forward.
  const after = draftOf([
    shot("s1", "00:00", "00:08"),
    shot("s2", "00:09", "00:13"),
    shot("s3", "00:14", "00:18"),
  ]);
  assert.equal(countV19CascadedShots(before, after), 2);
});

test("countV19CascadedShots is 0 across a structural change (insert/reorder), not a plain field edit", () => {
  const before = draftOf([shot("s1", "00:00", "00:04")]);
  const after = draftOf([shot("s1", "00:00", "00:04"), shot("s2", "00:05", "00:09")]);
  assert.equal(countV19CascadedShots(before, after), 0);
});

test("buildV19VersionTree roots versions with baseNumber === null and nests the rest by base version number", () => {
  const rows = buildV19VersionTree([
    { id: "v2", number: 2, ownerUserId: "u2", ownerName: "李晓芸", baseNumber: 1, createdAt: "", updatedAt: "", isMine: false, isVirtual: false, baseIsFinal: false },
    { id: "v1", number: 1, ownerUserId: "u1", ownerName: "王大明", baseNumber: null, createdAt: "", updatedAt: "", isMine: false, isVirtual: false, baseIsFinal: false },
    { id: "v3", number: 3, ownerUserId: "u3", ownerName: "张三", baseNumber: 1, createdAt: "", updatedAt: "", isMine: true, isVirtual: false, baseIsFinal: false },
  ]);
  assert.deepEqual(rows.map((row) => [row.version.id, row.depth]), [
    ["v1", 0],
    ["v2", 1],
    ["v3", 1],
  ]);
});

// ---------------------------------------------------------------------------
// describeV19FinalIntakeToast (spec 五、17): merged → 同步进入最终版;
// not merged → 未纳入警示; identical merged/pending outcome as last time →
// no toast (the autosave-spam guard).
// ---------------------------------------------------------------------------

test("describeV19FinalIntakeToast returns null when nothing actually changed", () => {
  assert.equal(describeV19FinalIntakeToast([], { merged: true, pending: 0 }, null), null);
});

test("describeV19FinalIntakeToast announces a merge for a single-field change, naming that field", () => {
  const result = describeV19FinalIntakeToast(
    [{ targetLabel: "商业意图" }], { merged: true, pending: 0 }, null,
  );
  assert.deepEqual(result, { text: "「商业意图」的修改已同步进入最终版", signature: "true:0" });
});

test("describeV19FinalIntakeToast warns when the final version is done and the change did not merge", () => {
  const result = describeV19FinalIntakeToast(
    [{ targetLabel: "张力按钮" }], { merged: false, pending: 3 }, null,
  );
  assert.deepEqual(result, {
    text: "最终版已定稿，「张力按钮」的修改未纳入最终版，等老孙取消定稿后采纳",
    signature: "false:3",
  });
});

test("describeV19FinalIntakeToast names the count, not a field, for a multi-field save", () => {
  const result = describeV19FinalIntakeToast(
    [{ targetLabel: "商业意图" }, { targetLabel: "故事梗概" }], { merged: true, pending: 0 }, null,
  );
  assert.equal(result?.text, "「本次的 2 处修改」的修改已同步进入最终版");
});

test("describeV19FinalIntakeToast suppresses a repeat of the same merged/pending outcome, so an unbroken run of autosaves does not spam a toast", () => {
  const first = describeV19FinalIntakeToast([{ targetLabel: "商业意图" }], { merged: true, pending: 0 }, null);
  assert.ok(first);
  const second = describeV19FinalIntakeToast([{ targetLabel: "故事梗概" }], { merged: true, pending: 0 }, first.signature);
  assert.equal(second, null);
});

test("describeV19FinalIntakeToast toasts again once the outcome actually shifts (e.g. 定稿 happens between two saves)", () => {
  const first = describeV19FinalIntakeToast([{ targetLabel: "商业意图" }], { merged: true, pending: 0 }, null);
  assert.ok(first);
  const second = describeV19FinalIntakeToast([{ targetLabel: "故事梗概" }], { merged: false, pending: 1 }, first.signature);
  assert.ok(second);
  assert.match(second.text, /未纳入/);
});
