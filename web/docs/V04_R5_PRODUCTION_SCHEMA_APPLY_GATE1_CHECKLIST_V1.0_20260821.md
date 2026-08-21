# V0.4 R5｜生产 schema APPLY 门一执行清单 V1.0

状态：**预备完成；唯一阻塞为 Supabase provider restore point 尚未验证；严禁生产 APPLY**

形成时间：2026-08-21（Asia/Shanghai）

关闭基线：`5adcb14347f80bd52062be032a93509422d5b1ca`

GitHub：`origin/main=5adcb14347f80bd52062be032a93509422d5b1ca`

本清单只用于门一客观条件对账和后续受控执行。它不是生产 schema APPLY 批准记录，也不是备份／恢复证据。TEST_ONLY 数据库、应用 hash、`pg_dump` 或本地容器都不得冒充 Supabase provider restore point。

## 1. 门一条件对账

| 条件 | 状态 | 证据／停止点 |
|---|---|---|
| 门 P 独立复验 | 已满足 | 产品／方法任务结论 `P-A`；生产 PREVIEW 已关闭。 |
| GitHub、main 与关闭基线一致 | 已满足 | `HEAD=origin/main=5adcb14347f80bd52062be032a93509422d5b1ca`，工作树在本清单创建前干净。 |
| PREVIEW 目标代码 SHA 已锁定 | 已满足 | 门 P 目标 SHA：`f2d4f8f39d836d4a782c83d8ecb741e920f1fed4`。该旧 token 已过期且绝不复用；后续必须在同一 PREVIEW+APPLY 部署重新生成 token。 |
| schema bundle hash 已锁定 | 已满足 | `d068f0e422a26162ed90a28c3b36a905e0b80d0ddd2a0c08711af0d62603155c`。 |
| 生产 catalog hash 已锁定 | 已满足 | pre-1A 值为 `331f79c488e5d84d880de9cdad258af534beac661b3352350d5fb77b77408206`；安装后精确 catalog 以第9.2节门二 fresh PREVIEW 修正值为准。 |
| source hash 已锁定 | 已满足 | `f2e8865cad80facb737a2b83cd132b1fc123540c37e5dac60475b86f798582fe`。 |
| target hash 已锁定 | 已满足 | `d20fe2f7c62411ccee4897fc501fc0e7f5b5b9aae380006f2d30a710b8bf8d29`。 |
| non-target hash 已锁定 | 已满足 | `734b60057165b03129c405d309e8ac4cdb0f0bbdf4c2264f8a359b835f3f70e7`。 |
| 管理员稳定身份／pre-1A 唯一映射 | 已满足 | 门 P：当前 actor 为 ACTIVE stable user，唯一映射；歧义、缺失、停用均为 0。后续 APPLY 必须绑定同一 actor，安装后只用 stable SYSTEM_ADMIN membership 复核。 |
| pre-1A catalog 与业务事实 | 已满足 | `mode=PRE_1A_EXACT`、`ready=true`、`stopReasons=[]`；P01—P11 为真实只读事实；GET 前后 `UNCHANGED`。 |
| 合同与目标业务边界 | 已满足 | 当前合同 `MISSING`，安装后预期 `DRAFT`；V0.4 workspace／submission／lease／comment 等目标业务行均为 0；不激活、不回填。 |
| 工具门 T | 已满足 | 同源管理页、增强 PREVIEW、POST-only APPLY、token 摘要、账本、事务、advisory lock、savepoint、幂等、失败留账已通过 TEST_ONLY 复验。 |
| 真实 Supabase provider restore point | **待满足／唯一阻塞** | 当前浏览器打开 Supabase 后落在登录页，没有可复用已登录会话，无法只读确认 Backups/PITR。不得以 TEST_ONLY、应用 hash、`pg_dump` 或自行读取凭据替代。 |
| 恢复点范围、覆盖时间和可恢复性 | **待满足** | 必须由现有 Supabase 账号登录后，只读记录 opaque reference、备份类型、覆盖时间、`verifiedAt`、对应生产项目范围、可恢复性；不得点击 Restore、下载备份或开通付费 PITR。 |

