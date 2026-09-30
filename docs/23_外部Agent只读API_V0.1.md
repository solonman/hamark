# 外部 Agent 只读 API｜V0.1

日期：2026-09-30
范围：给站外 Agent（研究助手、文案助手等）读取案例库里的视频逆向拆解作业与报告逆向拆解作业。
代码：`web/app/api/agent/v1/**`、`web/lib/agent-api/*`、令牌管理 `web/app/agent-tokens/*` + `web/app/api/agent-tokens/**`、测试 `web/tests/agent-api.test.ts`。
迁移：`web/db/migrations/2026-09-30-agent-api-tokens.sql`（生产在 Supabase SQL 编辑器整段执行；未执行前令牌页与接口都会提示"请先执行迁移"，不影响站内其他功能）。

## 一、原则

1. **只读**：路由只导出 `GET`，其他方法由框架直接回 405；读取服务只有 `SELECT`，另外只复用两个本来就不写库的读路径 `loadFinalVersion` / `loadReportFinalVersion`（没有集成版行时在内存里算虚拟版，不落库）。站内报告库的 `listReports` / `loadReportDetail` 会顺手向数据万象轮询并写库，这里刻意不用。唯一的写入是鉴权旁注：令牌的"最近使用时间"，五分钟内不重复写。
2. **只对指定成员开放**：只有名单内成员（`web/lib/agent-api/access.ts` 的 `AGENT_TOKEN_OWNER_NAMES`，当前为老孙、晏恩华）能生成令牌；没有令牌就调不了接口。
3. **与站内同口径的可见范围**：
   - 视频：`deleted_at IS NULL`、`data_scope = BUSINESS`、`deletion_state = ACTIVE`（空值按 ACTIVE）、`status = READY`。TEST_ONLY 灰度数据、回收站、已清理资产一律不可见。
   - 报告：`deleted_at IS NULL`、`status = READY`；相关资料排除已软删除的。报告库总开关 `REPORT_LIBRARY_UI_ENABLED` 关着时，报告接口回 404。
4. **内容来源**：只读 V1.9 版本链（`analysis_versions` / `report_versions`）与集成版（`analysis_final_versions` / `report_final_versions`）。V0.2/V0.3 的旧快照不对外。一条视频还没人在 V1.9 工作台保存过时，接口给出工作台此时展示的同一份虚拟 v1（由旧工作稿生成），没有内容就回 `NO_ANALYSIS`。
5. **不暴露**：上传者邮箱、用户 id、评论、评分、收藏、审计记录。版本只带作者显示名。

## 二、鉴权

请求头 `Authorization: Bearer <token>`。

- **谁能生成**：名单内成员（老孙、晏恩华）登录站内后，头像菜单里有「外部 Agent 令牌」入口（`/agent-tokens`）；其他人看不到入口，直接打开页面只见"只对指定成员开放"，管理接口回 403。
- **生成**：填一个名字（给哪个 Agent 用，≤40 字）→ 令牌明文（`hmk_agent_<43位base64url>`）只在这一刻显示一次，页面上可复制。库里（`agent_api_tokens`）只存 SHA-256 和末 4 位提示。每人同时有效最多 10 枚，每人只看得到、只停得了自己生成的。
- **停用**：列表里点「停用」→ 共享确认弹窗（默认焦点在「取消」）→ 立即失效，行保留为"已停用"，不删除。
- **每次调用都复核主人**：令牌主人必须仍是 ACTIVE 且仍在名单里。把某人移出名单（或企微账号停用），他生成的令牌立即全部失效。
- 每次调用在服务端日志记一行 `[agent-api] token=<id> agent="<令牌名>" owner=<主人> GET <路径> <状态码> <耗时>`。
- `web/proxy.ts` 把 `/api/agent/`（带斜杠）列为免会话前缀，鉴权由每个路由自己做；令牌管理接口 `/api/agent-tokens` 仍走企微会话，写操作先过同源校验。

## 三、接口

基址：`https://hamark.boga.plus/api/agent/v1`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 自描述：端点、参数、当前令牌的名字与主人 |
| GET | `/videos` | 视频案例列表，带拆解进度摘要 |
| GET | `/videos/{id}` | 视频详情：元数据、视频与封面签名链接、版本列表、集成版状态 |
| GET | `/videos/{id}/analysis` | 视频拆解内容 |
| GET | `/reports` | 报告列表，带拆解进度摘要 |
| GET | `/reports/{id}` | 报告详情：元数据、逐页页图签名链接与文字摘录、相关资料、版本列表、集成版状态 |
| GET | `/reports/{id}/analysis` | 报告拆解内容 |

### 列表参数（`/videos`、`/reports`）

| 参数 | 说明 |
|---|---|
| `limit` | 默认 50，最大 200 |
| `offset` | 默认 0 |
| `q` | 模糊搜索：视频按标题/品牌/标签，报告按标题/任务类型/标签 |
| `hasAnalysis=true` | 只要已有拆解版本的 |
| `updatedSince` | ISO 8601；只要拆解内容（任一版本或集成版）在此之后有更新的，供增量同步 |

