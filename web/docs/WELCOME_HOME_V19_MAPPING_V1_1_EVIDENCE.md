# 《欢迎回家》V1.9 固定直接映射工具｜工程证据

状态：工程实现完成，生产 PREVIEW／APPLY 默认关闭，待产品独立复验。

## 固定作用域

- 唯一案例：`video_e2d5dbab-fc35-4e81-9d8e-0ab1a0a90435`。
- 唯一源：ACTIVE `V0.3-PILOT` stream、共享轮 1、current WORKING snapshot rev 153。
- 唯一合同：`WELCOME_HOME_V19_DIRECT_MAPPING_V1_1`，19 种、196 实例。
- 生产预期：虚拟初始化 7 个桥段／23 个镜头稳定容器后，195 `TARGET_EMPTY`、1 `TARGET_SAME`、0 `TARGET_DIFFERENT`、0 `UNADDRESSABLE`；写后 196 `TARGET_SAME`。

## 安全实现

- 独立开关 `V04_WELCOME_HOME_V19_MAPPING_PREVIEW_ENABLED` 与 `V04_WELCOME_HOME_V19_MAPPING_APPLY_ENABLED` 均缺省关闭，未写入 `vercel.json`。
- 管理页面只复用现有稳定登录和 `SYSTEM_ADMIN` membership；PREVIEW/APPLY 路由均为 POST、same-origin、no-store。
- 完整 30 分钟 token 只存在同源 API 响应和页面运行时 React state；页面只显示不可逆 token 摘要，不写 DOM、URL、storage、console、日志或账本。
- 权威源不比较旧 annotation 可变哈希。工具重建当前 annotation 可变包，以 `sharedContentFingerprint` 与 current snapshot payload 做键序无关、排除流转字段的一致性校验；stored snapshot hash 仍要求 64 位并进入 token 绑定。
- APPLY 在 SERIALIZABLE 事务、全局 advisory lock 与目标行锁内重查 stream／round／snapshot／annotation／workspace／working snapshot；token 绑定 actor 摘要、目标 Git SHA、源四个稳定 ID、stored hash、canonical fingerprint、source digest、目标 revision/hash。
- 目标不同值永不覆盖；目标空白才写；相同值不重复写。生产固定预期不允许 DIFFERENT／UNADDRESSABLE。
- 新建一个 V1.9 WORKING snapshot 和 SYSTEM_MIGRATION revision events；不创建 submission，不改 expert preference，不改 V0.3/V0.2 历史。
- V0.3 与 V1.9 共用 legacy shot 关系表且主键全局。V1.9 immutable payload 保留源稳定 ID；关系投影使用 annotation-scoped deterministic physical ID，避免与源 rows 冲突，不改变 payload 稳定定位含义。
- `admin_data_operations` 只保存 token 摘要、脱敏 hash、前快照指针和结果摘要；同幂等键重放返回原结果，并发只允许一个事务提交。

## TEST_ONLY PostgreSQL 证据

命令：

```text
NODE_ENV=test V04_TEST_DATABASE_URL=<loopback-test-db> V04_TEST_RUN_ID=<run-id> npm run verify:welcome-home-v19-mapping
```

已在仅 loopback 的既有 PostgreSQL 16 TEST_ONLY 容器执行，结果全部为 `true`：

- annotation 旧 hash 与 snapshot stored hash 不一致，但规范内容相同可通过；
- 规范内容漂移、annotation revision 漂移、过期 token 均拒绝；
- PREVIEW 精确 195+1，APPLY 后结构 7/23 且 196 SAME；
- 失败注入全回滚；并发仅一个事务提交；重复请求幂等返回；
- submission／expert 不变，V0.3 源快照数量不变，另一 TEST_ONLY 案例不变；
- 测试 schema 使用 run marker 精确清理，没有触碰 public／生产数据。

## 生产停止点

本提交只部署默认关闭的工具。不得在本工程步骤中开启开关、运行生产 PREVIEW 或运行生产 APPLY。后续必须先由产品独立复验，再采用独立短期开启提交执行生产 PREVIEW；只有 195+1、7/23、零提交／专家／活动租约和全部指纹事实符合冻结合同，才可进入另行受控 APPLY。
