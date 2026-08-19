# V0.4 阶段1批次1C本地／代码门工程证据

状态：1C 工程实现与门 A 待复验证据；待工程统筹复核／产品独立验收。

本文不表示门 A 已通过、1C 已通过、生产 PREVIEW 已执行、合同已激活或阶段1已完成。

## 基线与边界

- 开工基线：`ebeed4120de13f119d95b396801fbd1a79a636f7`（1B独立验收A后的本地main）。
- 保留1A／1B成果及祖先`1156712`、`6df98f1`；本批次不修改V1.9原型。
- taxonomy、workflow、vocabulary、payload合同全程保持`DRAFT`；没有激活路由。
- 没有连接生产DB／COS，没有schema/data APPLY，没有切正式V0.4入口。
- 本隔离worktree不push、不deploy；门B的GitHub、Vercel、真实域名和生产只读证据不在本轮执行。
- 用户未跟踪文件未移动、改写、删除或暂存。

## legacy adapter 证据

1. V0.2／V0.3只读适配：输入前后深比较不变；相同输入的payload、issue和hash稳定。
2. 稳定历史shot/group/object ID原样保留；V0.2缺group时只用确定性ID建立兼容展示组。
3. 所有旧镜头`subtitleEffect=""`；不读取字幕、画面、点评或声音推断字幕特效。
4. 只使用1A冻结的24／15／21词表和批准alias精确映射；不做模糊或语义匹配。
5. 固定值、`customText`、`advancedText`、`legacyRawValue`独立保留；未知值不伪造option ID。
6. 异常输出类型、稳定源/目标ID、源workflow和原值hash，不输出完整正文。

## 只读PREVIEW的11项结构

| 编号 | 本地输出 |
|---|---|
| P01 | BUSINESS视频数；V0.2／V0.3／V0.4 annotation数 |
| P02 | V0.3 stream、V0.4 workspace、canonical、ACTIVE round、逻辑空workspace数 |
| P03 | snapshot kind分布与version异常 |
| P04 | 原位提升后仍被stream current指向的稳定stream ID |
| P05 | release／candidate／review／round／workspace参照异常 |
| P06 | video级与schema级双账本状态，PREVIEW账本越界异常 |
| P07 | 表、列、trigger、index、policy、RLS相对冻结DDL的drift |
| P08 | `__CUSTOM__`／其他／待形成／开放文本组合及稳定annotation ID |
| P09 | 旧管理员姓名到ACTIVE user的唯一／歧义／缺失／停用分类，只输出稳定ID |
| P10 | 物理删除audit、DB orphan、object key异常；COS orphan固定标为DB无法确认 |
| P11 | 旧snapshot／baseline／release数量与全历史内容聚合hash |

输出只含计数、稳定ID、异常类型、fingerprint和hash；不含原文、姓名、邮箱、
cookie、session或lease token。`sourceHash`、`targetHash`、`nonTargetHash`按互斥行范围归类，
token绑定环境、合同版本、schema fingerprint、三类hash、稳定actor和全部规范化事实。

## 路由与权限

- `GET /api/admin/v04-migration/preview`默认因`V04_MIGRATION_PREVIEW_ENABLED`非`true`而关闭。
- feature guard先于身份/数据库读取；路由只有GET，没有POST／APPLY。
- request URL、可选Origin与`sec-fetch-site`共同实施same-origin边界。
- 会话需对应ACTIVE稳定user；服务二次校验`app_role_memberships.SYSTEM_ADMIN/ACTIVE`。
- `EXPERT`、MEMBER、UPLOADER均不可调用；display name/email只是PREVIEW匹配证据，不授权。
- 成功与错误响应均`Cache-Control: no-store`。token绑定固定30分钟时间窗口的
  `expiresAt`：同窗口同事实稳定，到期瞬间／过期、跨窗口或事实变化均返回
  `STALE_PREVIEW`/409，无需写入型token账本。
