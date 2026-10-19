// 读源码断言客户需求复盘库前端几条不容妥协的规则（做法同 tests/visual-ui-source.test.ts）：
// 复用站内组件而不是另起一套、页签与开关分支、提示走 LibraryToast、深色岛标注、无写死颜色、
// 路由外壳先查开关再门禁、客户端覆盖规格第九节的接口、出处标记文字走 formatRetroSourceLabel。

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const RETRO_DIR = new URL("../components/retro/", import.meta.url);
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

async function retroSources(): Promise<Map<string, string>> {
  const names = (await readdir(RETRO_DIR)).filter((name) => name.endsWith(".tsx"));
  return new Map(await Promise.all(names.map(async (name) => [name, await readFile(new URL(name, RETRO_DIR), "utf8")] as const)));
}

test("components/retro never uses dangerouslySetInnerHTML (everything the users write is rendered as text)", async () => {
  const sources = await retroSources();
  assert(sources.size >= 10);
  for (const [name, source] of sources) assert.doesNotMatch(source, /dangerouslySetInnerHTML/, name);
});

test("V04LibraryClient has the fourth tab: ?library=RETRO, 新建案例 in the header, disabled with 建设中 when the switch is off", async () => {
  const source = await read("components/v04/V04LibraryClient.tsx");
  assert.match(source, /type LibraryTab = "VIDEO" \| "REPORT" \| "VISUAL" \| "RETRO";/);
  assert.match(source, />客户需求复盘库<\/button>/);
  assert.match(source, /next === "REPORT" \|\| next === "VISUAL" \|\| next === "RETRO"/);
  assert.match(source, /initial === "REPORT" \|\| initial === "VISUAL" \|\| initial === "RETRO"/);
  assert.match(source, /retroLibraryEnabled = false/);
  assert.match(source, />新建案例<\/button>/);
  assert.match(source, /<button type="button" disabled title="客户需求复盘库建设中">新建案例<\/button>/);
  assert.match(source, /<RetroLibrary/);
  assert.match(source, /客户需求复盘库建设中/);
  // 新逻辑都在 components/retro，这里只加分支和按钮：库首页没有被复制进来。
  assert.doesNotMatch(source, /groupRetroCardsByMonth|retroApi/);
  // 视频库、报告库、公共视觉库原有分支原样还在。
  assert.match(source, /library === "VIDEO"/);
  assert.match(source, /reportLibraryEnabled/);
  assert.match(source, /visualLibraryEnabled/);
});

test("the home page passes the server-side switch down the same way as the visual library", async () => {
  const source = await read("app/page.tsx");
  assert.match(source, /import \{ isRetroFeatureEnabled \} from "@\/lib\/retro-model";/);
  assert.match(source, /retroLibraryEnabled=\{isRetroFeatureEnabled\(\)\}/);
});

test("route shells check the switch before the login gate (notFound first)", async () => {
  for (const path of ["app/retro/[id]/page.tsx", "app/retro/months/[month]/page.tsx"]) {
    const source = await read(path);
    const notFoundIndex = source.indexOf("if (!isRetroFeatureEnabled()) notFound();");
    const loginIndex = source.indexOf("requirePageUser(");
    assert(notFoundIndex >= 0, `${path}: feature-flag guard`);
    assert(loginIndex > notFoundIndex, `${path}: the flag is checked before requirePageUser`);
  }
  const month = await read("app/retro/months/[month]/page.tsx");
  assert(month.indexOf("isRetroMonthKey(month)") < month.indexOf("requirePageUser("), "month format is checked before the login gate too");
});

