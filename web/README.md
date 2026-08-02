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

运行前需要在 `.env.local` 中配置 Supabase Postgres 和腾讯云COS。没有工作区身份头时，写入身份显示为“演示用户”。

## Vercel部署

Vercel项目的 Root Directory 必须设置为 `web`。

- Install Command：`npm ci`
- Build Command：`npm run build`
- Output：使用Vercel自动识别的Next.js输出

不要把默认构建命令改成 `npm run build:vinext`；那是Cloudflare Worker兼容构建，Vercel不能直接作为Next.js站点托管。

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

这是用来验证“一支视频完整走通上传、观看、逆向标注、提交、公开回看和原位批改”的可运行纵向切片，不等同于完整MVP。企业微信、正式互评分配、评选活动、管理员精修与Excel导出、视频转码和AI拆解尚未进入本版。
