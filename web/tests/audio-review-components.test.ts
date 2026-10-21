// 老孙点评（录音或文字）的前端组件：页头入口、点评卡、点评原文的静态渲染，以及上传弹层、
// 确认抽屉、外壳里的文案与分支（这两个是 portal 到 body 的浮层，静态渲染拿不到，读源码断言）。
// 见 docs/25_录音点评改写_实施规格_V0.1.md 二之二、七。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AudioReviewSegment, AudioReviewView, V19AudioReviewSummary } from "../lib/audio-review-model.ts";

// 同 tests/v19-studio-document.test.ts：把 .css 模块换成空对象，真组件可以直接渲染。
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

const V19AudioReviewEntry = (await import("../components/v04/V19AudioReviewEntry.tsx")).default;
const V19AudioReviewCard = (await import("../components/v04/V19AudioReviewCard.tsx")).default;
const { V19AudioReviewDocumentText } = await import("../components/v04/V19AudioReviewParts.tsx");

const componentDir = new URL("../components/v04/", import.meta.url);
const read = (name: string) => readFile(new URL(name, componentDir), "utf8");
const [entrySource, uploadSource, drawerSource, cardSource, partsSource, shellSource, documentSource] = await Promise.all([
  read("V19AudioReviewEntry.tsx"),
  read("V19AudioReviewUploadDialog.tsx"),
  read("V19AudioReviewDrawer.tsx"),
  read("V19AudioReviewCard.tsx"),
  read("V19AudioReviewParts.tsx"),
  read("V04StudioClient.tsx"),
  read("V19StudioDocument.tsx"),
]);

