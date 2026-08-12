# 视频创意逆向工程系统｜同事接手必读

交付日期：2026-08-02  
当前交付性质：可运行的演示纵切版＋正式生产演进资料  
详细部署清单：[`docs/11_部署交接与正式上线清单.md`](docs/11_部署交接与正式上线清单.md)

## 先看结论

本包不是页面原型，而是已经跑通以下闭环的可运行网站：

```text
上传视频 → 在线播放 → 填写逐镜脚本与V0.2标注
→ 自动保存 → 提交不可变快照 → 公开阅读 → 原位百分制评分
```

当前源码已改为通过环境变量连接 Supabase Postgres 和腾讯云 COS，并以企业微信作为生产身份入口。它还不是可以直接向全公司开放的生产版本：正式上线前必须确认企业微信应用可见范围、建立正式权限，并完成生产级上传、备份和权限验收。认证路径不再保留 demo-user fallback。

## 目录入口

- `README.md`：产品总览和本地启动方法；
- `web/`：完整网站源码；
- `web/package-lock.json`：锁定依赖，使用 `npm ci` 安装；
- `web/.env.example`：Supabase Postgres、腾讯云 COS、企业微信认证配置模板；
- `web/db/bootstrap.ts`：数据库 schema 的唯一来源，用 `npm run db:migrate` 应用；
- `web/.wrangler/state/`：历史本地演示数据快照，仅限内部开发演示，不再作为运行时数据源；
- `docs/`：产品、数据模型、交互、技术选型和验收资料；
- `参考资料/`：V0.2权威标准表和三菱汽车完成版样例。

## 本地启动

环境要求：Node.js 22.13或更高版本。

```bash
cd web
npm ci
cp .env.example .env.local
npm run dev
```

浏览器访问终端显示的本地地址，默认通常为 `http://localhost:3000/`。

如部署到Vercel，项目 Root Directory 必须设为 `web`，并使用默认的 `npm run build`。`npm run build:vinext` 仅用于Cloudflare Worker兼容构建，不适合作为Vercel站点输出。

## 企业微信认证上线前检查

Supabase SQL 新增迁移必须在认证代码部署前执行。部署认证代码前，必须先在 Supabase SQL 编辑器执行新增迁移，确保企业微信身份字段和会话表结构已存在。

本轮“原位批注／优秀标记／修订建议”上线前，需要依次执行
`web/db/migrations/2026-08-07-analysis-comments.sql` 和
`web/db/migrations/2026-08-08-inline-revision-suggestions.sql`。迁移只新增批注、文字锚点、
修订建议表和索引，不会覆盖已有视频、作业快照或评分数据；应用代码部署必须排在迁移之后。

Vercel Production 环境变量必须配置完整：

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

Preview 只有在其精确回调域名也登记到企业微信时，才需要单独配置对应的 Preview 值。企业微信后台需配置回调 URL `https://hamark.boga.plus/api/auth/wecom/callback`、可信域名 `hamark.boga.plus`，并把固定出口 `111.229.151.122` 加入企业可信 IP。

生产环境的 `WECOM_SECRET` 只保存在固定 IP 服务器 `/etc/hamark-wecom-proxy.env`，不要配置到 Vercel。Vercel 通过 `WECOM_PROXY_URL` 和 `WECOM_PROXY_SECRET` 调用 `hamark-wecom.boga.plus`；具体部署顺序见 `web/README.md`。

`DATABASE_URL` 必须使用服务端 Postgres 连接串，推荐 Supabase pooler 的 `postgres`/owner 连接，不是 Supabase anon key。认证相关表开启了 RLS，但不提供浏览器侧策略；运行时数据库访问只应发生在 Next.js 服务端。

企业微信应用的可见范围控制成员登录资格；不在可见范围内的成员不应能完成登录。密钥配置后，剩余生产验证至少包括一次桌面浏览器企业微信二维码扫码登录，以及一次企业微信客户端内登录检查。

完整验收：

```bash
cd web
npm run lint
npm test
```

## 本地演示数据

交付包保留当前本地演示状态：

- 4条视频记录；
- 3份个人作业，其中2份已经提交；
- 3份不可变作业快照；
- 1份评分记录；
- 三菱汽车《欢迎回家》真实演示视频、逐镜脚本和分析作业。

另外3条中包含用于页面闭环验证的轻量演示占位素材。正式迁移时，建议只迁移确认需要保留的《欢迎回家》案例，不要把占位数据直接导入生产库。

## 严禁直接照搬到生产的部分

1. 企业微信部门同步和正式角色权限仍需完成业务验收。
2. 当前数据库和视频存储已切到 Supabase Postgres 与私有 COS，但仍需完成生产级备份、容量、权限和迁移验收。
3. 当前上传适合演示；生产大文件应采用分块直传、暂停恢复和失败清理。
4. 本地演示视频与分析仅限公司内部学习，不得发布为匿名公开资源。

## 正式方案基线

正式生产演进以 `docs/09_技术选型与阶段1工程设计.md` 为准：

- TypeScript模块化单体；
- Next.js页面和业务API；
- PostgreSQL事实库；
- 私有腾讯云COS；
- 企业微信OAuth和部门标签；
- Docker容器部署；
- 视频处理使用独立Worker；
- 首版不使用Kubernetes，不默认启用CDN。

接手人应先完整阅读详细部署清单，再申请域名、云资源或修改身份模块。
