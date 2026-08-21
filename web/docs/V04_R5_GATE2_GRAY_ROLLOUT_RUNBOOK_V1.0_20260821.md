# V0.4 R5 门二｜小范围灰度开启、监控与回滚手册 V1.0

日期：2026-08-21（Asia/Shanghai）

当前基线：三份冻结合同已原子激活为 `ACTIVE`；生产灰度和所有 V0.4 正式入口仍关闭。

本手册是执行准备，不包含有效生产 user/video allowlist，也不等于灰度已经开放。任何占位或测试 ID 均不得提交到 `web/vercel.json`。

## 一、灰度保护合同

服务器端统一守卫为 `web/lib/v04-gray-access.ts`。所有正式 V0.4 API、既有详情投影、既有首页投影和显式 `taxonomy=V0.4` 工作页均复用该守卫。

必须同时满足：

1. `V04_GRAY_ROLLOUT_ENABLED=true`；
2. 服务端对当前 `users.id` 计算规范化 SHA-256 摘要，并以恒定时间比较精确命中 `V04_GRAY_USER_ID_SHA256S`；当前用户仍须为 `ACTIVE`；
3. taxonomy、vocabulary、workflow 三份冻结合同均精确 `ACTIVE`；
4. 目标 `videos.id` 精确出现在下列一类 allowlist：
   - `V04_GRAY_TEST_VIDEO_IDS`：数据库 `data_scope` 还必须为 `TEST_ONLY`；
   - `V04_GRAY_CONTROLLED_VIDEO_IDS`：仅用于已经单独归档批准的受控 BUSINESS 对象；配置本身不能代替批准证据；
5. 视频必须真实存在、`READY`、`object_key` 非空、`file_size>0`、未进回收站且资产未清理；
6. API/UI/detail/library 对应开关按本手册第五节同时开启。

空 allowlist、重复 ID、通配符、显示姓名、标签、未知/停用用户、未知/无媒体/未批准视频、合同非 ACTIVE 和任一开关关闭都 fail-closed。列表上限32项；本轮实际范围只能是已归档的两名稳定身份和一个受控视频。

## 二、执行前资源证据

以下四项必须有非敏感稳定引用，缺一即停止：

- 当前稳定管理员由本人登录会话生成的身份 SHA-256 摘要；
- 第二稳定身份由本人登录会话生成的身份 SHA-256 摘要；
- 受控视频 `videos.id`；
- 视频审批来源、`data_scope`、READY/媒体存在性的脱敏只读证据。

禁止使用显示姓名、Mock/fixture ID、同一用户双tab、普通41案例、历史演示案例或本机TEST_ONLY对象代替。工程仓库截至本手册创建时没有第二稳定身份引用；受控媒体只能通过下一节的专用生产 TEST_ONLY 工具，在当次浏览器安全确认后创建，不能借用普通业务视频。

身份摘要证明页为 `/v04-gray-identity`，由独立 `V04_GRAY_IDENTITY_DIGEST_ENABLED` 默认关闭开关保护。每个同事必须用本人企微登录会话打开；页面只返回其本人摘要、短摘要和ACTIVE判断，不渲染原始`users.id`、显示姓名、邮箱或identity key。摘要可登记到服务器配置，但原始稳定ID不得写入Git、`vercel.json`、DOM、URL、日志、截图、测试快照、证据或文档。不得根据显示姓名、首次登录时间或邮箱推断第二身份。

### 2.1 专用生产 TEST_ONLY 媒体对象

工具入口：`/admin/v04-gray-test-object`。独立开关 `V04_GRAY_TEST_OBJECT_ENABLED` 默认关闭，且不得与灰度开关、schema PREVIEW/APPLY、合同生命周期开关同时常驻开启。

固定计划（版本化代码，不接收管理员选择文件）：

