# V0.4 R5｜增强 PREVIEW 与受控 schema APPLY 工程证据

状态：工程完成，待门 T 产品真实路径复验；生产 PREVIEW／APPLY 均未执行。
日期：2026-08-20（Asia/Shanghai）

## 1. 已实现边界

- 同源管理员页：`/admin/v04-schema`，复用现有 session、`users`、`app_admins` 与 stable membership；页面加载不自动 PREVIEW／APPLY。
- 增强只读 PREVIEW：pre-1A 也返回 P01—P11、目标 SHA、DDL bundle hash、catalog expected/absent/drift、三类语义指纹和 GET 前后零写证据；token 固定30分钟并绑定 actor、时间窗和全部事实。
- 受控 APPLY：POST-only、默认关闭、stable actor、同源、显式确认、外部恢复点引用、目标 SHA、token、幂等键、事务 advisory lock、控制平面账本、savepoint、写后复核和失败留账。
- 管理员安全配置：只把本次唯一 ACTIVE actor 写为唯一 `SYSTEM_ADMIN`；不猜上传者、不批量授予、不放宽 RLS。
- 安装内容只含 additive schema、DRAFT 合同和上述安全配置；没有业务回填、合同激活、V0.4 正式入口切换或生产连接。

## 2. TEST_ONLY PostgreSQL 结果

显式环境守卫：`NODE_ENV=test`、loopback URL、数据库名含 `test`、唯一 `V04_TEST_RUN_ID`、带 marker 的隔离 schema；只清理本次 run，`public` catalog／业务指纹前后相同。

`npm run verify:v04-schema-apply` 已证明：

- `PRE_1A_EXACT` 且 `ready=true`，P01—P11 共11项，PREVIEW 前后指纹不变；
- 旧 token 拒绝，两个并发请求只有一个实际 APPLY，另一个幂等返回；
- 15张目标／统一表全部存在且15/15 RLS；
- 24／15／21 共60个固定选项，taxonomy／vocabulary／workflow contract 均为 DRAFT，`activated_at` 为空；
- 只有当前稳定 actor 的一条 ACTIVE SYSTEM_ADMIN；
- source、target、non-target 三类语义 hash 写前写后完全一致；
- 同幂等键重放返回原 operation，不创建第二套 schema／账本；
- `AFTER_SCHEMA` 失败注入回滚目标 DDL，只保留脱敏 FAILED 账本；
- 超时 APPLYING 在精确 `CONTROL_LEDGER_ONLY_EXACT` 状态安全标记 FAILED；
- 任意 partial drift 返回 `DRIFT_OR_PARTIAL`、`ready=false`；
- `public` catalog／业务指纹不变。

既有矩阵同时通过：

- `verify:v04-schema`：空库／重复安装／migration-bootstrap catalog 等价、15/15 RLS、合同 DRAFT、旧历史不变；
- `verify:v04-workflow`：租约、并发、提交编号、幂等、失败回滚、恢复、软删除、非 owner RLS 拒绝；
- `verify:v04-preview`：重复／并行 token、到期、事实变化、index/trigger/policy drift、pre-1A 当前管理员唯一映射和零写。

## 3. 默认关闭与生产停止点

`web/vercel.json` 不包含 `V04_MIGRATION_PREVIEW_ENABLED`、`V04_SCHEMA_APPLY_ENABLED`、合同激活或 V0.4 UI/API 开关。build、start、普通 GET 和部署不会执行 schema APPLY。

本证据只说明门 T 工具具备复验条件，不是生产 PREVIEW、schema APPLY、合同激活或上线完成。下一步必须先按 runbook 短期开启 PREVIEW，在真实同源管理员页取得稳定 READY 证据并立即关闭；事实、身份、目标 SHA、bundle、恢复点或业务指纹任一不一致即停线。