/** 去掉注释，只看会显示出来的代码与文案。 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
}

function summary(overrides: Partial<V19AudioReviewSummary> = {}): V19AudioReviewSummary {
  return {
    id: "arv-1", baseVersionId: "ver-1", sourceKind: "AUDIO", status: "TRANSCRIBING", step: 1, failReason: null,
    changeCount: 0, reviewVersionId: null, reviewVersionNumber: null,
    ...overrides,
  };
}

const paragraphs: AudioReviewSegment[] = [
  { id: 1, startMs: 0, endMs: 0, speaker: "老孙", isReviewer: true, text: "母题看浅了。", corrections: [] },
  { id: 2, startMs: 0, endMs: 0, speaker: "王一凡", isReviewer: false, text: "王一凡问：那还算形式游戏吗？", corrections: [] },
  { id: 3, startMs: 0, endMs: 0, speaker: "老孙", isReviewer: true, text: "辅助是对置生义。", corrections: [{ from: "对质生意", to: "对置生义" }] },
];

function review(overrides: Partial<AudioReviewView> = {}): AudioReviewView {
  return {
    id: "arv-1", videoId: "vid-1", baseVersionId: "ver-1", baseVersionNumber: 1, baseOwnerName: "刘梦娜",
    sourceKind: "AUDIO", reviewerName: "老孙", uploaderName: "秦欣欣",
    status: "GENERATED", failedStep: null, failReason: null, step: 2,
    audio: { fileName: "捉迷藏点评.m4a", sizeBytes: 1000, durationMs: 684_000, url: "/audio" },
    transcript: { segments: [{ id: 1, startMs: 8_000, endMs: 20_000, speaker: "老孙", isReviewer: true, text: "下一个。", corrections: [] }] },
    proposal: {
      opinions: [{ id: "o1", number: 1, kind: "GENERAL", summary: "母题看浅了", rationale: "", segmentIds: [1], changeIds: ["c1"] }],
      changes: [{
        id: "c1", key: "facts.creativeMotif", targetKey: "facts.creativeMotif", subKey: null, label: "创意母题", valueType: "TEXT",
        before: "a", after: "b", beforeText: "a", afterText: "b", opinionIds: ["o1"],
      }],
      unaddressed: [], model: null, promptVersion: null,
    },
    selectedChangeIds: ["c1"], reviewVersionId: "ver-3", reviewVersionNumber: 3,
    createdAt: "2026-10-21T06:00:00.000Z", updatedAt: "2026-10-21T06:30:00.000Z", confirmedAt: "2026-10-21T06:30:00.000Z",
    ...overrides,
  };
}

const entryProps = {
  view: null, baseLabel: "v1 刘梦娜", uploadingLocally: false, busy: false,
  onUpload: () => undefined, onOpenDrawer: () => undefined, onView: () => undefined,
  onRetry: () => undefined, onReupload: () => undefined, onAbandon: () => undefined,
};

// ---------------------------------------------------------------------------
// 页头入口
// ---------------------------------------------------------------------------

test("入口：按钮叫「上传点评」，title 说明录音、文档或直接粘贴文字都行", () => {
  const html = renderToStaticMarkup(createElement(V19AudioReviewEntry, { ...entryProps, state: { kind: "UPLOAD" } }));
  assert.match(html, />上传点评<\/span>/);
  assert.match(html, /title="上传对 v1 刘梦娜 的点评：录音、文档或直接粘贴文字"/);
  assert.doesNotMatch(html, /录音点评|点评录音/);
});

test("入口：文档处理中写「点评处理中 · 读取文字 2/3」；录音处理中仍是「转写成文字」", () => {
  const document = renderToStaticMarkup(createElement(V19AudioReviewEntry, {
    ...entryProps, state: { kind: "PROCESSING", review: summary({ sourceKind: "DOCUMENT", status: "TRANSCRIBING", step: 1 }) },
  }));
  assert.match(document, /点评处理中 · 读取文字<\/span><b>2\/3<\/b>/);
  assert.match(document, /title="点评处理中 · 读取文字 2\/3，点开看进度"/);
  const audio = renderToStaticMarkup(createElement(V19AudioReviewEntry, {
    ...entryProps, state: { kind: "PROCESSING", review: summary({ status: "TRANSCRIBING", step: 1 }) },
  }));
  assert.match(audio, /点评处理中 · 转写成文字<\/span><b>2\/3<\/b>/);
  for (const html of [document, audio]) assert.doesNotMatch(html, /点评录音/);
});

test("入口：失败胶囊写「点评处理失败」，不再写「录音」", () => {
  const html = renderToStaticMarkup(createElement(V19AudioReviewEntry, {
    ...entryProps, state: { kind: "FAILED", review: summary({ sourceKind: "DOCUMENT", status: "FAILED", failReason: "文件损坏" }) },
  }));
  assert.match(html, />点评处理失败<\/span>/);
  assert.match(html, /title="点评处理失败：文件损坏"/);
  assert.doesNotMatch(html, /录音/);
});

// ---------------------------------------------------------------------------
// 点评卡
// ---------------------------------------------------------------------------

const cardProps = { videoId: "vid-1", loadError: "", baseVersionNumber: 1, onRetry: () => undefined, onJumpToOpinion: () => undefined };

test("点评卡（文档）：标题「老孙的点评」；来源「文档 · 文件名（可下载原文件） · X 确认生成」；没有录音条；原文区「点评原文（N 段）」默认折叠", () => {
  const html = renderToStaticMarkup(createElement(V19AudioReviewCard, {
    ...cardProps,
    review: review({
      sourceKind: "DOCUMENT",
      audio: { fileName: "捉迷藏点评.docx", sizeBytes: 2048, durationMs: null, url: "/file" },
      transcript: { segments: paragraphs },
    }),
  }));
  assert.match(html, /<h2>老孙的点评<\/h2>/);
  assert.match(html, /文档 · <a href="\/api\/videos\/vid-1\/audio-reviews\/arv-1\/audio" download="捉迷藏点评.docx"[^>]*>捉迷藏点评.docx<\/a> · 秦欣欣 \S+ \S+ 确认生成/);
  assert.doesNotMatch(html, /<audio/, "文档来源没有录音条");
  assert.doesNotMatch(html, /录音暂时播放不了|完整文字稿|按词表校正/);
  assert.match(html, /<details[^>]*data-v19-audio-review-document[^>]*><summary>点评原文（3 段 · 虚线＝校正过的错别字）<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]*open[^>]*data-v19-audio-review-document/, "默认折叠");
  assert.doesNotMatch(html, /录音点评/);
});

test("点评卡（录音）：来源「录音 · 文件名 · 时长 · X 确认生成」，文件名不做下载；录音条与「完整文字稿」照旧", () => {
  const html = renderToStaticMarkup(createElement(V19AudioReviewCard, { ...cardProps, review: review() }));
  assert.match(html, /<h2>老孙的点评<\/h2>/);
  assert.match(html, /录音 · <span>捉迷藏点评.m4a<\/span> · 11:24 · 秦欣欣 /);
  assert.doesNotMatch(html, /download=/);
  assert.match(html, /<audio/);
  assert.match(html, /完整文字稿（1 段/);
  assert.doesNotMatch(html, /点评原文/);
});

test("点评原文：左列「第 N 段」，按 segments 顺序编号；写明是别人说的段落标出是谁；校正的错别字悬停看原文", () => {
  const html = renderToStaticMarkup(createElement(V19AudioReviewDocumentText, {
    segments: paragraphs, open: true, onToggle: () => undefined, flashId: 3,
  }));
  assert.match(html, /<details[^>]*open=""/);
  assert.match(html, /data-review-paragraph="1"[^>]*><span>第 1 段<\/span>/);
  assert.match(html, /data-review-paragraph="3"[^>]*><span>第 3 段<\/span>/);
  assert.match(html, /title="这一段是王一凡说的，不算点评意见">王一凡<\/span>/);
  assert.match(html, /title="原文写作“对质生意”，按错别字校正为“对置生义”">对置生义<\/span>/);
  assert.doesNotMatch(html, /\d{2}:\d{2}/, "文档没有时间点");
});

// ---------------------------------------------------------------------------
// 上传弹层、确认抽屉、外壳（源码）
// ---------------------------------------------------------------------------

test("source: 上传弹层——标题「上传点评」；先按文档分类、PDF／.doc 拒收；粘贴的文字走同一条 create → PUT → UPLOADED", () => {
  const code = withoutComments(uploadSource);
  assert.match(code, /<b id=\{titleId\}>上传点评<\/b>/);
  assert.match(code, /录音（m4a \/ mp3 \/ wav \/ aac 等）或文档（Word \.docx \/ \.txt \/ \.md）/);
  assert.match(code, /const checked = classifyAudioReviewUpload\(file\);/);
  assert.match(code, /void start\(pastedAudioReviewFile\(checked\.text\), \{ sourceKind: "DOCUMENT", contentType: "text\/plain" \}, "文字"\);/);
  assert.match(code, /直接粘贴文字/);
  assert.match(code, />提交文字<\/button>/);
  // 只有一条上传流程：create、PUT、UPLOADED 各出现一次
  assert.equal((code.match(/audioReviewApi\.create\(/g) ?? []).length, 1);
  assert.equal((code.match(/putAudioReviewFile\(created\.uploadUrl/g) ?? []).length, 1);
  assert.equal((code.match(/action: "UPLOADED"/g) ?? []).length, 1);
  // 说明文字对录音和文字都成立，保留三句口径
  assert.match(code, /录音和文字二选一/);
  assert.match(code, /以\$\{AUDIO_REVIEW_CRITIC_NAME\}的意见为准/);
  assert.match(code, /<b>生成后这一版不能再传<\/b>/);
  assert.match(code, /全站可见/);
  assert.doesNotMatch(code, /一段录音对应这一份作业/);
  // 复盘库仍用只认录音的那一个
  assert.match(code, /export function validateAudioReviewFile[\s\S]*?return checkAudioReviewRecording\(file\);/);
});

test("source: 确认抽屉——文档不渲染录音条；原话与没落到条目的话用「第 N 段」跳到原文；标题「据老孙点评改写」", () => {
  const code = withoutComments(drawerSource);
  assert.match(code, /据\{AUDIO_REVIEW_VERSION_LABEL\}改写 \{baseLabel\}/);
  assert.match(code, /\{!isDocument && \(\s*<V19AudioReviewAudioBar/);
  assert.equal((code.match(/audioReviewSegmentRef\(sourceKind, segments,/g) ?? []).length, 2, "原话、没落到条目的话各一处");
  assert.match(code, /if \(reference\.segmentId !== null\) paragraphs\.jump\(reference\.segmentId\);/);
  assert.match(code, /\{isDocument \? \(\s*<V19AudioReviewDocumentText/);
  assert.doesNotMatch(code, /录音点评/);
});

test("source: 「第 N 段」跳转——展开原文、滚到那一段、短暂高亮", () => {
  assert.match(partsSource, /const jump = useCallback\(\(segmentId: number\) => \{[\s\S]*?setOpen\(true\);[\s\S]*?setFlash\(/);
  assert.match(partsSource, /querySelector<HTMLElement>\(`\[data-review-paragraph="\$\{flash\.id\}"\]`\)/);
  assert.match(partsSource, /scrollIntoView\(\{ block: "center"/);
});

test("source: 外壳——胶囊、版本菜单、提示条、目录、放弃确认、toast 都叫「老孙点评」，不写死", () => {
  const code = withoutComments(shellSource);
  assert.match(code, /<span className=\{styles\.versionOwner\}>\{AUDIO_REVIEW_VERSION_LABEL\}<\/span>/);
  assert.match(code, /\{AUDIO_REVIEW_VERSION_LABEL\}，基于 v\{version\.baseNumber \?\? "\?"\}/);
  assert.match(code, /据\{AUDIO_REVIEW_VERSION_LABEL\}改写 v\{version\.baseNumber \?\? "\?"\}/);
  assert.match(code, /<b>\{AUDIO_REVIEW_CRITIC_NAME\}对这一版做了点评<\/b>/);
  assert.match(code, /<b>\{AUDIO_REVIEW_CRITIC_NAME\}的点评<\/b><span>\{describeAudioReviewNavHint\(currentReviewSourceKind\)\}<\/span>/);
  assert.match(code, /pushToast\(describeAudioReviewUploadedToast\(sourceKind, fileName\)\);/);
  assert.match(code, /入口回到「上传点评」/);
  for (const source of [code, withoutComments(entrySource), withoutComments(cardSource), withoutComments(documentSource)]) {
    assert.doesNotMatch(source, /录音点评|点评录音|上传点评录音/);
  }
});
