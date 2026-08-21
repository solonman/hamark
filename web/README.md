# RE:VERSE 反写

广告视频创意逆向学习与结构化标注网站的阶段1演示纵切版。

## 已实现

- 统一视频展台与片名／品牌／标签／作者搜索；
- 视频上传、腾讯云COS对象存储和网页播放；普通成员不提供原片下载；
- 个人作业约1秒自动保存，通过单一入口发布新修订；
- 单页纵向完成核心判断、逐镜脚本、创意构成A1–A9和故事组织B1–B10；
- 所有作业固定绑定标注体系`V0.2`；
- 提交生成不可变快照、修订号和内容哈希；
- 作品页公开展示每位成员的最新提交；
- 对应内容旁的原位百分制批改、自动保存和悬浮总分；
- 作业与评审场景始终可见的悬浮播放器；
- 软删除、审计日志及响应式页面基础。

## 本机运行

要求Node.js 22.13或更高版本。

```bash
npm install
cp .env.example .env.local
npm run dev
```

访问：`http://localhost:3000/`

运行前需要在 `.env.local` 中配置 Supabase Postgres、腾讯云COS和企业微信登录变量。

如果只需在本机演示并验收，可以启用与生产完全隔离的本机演示模式。它使用本机
Postgres、`.local-demo/` 视频存储和两个临时演示身份；只有 `NODE_ENV=development`
时才能开启，正式构建和线上环境不会暴露该入口。

```bash
docker run --name hamark-local-demo-postgres \
  -e POSTGRES_PASSWORD=hamark-local-demo \
  -e POSTGRES_DB=hamark \
  -p 127.0.0.1:55432:5432 \
  -d postgres:16-alpine
```

`.env.local` 只需写入：

```env
LOCAL_DEMO_MODE=1
APP_URL=http://localhost:3000
DATABASE_URL=postgresql://postgres:hamark-local-demo@127.0.0.1:55432/hamark
SUPABASE_DB_SSL=false
```

保留旧演示包中的 `.wrangler/state/v3` 数据后，执行：

```bash
npm run local:setup
npm run local:dev
```

登录页可以选择“案例作者”或“评审同事”，用于演示作业修订、多人批注、评分和管理员优秀标记。

V0.3-PILOT 与 V0.2 按体系版本分开保存。新练习页默认进入 V0.3，需要查看或继续历史作业时可在页头切换到 V0.2。启动本机站点后，可使用现有“欢迎回家”案例验证完整纵向链路：

```bash
npm run verify:v03-local
```

该验证只允许连接 `LOCAL_DEMO_MODE=1` 的本机回环地址，会发布一份 V0.3 演示快照，并自动断言 V0.2 作业内容与修订号均未改变。

V0.4 小范围灰度和专用 TEST_ONLY 媒体工具均为默认关闭的暗能力。灰度只接受当前稳定 `users.id` 的服务器端 SHA-256 摘要与显式 `videos.id`；不接受原始用户ID、姓名、标签或通配符。本人身份摘要证明页 `/v04-gray-identity` 也由独立开关默认关闭，只显示当前登录者自己的不可逆摘要与ACTIVE状态。专用媒体工具位于 `/admin/v04-gray-test-object`，只允许稳定 SYSTEM_ADMIN 使用固定哈希的本机生成测试片；它只接受“目标/对象/账本全空”或“三者全量精确匹配”两种状态，条件创建不覆盖预存对象，补偿也只删除带本次creation marker与ETag的对象。生产创建动作必须取得当次浏览器安全确认。工具关闭、页面加载、构建和部署都不会创建对象或数据库行。详细门禁、开启及回滚步骤见 `docs/V04_R5_GATE2_GRAY_ROLLOUT_RUNBOOK_V1.0_20260821.md`。

《欢迎回家》V1.9 固定单案例直接映射的默认关闭 PREVIEW/APPLY 工具及 TEST_ONLY 证据见 `docs/WELCOME_HOME_V19_MAPPING_V1_1_EVIDENCE.md`。生产部署不会自动运行 PREVIEW、APPLY、迁移或数据回填。

