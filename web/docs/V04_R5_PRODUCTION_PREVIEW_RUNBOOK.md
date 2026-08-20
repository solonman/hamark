# V0.4 R5｜生产 PREVIEW 实施预备与停线清单

状态：R1—R4 产品复验 A；增强 PREVIEW／受控 APPLY 已完成 TEST_ONLY 工程，待门 T 复验后执行新的生产只读 PREVIEW。
形成日期：2026-08-20（Asia/Shanghai）
代码基线：`917f7cf14f37c8187cadceee309aa27c3d5d89fc`
GitHub／Vercel：目标 SHA 一致，Vercel 已报告 Deployment has completed。

本文不是生产 PREVIEW 已执行、schema 已 APPLY、合同已激活或灰度已开放的证明。本次预备没有连接生产数据库，没有开启任何 V0.4 开关，没有执行 PREVIEW／APPLY，也没有改动生产业务数据。

## 1. 结论先行

1. 项目负责人对三门的有条件提前授权已经归档并生效；三门仍须独立执行，不能合并。
2. 当前生产状态按已归档事实仍为 **pre-1A**；V0.4 合同未安装／未激活，正式入口仍为 V0.3。本文没有通过连接生产数据库重新验证该事实。
3. 现有 `/api/admin/v04-migration/preview` 已具备默认关闭、GET 零写、same-origin、稳定管理员 fail-closed、pre-1A 过渡鉴权、30 分钟 token、固定诊断阶段和 `no-store`。
4. 当前 PREVIEW 在 pre-1A catalog 上会提前返回 `ready=false` 和 P07 schema drift；P01—P11 其余事实为不可用占位，`sourceHash/targetHash/nonTargetHash` 也不是可用于 APPLY 的完整三类业务指纹。
5. 仓库目前**没有**生产 schema APPLY API／服务封装，也没有把 PREVIEW token、备份、事务、`schema_migration_operations`、写后校验和失败归档串成一个受控动作。`npm run db:migrate` 只是直接执行 bootstrap，不满足生产门一。
6. 因此 R3／R4 产品复验 A 后，可以按本文直接执行一次生产**只读 PREVIEW**；结果可确认 pre-1A 事实和 catalog 差异，但不能单独作为 schema APPLY 放行证据。完成 PREVIEW 后必须重新关闭开关，并停在“补齐受控 schema APPLY 工具及其测试”。

## 2. 冻结授权与当前门状态

权威授权：`交付包/AI视频创意逆向工程_V0.4_生产三门有条件提前授权记录_V1.0_20260820.md`。

| 门 | 已获授权 | 当前是否执行 | 本次可做动作 |
|---|---:|---:|---|
| 门一：生产 schema APPLY | 有条件提前授权 | 否 | 只执行生产 PREVIEW；当前不得 APPLY |
| 门二：`CONTRACT_ACTIVATE`／小范围灰度 | 有条件提前授权 | 否 | 不执行 |
| 门三：正式默认切换 | 有条件提前授权 | 否 | 不执行 |

提前授权仅在全部客观条件成立时免除临门重复确认；PREVIEW 不一致、破坏历史、权限放宽、扩面、不可回滚、隐私／凭据／费用风险等任一停止条件出现，授权不适用于本次执行。

## 3. R1—R4 代码与验收基线

| 批次 | 目标提交 | 当前事实 |
|---|---|---|
| R1 共享底座 | `8396c4768e9cad6cc1450baa76dfe3a3f5764d20` | 产品复验 A；包含首次安装前 trigger 定向纠错及真实 PG 证据 |
| R2 现有 practice 接入 | `46e27cd4cf7a59add962339638e00a7cf8eb07f2` | 与定向修正共同验收 |
| R2-ISSUE-001 | `eaf91437b33ce077dd99abea57d6899f725eabd2` | 定向产品复验 A |
| R3 现有详情增量 | `f672254cfa3348930dc5bcecba09819fbcbd6289` | 已实现、测试、部署；待产品真实路径复验 |
| R4 现有首页增量 | `917f7cf14f37c8187cadceee309aa27c3d5d89fc` | 已实现、测试、部署；待产品真实路径复验 |

R5 PREVIEW 的首个产品前置是 R3、R4 均取得 A。未满足时不打开生产 PREVIEW 开关。

## 4. 最新冻结 schema／migration／catalog 指纹

以下值由当前 `917f7cf` 工作树重新计算；它们是 PREVIEW 前的代码侧基线，不是生产 catalog 的实际值。

