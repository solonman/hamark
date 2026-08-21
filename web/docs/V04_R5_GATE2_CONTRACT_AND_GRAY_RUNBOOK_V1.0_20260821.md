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
- catalog：`b13f99779015239d09b8ceef8d7e081272e83d9ff163a590cbf0fd68ef043a64`（门二 fresh PREVIEW、P07=0；修正门一文档中的旧归档值）。
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

## 七、2026-08-21 生产执行记录（脱敏）

### 7.1 合同工具与短期开关

- 默认关闭工具：`3cd00e9cd41650d67596f38ba08b86534bb84efd`。
- 第一次短期开启：`2dc321a`。事务前门禁因门一归档中的 catalog hash 抄写值与生产 fresh PREVIEW 不一致而拒绝；拒绝发生在账本和合同正文写入前，未产生合同或业务写入。立即以 `c3d9980` 关闭。
- 只读诊断 PREVIEW：`722eccc68278470fa5308b0a2b2720f5d70aa4a0`；确认 `TARGET_APPLIED_EXACT`、P07=0、15/15 RLS、60项词表、唯一稳定 SYSTEM_ADMIN、三合同 DRAFT、V0.4 工作事实为0，取得本手册第一节记录的真实 catalog hash。立即以 `49a7a71` 关闭。
- 真实 catalog 证据绑定修正：`7afeab126661f5845a7a320db94cdceec0546a54`。
- 第二次短期开启：`caf14bdd3dbf52a23ebc4913a4133c31e7dfceb0`；生产页面同时显示 PREVIEW关闭、APPLY关闭、合同生命周期短期开启、V0.4正式入口关闭。
- 激活动作只执行一次，脱敏账本引用为 `contract_operation_df651e800c2df354b907b7d5e37a6456`，结果 `APPLIED`。
- 激活服务在同一事务内完成前置 DRAFT 精确复核、三份合同原子 DRAFT→ACTIVE，以及 ACTIVE 写后复核；只有写后 `TARGET_APPLIED_EXACT`、P07/RLS/词表/稳定管理员/零V0.4工作事实和三类业务指纹继续成立时，账本才会进入 APPLIED。
- 操作后立即以 `e858bbb` 独立提交关闭合同生命周期开关；生产管理页确认 PREVIEW、APPLY、合同生命周期、V0.4正式入口全部关闭。

### 7.2 防回退与灰度停止点

- 关闭态线上首页仍为41个案例、当前稳定管理员会话正常；搜索、上传入口和既有案例卡正常。
- 当前《欢迎回家》生产案例详情、播放器入口和显式 `taxonomy=V0.3-PILOT` 公共工作稿可读；正式默认入口未切换，未出现空JSON或 `INTERNAL_ERROR`。
- 合同激活没有执行 schema APPLY、bootstrap、业务回填、P10清理或V0.4工作事实创建。
- 截至本记录，尚无可由工程侧客观核对的“第二稳定身份＋带可用媒体且明确批准的 TEST_ONLY／受控灰度对象”组合。依据第五节停止条件，小灰度保持关闭；不得以普通41案例、显示姓名、同一用户双tab或历史演示案例推定授权范围。
- 后续灰度只有在稳定身份和受控对象均有明确、非敏感稳定引用后，才能通过独立版本化开关进入；未满足前的准确状态为“合同已激活，灰度未开启，待门二产品独立复验／灰度对象证据补齐”。