历史视频缩略图回填需要在有生产环境变量和 `ffmpeg` 的机器上执行。脚本会先确保 `thumbnail_key` 字段存在，再为 `READY` 且缺少封面的历史视频生成 `1600px` 宽度上限的 JPEG 封面并上传到 COS：

```bash
npm run thumbnails:backfill
THUMBNAIL_BACKFILL_LIMIT=5 npm run thumbnails:backfill
```

企业微信登录相关变量：

```env
APP_URL=https://hamark.boga.plus
AUTH_SECRET=replace-with-at-least-32-random-bytes-base64
WECOM_CORP_ID=wwxxxxxxxxxxxxxxxx
WECOM_AGENT_ID=1000002
WECOM_PROXY_URL=https://hamark-wecom.boga.plus
WECOM_PROXY_SECRET=replace-with-at-least-32-random-bytes-base64
```

生成 `AUTH_SECRET`：

```bash
openssl rand -base64 48 | tr -d '\n'
```

## Vercel部署

Vercel项目的 Root Directory 必须设置为 `web`。

- Install Command：`npm ci`
- Build Command：`npm run build`
- Output：使用Vercel自动识别的Next.js输出

不要把默认构建命令改成 `npm run build:vinext`；那是Cloudflare Worker兼容构建，Vercel不能直接作为Next.js站点托管。

Vercel 环境变量必须配置在 Production 环境。Preview 只有在其精确回调域名也登记到企业微信时，才需要单独配置对应的 Preview 值。企业微信后台需配置：

- 回调 URL：`https://hamark.boga.plus/api/auth/wecom/callback`
- 可信域名：`hamark.boga.plus`
- 企业可信 IP：`111.229.151.122`

生产环境通过 `https://hamark-wecom.boga.plus` 的独立代理访问企业微信服务端 API，避免 Vercel 动态出口 IP 被企业微信拒绝。Vercel 只保存 `WECOM_PROXY_SECRET`，不保存企业微信应用 Secret；`WECOM_SECRET` 仅配置在固定 IP 服务器的 `/etc/hamark-wecom-proxy.env`。

代理源码和部署模板位于 `services/wecom-proxy/`。服务只监听 `127.0.0.1:3201`，由独立 Nginx HTTPS 虚拟主机转发。不要复用服务器上 Advault 的公开 HTTP `/cgi-bin/` 转发，也不要把代理端口暴露到公网。

代理使用隔离安装的 Node.js 22.23.2，不替换服务器 `/usr/bin/node`，避免影响 BOGACLAW。先从 Node.js 官方发布目录下载 `node-v22.23.2-linux-x64.tar.xz` 和 `SHASUMS256.txt`，校验 SHA-256 后安装：

```bash
grep ' node-v22.23.2-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum --check
sudo tar -xJf node-v22.23.2-linux-x64.tar.xz -C /opt
/opt/node-v22.23.2-linux-x64/bin/node --version
sudo ln -sfn /opt/node-v22.23.2-linux-x64 /opt/node-v22.23.2
```