test("reuse: library, card, dialogs, detail pages are built from the site's own pieces, not a second copy", async () => {
  const sources = await retroSources();
  const all = [...sources.values()].join("\n");
  // 库首页：按月分组复用 weekSection／weekHeading，卡片骨架复用 caseCard 一组与报告库 4:3 .cover。
  const library = sources.get("RetroLibrary.tsx")!;
  assert.match(library, /v04\.weekSection/);
  assert.match(library, /v04\.weekHeading/);
  assert.match(library, /v04\.libraryHero/);
  assert.match(library, /v04\.libraryToolbar/);
  assert.match(library, /v04\.librarySearch/);
  assert.match(library, /v04\.caseGrid/);
  assert.match(library, /v04\.emptyState/);
  assert.match(library, /libraryCountLabel\(/);
  assert.match(library, /onCompositionStart/, "IME composition does not filter mid-way");
  const card = sources.get("RetroCard.tsx")!;
  for (const name of ["caseCard", "caseQuickActions", "caseEnterPill", "caseNumber", "caseInfoBand", "caseCategoryTag"]) assert.match(card, new RegExp(`v04\\.${name}`), name);
  assert.match(card, /report\.cover/);
  // 对话框外壳复用报告上传框。
  for (const file of ["RetroCaseDialog.tsx", "RetroRecordingUploadDialog.tsx", "RetroLinkPicker.tsx"]) {
    const source = sources.get(file)!;
    assert.match(source, /report\.uploadBackdrop/, file);
    assert.match(source, /report\.uploadDialog/, file);
    assert.match(source, /report\.uploadFooter/, file);
  }
  const caseDialog = sources.get("RetroCaseDialog.tsx")!;
  for (const name of ["field", "two", "hint", "formError"]) assert.match(caseDialog, new RegExp(`report\\.${name}`), name);
  assert.match(caseDialog, /"EDIT" : "NEW CASE"/);
  // 详情页：detailHero／breadcrumb／readingModule／readingCore。
  const detail = sources.get("RetroCaseClient.tsx")!;
  for (const name of ["detailHero", "breadcrumb", "detailEyebrow", "detailTags", "readingModule", "readingCore", "readingBody"]) assert.match(detail, new RegExp(`v04\\.${name}`), name);
  // 原位编辑、录音条、文字稿、直传、校验都用站内原件。
  assert.match(detail, /import V19EditableValue from "\.\.\/v04\/V19EditableValue";/);
  assert.match(all, /V19AudioReviewAudioBar/);
  assert.match(all, /V19AudioReviewTranscript/);
  assert.match(all, /useAudioReviewPlayback/);
  assert.match(sources.get("RetroRecordingUploadDialog.tsx")!, /putAudioReviewFile/);
  assert.match(sources.get("RetroRecordingUploadDialog.tsx")!, /validateAudioReviewFile/);
  // 三步进度、胶囊用 V04 的类。
  assert.match(sources.get("RetroSunPanel.tsx")!, /v04\.reviewSteps/);
  assert.match(sources.get("RetroSunPanel.tsx")!, /v04\.reviewSpin/);
});

test("confirmations use the shared DeleteConfirmDialog; messages go through LibraryToast, never a page banner", async () => {
  const sources = await retroSources();
  for (const file of ["RetroCaseClient.tsx", "RetroMonthClient.tsx"]) {
    const source = sources.get(file)!;
    assert.match(source, /import DeleteConfirmDialog from "@\/components\/shared\/DeleteConfirmDialog";/, file);
    assert.match(source, /<DeleteConfirmDialog/, file);
    assert.match(source, /import \{ LibraryToastStack, useLibraryToast \} from "@\/components\/shared\/LibraryToast";/, file);
    assert.match(source, /<LibraryToastStack toasts=\{toasts\} \/>/, file);
  }
  assert.match(sources.get("RetroAssetBlock.tsx")!, /<DeleteConfirmDialog/);
  assert.match(sources.get("RetroLibrary.tsx")!, /<LibraryToastStack toasts=\{toasts\} \/>/);
  for (const [name, source] of sources) assert.doesNotMatch(source, /role="alert"[^>]*banner|<Banner|PageNotice/i, name);
  // 两个整页都带外观开关。
  for (const file of ["RetroCaseClient.tsx", "RetroMonthClient.tsx"]) assert.match(sources.get(file)!, /<ThemeSwitcher \/>/, file);
});

test("toasts the spec asks for are in the code", async () => {
  const sources = await retroSources();
  assert.match(sources.get("RetroCaseClient.tsx")!, /案例已创建，接着把需求和过程填上/);
  assert.match(sources.get("RetroMonthClient.tsx")!, /本月纪要草稿已生成，等你审阅/);
  assert.match(sources.get("RetroMonthClient.tsx")!, /已发布 v\$\{[^}]+\}，全员可见/);
  // 只在「看着它变成待审阅」那一刻弹一次：按任务 id 记住上一次的状态。
  assert.match(sources.get("RetroMonthClient.tsx")!, /jobStatuses/);
});