| 对象 | SHA-256／值 |
|---|---|
| `db/migrations/2026-08-19-v04-contract-foundation.sql` 原文件 | `21048e264b8f93fc1d67e1f7b59b4b26520b1c10ee343ebd4fe97e1cd1429fea` |
| `db/v04-schema.ts` 原文件 | `262aa2d19a43a2b039588724ae7df7d0b445c6cb6e142b4a74d02bbae3e17286` |
| `V04_SCHEMA_STATEMENTS` 104 条连接流 | `0c512d7caa93c2b347fb71f319636a32886377888bd556db5a534f0e52430fed` |
| 冻结 index／trigger／policy 规范对象 hash | `e905cac94972c9f100b25b883f9b178648fefb10b2d011ec8aa355dab98e60bd` |
| workflow contract hash | `437476f470b8cca0d6f21819ec0a16f72ed900192fb8748dd1d7873c91a79d45` |
| vocabulary combined hash | `8fe7c3b01517d8a0fca6c2dbd79d4b12e16eecbe53ea9f907d2562568373c8c6` |
| 24 项桥段作用 TSV | `ff2ab8d53f738c3fbcc48287e76541a86b143d7e477938ea665f93c80f922b24` |
| 15 项机制 TSV | `d3248ebb22178222a4d8943f826da3b86c7ac6c6184d385be88a07e575d7c1dd` |
| 21 项故事参照 TSV | `506c8c1c7e0088d2735d7ebc343c500f2eeddb0db09aa0a57bc6639426623c1b` |
| PREVIEW service 原文件 | `57947ff95668ea63eb32d3e81d56dbe5ef6efd2c120db4455a73ec7f01ac0c73` |
| PREVIEW route 原文件 | `46e3757e0cef633f0197a87e6ec5641fe6ba75a0ebb48d45a52140382c47b87a` |

冻结目标由 14 张 V0.4 新／统一表加既有 `admin_data_operations` 组成；预期 15／15 RLS，规范对象为 5 个非约束 index、19 个业务 trigger、0 个显式 policy（RLS 无 policy 即默认拒绝外部角色）。migration 和 TS 声明源的等价性由 `v04-schema.test.mjs` 防漂移。

## 5. PREVIEW／APPLY 工具现状

### 5.1 已具备：生产只读 PREVIEW

- 路由：`GET /api/admin/v04-migration/preview`；不存在 POST。
- 开关：`V04_MIGRATION_PREVIEW_ENABLED`，当前未写入 `vercel.json`，生产默认关闭。
- 请求边界：feature guard 先于身份／数据库读取；same-origin；当前 session 必须是 ACTIVE 稳定 user。
- pre-1A 鉴权：仅当 `app_role_memberships` 表不存在时，允许当前稳定 actor ID、ACTIVE user、`app_admins` 姓名和同名 ACTIVE user 唯一性四项全部相符的只读过渡鉴权。
- schema 安装后鉴权：只接受 ACTIVE `SYSTEM_ADMIN` membership，不再回退姓名。
- 输出：P01—P11、schema fingerprint、三类 hash、异常、30 分钟 token；不输出正文、姓名、邮箱、cookie、session、SQL 或错误栈。
- 失败诊断只暴露固定阶段：`ADMIN_CAPABILITY`、`ADMIN_LEGACY_MAPPING`、`CATALOG_TABLES`、`CATALOG_COLUMNS`、`CATALOG_INDEXES`、`CATALOG_TRIGGERS`、`CATALOG_POLICIES`、`SCHEMA_DRIFT`。
- 已验证：GET 零写、重复／并行 token 稳定、过期／事实变化拒绝、catalog drift 不自动修复。

### 5.2 尚不具备：生产受控 schema APPLY

- 没有 `/api/admin/v04-migration/apply` 或等价服务。
- 没有把 `SCHEMA_APPLY` operation、PREVIEW token、actor、idempotency key、目标／非目标 hash、备份、事务、写后复核串为一次受控动作。
- `scripts/migrate-db.ts` 仅调用 `applySchema()`；它会直接执行 bootstrap，不能用作生产门一入口。
- `schema_migration_operations` 的 DDL／状态机已经冻结，但在 pre-1A 生产中该表尚不存在；失败事务如何可靠留下 FAILED 账本证据仍须由受控 APPLY wrapper 明确处理。
- 没有独立 `CONTRACT_ACTIVATE` 路由；本次也不需要它。

