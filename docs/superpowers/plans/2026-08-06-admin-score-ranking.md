# 管理员评分排行弹层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让预置管理员能在首页按视频上传日期查看有效作业评分排行，并在新标签页进入相应视频详情。

**Architecture:** 由数据库 `app_admins` 表作为显示姓名白名单，服务端的管理员帮助函数同时供首页 SSR 和排行 API 使用。首页只在管理员会话下渲染日期入口；它请求一个最小化的聚合接口，并把结果交给独立、可关闭的弹层组件显示。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript、PostgreSQL/Supabase、Node test runner、ESLint。

---

## File structure

- Create: `web/lib/admin.ts` — 查询管理员白名单并暴露服务端权限判断。
- Create: `web/lib/score-ranking.ts` — 统一日期解析、日期范围和排行 API 的共享类型。
- Create: `web/app/api/admin/video-score-ranking/route.ts` — 认证、授权、参数校验和视频评分聚合查询。
- Create: `web/app/components/ScoreRankingDialog.tsx` — 无障碍弹层与新标签页排行链接。
- Create: `web/tests/admin-score-ranking.test.mjs` — 日期/权限/接口 SQL 与弹层安全链接回归测试。
- Modify: `web/db/bootstrap.ts` — 创建和种子化 `app_admins`。
- Modify: `web/db/supabase.sql` — 为生产数据库提供同等 DDL 与种子。
- Modify: `web/app/page.tsx` — 服务器端计算 `isAdmin` 并传给首页客户端。
- Modify: `web/app/components/HomeClient.tsx` — 管理员日期输入、请求状态和弹层状态。
- Modify: `web/app/globals.css` — 顶部工具、弹层和移动端布局样式。

### Task 1: 数据库白名单与服务端权限

**Files:**
- Create: `web/lib/admin.ts`
- Modify: `web/db/bootstrap.ts`
- Modify: `web/db/supabase.sql`
- Test: `web/tests/admin-score-ranking.test.mjs`

- [ ] **Step 1: 写出失败测试，锁定种子名单和管理员查询。**

```js
test("admin bootstrap seeds the three approved WeCom display names", () => {
  const bootstrap = readRepoFile("../db/bootstrap.ts");
  const schema = readRepoFile("../db/supabase.sql");
  for (const source of [bootstrap, schema]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS app_admins/);
    assert.match(source, /老孙/);
    assert.match(source, /李丽萍/);
    assert.match(source, /晏恩华/);
  }
});

test("admin helper checks the current WeCom display name in the database", () => {
  const source = readRepoFile("../lib/admin.ts");
  assert.match(source, /WHERE display_name = \?/);
  assert.match(source, /user\.displayName/);
});
```

- [ ] **Step 2: 运行测试，确认因文件尚不存在而失败。**

Run: `npm test -- --test-name-pattern="admin"`

Expected: FAIL，指出 `web/lib/admin.ts` 不存在或断言未匹配。

- [ ] **Step 3: 加入迁移安全的管理员表和初始名单。**

在 `bootstrap.ts` 的 `statements` 数组、`supabase.sql` 的用户表之前加入完全相同的 SQL：

```sql
CREATE TABLE IF NOT EXISTS app_admins (
  display_name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
INSERT INTO app_admins (display_name) VALUES
  ('老孙'),
  ('李丽萍'),
  ('晏恩华')
ON CONFLICT (display_name) DO NOTHING
```

保持 `bootstrap.ts` 中每条语句是独立模板字符串，以便当前 `db.batch()` 可按顺序执行。

- [ ] **Step 4: 实现唯一的服务端权限入口。**

```ts
// web/lib/admin.ts
import { getDbClient } from "@/db";
import type { CurrentUser } from "@/lib/current-user";

export async function isAppAdmin(user: CurrentUser) {
  const row = await getDbClient()
    .prepare("SELECT display_name FROM app_admins WHERE display_name = ?")
    .bind(user.displayName)
    .first<{ display_name: string }>();
  return Boolean(row);
}
```

不要把管理员名单硬编码到客户端，也不要以邮箱或 `identityKey` 替代已确认的显示姓名规则。

- [ ] **Step 5: 重新运行管理员测试。**

Run: `npm test -- --test-name-pattern="admin"`

Expected: PASS。

- [ ] **Step 6: 提交本任务。**

```bash
git add web/lib/admin.ts web/db/bootstrap.ts web/db/supabase.sql web/tests/admin-score-ranking.test.mjs
git commit -m "feat: add database-backed admin access"
```

### Task 2: 排行参数、聚合接口与服务端拒绝路径

**Files:**
- Create: `web/lib/score-ranking.ts`
- Create: `web/app/api/admin/video-score-ranking/route.ts`
- Modify: `web/tests/admin-score-ranking.test.mjs`

- [ ] **Step 1: 写失败测试，固定日期边界和 API 访问控制 SQL。**