固定 IP 服务器首次部署顺序：

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin hamark-wecom
sudo install -d -o root -g root -m 0755 /opt/hamark-wecom-proxy
sudo install -o root -g root -m 0644 services/wecom-proxy/protocol.mjs services/wecom-proxy/wecom.mjs services/wecom-proxy/server.mjs /opt/hamark-wecom-proxy/
sudo install -o root -g root -m 0600 /dev/null /etc/hamark-wecom-proxy.env
sudoedit /etc/hamark-wecom-proxy.env
sudo chmod 600 /etc/hamark-wecom-proxy.env
sudo install -o root -g root -m 0644 services/wecom-proxy/deploy/hamark-wecom-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hamark-wecom-proxy
```

`/etc/hamark-wecom-proxy.env` 只保存服务器变量：`WECOM_CORP_ID`、`WECOM_SECRET`、`WECOM_PROXY_SECRET`、`HOST=127.0.0.1` 和 `PORT=3201`。其中代理密钥必须与 Vercel Production 的 `WECOM_PROXY_SECRET` 完全一致。

DNS 添加 `hamark-wecom.boga.plus A 111.229.151.122` 后，先安装无证书引导配置，再签发证书，最后切换正式配置：

```bash
sudo install -o root -g root -m 0644 services/wecom-proxy/deploy/nginx-bootstrap.conf /etc/nginx/sites-available/hamark-wecom.conf
sudo ln -s /etc/nginx/sites-available/hamark-wecom.conf /etc/nginx/sites-enabled/hamark-wecom.conf
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --nginx -d hamark-wecom.boga.plus
sudo install -o root -g root -m 0644 services/wecom-proxy/deploy/nginx.conf /etc/nginx/sites-available/hamark-wecom.conf
sudo nginx -t
sudo systemctl reload nginx
```

若符号链接已存在，不要重复创建；直接核对它指向 `/etc/nginx/sites-available/hamark-wecom.conf`。上线前执行 `curl -fsS http://127.0.0.1:3201/health` 和 `curl -fsS https://hamark-wecom.boga.plus/health`。

企业微信应用的可见范围控制哪些成员有登录资格。部署认证代码前，先在 Supabase 执行新增 SQL 迁移；当前认证路径不再保留 demo-user fallback。

上线“原位批注／优秀标记／修订建议”前，依次执行
`db/migrations/2026-08-07-analysis-comments.sql` 和
`db/migrations/2026-08-08-inline-revision-suggestions.sql`。两个脚本只新增表、字段和索引，
可以重复执行，不会改写已有作业快照或评分。应用代码必须在迁移成功后部署。

**迁移必须先于部署。** 2026-08-12 发生过一次事故：V0.3／V0.3.1／V0.3.2 的代码部署上线，
三个迁移一个都没跑，视频详情页全部 500（`42P01 relation "analysis_review_rounds" does not exist`）。
迁移是加法且幂等的，先跑迁移再部署代码不会有任何损失。

`db/bootstrap.ts` 是 schema 的**唯一来源**，用 `npm run db:migrate` 应用，幂等可重复执行。
`db/migrations/*.sql` 只是可单独贴进 Supabase SQL Editor 的历史记录，内容已包含在 bootstrap 里。

Supabase 的 `public` schema 同时会被 PostgREST 对外暴露，因此所有表都开启了 RLS 且不建任何策略，
并回收了 `anon`／`authenticated` 的表权限，等于关闭浏览器直连数据库这条路。**新增表时必须同步在
`db/bootstrap.ts` 末尾的 RLS 清单里加一行**，漏掉就等于把那张表公开可读，Supabase 会发告警邮件——
`tests/schema-rls.test.mjs` 会检查这一点，漏了测试会红。
补齐历史库执行 `db/migrations/2026-08-12-enable-rls-all-tables.sql`，需在 V0.3 系列迁移之后运行。

`DATABASE_URL` 必须使用服务端 Postgres 连接串，推荐 Supabase pooler 的 `postgres`/owner 连接——
该角色带 BYPASSRLS，所以开启 RLS 不影响任何运行时查询。运行时数据库访问应只发生在 Next.js 服务端。

生产验收还需要在密钥配置完成后执行两项登录检查：一次桌面浏览器企业微信二维码扫码登录，一次企业微信客户端内登录。

## 检查命令

```bash
npm run lint
npx tsc --noEmit
npm test
```

### V0.4 阶段1批次1A本机 schema 验证

1A 的 PostgreSQL 验证器只接受显式的专用测试环境：`NODE_ENV=test`、符合
`[a-z0-9_-]{8,40}` 的 `V04_TEST_RUN_ID`、回环地址且数据库名包含 `test` 的
`V04_TEST_DATABASE_URL`。它不会回退读取通用 `DATABASE_URL`，也不会连接生产库。

