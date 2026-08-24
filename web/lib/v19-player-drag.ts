export type PlayerPosition = { x: number; y: number };
export type PlayerSize = { width: number; height: number };
export type ViewportSize = { width: number; height: number };

/**
 * 浮窗视频窗口的拖动坐标裁剪：保证四条边都留在视口内，并留出 margin。
 * 视口比播放器还小时（极窄屏），两个方向都退回到 margin，不产生负坐标。
 */
export function clampPlayerPosition(
  position: PlayerPosition,
  size: PlayerSize,
  viewport: ViewportSize,
  margin = 8,
): PlayerPosition {
  const maxX = Math.max(margin, viewport.width - size.width - margin);
  const maxY = Math.max(margin, viewport.height - size.height - margin);
  return {
    x: Math.min(Math.max(position.x, margin), maxX),
    y: Math.min(Math.max(position.y, margin), maxY),
  };
}

/**
 * 判断指针是否落在播放器底部的原生控制条区域内——这一区域不触发拖动，
 * 否则用户没法用鼠标去点播放/进度条/音量等原生视频控件。
 */
export function isVideoControlStrip(pointerY: number, elementBottom: number, stripHeight = 34): boolean {
  return pointerY >= elementBottom - stripHeight;
}