```js
import { parseScoreRankingDateRange } from "../lib/score-ranking.ts";

test("score ranking includes the whole end day and rejects reversed dates", () => {
  assert.deepEqual(parseScoreRankingDateRange("2026-07-01", "2026-07-31"), {
    start: "2026-07-01T00:00:00.000Z",
    endExclusive: "2026-08-01T00:00:00.000Z",
  });
  assert.throws(() => parseScoreRankingDateRange("2026-08-01", "2026-07-31"), /起始日期/);
});

test("score ranking endpoint restricts access and aggregates submitted valid reviews", () => {
  const source = readRepoFile("../app/api/admin/video-score-ranking/route.ts");
  assert.match(source, /isAppAdmin/);
  assert.match(source, /status = 'SUBMITTED'/);
  assert.match(source, /is_valid_for_aggregate = 1/);
  assert.match(source, /AVG\(r\.total_score\)/);
  assert.match(source, /ORDER BY average_score DESC, valid_review_count DESC, uploaded_at DESC/);
});
```

- [ ] **Step 2: 运行测试，确认失败。**

Run: `npm test -- --test-name-pattern="score ranking"`

Expected: FAIL，提示共享模块和路由尚未创建。

- [ ] **Step 3: 实现严格的日期范围解析与返回类型。**

```ts
// web/lib/score-ranking.ts
export type ScoreRankingItem = {
  videoId: string;
  title: string;
  brand: string;
  averageScore: number;
  validReviewCount: number;
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export function parseScoreRankingDateRange(startDate: string | null, endDate: string | null) {
  if (!startDate || !endDate || !datePattern.test(startDate) || !datePattern.test(endDate)) {
    throw new Error("请选择有效的起止日期。");
  }
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start > end) {
    throw new Error("起始日期不能晚于结束日期。");
  }
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), endExclusive: end.toISOString() };
}
```

- [ ] **Step 4: 实现授权的聚合路由。**

```ts
const user = await requireApiUser(request);
if (user instanceof Response) return user;
if (!(await isAppAdmin(user))) {
  return Response.json({ error: "仅管理员可查看评分排行。" }, { status: 403 });
}
```

读取 `startDate` 与 `endDate`，用 `parseScoreRankingDateRange` 验证并把异常转为 400。聚合 SQL 必须连接 `videos v` 与 `assignment_reviews r`，并使用：

```sql
WHERE v.deleted_at IS NULL
  AND v.created_at >= ? AND v.created_at < ?
  AND r.status = 'SUBMITTED'
  AND r.is_valid_for_aggregate = 1
  AND r.deleted_at IS NULL
GROUP BY v.id, v.title, v.brand, v.created_at
ORDER BY average_score DESC, valid_review_count DESC, uploaded_at DESC
```

选择 `AVG(r.total_score) AS average_score`、`COUNT(*) AS valid_review_count`，并显式把数值转换为 `Number` 后返回 `{ items }`。不得以单个评分快照取代视频级平均分。

- [ ] **Step 5: 运行排行测试。**

Run: `npm test -- --test-name-pattern="score ranking"`

Expected: PASS。

- [ ] **Step 6: 提交本任务。**

```bash
git add web/lib/score-ranking.ts web/app/api/admin/video-score-ranking/route.ts web/tests/admin-score-ranking.test.mjs
git commit -m "feat: add admin video score ranking api"
```

### Task 3: 首页权限传递与评分排行弹层

**Files:**
- Create: `web/app/components/ScoreRankingDialog.tsx`
- Modify: `web/app/page.tsx`
- Modify: `web/app/components/HomeClient.tsx`
- Modify: `web/tests/admin-score-ranking.test.mjs`

- [ ] **Step 1: 写失败测试，确保新标签页与非管理员隐藏。**

```js
test("ranking dialog opens video details in a safe new tab", () => {
  const source = readRepoFile("../app/components/ScoreRankingDialog.tsx");
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noopener noreferrer"/);
  assert.match(source, /href=\{`\/videos\/\$\{item\.videoId\}`\}/);
});

test("home receives server-computed admin access before rendering ranking controls", () => {
  const page = readRepoFile("../app/page.tsx");
  const home = readRepoFile("../app/components/HomeClient.tsx");
  assert.match(page, /isAppAdmin\(user\)/);
  assert.match(home, /isAdmin \? \(/);
});
```

- [ ] **Step 2: 运行测试，确认失败。**

Run: `npm test -- --test-name-pattern="ranking dialog|server-computed admin"`

Expected: FAIL，提示弹层缺失且首页尚未传递权限。

- [ ] **Step 3: 将管理员状态从服务器页面传给客户端。**

在 `web/app/page.tsx` 中导入 `isAppAdmin`，并在 `requirePageUser("/")` 后执行：

```tsx
const isAdmin = await isAppAdmin(user);
return <HomeClient user={{ /* existing fields */ }} isAdmin={isAdmin} />;
```

扩展 `HomeClient` props 为 `{ user: UserMenuUser; isAdmin: boolean }`。不要从浏览器请求管理员状态。

- [ ] **Step 4: 实现独立的无障碍弹层。**

`ScoreRankingDialog` 接收 `startDate`、`endDate`、`items`、`onClose`。用 `useEffect` 监听 Escape 并在卸载时恢复监听；背景点击时仅当 `event.target === event.currentTarget` 才关闭。组件必须使用：