```bash
export V04_TEST_RUN_ID="stage1a_<unique>"
# V04_TEST_DATABASE_URL 由受控的本机 TEST_ONLY 环境注入，文档不记录凭据值。
NODE_ENV=test \
V04_TEST_RUN_ID="${V04_TEST_RUN_ID:?set a unique guarded run id}" \
V04_TEST_DATABASE_URL="${V04_TEST_DATABASE_URL:?inject a loopback test database URL}" \
npm run verify:v04-schema
```

验证器只在 `test_only_v04_<runId>` 隔离 schema 内写入 TEST_ONLY fixture，使用随机
cleanup token 与 marker 校验后仅删除该精确 schema；执行前后还会比对 `public` 的
catalog 和业务指纹。普通 `npm test` 未提供上述变量时会明确跳过真实 PostgreSQL 矩阵，
不会隐式连接数据库。

该命令验证的是 1A 的 DRAFT 合同和 schema 安全底座，不是生产业务数据 APPLY：不会激活
V0.4 合同、不会回填历史上传者、不会创建生产 V0.4 工作区，也不得在 build/start/deploy
过程中自动运行。生产 schema APPLY 和业务迁移仍须分别经过受控 PREVIEW 与单独批准。

### V0.4 阶段1批次1B本机工作流验证

1B 在 1A 的 DRAFT 合同上增加工作区、租约、保存、提交、专家优选、非破坏恢复、只读模型
和回收站事务。所有 V0.4 API 仍是暗路由：默认关闭，只有服务端显式设置
`V04_WORKFLOW_API_ENABLED=true` 才响应；本批次不激活合同、不切换正式入口，也不包含 1C
历史适配或生产 PREVIEW/APPLY。

真实 PostgreSQL 纵切沿用 1A 的 TEST_ONLY 守卫，并在独立的
`test_only_v04_<runId>_workflow` schema 内运行。命令中的账号、密码只应是本机一次性测试值：

```bash
export V04_TEST_RUN_ID="stage1b_<unique>"
# V04_TEST_DATABASE_URL 由受控的本机 TEST_ONLY 环境注入，文档不记录凭据值。
NODE_ENV=test \
V04_TEST_RUN_ID="${V04_TEST_RUN_ID:?set a unique guarded run id}" \
V04_TEST_DATABASE_URL="${V04_TEST_DATABASE_URL:?inject a loopback test database URL}" \
npm run verify:v04-workflow
```

验证覆盖两个用户、同用户双标签页、30秒心跳／120秒TTL、change-set重放与冲突、首次和
二次提交编号、幂等重试、事务失败回滚、专家优选、非破坏恢复、读模型零写、90天软删除／
恢复、RLS拒绝以及`public`目录指纹不变。清理只允许删除本次随机cleanup token和marker
同时匹配的精确隔离schema；验证器不会读取通用`DATABASE_URL`，不会物理删除视频或COS
对象，也不会创建清理任务。

自动保存采用约2.5秒防抖和15秒超时。离线恢复键绑定用户、工作区、轮次、标签页和payload
版本五个维度；写入前会按运行时白名单重建记录，不保存会话、租约或凭据字段。自动／手动
保存只更新当前草稿，不生成提交快照、不修改专家优选，也不释放租约。

完整的 1B 本机证据和明确边界见
[`docs/V04_STAGE1_BATCH1B_EVIDENCE.md`](docs/V04_STAGE1_BATCH1B_EVIDENCE.md)。

### V0.4 阶段1批次1C本地只读PREVIEW验证

1C 只读地把 V0.2／V0.3 历史映射为 V0.4 兼容展示对象：不修改旧 payload、
snapshot、release 或 audit，旧镜头的 `subtitleEffect` 固定为空字符串。旧固定值只在
批准 alias 唯一时映射 option ID；开放值、待形成值和无法确定的值分别保留在
`customText`、`advancedText`、`legacyRawValue` 或结构化异常中。