test("dark islands are marked: text cover, attachment tiles, link thumbnails, viewer", async () => {
  const sources = await retroSources();
  assert.match(sources.get("RetroCard.tsx")!, /report\.cover[^>]*data-v04-scheme="dark"/);
  assert.equal((sources.get("RetroAssetBlock.tsx")!.match(/data-v04-scheme="dark"/g) ?? []).length, 3, "doc, audio and image/video tiles");
  assert.match(sources.get("RetroRoundCard.tsx")!, /styles\.linkThumb\} data-v04-scheme="dark"/);
  assert.match(sources.get("RetroLinkPicker.tsx")!, /styles\.linkThumb\} data-v04-scheme="dark"/);
  assert.match(sources.get("RetroCaseClient.tsx")!, /styles\.viewerBody\} data-v04-scheme="dark"/);
});

test("no hard-coded colours in the components, except the file-type icon inside the dark attachment tile", async () => {
  const sources = await retroSources();
  for (const [name, source] of sources) {
    const literals = source.replace(/\/\/.*$/gm, "").match(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g);
    if (name === "RetroAssetBlock.tsx") continue; // DocIcon 的描边与文件类型色，只出现在深色岛格子里
    assert.equal(literals, null, `${name} hardcodes ${literals?.join(", ")} — use a --v04-* token`);
  }
});

