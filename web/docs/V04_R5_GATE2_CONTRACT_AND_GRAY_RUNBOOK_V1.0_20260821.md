# V0.4 R5 门二｜合同激活与小范围灰度执行手册 V1.0

日期：2026-08-21（Asia/Shanghai）

起点：`main@5fe4e03df46847b9033cb8721f18d233f0642c92`，门一独立结论 A

边界：本手册不等于合同已激活、灰度已开放或默认入口已切换。

## 一、冻结证据

- schema：`TARGET_APPLIED_EXACT`，P07=0，15/15 RLS。
- 合同：taxonomy、vocabulary、workflow 均为 DRAFT；词表60项。
- 稳定权限：ACTIVE SYSTEM_ADMIN=1。
- V0.4 工作区、提交、租约、批注等业务事实均为0；P10三个既有孤儿不清理、不改写。
- bundle：`d068f0e422a26162ed90a28c3b36a905e0b80d0ddd2a0c08711af0d62603155c`。
- catalog：`b13f997790152385817351f90f42879261530c39faea69e7365acd68ef043a64`。
- source：`f2e8865cad80facb737a2b83cd132b1fc123540c37e5dac60475b86f798582fe`。
- target：`d20fe2f7c62411ccee4897fc501fc0e7f5b5b9aae380006f2d30a710b8bf8d29`。
- non-target：`734b60057165b03129c405d309e8ac4cdb0f0bbdf4c2264f8a359b835f3f70e7`。

## 二、代码白名单

合同工具允许：

- `web/lib/v04-contract-activation.ts`
- `web/lib/v04-migration-preview.ts`
- `web/lib/v04-schema-admin-contract.ts`
- `web/app/api/admin/v04-contract/route.ts`
- `web/app/admin/v04-schema/page.tsx`
- `web/app/admin/v04-schema/V04SchemaAdminClient.tsx`
- `web/app/admin/v04-schema/page.module.css`
- `web/scripts/verify-v04-contract-activation.ts`
- `web/tests/v04-contract-activation.test.ts`
- `web/package.json`
- 本手册及对应证据说明。

短期开启/关闭部署仅允许修改 `web/vercel.json` 和对应开关断言。禁止修改 V0.2/V0.3 页面、数据正文、历史、媒体、身份、上传与默认入口。

## 三、合同生命周期事务

操作面：`POST /api/admin/v04-contract`。默认由 `V04_CONTRACT_ACTIVATE_ENABLED` 关闭；GET、页面加载、构建、启动和部署都不会运行合同操作。

请求必须同时满足：

1. 当前会话属于 ACTIVE stable user，且 `app_role_memberships` 中有 ACTIVE SYSTEM_ADMIN；不以姓名授权。
2. same-origin、显式确认语句、`Idempotency-Key` 与正文一致。
3. 目标运行代码 SHA、门一批准引用、门一证据 SHA、bundle/catalog/source/target/non-target hash 全部一致。
4. 事务内 advisory lock 后重新运行只读 PREVIEW；状态必须为 `TARGET_APPLIED_EXACT`、P07=0、15/15 RLS、60项词表、SYSTEM_ADMIN=1、三份合同状态一致、V0.4业务事实为0。

原子正文只更新三行状态：taxonomy、vocabulary、workflow；workflow 激活时写 `activated_at`。账本使用 `schema_migration_operations.operation_type=CONTRACT_ACTIVATE`，完整 PREVIEW token 只在事务内存中使用，账本仅保存摘要。失败回滚三份合同并留下脱敏 FAILED 账本；重放返回同一结果；并发只有一个胜者。

生命周期停用 `ACTIVE→RETIRED` 使用同一受控边界和独立确认语句。它不是删除或恢复到 DRAFT；生产常规灰度回滚优先关闭 UI/API/灰度开关并保留 ACTIVE 合同与历史，只有在未产生 V0.4 工作事实且确需合同级停用时才执行 RETIRE。

## 四、激活执行顺序

1. 在默认全关提交上完成 TEST_ONLY PostgreSQL：成功、相同幂等重放、并发、失败注入三合同全回滚、稳定管理员拒绝、ACTIVE写后复核、RETIRED演练、三类业务指纹不变。
2. 全量 `npm test`、`npm run lint`、`npm run build`、`npm run verify:v04-contract-activation`、`git diff --check`。
3. 提交并部署默认关闭工具；核对 GitHub、Vercel、`/api/version` 同 SHA。
4. 独立最小提交仅开启 `V04_CONTRACT_ACTIVATE_ENABLED=true`；PREVIEW/APPLY/bootstrap/ACTIVATE以外所有 V0.4 UI/API/detail/library/shadow/default 开关均保持关闭。
5. 在已登录同源管理页填入批准引用、门一证据引用和精确确认语句，执行一次 `DRAFT→ACTIVE`。
6. 核对唯一 APPLIED 账本、三合同 ACTIVE、workflow `activated_at`、P07/RLS/词表/admin、业务事实与三类指纹。
7. 立即以第二笔独立提交删除激活开关并部署，确认所有生产操作开关关闭。

任一步失败，立即关闭开关；不得重写合同、手工改库、清理P10或继续灰度。

## 五、小灰度停止条件

灰度实现必须同时具备：

- 三合同 ACTIVE；显式服务器端灰度总开关默认关。
- 仅稳定授权 user ID 和明确 `data_scope=TEST_ONLY`／已批准受控对象；禁止按 display_name、随机普通案例或“当前登录者”扩大范围。
- 复用现有 users/videos/media/auth/首页/详情/practice，不建立第二片库、第二身份或第二媒体主数据。
- 默认入口仍为 V0.3；非灰度身份/对象得到清楚的关闭态，不创建 V0.4 工作区。
- 第二稳定身份、带可用媒体的批准灰度对象必须在执行前客观可验证。若任一不存在，停在“合同已激活、灰度未开启”，不得伪造或用普通业务案例替代。

灰度回滚先关闭 workflow API/UI/detail/library 灰度开关；不可变提交、合同、账本、V0.2/V0.3与历史均保留。正式默认切换属于门三，本手册禁止执行。

## 六、回传证据

- 默认关闭工具、短期开启、立即关闭及灰度提交 SHA；GitHub/Vercel/`/api/version` 对应关系。
- 事务前后合同三行状态与 hash、唯一账本、幂等/失败回滚、P07、RLS、60词表、SYSTEM_ADMIN、业务事实、三类指纹。
- 灰度对象/身份仅回传稳定脱敏引用；不回传 cookie、凭据、完整 PREVIEW token或业务正文。
- 桌面与390px、两身份租约/旁观、保存/提交/历史/专家/恢复/批注/视频单实例，以及V0.2/V0.3/首页/详情/上传/stream防回退。

最终状态只能写“待门二产品独立复验”，不得自评门二 A，也不得切正式默认入口。