## 6. 生产只读 PREVIEW 可执行步骤

以下步骤只在 R3、R4 产品复验均为 A 后执行。

### A. 执行前冻结

1. 记录 `origin/main`、GitHub、Vercel SHA，三者必须相同且包含 R1—R4；预计基线为 `917f7cf...`，若远端前进则重新核对差异。
2. 确认 `web/vercel.json` 中所有 V0.4 开关仍缺省：workflow API/UI、detail、library、shadow、migration preview 均未开启。
3. 复跑 contract／schema／preview 静态测试、完整 `npm test`、lint、build、`git diff --check`。
4. 记录上述 migration、schema、statement stream、catalog object、contract、vocabulary hash；任一变化均停止。
5. 确认将使用现有已登录、ACTIVE、稳定 `SYSTEM_ADMIN` 对应身份；不得复制 cookie、token 或数据库凭据到命令行／文档。

### B. 版本化短期开启 PREVIEW

1. 建立单一、可精确撤销的门 B 开启提交。
2. 仅在 `web/vercel.json` 顶层增加：

   ```json
   { "env": { "V04_MIGRATION_PREVIEW_ENABLED": "true" } }
   ```

   保留现有 framework、install、build、region 配置；不得加入任何凭据或其他 V0.4 开关。
3. 同步调整唯一相关配置断言，使测试明确“只开启 PREVIEW，不开启 APPLY／ACTIVATE／workflow UI／workflow API／detail／library／shadow”。
4. 运行受影响测试、lint、build、diff-check；独立提交，fetch 后安全推 main。
5. 等待 Vercel `Deployment has completed`，核对部署 SHA 与 GitHub SHA 完全相同。

### C. 使用真实站点已登录会话执行 GET

1. 从 `https://hamark.boga.plus` 同源页面，以当前已登录稳定管理员会话访问相对地址：

   ```text
   /api/admin/v04-migration/preview
   ```

2. 不携带生产数据库 URL，不复制 cookie，不使用跨源 curl，不提交任何表单。
3. 保存脱敏证据：HTTP 状态、requestId、preview schema version、generatedAt／expiresAt、environment key、actor stable ID、ready、schema fingerprint、P01—P11 计数／稳定 ID／hash、异常类型。短期 token 只在受控执行上下文使用，归档时遮蔽主体。
4. 在同一 30 分钟窗口立即用返回 token 再次 GET：

   ```text
   /api/admin/v04-migration/preview?previewToken=<本次短期 token>
   ```

   第二次须返回同一 token／fingerprint／事实；跨窗口或事实变化必须 `STALE_PREVIEW`。
5. 当前预期是结构化 `preview` 且 `ready=false`，P07 明确反映 pre-1A 缺失；这不是失败，也不是 APPLY 放行。

### D. 结果判读

仅当以下全部成立，才把结果归档为“生产 pre-1A 只读 PREVIEW 技术完成”：

- 无 `INTERNAL_ERROR`，无固定 stage 诊断；
- 当前 actor 通过严格管理员边界；
- `previewSchemaVersion=V04_MIGRATION_PREVIEW_V1`；
- P07 仅包含与冻结 pre-1A→target additive schema 相符的缺失对象／列，不含意外 extra／changed／partial-install；
- contract 状态与 pre-1A 事实一致，不得意外为 ACTIVE；
- 两次调用 token、schema fingerprint 和规范化事实稳定；
- 响应 `Cache-Control: no-store`；
- 线上首页、详情、V0.3 工作入口继续正常，V0.4 UI/API/写开关仍关闭；
- 没有任何业务写入或操作账本新增迹象。

### E. 立即关闭 PREVIEW

无论 PREVIEW 成功或失败，都使用独立关闭提交精确撤销 `V04_MIGRATION_PREVIEW_ENABLED=true`，重新运行测试、推 main、等待 Vercel 同 SHA，并确认端点恢复 `UNSUPPORTED_WORKFLOW`、既有 V0.3 链路正常。不得把只读开关长期留在生产。

## 7. 必须停止的条件

出现任一项立即停止，不进入 schema APPLY：