只有最后两项满足，且其余事实在 fresh PREVIEW 中保持一致，统筹才可依据既有授权放行一次生产 schema APPLY。

## 2. Supabase provider 恢复点证据模板

以下字段必须来自 Supabase Dashboard 的只读 Backups／PITR 页面；不得填写数据库内容、URL、token、密码或可直接访问备份的凭据。

| 字段 | 允许记录内容 | 当前值 |
|---|---|---|
| provider | 固定提供方 | `Supabase` |
| project scope | 不敏感项目名称或 project ref 摘要；必须对应 `hamark.boga.plus` 的生产数据库 | 未验证 |
| backup type | Scheduled backup／PITR 等页面显示类型 | 未验证 |
| opaque backup reference | provider 页面显示的不可执行、不可换取凭据的备份／restore point 标识 | 未验证 |
| coverage time | 恢复点覆盖的 UTC／CST 时间 | 未验证 |
| verifiedAt | 实际只读核验时间，必须在 APPLY 请求前 24 小时内 | 未验证 |
| recoverability | 页面明确表明可恢复；不得实际点击 Restore | 未验证 |
| reviewer | 只记录稳定操作者角色，不记录账号或凭据 | 未验证 |

若现有计划没有备份／PITR、页面要求升级付费、项目范围不明、恢复点早于需要保护的生产状态，或无法证明可恢复，均保持阻塞并停止。

## 3. 后续短期 PREVIEW＋APPLY 最小 Git 差异

恢复点验证前不得创建、提交或推送本节开关改动。

允许的最小提交只包含：

1. `web/vercel.json`
   - 顶层仅增加：

     ```json
     "env": {
       "V04_MIGRATION_PREVIEW_ENABLED": "true",
       "V04_SCHEMA_APPLY_ENABLED": "true"
     }
     ```

   - `CONTRACT_ACTIVATE`、workflow UI/API、detail、library、shadow、default-entry 等开关必须继续缺失／关闭。
2. `web/tests/v04-migration-preview.test.ts`
   - 只允许同步断言 PREVIEW=true、APPLY=true；继续断言 ACTIVATE、UI/API、detail/library/shadow 均未开启，GET 不执行 APPLY。
3. `web/tests/v04-schema-apply.test.ts`
   - 只允许同步断言 PREVIEW=true、APPLY=true；继续断言 APPLY 只由显式 POST 触发，build/start/page-load/GET 不执行 schema 变更。

提交前必须重算这三份文件的 SHA-256。当前关闭态基线为：

- `web/vercel.json`: `c8c2445454c43532b6a6d7f6e33395eed810536c709395c07d9aaf3d144e97f8`
- `web/tests/v04-migration-preview.test.ts`: `caf4dd90bffb945f76ab8547cb7e290761030f6f01ffc08f3f406ba2eb921083`
- `web/tests/v04-schema-apply.test.ts`: `b59da2bd21956acb2b7bad5898635688d16383a925256d2bd39966639631e7aa`

开关提交部署后，必须在同一目标 SHA、同一 actor、同一30分钟窗口重新执行 PREVIEW；门 P 的旧 token 和 token 摘要均不得复用。

## 4. APPLY 请求输入口径

只在 provider 恢复点通过后生成实际值：

- `action`: 固定 `APPLY_SCHEMA`。
- `previewToken`: 仅来自本次同部署 fresh PREVIEW，完整值只留在同源页面运行时内存，不进入 DOM、URL、存储、日志或文档。
- `targetCodeSha`: 开启 PREVIEW＋APPLY 的同一 Vercel/GitHub SHA。
- `Idempotency-Key`／`idempotencyKey`: 两处完全相同；格式建议 `v04-schema-prod-20260821-<targetSha12>-<一次性随机摘要>`，长度16—128，仅用于本次操作，失败重试不得更换，新的事实窗口必须换新 key。
- `confirmation`: 固定 `我确认仅安装 V0.4 DRAFT schema，不回填业务数据`。
- `approvalReference`: `approval:AI视频创意逆向工程_V0.4_生产三门有条件提前授权记录_V1.0_20260820.md;gateP:P-A;gate1:<执行批次>`，不包含聊天内容或账号信息。
- `backupReference`: Supabase 提供的不敏感 opaque reference；不得填 URL、access token、连接串或备份内容。
- `backupVerifiedAt`: Supabase 页面实际核验的 ISO 时间，执行时必须在工具允许的24小时窗口内。