```tsx
<div className="dialog-backdrop score-ranking-backdrop" onMouseDown={onBackdropMouseDown}>
  <section className="score-ranking-dialog" role="dialog" aria-modal="true" aria-labelledby="score-ranking-title">
    <button type="button" className="dialog-close" onClick={onClose} aria-label="关闭评分排行">×</button>
    <h2 id="score-ranking-title">作品评分排行</h2>
    {items.map((item, index) => (
      <Link key={item.videoId} href={`/videos/${item.videoId}`} target="_blank" rel="noopener noreferrer" className="score-ranking-row">
        {/* rank, title, brand, validReviewCount, averageScore */}
      </Link>
    ))}
  </section>
</div>
```

平均分使用 `toFixed(1)`；空数组显示“这个日期范围内还没有有效评分作业。”。

- [ ] **Step 5: 接入首页日期与请求状态。**

在 `HomeClient` 中增加 `startDate`、`endDate`、`rankingItems`、`rankingError`、`rankingLoading` 和 `showRanking` 状态。仅在 `isAdmin ? (...) : null` 分支渲染日期控件。点击处理函数先在浏览器检查两日期和先后顺序，再请求：

```ts
const response = await fetch(
  `/api/admin/video-score-ranking?${new URLSearchParams({ startDate, endDate })}`,
  { cache: "no-store" },
);
```

请求成功时存储 `data.items ?? []` 并 `setShowRanking(true)`；失败时显示接口错误且不打开弹层。渲染 `<ScoreRankingDialog>` 时只传入当前状态，关闭仅调用 `setShowRanking(false)`，因此不重置搜索、日期或页面位置。

- [ ] **Step 6: 运行组件回归测试。**

Run: `npm test -- --test-name-pattern="ranking dialog|server-computed admin"`

Expected: PASS。

- [ ] **Step 7: 提交本任务。**

```bash
git add web/app/page.tsx web/app/components/HomeClient.tsx web/app/components/ScoreRankingDialog.tsx web/tests/admin-score-ranking.test.mjs
git commit -m "feat: show admin score ranking dialog"
```

### Task 4: 视觉样式、全量验证与数据库部署步骤

**Files:**
- Modify: `web/app/globals.css`
- Modify: `web/tests/admin-score-ranking.test.mjs`

- [ ] **Step 1: 写失败测试，锁定移动端和弹层样式钩子。**

```js
test("ranking styles provide a modal overlay and narrow-screen layout", () => {
  const css = readRepoFile("../app/globals.css");
  assert.match(css, /\.score-ranking-backdrop/);
  assert.match(css, /\.score-ranking-dialog/);
  assert.match(css, /\.score-ranking-row/);
  assert.match(css, /@media \(max-width: 760px\)/);
});
```

- [ ] **Step 2: 运行样式测试，确认失败。**

Run: `npm test -- --test-name-pattern="ranking styles"`

Expected: FAIL，因为评分排行选择器尚未定义。

- [ ] **Step 3: 添加与现有首页一致的 CSS。**

将管理员日期栏设计为紧凑、可换行的 `.score-ranking-controls`，并复用 `.button` 的深色实心按钮语言。`.score-ranking-backdrop` 使用固定定位、半透明遮罩和高于 `.site-header` 的 `z-index`；`.score-ranking-dialog` 限制宽度、可滚动、在小屏占满安全边距。列表行用 `display:grid` 对齐排名、标题信息、作业数和分数；小屏时把作业数移到标题下方，确保点击区域仍为整行。为 `:focus-visible` 定义清晰轮廓，且不把评分颜色作为唯一信息载体。

- [ ] **Step 4: 执行迁移并完成完整验证。**

Run: `npm run db:migrate`

Expected: 成功创建 `app_admins` 并插入三位管理员（重复执行不失败）。

Run: `npm run lint && npm test`

Expected: ESLint 无错误；Next 构建完成且所有 Node 测试通过。

- [ ] **Step 5: 手工验收登录态页面。**

以管理员会话确认入口可见，选日期能打开弹层，空结果提示清楚，任一行在新标签页打开详情；以非管理员会话确认入口不存在且直访 API 返回 403。确认关闭按钮、遮罩点击和 Esc 都关闭弹层，关闭后日期和首页位置仍保留。

- [ ] **Step 6: 提交本任务。**

```bash
git add web/app/globals.css web/tests/admin-score-ranking.test.mjs
git commit -m "style: polish admin score ranking dialog"
```

## Plan self-review

- Spec coverage: 任务 1 覆盖数据库白名单和服务端权限；任务 2 覆盖日期范围、聚合、排序和拒绝路径；任务 3 覆盖首页入口、弹层、关闭行为与新标签页；任务 4 覆盖样式、迁移与手工验收。
- Placeholder scan: 本计划无 TBD、TODO、模糊的“适当处理”步骤或未定义文件。
- Type consistency: `ScoreRankingItem`、`isAppAdmin`、`parseScoreRankingDateRange` 与 API 和组件中的命名一致；日期参数始终为 `startDate`、`endDate`。
