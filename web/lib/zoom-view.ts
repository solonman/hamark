// 大图预览的缩放计算（components/shared/ZoomStage.tsx 用；复盘库、公共视觉库、报告库三处共用）。
// 纯函数，单测直接覆盖。约定：scale = 1 是「适应窗口」，x/y 是以容器中心为原点的平移量（px）。

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 5;
export const ZOOM_STEP = 1.25;

export type ZoomView = { scale: number; x: number; y: number };
export const ZOOM_FIT: ZoomView = { scale: 1, x: 0, y: 0 };

/** 放大后能拖多远：内容边不离开框边（内容比框小的那个方向不许挪）。 */
export function clampZoomOffset(view: ZoomView, base: { width: number; height: number }, box: { width: number; height: number }): ZoomView {
  const maxX = Math.max(0, (base.width * view.scale - box.width) / 2);
  const maxY = Math.max(0, (base.height * view.scale - box.height) / 2);
  return { scale: view.scale, x: Math.min(maxX, Math.max(-maxX, view.x)), y: Math.min(maxY, Math.max(-maxY, view.y)) };
}

/** 以容器中心为原点的一点 (px, py) 为中心，把缩放改到 nextScale（那一点在内容上的位置不动）；缩回 1 倍就是适应窗口。 */
export function zoomViewAt(view: ZoomView, nextScale: number, px: number, py: number): ZoomView {
  const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextScale));
  if (scale === ZOOM_MIN) return ZOOM_FIT;
  const ratio = scale / view.scale;
  return { scale, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio };
}
