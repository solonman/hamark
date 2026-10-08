// 外部 Agent 接入说明（Markdown）：令牌页上展示和「复制」的，与接口入口
// GET /api/agent/v1 返回的 guideMarkdown，都出自这里，只维护这一份。
// 纯函数、浏览器可用。内容必须与实现一致——参数、字段、错误码改了这里要跟着改
// （tests/agent-api.test.ts 会核对关键参数与错误码都写到了）。

import {
  AGENT_LIST_DEFAULT_LIMIT,
  AGENT_LIST_MAX_LIMIT,
  AGENT_MEDIA_URL_TTL_SECONDS,
} from "./params";

export const AGENT_API_PATH = "/api/agent/v1";

export function buildAgentGuideMarkdown(origin: string, token = "<令牌>"): string {
  const base = `${origin}${AGENT_API_PATH}`;
  const ttlMinutes = Math.round(AGENT_MEDIA_URL_TTL_SECONDS / 60);
  return `# hamark 案例库只读接口 · 接入说明

你可以通过下面的 HTTP 接口读取 hamark（RE:VERSE 反写）案例库里的**视频广告逆向拆解作业**和**营销报告逆向拆解作业**。接口只读，不能写入或修改任何数据。

## 1. 鉴权

- 基址：\`${base}\`
- 每个请求都带请求头：\`Authorization: Bearer ${token}\`
- 只接受 GET；其他方法返回 405。
- 令牌失效（被停用或主人权限变更）时返回 401，请停止调用并联系令牌提供者。

\`\`\`bash
curl -H "Authorization: Bearer ${token}" "${base}"
\`\`\`

## 2. 推荐调用顺序

1. \`GET ${AGENT_API_PATH}\`：自查。返回全部端点、参数，以及这枚令牌的名字和主人。
2. \`GET ${AGENT_API_PATH}/videos?hasAnalysis=true\` 或 \`/reports?hasAnalysis=true\`：找到已有拆解内容的案例。
3. \`GET ${AGENT_API_PATH}/videos/{id}\` 或 \`/reports/{id}\`：看元数据、媒体链接、版本列表、集成版状态。
4. \`GET ${AGENT_API_PATH}/videos/{id}/analysis?format=readable\` 或 \`/reports/{id}/analysis?format=readable\`：读取拆解内容。只做理解和总结时用 \`readable\` 最省篇幅。

## 3. 端点

| 端点 | 说明 |
|---|---|
| \`GET /videos\` | 视频案例列表 |
| \`GET /videos/{id}\` | 视频详情：元数据、视频与封面链接、版本列表、集成版状态 |
| \`GET /videos/{id}/analysis\` | 视频拆解内容：逐镜脚本、全片判断、感知路径、整体评价 |
| \`GET /reports\` | 报告案例列表 |
| \`GET /reports/{id}\` | 报告详情：元数据、逐页页图链接与文字摘录、相关资料、版本列表、集成版状态 |
| \`GET /reports/{id}/analysis\` | 报告拆解内容：背景、策略、模块／单元结构、逐页组块 |

## 4. 列表参数（/videos、/reports）

| 参数 | 说明 |
|---|---|
| \`limit\` | 每页条数，默认 ${AGENT_LIST_DEFAULT_LIMIT}，最大 ${AGENT_LIST_MAX_LIMIT} |
| \`offset\` | 跳过条数，默认 0。返回里的 \`total\` 是符合条件的总数，用它判断是否还有下一页 |
| \`q\` | 模糊搜索：视频按标题／品牌／标签，报告按标题／任务类型／标签 |
| \`hasAnalysis\` | \`true\` 时只返回已有拆解版本的案例 |
| \`updatedSince\` | ISO 8601 时间，例如 \`2026-09-01T00:00:00Z\`。只返回拆解内容在此之后有更新的案例，用于增量同步 |

列表按上传时间倒序。每条带 \`analysis\` 摘要：

- \`versionCount\`：已有几个个人版本（0 表示还没人拆）
- \`finalStatus\`：集成版状态。\`DONE\` = 已定稿，\`OPEN\` = 未定稿（内容仍可能变化），\`null\` = 还没有任何版本
- \`lastVersionUpdatedAt\` / \`finalUpdatedAt\` / \`finalDoneAt\`：最近更新时间与定稿时间（ISO 8601，UTC）

## 5. 拆解内容参数（/videos/{id}/analysis、/reports/{id}/analysis）

| 参数 | 说明 |
|---|---|
| \`version\` | \`final\`（默认）= 集成版，即多人版本逐处汇总后的最新稿；\`latest\` = 最近保存的那个个人版本；也可以传详情接口 \`versions[].id\` 里的具体版本 id |
| \`format\` | \`both\`（默认）= 同时返回 \`payload\` 和 \`readable\`；\`raw\` = 只要 \`payload\`；\`readable\` = 只要 \`readable\` |

返回结构：

\`\`\`jsonc
{
  "case": { "id": "…", "title": "…", "brand": "…" },   // 报告为 "report": { "id", "title", "taskType" }
  "version": {
    "kind": "FINAL",            // FINAL = 集成版；VERSION = 个人版本；VIRTUAL_V1 = 旧工作稿生成的初始版
    "status": "DONE",           // 仅集成版：DONE 已定稿 / OPEN 未定稿
    "number": 2, "ownerName": "…",   // 仅个人版本
    "updatedAt": "2026-09-30T04:10:54.000Z",
    "contentHash": "…"          // 内容指纹：与上次相同就说明内容没变，不必重新处理
  },
  "payloadSchemaVersion": "AD_VIDEO_PAYLOAD_V1",   // 报告为 "report-annotation/1"
  "payload": { },    // 原始结构，含稳定 id，适合程序处理
  "readable": { }    // 中文可读视图，字段名与站内工作台一致，选项已翻成中文
}
\`\`\`

### 视频 readable 的结构

- \`第一模块｜全片事实与核心判断\`：商业意图、故事梗概、创意母题、张力按钮、创意主导手法及机制、创意辅助手法及机制（各含 机制／手法／进阶机制层）、创意思维链、故事参照类型、创意承重载体、创意承重载体具体说明、创意成立契约
  - \`创意思维链\` 是一段 Markdown 嵌套列表文字：顶格的每一行是一条思维链的中心（一份分析可以有几条）；中心下第一层（\`- \` 开头、缩进两格）是按先后排列的推导步骤；再往下每深一级多两格缩进，是上一级节点的并列分叉。早期案例可能是没有缩进的「1）2）3）…」逐行写法，按一条思维链、每行一步理解
- \`第二模块｜脚本反写\`：桥段数组。每个桥段含 桥段序号、桥段名称、桥段主创意作用、桥段辅助创意作用、本桥段关键创意描述、镜头数组。每个镜头含 镜号（如 1-2）、开始时间、结束时间、景别、机位／角度、镜头运动、画面内容（镜头故事）、字幕／屏幕文案、字幕特效、对白、旁白、声效、音乐
- \`第三模块｜主导感知类型发生路径与整体评价\`：主导路径（有爱／情感、有趣／预期、有料／感知）、主导路径细项、辅助路径、整体创意评价（S/A/B/C）、评价理由

### 报告 readable 的结构

- \`案例背景\`：城市、开发商、项目背景、业务背景
- \`报告策略\`：竞争与提报策略、报告模型
- \`结构\`：模块数组。每个模块含 编号、模块名称、模块间组织关系、策略作用、页码范围、讲述单元。讲述单元可以通过 \`下级单元\` 继续嵌套，编号形如 1 / 1-1 / 1-1-1
- \`未归属页码\`：还没划入任何模块的页
- \`逐页\`：每页含 页码、所属、过渡页、页面作用、本页组织关系、组块数组。每个组块含 组块名称、内容类型、组块作用、文风类型、组块间组织关系、叙述作用、关键标记、位置（页图百分比）

## 6. 媒体链接

详情接口里的 \`videoUrl\`、\`thumbnailUrl\`、页图 \`thumbUrl\`／\`imageUrl\`、相关资料 \`url\` 都是临时签名链接，**${ttlMinutes} 分钟内有效**，不要长期保存；过期后重新调用详情接口获取。报告页图渲染失败的页（\`renderStatus\` 不是 \`OK\`）没有链接，可以改用 \`textExcerpt\` 文字摘录。

## 7. 错误

错误统一返回 \`{ "error": "中文说明", "code": "…" }\`。

| 状态 | code | 含义与处理 |
|---|---|---|
| 400 | \`INVALID_PARAM\` | 参数格式不对，按 error 提示修正 |
| 401 | \`AUTH_REQUIRED\` / \`INVALID_TOKEN\` | 没带令牌，或令牌无效／已停用。不要重试，联系令牌提供者 |
| 404 | \`CASE_NOT_FOUND\` / \`REPORT_NOT_FOUND\` | 案例不存在、已删除或未就绪 |
| 404 | \`VERSION_NOT_FOUND\` | 版本 id 不属于这个案例 |
| 404 | \`NO_ANALYSIS\` | 这个案例还没有拆解内容 |
| 404 | \`REPORT_FEATURE_DISABLED\` | 报告库暂未开放 |
| 405 | — | 只支持 GET |
| 500 / 503 | \`INTERNAL_ERROR\` / \`AGENT_API_NOT_READY\` | 服务端暂时不可用，稍后重试 |

## 8. 使用建议

- 增量同步：记下上次同步时间，下次用 \`updatedSince\` 只拉有变化的案例，再用 \`contentHash\` 判断内容是否真的变了。
- 引用观点时说明来源：案例标题，以及是集成版（是否已定稿）还是某个人的第几版。
- 集成版 \`OPEN\` 表示还在汇总中，结论可能变化；\`DONE\` 是审定后的定稿，优先采信。
- 案例数据仅供公司内部学习使用，不要对外公开或转发原始视频和报告。
`;
}