本机真实 PostgreSQL 纵切继续使用显式 TEST_ONLY 守卫，不会回退读取通用
`DATABASE_URL`：

```bash
export V04_TEST_RUN_ID="stage1c_<unique>"
# V04_TEST_DATABASE_URL 由受控的本机 TEST_ONLY 环境注入，文档不记录凭据值。
NODE_ENV=test \
V04_TEST_RUN_ID="${V04_TEST_RUN_ID:?set a unique guarded run id}" \
V04_TEST_DATABASE_URL="${V04_TEST_DATABASE_URL:?inject a loopback test database URL}" \
npm run verify:v04-preview
```

验证器只在 `test_only_v04_preview_<runId>` 隔离 schema 内生成历史组合，使用随机
cleanup token 和 marker 精确清理，并比对 `public` catalog/业务指纹。它覆盖冻结的
11项 PREVIEW、同一30分钟窗口的重复/并行 token 稳定、到期/跨窗口/事实变化后
`STALE_PREVIEW`、index/trigger/policy的缺失、额外及同名定义漂移、schema drift
只报告不修复、稳定 `SYSTEM_ADMIN` 授权和 GET 零业务写。测试连接信息只由受控环境注入，
文档不保存口令或完整连接串。

部署后的只读路由为 `/api/admin/v04-migration/preview`，默认关闭，只有服务端显式设置
`V04_MIGRATION_PREVIEW_ENABLED=true` 才响应；它没有 POST 或 APPLY 路径，不写 preview 账本。
门 B 核验期间由版本化 `vercel.json` 短期开启这一项非敏感布尔开关；配置不包含数据库
凭据，也不启用 schema APPLY、业务 APPLY、合同激活或 V0.4 正式入口，核验结束后应精确撤销。
本机验证只属于 1C “门 A”证据，不代表生产只读 PREVIEW、1C 通过或合同激活。
完整证据与双门边界见
[`docs/V04_STAGE1_BATCH1C_EVIDENCE.md`](docs/V04_STAGE1_BATCH1C_EVIDENCE.md)。

### V0.4 R5 增强 PREVIEW 与受控 schema APPLY（TEST_ONLY）

R5 新增同源管理员页 `/admin/v04-schema`、增强 pre-1A PREVIEW 和默认关闭的
POST-only schema APPLY。普通页面加载、build、start、GET 与部署不会安装 schema；合同和
V0.4 正式 UI/API 也不会被激活。真实数据库验证只允许显式 TEST_ONLY 环境：

```bash
NODE_ENV=test \
V04_TEST_RUN_ID="r5_apply_<unique>" \
V04_TEST_DATABASE_URL="${V04_TEST_DATABASE_URL:?inject a loopback test database URL}" \
npm run verify:v04-schema-apply
```

验证器覆盖 pre-1A 完整 P01—P11、GET 零写、token/目标 SHA/bundle 绑定、并发唯一
APPLY、15/15 RLS、DRAFT 合同、唯一 stable SYSTEM_ADMIN、幂等重放、savepoint 失败
回滚、FAILED 留账、超时 APPLYING 补偿、partial drift 拒绝和 public 指纹不变。生产
PREVIEW/APPLY 开关均不写入 `vercel.json`；本机通过不代表生产 APPLY 获准或已执行。
详见 [`docs/V04_R5_SCHEMA_APPLY_EVIDENCE.md`](docs/V04_R5_SCHEMA_APPLY_EVIDENCE.md)。

### V0.4 V1.9 现有系统增量优化 R1 本机验证

R1 在现有系统上补齐 V0.4 暗 API、读模型和 TEST_ONLY PostgreSQL 纵链。现有 `/api/videos`
仍是唯一视频目录、标签和上传来源；V0.4 cards API 只按这些既有 video ID 投影工作状态、
版本和查看者能力，不建立第二套片库。媒体继续使用既有 video ID、stream 路径和预签名能力，
用户与权限继续使用现有稳定身份。生产 UI／API 开关仍默认关闭；普通 build、start、GET 和
部署不会安装 schema、激活合同或创建 V0.4 业务数据。

