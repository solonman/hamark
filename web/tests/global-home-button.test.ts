import assert from "node:assert/strict";
import test from "node:test";
import { isFormalV04SurfacePath, isProtectedDraftWorkspacePath } from "../app/components/GlobalHomeButton";

test("formal V04 surfaces hide the floating '全部作品' button — home, video workspace, and report workspace alike", () => {
  // 首页本身：按钮换成实心圆点，不是浮动返回钮那一支，但也算「正式界面」。
  assert.equal(isFormalV04SurfacePath("/"), true);

  // 视频库：详情页、练习页都靠 logo 回列表，原来就认。
  assert.equal(isFormalV04SurfacePath("/videos/video-a"), true);
  assert.equal(isFormalV04SurfacePath("/videos/video-a/practice"), true);

  // 报告库工作台（/reports/[id]，见 app/reports/[id]/page.tsx）：本次要修的那条——
  // 之前的判断只认视频路径，报告工作台一直漏判，浮钮跟视频工作台不一致地露着。
  assert.equal(isFormalV04SurfacePath("/reports/report-a"), true);

  // 报告库首页列表（不带 id）不算工作台，浮钮该照常显示，方便离开搜索/筛选状态回到入口。
  assert.equal(isFormalV04SurfacePath("/reports"), false);
  assert.equal(isFormalV04SurfacePath("/reports/"), false);

  // 报告工作台再往下一层（比如带查询参数以外的真实子路径）不该被这条正则误伤放宽——
  // pathname 不含查询串，这里用真实会出现的子路径确认边界不会意外放行。
  assert.equal(isFormalV04SurfacePath("/reports/report-a/practice"), false);

  // 其它库外页面照常显示浮钮。
  assert.equal(isFormalV04SurfacePath("/admin/v02-v03-batch-mapping"), false);
});

test("draft workspace guard is unaffected by the report-workspace fix (regression pin)", () => {
  assert.equal(isProtectedDraftWorkspacePath("/videos/video-a/practice"), true);
  assert.equal(isProtectedDraftWorkspacePath("/videos/video-a"), false);
  assert.equal(isProtectedDraftWorkspacePath("/reports/report-a"), false);
});
