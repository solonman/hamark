# V0.4 R5｜受控 schema APPLY 工具实施方案

状态：工程安全方案已形成；尚未实施工具，尚未执行生产 schema APPLY。
形成日期：2026-08-20（Asia/Shanghai）
审计基线：`025bf771b7cde049104ac32bf153c7f2befe4be6`（临时 PREVIEW 开关已经关闭）

本文只定义后续受控工具的实现白名单、事务、幂等、备份、测试和停线规则。它不是 schema APPLY 批准或执行记录，不允许用 `npm run db:migrate`、构建、启动或普通 GET 代替受控 APPLY。

## 1. 结论与当前停止点

1. 生产只读 PREVIEW 未实际调用：现有已登录浏览器会话可访问业务页面，但当前浏览器控制层阻止直接导航到 JSON API，页面沙箱也不提供 `fetch`／XHR；为避免复制 Cookie 或凭据，已按冻结规则关闭临时 PREVIEW 开关。
2. 当前 pre-1A PREVIEW 的 schema drift 早退分支只真实给出 P07；P01—P06、P08—P11和三类 hash 是占位值。该 token 只能证明“pre-1A catalog drift 稳定”，不得绑定 APPLY。
3. 现有 catalog 比对没有完整覆盖既有表上的 V0.4 新列、列类型/default/nullability、PK/FK/CHECK/UNIQUE、ACL 与全部 RLS 语义；P07=0 目前不能单独证明目标 catalog 精确等价。
4. 现有业务 hash 多处使用 `SELECT *`。新增 nullable/default 列会改变物理 JSON，即使 V0.2/V0.3 正文完全未变；必须先升级为版本化语义指纹。
5. pre-1A 没有 `schema_migration_operations`。如果在单一事务中同时建表、写账本和执行全部 DDL，失败时 FAILED 行也会回滚；必须使用“控制平面前缀＋savepoint”。
6. 应用内 catalog/hash 不是可恢复备份。APPLY 前必须已有外部 provider restore point，并提供不含凭据的 opaque reference 与 verifiedAt。
7. 存在管理员自锁停线项：pre-1A 可用唯一 legacy admin→stable user 的严格过渡鉴权；schema 安装后 `app_role_memberships` 表存在但为空，常规逻辑会拒绝所有人。实现前必须冻结“同事务只为本次唯一 actor 种一条 SYSTEM_ADMIN 安全配置”或“先执行独立角色 bootstrap operation”之一；不得继续依赖 display_name，也不得一般性放宽授权。

当前停止点：先补齐增强 PRE-APPLY PREVIEW 和受控工具，在 TEST_ONLY PostgreSQL 通过完整矩阵；再次短期开启生产 PREVIEW 后，只有真实 P01—P11、完整 catalog、三类语义 hash、管理员方案和外部恢复点全部满足，才可进入生产 APPLY。

## 2. 精确文件白名单

### 2.1 新增

- `web/lib/v04-schema-apply.ts`：请求校验、SERIALIZABLE 事务、全局 advisory lock、savepoint、幂等、失败归档、受控补偿。
- `web/lib/v04-schema-catalog.ts`：完整 catalog／constraint／ACL／RLS 的规范化快照、delta 与 hash。
- `web/app/api/admin/v04-migration/apply/route.ts`：默认关闭的 POST-only 路由、same-origin、稳定管理员、显式确认。
- `web/scripts/verify-v04-schema-apply.ts`：静态合同和默认关闭验证。
- `web/tests/v04-schema-apply.test.ts`：路由、权限、确认、token、幂等、错误脱敏的单元测试。
- `web/tests/v04-schema-apply-postgres.test.mjs`：TEST_ONLY 真实 PostgreSQL 纵向矩阵。
- `web/docs/V04_R5_SCHEMA_APPLY_EVIDENCE.md`：先记录 TEST_ONLY；生产执行后再追加受控证据。

### 2.2 定向修改

- `web/lib/v04-migration-preview.ts`：pre-1A 真实 P01—P11、版本化语义 hash、完整 catalog、schemaState、bundleHash、control-ledger-only 允许态。
- `web/app/api/admin/v04-migration/preview/route.ts`：仅在响应需要新增 `schemaState`／`bundleHash` 时修改；保持 GET、no-store、零写。
- `web/db/v04-schema.ts`：拆出控制平面声明；加强 schema ledger 时间／结果不变量。
- `web/db/migrations/2026-08-19-v04-contract-foundation.sql`：由同一声明源保持最终 catalog 等价；生产从未 APPLY，可在首次安装前修正。
- `web/tests/v04-migration-preview.test.ts`
- `web/scripts/verify-v04-migration-preview.ts`
- `web/tests/v04-schema.test.mjs`
- `web/scripts/verify-v04-schema.ts`
- `web/package.json`：增加 `verify:v04-schema-apply`。
- `web/README.md`
- `web/docs/V04_R5_PRODUCTION_PREVIEW_RUNBOOK.md`：增加增强 PREVIEW 与新 hash 口径。

