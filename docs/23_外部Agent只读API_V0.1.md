# 外部 Agent 只读 API｜V0.1

日期：2026-09-30
范围：给站外 Agent（研究助手、文案助手等）读取案例库里的视频逆向拆解作业与报告逆向拆解作业。
代码：`web/app/api/agent/v1/**`、`web/lib/agent-api/*`、测试 `web/tests/agent-api.test.ts`。

## 一、原则

1. **只读**：路由只导出 `GET`，其他方法由框架直接回 405；服务层只有 `SELECT`，另外只复用两个本来就不写库的读路径 `loadFinalVersion` / `loadReportFinalVersion`（没有集成版行时在内存里算虚拟版，不落库）。站内报告库的 `listReports` / `loadReportDetail` 会顺手向数据万象轮询并写库，这里刻意不用。
2. **默认关闭**：没有配置 `AGENT_API_KEYS` 时整组接口回 404。
3. **与站内同口径的可见范围**：
   - 视频：`deleted_at IS NULL`、`data_scope = BUSINESS`、`deletion_state = ACTIVE`（空值按 ACTIVE）、`status = READY`。TEST_ONLY 灰度数据、回收站、已清理资产一律不可见。
   - 报告：`deleted_at IS NULL`、`status = READY`；相关资料排除已软删除的。报告库总开关 `REPORT_LIBRARY_UI_ENABLED` 关着时，报告接口回 404。
4. **内容来源**：只读 V1.9 版本链（`analysis_versions` / `report_versions`）与集成版（`analysis_final_versions` / `report_final_versions`）。V0.2/V0.3 的旧快照不对外。一条视频还没人在 V1.9 工作台保存过时，接口给出工作台此时展示的同一份虚拟 v1（由旧工作稿生成），没有内容就回 `NO_ANALYSIS`。
5. **不暴露**：上传者邮箱、用户 id、评论、评分、收藏、审计记录。版本只带作者显示名。

## 二、鉴权

请求头 `Authorization: Bearer <token>`。

- 令牌由 `npm run agent:key -- <agent名称>`（在 `web/` 下）生成，格式 `hmk_agent_<43位base64url>`。明文只打印一次，交给 Agent 使用方保存。
- 服务器只保存 SHA-256：Vercel Production 环境变量 `AGENT_API_KEYS="名称:哈希,名称:哈希"`。改完要重新部署才生效。
- 停用某个 Agent：从 `AGENT_API_KEYS` 删掉它那一条，再重新部署。
- 每次调用在服务端日志里记一行 `[agent-api] agent=<名称> GET <路径> <状态码> <耗时>`，可在 Vercel 日志按 agent 名称检索。
- `web/proxy.ts` 把 `/api/agent/` 列为免会话前缀（外部 Agent 没有登录 Cookie），鉴权由每个路由自己做。

## 三、接口

基址：`https://hamark.boga.plus/api/agent/v1`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 自描述：端点、参数、当前令牌对应的 agent 名称 |
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
| 401 | `AUTH_REQUIRED` / `INVALID_TOKEN` | 没带令牌 / 令牌无效或已停用（带 `WWW-Authenticate: Bearer`） |
| 404 | `AGENT_API_DISABLED` | 服务器没配置任何令牌 |
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

- 限流：目前靠令牌数量少、每个令牌可单独停用；需要时再加。
- 溯源（集成版每处的来源与被覆盖的旧写法）、评论、评分：不对外。
- 写入：不提供任何写接口。