## 5. 执行与写后复核顺序

1. 确认 Supabase restore point 已验证，以上字段齐全且无费用／升级动作。
2. `git fetch`；确认 main、GitHub、Vercel、工作树和白名单无未审计变化。
3. 创建最小 PREVIEW＋APPLY 开关提交；运行定向测试、完整 `npm test`、lint、build、`verify:v04-schema-apply`、`git diff --check`。
4. 推送并等待 Vercel 部署同 SHA。确认只开 PREVIEW/APPLY，其他 V0.4 开关全关。
5. 在同源管理页生成新的 PREVIEW；确认同 actor、`PRE_1A_EXACT`、ready、无 stopReasons、bundle/catalog/P01—P11/三类指纹与批准事实一致。
6. 在同窗用完整 token 运行一次受控 POST APPLY。不得运行 `npm run db:migrate`，不得开 ACTIVATE/UI/API，不做业务回填或 P10 孤儿清理。
7. APPLY 返回后立即重新执行 PREVIEW：
   - `P07` 所有 missing/extra/changed/drift 均归零；
   - 15/15 RLS，5 index、19 trigger、0 显式 policy 与冻结 catalog 一致；
   - 24/15/21 共60条词表；taxonomy/vocabulary/workflow contract 全为 `DRAFT`，`activated_at=NULL`；
   - 只有本次 actor 的必要 ACTIVE SYSTEM_ADMIN membership；
   - V0.4 workspace/submission/lease/comment/expert 等业务行仍为0；
   - source/target/non-target 三类语义指纹与写前一致；V0.2/V0.3 历史、快照、stream、批准版、批注、修订、媒体均不变；
   - operation ledger 为唯一 APPLIED；相同 idempotency key 只返回同结果。
8. 回归首页41案例、详情、V0.3 practice；无论 APPLY 成功或失败，立即创建第二个独立提交关闭 PREVIEW 与 APPLY，测试、推送并等待 Vercel 同 SHA。
9. 关闭部署后确认四开关全关，管理页按钮禁用；仅归档脱敏 hash、opaque references、operation ID、request ID 和状态，不保存完整 token／凭据／业务正文。

## 6. 立即停止条件

- provider restore point 仍未验证，或需要登录凭据转移、付费升级、下载备份、点击 Restore；
- fresh PREVIEW 的 actor、目标 SHA、bundle、catalog、P01—P11、三类指纹、schemaState 或 stopReasons 与门 P 不一致；
- 当前状态不是精确 `PRE_1A_EXACT`，出现部分安装、未知对象、合同 ACTIVE 或 V0.4 业务行大于0；
- APPLY 需要放宽身份／RLS、猜测旧上传者、回填业务、清理 P10 孤儿、修改历史正文或执行破坏性操作；
- 不能在同一部署／同一actor／同一有效窗口生成并消费 fresh token；
- 无法确认 GitHub/Vercel 同 SHA，或关闭提交不能立即部署；
- 任何凭据、隐私、费用或不可恢复风险。

## 7. 本轮只读结论

2026-08-21 通过现有浏览器会话打开 `https://supabase.com/dashboard/projects`，页面重定向到 Supabase 登录页；没有可复用的已登录 provider 会话。本轮未输入账号、未查看 cookie／storage／token，未点击 Restore，未创建备份／PITR，未下载数据库，未产生费用。

因此当前唯一阻塞为：**provider restore point 不可验证，需要项目负责人在现有 Supabase 账号中登录，或提供不敏感的备份引用、类型、覆盖时间、项目范围和可恢复性证据。** 在该阻塞关闭前，生产 schema APPLY 不得执行，PREVIEW＋APPLY 开关提交也不得创建或推送。

## 8. 负责人外部迁移后的首次核验尝试

