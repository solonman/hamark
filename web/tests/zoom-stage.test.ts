// 大图预览的缩放（components/shared/ZoomStage.tsx，2026-10-21）：复盘库、公共视觉库、报告库三处共用。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ZOOM_FIT, clampZoomOffset, zoomViewAt } from "../lib/zoom-view";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("zooming at a point keeps it still; back to 1x is fit; capped at 5x; panning is clamped", () => {
  assert.deepEqual(zoomViewAt(ZOOM_FIT, 2, 100, 0), { scale: 2, x: -100, y: 0 });
  assert.deepEqual(zoomViewAt({ scale: 2, x: -100, y: 30 }, 0.5, 0, 0), ZOOM_FIT);
  assert.equal(zoomViewAt({ scale: 4, x: 0, y: 0 }, 9, 0, 0).scale, 5);
  assert.deepEqual(clampZoomOffset({ scale: 2, x: 999, y: -999 }, { width: 800, height: 600 }, { width: 1000, height: 700 }), { scale: 2, x: 300, y: -250 });
});

test("all three libraries' large previews go through the shared ZoomStage", async () => {
  const retro = await source("../components/retro/RetroAssetViewer.tsx");
  assert.match(retro, /import ZoomStage from "\.\.\/shared\/ZoomStage";/);
  const visual = await source("../components/visual/VisualCaseClient.tsx");
  assert.match(visual, /<ZoomStage resetKey=\{asset\.id\}>/);
  const report = await source("../components/report/studio/deck/ReportPageModal.tsx");
  // 报告库：整页（页图 + 标注框）一起缩放，框选模式下不拖动画面。
  assert.match(report, /<ZoomStage resetKey=\{String\(pageNo\)\} panDisabled=\{drawMode\}>/);
  assert.match(report, /stageRef\.current = element as HTMLDivElement \| null; zoom\.ref\(element\);/);
});

test("ZoomStage: wheel is non-passive, a click is not swallowed by panning (4px threshold), keys + − 0, and inputs are left alone", async () => {
  const zoom = await source("../components/shared/ZoomStage.tsx");
  assert.match(zoom, /addEventListener\("wheel", onWheel, \{ passive: false \}\)/);
  assert.match(zoom, /DRAG_THRESHOLD_PX = 4/);
  assert.match(zoom, /if \(!zoomed \|\| panDisabled \|\| event\.button !== 0\) return;/);
  assert.match(zoom, /\["INPUT", "TEXTAREA", "SELECT"\]\.includes\(target\.tagName\) \|\| target\.isContentEditable/);
  for (const label of ["缩小", "放大", "适应"]) assert.ok(zoom.includes(label), label);
});

test("ZoomStage fullscreen: browser fullscreen when allowed, otherwise fill the window; Esc in fill mode only leaves fill mode; the report page drops its 760px cap", async () => {
  const zoom = await source("../components/shared/ZoomStage.tsx");
  assert.match(zoom, /useSyncExternalStore\(subscribeNothing, \(\) => Boolean\(document\.fullscreenEnabled\), \(\) => false\)/);
  assert.match(zoom, /box\.requestFullscreen\(\)/);
  assert.match(zoom, /document\.exitFullscreen\(\)/);
  assert.match(zoom, /\{fullscreen \|\| filling \? "退出全屏" : "全屏"\}/);
  assert.match(zoom, /box\.requestFullscreen\(\)\.catch\(\(\) => setFilling\(true\)\)/);
  assert.match(zoom, /window\.addEventListener\("keydown", onKey, true\)/);
  assert.match(zoom, /FULLSCREEN_WAIT_MS = 600/);
  assert.match(zoom, /if \(on\) setFilling\(false\);/);
  assert.match(zoom, /event\.stopImmediatePropagation\(\);/);
  assert.match(zoom, /event\.key === "f" \|\| event\.key === "F"/);
  const css = await source("../components/report/studio/deck/ReportDeck.module.css");
  assert.match(css, /\.ovstage > :fullscreen > \.ovpage, \.ovstage > \[data-full="1"\] > \.ovpage \{ width: min\(calc\(100cqw - 48px\)/);
});