test("buttons and inputs in the stylesheet clear the .surface reset: every rule on a control carries the .root prefix", async () => {
  const css = (await read("components/retro/Retro.module.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim();
    if (!/font-size|font:/.test(rule[2])) continue;
    const controlTag = /^(?:[.\w-]*)(?:button|select|input|textarea)\b/;
    const controlClass = /\.(toolButton|addRound|addTile|linkAdd|linkX|partPill|deptSelect|eInput|eArea|addItem|smBtn|srcMark|roundMark|textLink|historySelect|quickBtn|pickRow|recEmpty|fileDropBtn)\b/;
    // 特异性至少 (0,2,0)：两个以上类名（.root 前缀或后代选择器都算），才压得过 .surface button 的 (0,1,1)。
    for (const part of selector.split(",")) {
      const last = part.trim().split(/\s+/).pop() ?? "";
      if (!controlTag.test(last.replace(/^\./, "")) && !controlClass.test(last)) continue;
      const classes = part.match(/\.[A-Za-z_][\w-]*/g) ?? [];
      assert(classes.length >= 2, `"${part.trim()}" sets a font on a control but is not (0,2,0): ${selector}`);
    }
  }
});

test("source marks take their text from formatRetroSourceLabel, and the popup jumps with ?t= / #recording", async () => {
  const ui = await read("lib/retro-ui.ts");
  assert.match(ui, /formatRetroSourceLabel\(/);
  assert.match(ui, /#recording/);
  assert.match(ui, /\?audio=/);
  assert.match(ui, /\?focus=summary/);
  const marks = await read("components/retro/RetroSourceMarks.tsx");
  assert.match(marks, /去听原声/);
  assert.match(marks, /role="dialog"/);
  assert.match(marks, /describeRetroSource/);
});

test("the API client covers every endpoint of spec section 9", async () => {
  const client = await read("lib/retro-client.ts");
  for (const fragment of [
    '"/api/retro-cases"',
    "caseBase(caseId)",
    '"/trash"', '"/restore"', '"/rounds"', '"/round-order"', "/rounds/${enc(roundId)}", "/links",
    '"/assets"', "/upload-url", '"/assets/complete"', "/assets/${enc(assetId)}", "/transcript",
    '"/api/retro-recordings"', "/api/retro-recordings/${enc(recordingId)}",
    "/api/retro-months/${enc(monthKey)}", "/publications/${version}", "/jobs", "/draft",
  ]) assert(client.includes(fragment), `client misses ${fragment}`);
  for (const method of ['"PATCH"', '"PUT"', '"DELETE"', '"POST"']) assert(client.includes(method), method);
  // 内部接力接口只认 HMAC 令牌，浏览器不调。
  assert.doesNotMatch(client, /\/advance/);
  // 写操作带同源 cookie，请求头带 X-Request-Id。
  assert.match(client, /credentials: "same-origin"/);
  assert.match(client, /X-Request-Id/);
});

test("in-place editing never overwrites other fields: PATCH answers only merge revision and the saved value", async () => {
  const source = await read("components/retro/RetroCaseClient.tsx");
  assert.match(source, /只并 revision、updatedAt/);
  assert.match(source, /const queue = useRef/, "saves are sent one at a time so revisions stay in step");
  assert.match(source, /isRetroConflict\(reason\)/);
});

test("the draft toolbar is a sticky bar with 放弃草稿 / 重新生成 / 发布, and only the reviewer gets the sun panel", async () => {
  const month = await read("components/retro/RetroMonthClient.tsx");
  assert.match(month, /放弃草稿/);
  assert.match(month, /重新生成/);
  assert.match(month, /发布 v\{/);
  assert.match(month, /isReviewer \? \(\s*<RetroSunPanel/);
  assert.match(month, /老孙整理确认后在这里发布/);
});

test("the in-minutes block only renders when the case is in a published version", async () => {
  const source = await read("components/retro/RetroInMinutes.tsx");
  assert.match(source, /if \(!minutes \|\| !ctx\) return null;/);
  assert.match(source, /看本月完整纪要 →/);
});

test("「重新生成」 is one atomic call with replaceJobId, gated by canRegenerate, and never ABANDON-then-GENERATE", async () => {
  const month = await read("components/retro/RetroMonthClient.tsx");
  assert.match(month, /replaceJobId: draftJob\.id/);
  assert.match(month, /retroRegenerateGate\(/);
  const start = month.slice(month.indexOf("async function startGenerate"), month.indexOf("function requestGenerate"));
  assert.doesNotMatch(start, /"ABANDON"/);
  const model = await read("lib/retro-model.ts");
  assert.match(model, /export type RetroStartJobRequest = \{[^}]*replaceJobId\?: string/);
});

test("recording dialog: only a failed PUT or a cancel removes the row; a failed UPLOADED keeps it and offers 重试收尾", async () => {
  const source = await read("components/retro/RetroRecordingUploadDialog.tsx");
  assert.match(source, /fileStored = true;/);
  assert.match(source, /if \(fileStored && createdRecording\)/);
  const keep = source.indexOf("if (fileStored && createdRecording)");
  const remove = source.indexOf('"REMOVE"');
  assert(keep >= 0 && remove > keep, "the keep branch returns before the REMOVE call");
  assert.match(source, /重试收尾/);
  assert.match(source, /retryFinish/);
});

test("polling in both clients drops results that a save has overtaken", async () => {
  for (const file of ["RetroCaseClient.tsx", "RetroMonthClient.tsx"]) {
    const source = await read(`components/retro/${file}`);
    assert.match(source, /const mutationSeq = useRef\(0\);/, file);
    assert.match(source, /mutationSeq\.current \+= 1;/, file);
    assert.match(source, /shouldApplyPoll\(seq, mutationSeq\.current, queued\.current\)/, file);
  }
});