负责人于2026-08-21报告“已在 Supabase 登录并完成迁移”。工程按“外部已可能执行迁移”处理，没有调用受控 POST APPLY，也没有盲目重复执行迁移。

执行记录：

- 起始关闭基线：`5adcb14347f80bd52062be032a93509422d5b1ca`。
- 只读 PREVIEW 短期开启提交：`0a50ad2cc23178b43acf72d41a2bd05c07f9fd4b`；只开启 `V04_MIGRATION_PREVIEW_ENABLED=true`，APPLY／ACTIVATE／所有 V0.4 UI/API 开关保持关闭；Vercel 部署成功。
- 当前自动化浏览器没有可用的 hamark 登录会话；`/admin/v04-schema` 只显示稳定管理员保护页。尝试进入既有企微扫码登录时，浏览器安全策略阻止访问扫码域名，未建立 session。
- 当前自动化浏览器也没有可用的 Supabase 登录会话；Dashboard 仍落在登录页。因此无法只读取得外部迁移 reference／恢复点或确认负责人实际执行的迁移对象。
- 未运行生产 PREVIEW，未生成 fresh token，未调用 POST APPLY，未读取 Cookie／数据库凭据／业务正文。
- 为避免只读开关停留在线上，立即以提交 `682a05e29493c7f06ae216a3f15d30ad22193c0a` 关闭 PREVIEW；Vercel 已完成该 SHA 部署。
- 开启态与关闭态均通过定向11项、全量276项（270通过、6个显式opt-in跳过）、lint、Webpack build、Turbopack build 与 `git diff --check`。

当前客观结论：**外部迁移是否为完整 V0.4 1A schema 安装尚未被工程 PREVIEW 证明。生产开关已经恢复全关；不得据负责人“已完成迁移”的口头事实继续 CONTRACT_ACTIVATE 或灰度。** 下一次核验必须在可用的稳定 SYSTEM_ADMIN 同源会话中重新短期开启 PREVIEW；若为 `TARGET_APPLIED_EXACT` 才进入安装后验证，若仍为 `PRE_1A_EXACT` 或出现 partial drift／stopReasons，则继续停线。

## 9. SYSTEM_ADMIN 自锁恢复与外部安装后核验

执行时间：2026-08-21 09:26 CST。

本节以后续真实同源管理页验收结果更新第8节的“尚未证明”状态，保留原执行记录不覆盖。

### 9.1 一次性 SYSTEM_ADMIN 自锁恢复

- 默认关闭工程提交：`1fa9f87` (`fix: recover unique V0.4 system admin`)。
- 短期开启提交：`9f213dd`；Vercel 部署成功，且只有 `V04_SYSTEM_ADMIN_BOOTSTRAP_ENABLED=true`。
- 关闭提交：`da94d9c`；Vercel 部署成功。
- 身份前置条件：当前会话用户为 ACTIVE stable user；旧 `app_admins` 身份到 stable `users.id` 唯一；执行前 ACTIVE SYSTEM_ADMIN 为0；当前 actor 无旧 membership 行。
- 执行边界：同源 POST、显式确认句、一次性幂等键、事务、advisory lock、安装后 exact PREVIEW，任一条件失败则 membership 与账本整笔回滚。
- 结果：管理页自动从自锁恢复面板返回正常 stable SYSTEM_ADMIN 管理面；恢复入口消失；未使用姓名作为后续授权。
- 脱敏账本：`schema:SCHEMA_PREVIEW:PREVIEWED=1`，异常账本数为0。完整操作 token、Cookie、凭据、用户ID和数据库正文均未归档。

TEST_ONLY PostgreSQL 门禁：合法唯一 actor 成功；非ACTIVE、歧义映射、跨用户、已有SYSTEM_ADMIN、schema drift 均拒绝；并发两请求只有1笔成功；同幂等键返回原结果；schema drift 时整笔回滚；旧业务语义指纹前后不变。

### 9.2 安装后生产 PREVIEW

