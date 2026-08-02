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

企业微信登录相关变量：

```env
APP_URL=https://hamark.boga.plus
AUTH_SECRET=replace-with-at-least-32-random-bytes-base64
WECOM_CORP_ID=wwxxxxxxxxxxxxxxxx
WECOM_AGENT_ID=1000002
WECOM_SECRET=replace-with-wecom-app-secret
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

企业微信应用的可见范围控制哪些成员有登录资格。部署认证代码前，先在 Supabase 执行新增 SQL 迁移；当前认证路径不再保留 demo-user fallback。

`DATABASE_URL` 必须使用服务端 Postgres 连接串，推荐 Supabase pooler 的 `postgres`/owner 连接。认证相关表开启了 RLS，但没有面向浏览器或 anon 角色的策略；运行时数据库访问应只发生在 Next.js 服务端。

生产验收还需要在密钥配置完成后执行两项登录检查：一次桌面浏览器企业微信二维码扫码登录，一次企业微信客户端内登录。

## 检查命令

```bash
npm run lint
npx tsc --noEmit
npm test
```

## 关键目录

- `app/`：片库、作品、作业页面和API；
- `db/`：Supabase Postgres 初始化SQL和运行时访问层；
- `storage/`：腾讯云COS对象存储适配层；
- `lib/annotation-fields.ts`：V0.2的A1–A9、B1–B10字段入口；
- `public/og.png`：网站分享预览图。

## 当前边界

这是用来验证“一支视频完整走通上传、观看、逆向标注、提交、公开回看和原位批改”的可运行纵向切片，不等同于完整MVP。企业微信登录已作为生产身份入口接入；正式互评分配、评选活动、管理员精修与Excel导出、视频转码和AI拆解尚未进入本版。