- `video.id`：`video_v04_gray_test_f79086fba2876352`；
- `data_scope`：`TEST_ONLY`；
- `test_run_id`：`V04_GRAY_PRODUCTION_GATE2_V1`；
- 本机 `/opt/homebrew/bin/ffmpeg` 生成的 1 秒、160×90、无音频纯色 MP4；
- 文件大小 `1685` 字节，SHA-256 `f79086fba2876352cc38b4566da616b1e96518cddcbd6cfbb7b5dee295fd9181`；
- 对象键固定在独立 `test-only/v04-gray/` 前缀，页面只显示不可逆摘要。

PREVIEW 是 same-origin、稳定 SYSTEM_ADMIN 的 POST，但只读数据库和对象 HEAD/固定小文件哈希，前后数据库指纹必须一致；浏览器公开合同、token 可逆载荷和结果只绑定不可逆 actor digest，不含原始稳定用户ID。完整30分钟 token 只在页面内存与同源请求中使用，不进入 DOM、URL、storage、console 或账本。

合法状态只允许两种：`CLEAN_CREATE = videos目标ABSENT + 对象ABSENT + APPLIED账本0`；`EXACT_APPLIED = videos目标EXACT + 对象大小/内容类型/固定SHA/元数据/creation marker/ETag全部EXACT + 唯一APPLIED账本与同一run/目标/hash/actor digest绑定`。其他任意组合均为 `INCONSISTENT`，PREVIEW `ready=false`，APPLY 在 advisory lock 和数据库事务内、任何目标写入前再次拒绝。

APPLY 需要精确确认语句、批准引用和幂等键；对象上传使用条件创建，禁止覆盖既有键。失败通过 savepoint 回滚数据库；只有当前请求确实新建、且补偿时 creation marker、ETag、大小、类型与固定SHA仍同时匹配的对象才可删除。预存、漂移或所有权不明的对象绝不删除；成功对象不立即清理。

生产执行必须另有当次浏览器安全确认。工程开发、部署和页面 PREVIEW 不能代替该确认；未经确认不得点击创建。创建成功后仍须等待第二稳定身份引用齐备，灰度总开关继续关闭。

灰度结束如需清理，复用现有 V0.4 视频生命周期：仅软删除进入90天回收站，`assetAction=NONE`，不立即物理删除COS、不删除workspace/submission/历史/账本，也不触碰P10三项孤儿记录。

## 三、TEST_ONLY 证据门

使用既有 `verify:v04-workflow` 的隔离 schema 与 guarded cleanup；只允许 loopback、数据库名含 `test`、独立 `V04_TEST_RUN_ID`。验证：

- 两个 ACTIVE stable user 均在 allowlist，同一 `TEST_ONLY` READY视频可进入；未知/停用用户、未知/无媒体/非TEST_ONLY视频拒绝；
- 固定测试媒体 PREVIEW 零写；状态笛卡尔矩阵只有 `CLEAN_CREATE`、`EXACT_APPLIED` 合法；对象先存在、仅数据库存在、仅账本存在、多账本、对象/数据库漂移全部fail-closed；预存对象永不删除；上传失败仅补偿当前请求拥有的对象；成功后 `READY`/`TEST_ONLY`/稳定上传者/独立对象键全部精确；重复与并发请求只产生一个视频；BUSINESS 片库数量和指纹不变；
- 两身份/同用户双tab租约、30秒heartbeat/120秒TTL、旁观、释放/过期/接管；
- 手动/自动保存、冲突/rebase、首次/二次提交、不可变快照、失败回滚、幂等和NO_CHANGES；
- 历史、专家优选/撤回、非破坏恢复、批注与软删除恢复；
- `subtitleEffect`等12字段、固定＋custom、五态和读模型；
- V0.2/V0.3、public catalog/业务指纹和非本run数据不变；
- 浏览器桌面与390px、视频单实例、V1.9及P1定位规则回归。

## 四、最小开启提交草案（不得填占位ID）

只有第二节证据齐备并经产品任务登记后，才允许以一笔独立提交在 `web/vercel.json` 写入：

