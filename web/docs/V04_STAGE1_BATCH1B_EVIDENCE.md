# V0.4 阶段1批次1B工程证据

状态：1B工程实现与本机验证记录；待工程统筹复核／产品独立验收。

本文件不表示阶段1完成、产品通过、生产迁移完成或正式上线。

## 基线与边界

- 基线：`9272e51e06b5a8dde338055f4ccba8f19e60afe6`，保留1A三提交及祖先
  `1156712`、`6df98f1`。
- 代码位于隔离worktree；原主目录用户未跟踪资料未移动、未改写、未删除或暂存。
- V0.4 taxonomy、workflow、vocabulary继续保持`DRAFT`；暗路由默认关闭。
- 未连接生产数据库，未做生产schema/data APPLY，未进入1C，未切正式V0.4入口。
- 未实现真实AI、生产COS清理或V0.2/V0.3历史适配；历史适配和生产PREVIEW属于1C。
- 本批次不推送、不部署。

## 实现对账

1. 五态由草稿事实、不可变`SUBMISSION`数量和hash纯函数推导；相同hash提交返回
   `NO_CHANGES_TO_SUBMIT`。
2. 工作区首次保存原子物化唯一公共主线；GET读模型零写。
3. 案例级租约以稳定用户、session和tab隔离；心跳30秒、TTL120秒；正文写入均在事务内
   验证租约。
4. change-set按稳定target记录；revision一致正常写入，不相交target可rebase，同target或
   结构／顺序目标冲突返回`REVISION_CONFLICT`；不提供默认整稿覆盖。
5. 自动保存约2.5秒防抖、15秒超时、最新请求优先；离线恢复使用五维键并在运行时剔除
   `sessionToken`、`leaseToken`、`credential`等扩展字段。
6. 保存只产生工作稿revision／事件／审计，不产生提交、不改变专家优选、不释放租约。
7. 提交独立写入不可变快照；首次／二次版本严格为1／2；幂等重试返回原结果；失败回滚
   不消耗编号。
8. 专家优选grant／replace／withdraw与工作稿五态独立；仅稳定`EXPERT`身份可执行。
9. 恢复只从不可变baseline、working snapshot或submission创建新的工作轮，不覆盖来源。
10. CaseCard、CaseDetail、Workspace、History读模型分离；CaseDetail默认最新提交，不泄漏
    未提交正文；Workspace GET不物化。
11. 暗API统一执行开关、same-origin、稳定ACTIVE身份、request/idempotency和错误结构校验。
12. 新上传视频记录稳定`created_by_user_id`；删除改为90天软删除／恢复，不物理删数据库或
    COS对象；受控清理只保留合同和状态，本批次不执行。

## TEST_ONLY PostgreSQL纵切证据

专用回环PostgreSQL、数据库名含`test`、显式`NODE_ENV=test`与`V04_TEST_RUN_ID`条件下，
验证器在随机token保护的隔离schema运行，完成后只清理该精确schema。最近一次完整纵切
得到以下结果：

- 空工作区重复GET写入数：0；首次物化唯一工作区：1。
- 两个用户／同用户双tab租约隔离：通过；重入续期、心跳、释放、过期和管理员强制释放：
  通过。
- 不相交change-set rebase：通过；同target冲突：`REVISION_CONFLICT`。
- 提交版本：1、2；同幂等键重试返回原结果；失败事务不消耗编号。
- 指针更新后强制失败回滚，下一次成功版本为3，证明编号未被失败事务占用。
- 专家身份、grant／replace／withdraw及强制失败回滚：通过；管理员未具备专家关系时拒绝。
- 非破坏恢复及强制失败回滚：通过；来源不可变对象保持不变。
- CaseCard／CaseDetail／Workspace／History读取前后写入计数不变。
- 稳定UPLOADER与SYSTEM_ADMIN软删除／恢复：通过；无COS动作、无清理任务。
- 15张V0.4／统一表RLS非owner的SELECT／INSERT／UPDATE／DELETE均被隐藏或拒绝。
- 执行前后`public`目录指纹不变；未写入生产或公共业务数据。

## 复验命令

```bash
npm test
npm run lint
npm run build -- --webpack
npm run verify:v04-schema       # 需要显式TEST_ONLY变量
npm run verify:v04-workflow     # 需要显式TEST_ONLY变量
git diff --check
```

未提供TEST_ONLY变量时，PostgreSQL测试明确跳过，不会回退读取通用数据库配置。构建、启动
和GET均不会运行迁移、激活合同或创建V0.4业务行。

本次隔离worktree复验结果：

- `npm test`（显式TEST_ONLY变量）：构建成功；221项测试全部通过，0失败、0跳过；1A与
  1B两套真实PostgreSQL矩阵均在同一次完整回归中执行。
- `npm run lint`：通过，0警告。
- `npm run build -- --webpack`：通过，TypeScript、静态页面和全部暗路由编译成功。
- `npm run verify:v04-schema`：`ok=true`，E1/E2、H1-H7、R1/R2、D1、P1、S1全通过，
  bootstrap与migration目录hash一致，公共目录与业务hash保持不变。
- `npm run verify:v04-workflow`：`ok=true`，上述工作流纵切全部通过，
  `publicFingerprintUnchanged=true`。

隔离worktree复用了主目录已安装依赖的只读软链接；Next默认Turbopack会拒绝项目根目录外的
`node_modules`软链接，因此本机验收显式使用Next官方webpack构建器。生产`build`脚本和
Vercel构建配置未改变；这是隔离工作树依赖布局限制，不是源码、类型或依赖解析失败。

## 独立验收注意

- 本文只提供工程复验证据，不代替产品清单的逐项独立验收，也不勾选产品通过。
- 需重点复核：稳定身份、租约与并发、失败回滚、编号off-by-one、只读不泄漏、软删除、
  RLS以及现有V0.2/V0.3共享提交hash和网络挂起自动保存回归。
- 1C开始前仍需单独冻结legacy adapter、只读生产PREVIEW与受控激活／迁移步骤。