### 2.3 禁改

- V0.2/V0.3 页面、API、正文、历史、快照、批准版、批注和修订事件。
- `web/db/bootstrap.ts`、`web/db/index.ts` 和 `admin_data_operations*` 的既有公开语义；schema operation 不得伪造成 video operation。
- V0.4 UI/API/detail/library/shadow/contract activation 开关。
- 构建、服务启动、普通 GET 不得触发 APPLY。
- 不做业务回填，不激活合同，不创建 V0.4 workspace/submission/lease/expert release 等业务行。

若实现必须修改白名单外源代码，先停线并重新审计，不得顺手扩大。

## 3. 增强 PRE-APPLY PREVIEW 合同

增强 PREVIEW 必须在 pre-1A catalog 上也能只读完成：

- 真实计算 P01—P11，不再把缺表当作业务事实为零；“缺表”只由 P07/schemaState 表达。
- `schemaState` 仅允许：`PRE_1A_EXACT`、`CONTROL_LEDGER_ONLY_EXACT`、`TARGET_APPLIED_EXACT`、`DRIFT_OR_PARTIAL`。
- token 绑定 actor stable ID、environment、generatedAt/expiresAt、migration bundle hash、完整 catalog hash、P01—P11、source/target/non-target 语义 hash。
- catalog 包含表、列类型/default/nullability、PK/FK/CHECK/UNIQUE、index、trigger、RLS、policy、ACL；所有读取失败均返回固定 stage 并阻塞，不能吞错当空。
- 版本化语义 hash：legacy 行先移除 V0.4 新增列再规范化；V0.4 contract/vocabulary/role 归 target；schema ledger 单独计；V0.4 缺表与空表都表示空业务集，结构差异只归 P07。
- 管理员分类 P09 必须真实计算 UNIQUE/AMBIGUOUS/MISSING/DISABLED；APPLY 只接受 UNIQUE 且 actor stable ID 完全一致。
- token 有效期仍为30分钟；锁内必须重新计算并逐项相等，不能只验证签名。

## 4. APPLY 请求与授权边界

路由：`POST /api/admin/v04-migration/apply`，默认 `V04_SCHEMA_APPLY_ENABLED=false`。

请求只接受：

- `action="APPLY_SCHEMA"`
- `previewToken`
- `Idempotency-Key`
- 精确确认语句
- `approvalReference`
- `backupReference` 与 `backupVerifiedAt`

禁止接收数据库 URL、Cookie、session token、SQL 或凭据正文。路由顺序固定为：feature guard → same-origin → ACTIVE stable actor → 严格 SYSTEM_ADMIN／冻结的首次 bootstrap 规则 → 请求合同 → 事务。错误只返回稳定 code、requestId 和固定 stage，不输出原始 SQL/message/stack/正文。

外部恢复点必须在 APPLY 前创建和验证。应用只记录不敏感 opaque reference、verifiedAt 与审批文档引用；缺失、过期或无法验证即停线。若产品要求独立备份字段而不是将其编码进不可变 `approval_reference`，须先调整冻结 schema 合同。

## 5. 事务、账本、幂等与失败补偿

### 5.1 事务

1. 开启 `SERIALIZABLE` 事务，设置本地 `lock_timeout` 和 `statement_timeout`。
2. 获取固定 key 的 `pg_advisory_xact_lock`，保证全局只有一个 schema APPLY。
3. 锁内重新运行增强 PREVIEW；验证 token 未过期且 actor/environment/bundle/catalog/P01—P11/三类语义 hash 完全一致。
4. 只允许 `PRE_1A_EXACT` 或 `CONTROL_LEDGER_ONLY_EXACT`。
5. 安装最小控制平面：只包含 `schema_migration_operations` 表、guard、RLS、REVOKE；写 `PREVIEWED→APPLYING`。
6. 建立 savepoint，执行批准的 additive DDL 声明源；绝不执行整库 bootstrap、业务回填或 CONTRACT_ACTIVATE。
7. 完整写后校验通过后写 `APPLIED`；失败则 `ROLLBACK TO SAVEPOINT`，写脱敏 `FAILED` 后提交外层事务。

### 5.2 账本不变量

- `SCHEMA_PREVIEW` 永远只能是 `PREVIEWED`。
- `SCHEMA_APPLY`／`CONTRACT_ACTIVATE` 才允许 `PREVIEWED→APPLYING→APPLIED|FAILED`。
- `APPLYING` 必须有 `started_at`；`APPLIED` 必须有 `result` 与 `completed_at`；`FAILED` 必须有稳定 `error_code`/固定 stage 与 `completed_at`。
- operation key 固定绑定 schema version 和 target bundle hash；同 idempotency key 重试返回原结果；同目标已 APPLIED 返回 `alreadyApplied`；并发 APPLYING 返回409。
- 失败内容不保存 SQL、stack、正文或凭据。