1. R3 或 R4 产品复验不是 A；
2. GitHub／Vercel／目标 SHA 不一致，或远端出现未核对提交；
3. 任何非 PREVIEW 的 V0.4 生产开关被开启；
4. 响应为 `INTERNAL_ERROR`、缺少 preview 对象或出现固定 stage 诊断；
5. 管理员映射为歧义、缺失、停用，或需要放宽身份规则；
6. 生产不是完整 pre-1A，而是部分安装、额外对象、同名定义漂移或合同意外 ACTIVE；
7. migration／schema／catalog／contract／vocabulary hash 与第 4 节不一致；
8. PREVIEW 的 token／fingerprint／事实在无数据变化的同一窗口不稳定；
9. P07 以外的 P01—P11 和三类业务 hash仍为占位，却试图据此批准 APPLY；
10. 无法取得可恢复备份、完整操作账本、幂等、事务、失败记录、写后 catalog／RLS／业务指纹证据；
11. 需要回填、猜测或改写 V0.2／V0.3 历史，或推断旧 `subtitleEffect`；
12. 涉及生产凭据、隐私、费用、破坏性删除、权限／RLS 放宽或真实业务范围扩大。

## 8. 后续受控 schema APPLY 的证据需求

本节是门一的后续工程缺口，不授权本次执行。

### 8.1 APPLY 前

- 一个独立版本化 APPLY route/service，只允许 POST、same-origin、ACTIVE stable `SYSTEM_ADMIN`；
- 显式确认语句、PREVIEW token 未过期且事实未变化、唯一 idempotency key；
- 生产可恢复备份／恢复点的存在性和恢复演练证据；
- 当前 catalog 全量快照、冻结目标 catalog hash、migration 原文件 hash；
- V0.2／V0.3 source、V0.4 target、non-target 的互斥数量与内容聚合 hash；
- `admin_data_operations`、audit、V0.3 streams／snapshots／releases 等关键业务指纹；
- `schema_migration_operations` 在 pre-1A 首次安装与失败回滚时的可靠记录方案。

### 8.2 APPLY 事务

- 只执行批准的 additive migration；不运行业务回填；
- 建表、加列、约束、trigger、RLS、DRAFT 合同种子和 schema ledger 在受控事务内；
- 任何错误全部回滚，不消费可重试编号／幂等键；
- 不启用 workflow UI/API/detail/library/shadow，不激活合同。

### 8.3 APPLY 后

- 14 张 V0.4 表与既有 `admin_data_operations` 共 15／15 RLS；5 index、19 trigger、0 policy 与冻结对象一致；
- 24／15／21 共 60 个 option，taxonomy／vocabulary／workflow contract 全为 DRAFT，hash 与第 4 节一致；
- `videos.created_by_user_id` 保持 nullable，不回填；历史 `subtitle_effect` 只取空默认，不从字幕推断；
- V0.4 workspace／submission／lease／expert release 等 BUSINESS 行为 0；
- V0.2／V0.3 count／hash、stream、snapshot、release、review、comment、revision、video／media 指纹前后完全相同；
- 重复执行只返回幂等已完成，不产生第二套对象、第二条 operation 或业务数据；
- 安装后重新运行完整 PREVIEW，此时 P07 为零、P01—P11 为真实事实、合同为 DRAFT；只有这一步和全部前后证据一致，门一才具备最终完成条件。

## 9. 本次只读核验记录

- 当前 `HEAD=origin/main=917f7cf14f37c8187cadceee309aa27c3d5d89fc`。
- `vercel.json` 只含 Next.js 构建和 `syd1` region，没有任何 V0.4 开关。
- contract／schema／preview 定向测试 16／16 通过；`git diff --check` 在创建本文前通过。
- 未连接生产数据库，未调用生产 PREVIEW，未执行 schema／业务 APPLY，未激活合同，未改正式入口。

## 10. 2026-08-20 首次执行记录

- R3／R4 产品真实路径复验均为 A，进入 R5 第一段。
- Runbook 以提交 `904a7af` 独立纳入版本控制。
- PREVIEW 以提交 `21f6d69` 短期开启，定向与全量门禁通过，GitHub/Vercel 已部署相同 SHA。
- 现有生产已登录业务会话可正常访问页面，但当前浏览器控制层阻止直接导航到 JSON API；受限页面执行环境也不提供 `fetch`／XHR。未复制、读取或输出 Cookie／凭据，也未调用生产 PREVIEW。
- 因无法在不转移会话凭据的前提下调用同源 API，按本文停止条件使用独立提交 `025bf77` 关闭 PREVIEW；没有生成 preview token/hash，没有生产写入，也没有执行 schema APPLY／合同激活／入口切换。
- 受控 APPLY 的工程审计发现：当前 pre-1A PREVIEW 的 P01—P11 多数为占位、catalog 覆盖和语义 hash 尚不足、首次安装账本失败留痕需要 control-plane savepoint、管理员 membership 存在安装后自锁风险、应用内 hash 不可冒充可恢复备份。精确实施方案见 `web/docs/V04_R5_SCHEMA_APPLY_IMPLEMENTATION_PLAN.md`。