- PREVIEW-only 开启提交：`7b6089a3326ed3554b652c1f78f3c2db3aa78e80`；Vercel 部署成功。
- PREVIEW 关闭提交：`ee5ed695405266a8bec7d7fc15d4e080a8cfe9ec`；Vercel 部署成功。
- schema 结果：`ready=true`，`schemaState=TARGET_APPLIED_EXACT`，`stopReasons=[]`，合同仍为 `DRAFT`，GET/PREVIEW 前后 `UNCHANGED`。
- 目标 bundle hash：`d068f0e422a26162ed90a28c3b36a905e0b80d0ddd2a0c08711af0d62603155c`。
- 安装后 catalog hash：`b13f99779015239d09b8ceef8d7e081272e83d9ff163a590cbf0fd68ef043a64`。原归档串在公共前缀后转录错误；2026-08-21 门二 fresh PREVIEW 再次得到该值，且 P07 的 missing/extra/changed/drift/RLS-disabled 仍全部为0，三类业务指纹未变化。
- source hash：`f2e8865cad80facb737a2b83cd132b1fc123540c37e5dac60475b86f798582fe`。
- target hash：`d20fe2f7c62411ccee4897fc501fc0e7f5b5b9aae380006f2d30a710b8bf8d29`。
- non-target hash：`734b60057165b03129c405d309e8ac4cdb0f0bbdf4c2264f8a359b835f3f70e7`。
- 同一事实窗口两次 PREVIEW 的 token 不可逆摘要均为 `sha256:6112a710987aa7db…`，三类指纹及 bundle/catalog 不变。完整 token 只存在同源页面运行时内存，未进入 DOM、URL、storage、console、日志或本文档。

P01—P11 脱敏事实：

- P01：业务视频46；V0.2 annotations 31；V0.3 annotations 38；V0.4 annotations 0。
- P02：V0.3 streams 38；V0.4 workspace/canonical annotation/active round 均0；逻辑空视频41。
- P03：BASELINE 22、CANDIDATE 16、SUBMISSION 28、WORKING 4819；版本异常0。
- P04/P05：历史 current promotion 13；引用异常0。
- P06：旧 admin completed ledger 42；本次自锁恢复 schema preview ledger 1；ledger anomalies 0。
- P07：所有 expected 表/列/索引/触发器均存在；missing/extra/changed/drift/policy anomaly/RLS-disabled 均为0。全15张 V0.4 新增／统一表 RLS 开启。
- P08：legacy custom marker 2、pending mechanism 2、custom text 1、structured legacy raw 0；未改写。
- P09：legacy admin 到 stable user 的唯一映射3；AMBIGUOUS/MISSING/DISABLED 均0；当前 ACTIVE SYSTEM_ADMIN 1。
- P10：physical delete audit 0；database orphan 3，未清理、未改写；object-key anomaly 0；COS 状态不从数据库猜测。
- P11：V0.4 workspace、baseline、round、submission、revision、lease、expert release、cleanup job 均0；taxonomy/vocabulary/workflow 各有1个 DRAFT；词表24/15/21共60条；SYSTEM_ADMIN 1。

### 9.3 停止结论与线上回归

- 因生产已是 `TARGET_APPLIED_EXACT`，**本轮没有调用 schema APPLY**，不重复外部迁移。
- 最终 main/origin/Vercel 目标为 `ee5ed695405266a8bec7d7fc15d4e080a8cfe9ec`；PREVIEW、APPLY、CONTRACT_ACTIVATE、bootstrap、V0.4 UI/API/detail/library/default-entry 全部关闭。
- 线上只读回归：首页仍显示41个案例与当前用户“老孙”；《欢迎回家》详情、内部播放器（1个 video 实例）、上传对话框、V0.3-PILOT 公共工作区与它的播放器（1个 video 实例）均正常；未出现空JSON/错误页。
- 工程回归：TEST_ONLY PostgreSQL 自锁恢复矩阵通过；`npm test` 279项中272通过、7项显式opt-in跳过；lint、Webpack build、Turbopack build、`git diff --check` 通过。

本节的工程结论是：**外部安装已被独立生产只读 PREVIEW 证明为精确目标 schema；不需要、也不得重复 schema APPLY。当前已回到全开关关闭状态，等待门一最终独立验收与后续门二放行。**