```json
{
  "env": {
    "V04_GRAY_ROLLOUT_ENABLED": "true",
    "V04_GRAY_USER_ID_SHA256S": "<approved-user-sha256-1>,<approved-user-sha256-2>",
    "V04_GRAY_TEST_VIDEO_IDS": "<approved-test-video-id>",
    "V04_GRAY_CONTROLLED_VIDEO_IDS": "",
    "V04_WORKFLOW_API_ENABLED": "true",
    "V04_WORKFLOW_UI_ENABLED": "true",
    "V04_DETAIL_UI_ENABLED": "true",
    "V04_LIBRARY_UI_ENABLED": "true"
  }
}
```

若批准对象为 BUSINESS 受控案例，必须把其 ID 放入 `V04_GRAY_CONTROLLED_VIDEO_IDS`，`V04_GRAY_TEST_VIDEO_IDS` 留空，并在证据文档引用对应批准记录。不得同时打开 `V04_UI_SHADOW_ENABLED`、schema PREVIEW/APPLY/bootstrap、CONTRACT_ACTIVATE或默认入口切换。

正式工作入口仍须显式 `?taxonomy=V0.4`；无授权用户/视频保持 V0.3默认或404。首页仍从 `/api/videos` 取得唯一片库，V0.4 cards仅返回 allowlist视频投影。

## 五、部署与验收

1. `git fetch`并确认基线未前进；全量测试、lint、Webpack/Turbopack build、TEST_ONLY PG和`git diff --check`通过；
2. 仅提交上述开关和对应安全断言；推送后查询 GitHub Vercel commit status，必须为目标 SHA `success`；
3. 使用已登录会话访问 `/api/version`，核对 `HEAD=origin/main=Vercel=/api/version`；不复制cookie/凭据；
4. 两个稳定身份分别在桌面和390px访问同一受控视频：管理员编辑、另一身份旁观/按租约接管；普通身份与其他视频不得获得V0.4入口或正文；
5. 执行保存、提交V1/V2、历史、专家、恢复、批注和视频单实例路径；只写受控对象；
6. 回归首页41案例、搜索、上传、详情、stream、V0.2/V0.3；检查console和服务错误率；
7. 记录灰度前后三类业务指纹、P10只读事实、V0.4事实只落在受控video ID。

## 六、监控与停止条件

观察登录、首页、详情、V0.3、V0.4 API/UI、lease、save、submit、comments、stream的状态码、错误码与延迟。出现以下任一项立即执行第七节关闭：

- 非allowlist用户或视频获得V0.4内容/写权限；
- V0.3默认入口、41案例、上传、详情、stream回退；
- 合同不再精确ACTIVE、catalog/RLS/词表变化；
- allowlist对象之外产生V0.4 workspace/submission/lease/comment；
- 不可变快照被改写、租约失效、重复提交编号或业务指纹越界；
- 浏览器P0/P1、服务错误率或延迟异常。

## 七、最小关闭与回滚

回滚只以独立提交删除 `V04_GRAY_*`、`V04_WORKFLOW_API_ENABLED`、`V04_WORKFLOW_UI_ENABLED`、`V04_DETAIL_UI_ENABLED`、`V04_LIBRARY_UI_ENABLED`。身份摘要证明开关也必须恢复关闭。验证并部署后：

- V0.4 API/UI/detail/library立即fail-closed，默认V0.3恢复；
- 不删除 additive schema、ACTIVE合同、schema ledger、V0.4草稿、submission、lease历史、comment、expert release或V0.2/V0.3；
- 不执行SQL清理、schema回滚或合同RETIRE；合同级停用仅能走独立受控生命周期操作；
- 重新运行首页/详情/V0.3/上传/stream回归和GitHub/Vercel/`/api/version` SHA核验。

准确停止状态为：**灰度保护代码已部署但默认关闭；待明确稳定身份与受控媒体对象引用后执行小灰度。**