当前停止点：**临时 PREVIEW 已关闭；首次调用未发生。必须先补齐增强 PREVIEW 与受控 schema APPLY 工具，在 TEST_ONLY PostgreSQL 完成验证后，再进行下一次短期生产 PREVIEW。不能直接运行 `npm run db:migrate`。**

## 11. 增强实现后的唯一生产 PREVIEW 步骤（覆盖第5—8节旧预备口径）

第5—8节保留首次尝试前的历史审计。本节是门 T 复验后的最新版执行口径：生产 PREVIEW 尚未执行，生产 schema APPLY 尚未获执行授权。

### 11.1 暗代码与操作面

- 管理页：`/admin/v04-schema`；复用现有登录、stable user 和管理员体系，不建立第二套身份。
- PREVIEW：`GET /api/admin/v04-migration/preview`，默认关闭、same-origin、no-store、零写。
- APPLY：`POST /api/admin/v04-migration/apply`，默认关闭；页面加载、build、start、GET 都不会调用。
- `web/vercel.json` 当前不含任何 V0.4 开关；合同激活、workflow UI/API、detail/library/shadow 正式入口均关闭。

### 11.2 版本化短期开启 PREVIEW

1. 记录 main、GitHub、Vercel SHA，三者必须一致；复跑全量门禁和 `verify:v04-schema-apply`。
2. 建立只修改 `web/vercel.json` 及对应配置断言的短期提交，只设置 `V04_MIGRATION_PREVIEW_ENABLED=true`；不得设置 APPLY、ACTIVATE 或 UI/API 开关。
3. 推送后等待 Vercel 部署同 SHA；使用负责人现有已登录会话打开同源 `/admin/v04-schema`。不得复制 cookie、凭据或数据库 URL。
4. 点击“运行只读 PREVIEW”。页面只展示脱敏事实：`schemaState`、ready、stopReasons、目标代码 SHA、bundle/catalog/source/target/non-target hash、有效期与 P01—P11。
5. 在同一30分钟窗口点击“使用当前 token 再次零写核验”；token、各 hash、P01—P11 和 stopReasons 必须稳定，`zeroWrite.unchanged=true`。
6. 保存证据后，无论结果成功或失败，都以第二笔独立提交关闭 PREVIEW 并核对 Vercel 同 SHA、端点恢复默认关闭、V0.3 主链正常。

### 11.3 PRE_1A_EXACT 的 READY 规则

增强版不再把合法的 pre-1A 缺表当成异常 drift。满足以下条件时应返回 `schemaState=PRE_1A_EXACT`、`contract.status=MISSING`、`contract.expectedStatus=DRAFT` 且 `ready=true`：

- 既有 V0.2/V0.3 基线表完整；V0.4 target 表／additive列尚未安装；没有部分安装、额外或同名定义变化；
- 当前 actor 是 ACTIVE stable user，且 pre-1A 过渡映射对当前 actor 唯一；
- P01—P11 都是真实只读结果，V0.4业务行预期为0，三类语义 hash 非占位；
- target code SHA 和 DDL bundle hash 与部署版本一致；GET 前后指纹不变。

P09 仍完整报告全部旧管理员 UNIQUE/AMBIGUOUS/MISSING/DISABLED 分布；只有当前执行 actor 的映射决定 PREVIEW 授权，不会据此批量授予角色。APPLY 只会写当前 actor 的唯一 SYSTEM_ADMIN membership。

### 11.4 本轮停止点

门 T 产品复验通过后才能短期开启生产 PREVIEW。生产 PREVIEW 返回 READY 并完成第二次稳定核验，也只形成生产 schema APPLY 的新决策输入；本轮部署不打开 APPLY，不执行生产写入。真实恢复点引用、审批引用、未过期 token、目标 SHA、bundle 与全部指纹必须在后续 APPLY 前再次锁内复核。

工程实现与 TEST_ONLY 证据见：

- `web/docs/V04_R5_SCHEMA_APPLY_IMPLEMENTATION_PLAN.md`
- `web/docs/V04_R5_SCHEMA_APPLY_EVIDENCE.md`