本批真实 PG 验证除 `verify:v04-schema`、`verify:v04-workflow`、`verify:v04-preview` 外，
还在 `tests/v04-ui-workflow.test.ts` 中逐表验证通用关系 trigger。运行时必须继续使用显式的
`NODE_ENV=test`、唯一 `V04_TEST_RUN_ID` 和 loopback／数据库名含 `test` 的
`V04_TEST_DATABASE_URL`；测试事务或隔离 schema 会精确回滚／清理，不允许连接生产。

R1 首次物化验收发现并修正了一项从未投产的 1A trigger 基线缺陷。修正只把通用触发器改为
按 `TG_TABLE_NAME` 读取各表真实字段，不关闭触发器、不放宽关系或不可变约束；bootstrap DDL
与版本化 migration 的最终 catalog 必须完全相同。完整 hash、catalog、浏览器和 PostgreSQL
证据见 [`docs/V04_V19_PRODUCTION_INTEGRATION_EVIDENCE.md`](docs/V04_V19_PRODUCTION_INTEGRATION_EVIDENCE.md)。

R2 只在现有 `/videos/[id]/practice` 增加显式 `taxonomy=V0.4` 分支，并继续使用现有登录用户和
同一个 video ID。该分支同时要求服务端 `V04_WORKFLOW_UI_ENABLED=true`；未配置时返回 404。
无 taxonomy、`V0.2` 和 `V0.3-PILOT` 仍原样渲染既有 `PracticeClient`，生产默认继续是
`V0.3-PILOT`。V0.4 API 仍由独立 `V04_WORKFLOW_API_ENABLED` 门控制；两个门均不写入
`vercel.json`，因此提交和部署暗代码不会自动开放入口或访问未安装的生产 schema。

### V0.4 R5 门二合同生命周期（默认关闭）

合同激活使用独立的 POST-only 管理操作面与 `V04_CONTRACT_ACTIVATE_ENABLED` 开关。服务端在
同一事务锁内复核门一 catalog/RLS/词表/稳定 SYSTEM_ADMIN/零业务事实和三类指纹，再将
taxonomy、vocabulary、workflow 三份冻结合同原子地从 DRAFT 激活为 ACTIVE；失败回滚三行并
保留脱敏 FAILED 账本，重放返回同一结果。生命周期停用仅支持受控 ACTIVE→RETIRED，不删除
任何历史。默认部署不配置该开关，页面加载、GET、build/start 不会触发合同操作。

TEST_ONLY PostgreSQL 门禁：

```bash
NODE_ENV=test \
V04_TEST_RUN_ID="gate2_contract_<unique>" \
V04_TEST_DATABASE_URL="${V04_TEST_DATABASE_URL:?inject a loopback test database URL}" \
npm run verify:v04-contract-activation
```

生产执行、立即关门和小灰度停止条件见
[`docs/V04_R5_GATE2_CONTRACT_AND_GRAY_RUNBOOK_V1.0_20260821.md`](docs/V04_R5_GATE2_CONTRACT_AND_GRAY_RUNBOOK_V1.0_20260821.md)。

## 关键目录

- `app/`：片库、作品、作业页面和API；
- `db/`：Supabase Postgres 初始化SQL和运行时访问层；
- `storage/`：腾讯云COS对象存储适配层；
- `lib/annotation-fields.ts`：V0.2的A1–A9、B1–B10字段入口；
- `public/og.png`：网站分享预览图。

## 当前边界

这是用来验证“一支视频完整走通上传、观看、逆向标注、提交、公开回看和原位批改”的可运行纵向切片，不等同于完整MVP。企业微信登录已作为生产身份入口接入；正式互评分配、评选活动、管理员精修与Excel导出、视频转码和AI拆解尚未进入本版。