### 5.3 受控补偿

只处理超时 `APPLYING`：

- catalog 精确等于 `CONTROL_LEDGER_ONLY_EXACT` 且业务 hash 未变：标记 FAILED，要求 fresh PREVIEW 后重试。
- catalog 精确等于 `TARGET_APPLIED_EXACT` 且全部业务不变量成立：只完成账本对账为 APPLIED。
- 任何其他 partial catalog／业务 hash 变化：停线人工审计；禁止自动 DROP、删除或覆盖。

## 6. TEST_ONLY 真实 PostgreSQL 矩阵

环境守卫：`V04_TEST_DATABASE_URL` 必须是 loopback 且数据库名含 `test`；必须有唯一 `V04_TEST_RUN_ID`；只创建带 run id 的隔离 schema/marker，只精确清理本轮 fixture。执行前后保存 public catalog 与业务语义指纹。

| 类别 | 必须验证 |
|---|---|
| 入口拒绝 | flag关闭、跨源、非管理员、错误确认、无备份、旧token、错误幂等键均零写 |
| PREVIEW | pre-1A 真实 P01—P11、完整 catalog、语义 hash；缺表不伪装成零数据 |
| 并发 | 两个并发 APPLY 只有一个执行；另一个幂等返回或409 |
| 安装 | 冻结 schema 声明全部安装；两条 DDL 来源 catalog 等价 |
| RLS/ACL | 15/15 RLS；非owner SELECT/INSERT/UPDATE/DELETE 全拒绝 |
| 合同 | 24/15/21 共60词表；三合同 DRAFT、activated_at null；V0.4业务行0 |
| 兼容 | V0.2/V0.3语义hash不变；V0.3 WORKING→CANDIDATE仍通过 |
| 幂等 | 同key重放返回同结果；重复执行不造第二套对象/operation |
| 失败 | 每个关键stage注入失败；savepoint回滚目标DDL但留下脱敏FAILED |
| 崩溃 | 超时APPLYING仅按两个精确catalog状态受控对账；其他partial停线 |
| 漂移 | schema/事实/actor/bundle/backup任一变化都拒绝旧token |
| 零自动执行 | build/start/GET均不安装schema、不写账本、不激活合同 |

完整门禁：新增定向测试、1A/1B/1C/R1—R4回归、`npm test`、`npm run lint`、`npm run build`、`npm run verify:v04-schema-apply`、`git diff --check`。

## 7. 生产执行分段与永久关闭

1. 工具实现提交：所有生产开关缺省false；部署暗代码，线上V0.3回归。
2. 增强 PREVIEW 短期开启提交：只开 `V04_MIGRATION_PREVIEW_ENABLED=true`；取得并核对真实证据后立即关闭部署。
3. APPLY 短期开启提交：只有全部停止条件已关闭时，只开 `V04_SCHEMA_APPLY_ENABLED=true`；执行一次受控 APPLY。
4. 写后 PREVIEW 与页面只读验收。
5. 立即关闭 APPLY 开关并部署；若 operation ledger 已完成，API 仍永久只读/不可重放。
6. CONTRACT_ACTIVATE、业务迁移和正式入口切换仍是后续独立门，不能并入 schema APPLY。

## 8. 生产 APPLY 停止条件

以下任一出现即停止：

- 使用当前占位 hash token 尝试 APPLY；
- P09 未真实计算，或首次 SYSTEM_ADMIN bootstrap 口径尚未冻结；
- catalog 缺少列类型、constraint、ACL/RLS证据；
- 没有真实 provider restore point；
- migration/schema/workflow/admin bundle hash变化；
- schemaState 不是精确 pre-1A/control-ledger-only；
- 任一 V0.4 合同 ACTIVE 或业务行大于0；
- V0.2/V0.3/non-target语义hash变化；
- 超时 APPLYING 无法安全归类；
- 需要直接执行 `npm run db:migrate`、一般性放宽RLS/姓名授权、业务回填、合同激活或UI/API开关；
- 涉及凭据、隐私、费用、不可恢复删除或生产权限弱化。

## 9. 待统筹冻结的一项安全配置选择

在工具编码前需明确且仅需明确以下一项，不涉及业务正文：

- **方案A**：schema APPLY 同事务为本次 P09=UNIQUE 且 stable actor ID 完全相同的管理员种一条 ACTIVE SYSTEM_ADMIN membership；作为安全配置写入 target hash 和账本。
- **方案B**：先开发并批准独立 role bootstrap operation，成功后再进行 schema APPLY／安装后复核。

无论选择哪项，schema 安装后都禁止 display_name 授权回退；普通 MEMBER/UPLOADER 仍按冻结规则派生，不持久化为 membership。
