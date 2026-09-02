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
const { resolveV19EditGuard, countV19CascadedShots, buildV19VersionTree } = componentModule;

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
    /v19Api\.save\(videoId, \{\s*basedOnVersionId: currentModel\.current\.id,\s*changeSetId,\s*changes,\s*\}\)/,
  );
});

// ---------------------------------------------------------------------------
// 2. A failed save never clears local draft state.
// ---------------------------------------------------------------------------

test("source: commitSaveAttempt's catch path never touches draftRef or draft state", () => {
  // Two-stage extraction: first isolate `commitSaveAttempt`'s own body (there
  // are other `catch` blocks in this file, e.g. in `switchToVersion`), then
  // find its single catch block within that isolated body.
  const functionMatch = source.match(
    /const commitSaveAttempt = useCallback\(async \(attempt: \{ version: number; draft: V04UiDraft \}\): Promise<boolean> => \{([\s\S]*?)\n {2}\}, \[videoId, viewerName, viewerUserId, refreshVersionList, pushToast\]\);/,
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