返回 `{ total, limit, offset, videos|reports: [...] }`，按上传时间倒序。每条带
`analysis: { versionCount, lastVersionUpdatedAt, finalStatus, finalDoneAt, finalUpdatedAt }`。
`finalStatus`：`DONE` = 已定稿，`OPEN` = 未定稿，`null` = 还没有任何版本。

### 拆解内容参数（`/videos/{id}/analysis`、`/reports/{id}/analysis`）

| 参数 | 说明 |
|---|---|
| `version` | `final`（默认，集成版）/ `latest`（最近保存的个人版本）/ 具体版本 id（取自详情接口的 `versions[].id`，只在本案例的版本里找） |
| `format` | `both`（默认）/ `raw` / `readable` |

返回：

```jsonc
{
  "case": { "id", "title", "brand" },          // 报告为 "report": { "id", "title", "taskType" }
  "version": {
    "kind": "FINAL" | "VERSION" | "VIRTUAL_V1",
    // FINAL：label=集成版、status(OPEN/DONE)、doneAt、doneByName、pendingCount（定稿后未纳入的修改数）、isVirtual
    // VERSION：number、ownerName、baseNumber、baseIsFinal、createdAt
    "updatedAt", "revision", "contentHash"
  },
  "payloadSchemaVersion": "AD_VIDEO_PAYLOAD_V1" | "report-annotation/1",
  "payload": { ... },   // 原始结构，字段见 lib/v04-contract.ts / lib/report-structure.ts，含稳定 id
  "readable": { ... }   // 中文可读视图，见下
}
```

`contentHash` 可用来判断内容自上次拉取后是否变化。

### 中文可读视图（`readable`）

字段名与工作台上的中文标签一致，选项 id 已换成词表中文标签，编号、页码范围按工作台同一套规则推导（`lib/agent-api/readable.ts`）。

- 视频：`第一模块｜全片事实与核心判断`（商业意图、故事梗概、创意母题、张力按钮、创意主导/辅助手法及机制｛机制、手法、进阶机制层｝、创意思维链、故事参照类型、创意承重载体、具体说明、创意成立契约）→ `第二模块｜脚本反写`（桥段序号、桥段名称、主/辅创意作用、关键创意描述、镜头[镜号 1-1、开始时间…音乐]）→ `第三模块｜主导感知类型发生路径与整体评价`（主导路径、主导路径细项、辅助路径、整体创意评价、评价理由）。
- 报告：`案例背景`、`报告策略`、`结构`（模块 → 讲述单元 → 下级单元，带编号 1 / 1-1 / 1-1-1、页码范围、直属页码）、`未归属页码`、`逐页`（所属、过渡页、页面作用、本页组织关系、组块[组块名称、内容类型、组块作用、文风类型、组织关系、叙述作用、关键标记、位置]）。

### 媒体链接

详情接口里的 `videoUrl`、`thumbnailUrl`、页图 `thumbUrl` / `imageUrl`、相关资料 `url` 都是私有 COS 的签名链接，**1 小时有效**，过期后重新调详情接口即可。渲染失败的页不签链接（`renderStatus != OK`）。

## 四、错误

统一 `{ "error": "中文说明", "code": "..." }`，并带 `Cache-Control: no-store`。

| 状态 | code | 含义 |
|---|---|---|
| 400 | `INVALID_PARAM` | 参数格式不对 |
| 401 | `AUTH_REQUIRED` / `INVALID_TOKEN` | 没带令牌 / 令牌无效、已停用，或主人已不在名单内（带 `WWW-Authenticate: Bearer`） |
| 503 | `AGENT_API_NOT_READY` | 生产库还没执行令牌表迁移 |
| 404 | `CASE_NOT_FOUND` / `REPORT_NOT_FOUND` | 不存在、已删除、未就绪或不在可见范围 |
| 404 | `VERSION_NOT_FOUND` | 版本 id 不属于该案例 |
| 404 | `NO_ANALYSIS` | 还没有拆解内容 |
| 404 | `REPORT_FEATURE_DISABLED` | 报告库总开关关闭 |
| 405 | — | 非 GET 请求 |
| 500 | `INTERNAL_ERROR` | 服务端异常（详情只进服务器日志） |

## 五、调用示例

```bash
curl -H "Authorization: Bearer $HAMARK_AGENT_TOKEN" \
  "https://hamark.boga.plus/api/agent/v1/videos?hasAnalysis=true&limit=20"

curl -H "Authorization: Bearer $HAMARK_AGENT_TOKEN" \
  "https://hamark.boga.plus/api/agent/v1/videos/<id>/analysis?format=readable"
```

## 六、本期不做

- 限流：目前靠名单只有两人、每人最多 10 枚、每枚可单独停用；需要时再加。
- 名单管理界面：名单写在代码常量里，改名单走一次代码提交。
- 溯源（集成版每处的来源与被覆盖的旧写法）、评论、评分：不对外。
- 写入：不提供任何写接口。