- P07相对冻结DDL比较所有相关表的非约束index、非内部trigger与policy；
  任意命名的多余对象、缺失对象及同名定义漂移均进入结构化drift，PK/UNIQUE/FK
  约束支撑索引不误报。

## TEST_ONLY真实PostgreSQL证据

最近一次本机回环PostgreSQL验证器输出：

- `preview11=true`；冻结11项字段全部存在。
- `repeatedTokenStable=true`、`parallelPreviewStable=true`；同窗口重复／并行事实稳定。
- `expiryBoundaryRejected=true`、`crossWindowTokenChanged=true`；过期前接受，到期边界和跨窗口旧token均拒绝。
- 增加TEST_ONLY历史事实后token改变，旧token返回`STALE_PREVIEW`。
- 覆盖异常：snapshot version、原位提升current、参照不一致、legacy choice组合、
  管理员歧义/停用、物理删除audit、DB orphan。
- 任意命名extra index/trigger、同名index/trigger定义变化、对象缺失、
  policy缺失／额外／定义变化的真实PG负向矩阵全部使`ready=false`；每项精确清理后恢复`ready=true`。
- 同名定义对账包含index key、`INCLUDE`列、predicate与access method，以及trigger timing、
  event、`UPDATE OF`列、ROW/STATEMENT orientation、function和WHEN条件；不依赖对象名模式。
- 人为添加TEST_ONLY schema列后`ready=false`且报告drift；列仍存在，证明PREVIEW只报告、不自动修复。
- `zeroWrite=true`；重复/并行PREVIEW前后隔离schema业务指纹不变。
- `publicFingerprintUnchanged=true`；本轮未改公共/生产业务数据。
- `testSchemaCleaned=true`；run id、随机cleanup token和marker匹配后只清理本次schema。
- taxonomy/workflow/vocabulary/payload合同状态始终`DRAFT`。

命令：

```bash
export V04_TEST_RUN_ID="stage1c_<unique>"
# V04_TEST_DATABASE_URL 由受控的本机 TEST_ONLY 环境注入，文档不记录凭据值。
NODE_ENV=test \
V04_TEST_RUN_ID="${V04_TEST_RUN_ID:?set a unique guarded run id}" \
V04_TEST_DATABASE_URL="${V04_TEST_DATABASE_URL:?inject a loopback test database URL}" \
npm run verify:v04-preview
```

未提供三个显式TEST_ONLY条件时，真实PG测试明确跳过，绝不回退使用通用
`DATABASE_URL`。连接配置必须由受控环境注入，数据库主机必须是loopback、库名必须包含
`test`；本文档不记录用户名、口令或完整连接串。

## 完整回归

- 显式TEST_ONLY环境下`npm test`：Next生产构建通过；231项测试全部通过，0失败、0跳过。
- 同一次完整回归实际执行1A schema、1B workflow和1C PREVIEW三套真实PostgreSQL矩阵。
- `npm run lint`：通过，0警告。
- `npm run build -- --webpack`：构建、TypeScript和路由收集通过；PREVIEW暗路由可编译。
- `npm run verify:v04-preview`：`ok=true`，上述token/hash/零写/drift/清理证据通过。
- `git diff --check`在提交前需再次执行；只允许1C直接文件进入本地提交。

## 双门停止点

- 本证据只供门A独立复验；工程侧不自行勾选产品结论。
- 若门A通过，唯一可允许的表述是“具备部署生产只读PREVIEW条件”。
- 门B须由统筹在受控push/部署、GitHub/Vercel/`api/version` SHA一致后，以真定管理员在
  真实域名执行生产只读PREVIEW。
- 门B前后必须比较schema/source/target/non-target/操作账本/审计零写证据。
- 即使门A+B通过，`CONTRACT_ACTIVATE`仍需项目负责人根据生产PREVIEW另行批准；
  本批次没有激活、schema/data APPLY、正式入口切换或生产写入。
