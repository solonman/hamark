# 企业微信扫码登录设计

日期：2026-08-02  
状态：已确认，待实施

## 1. 目标与范围

为 RE:VERSE 反写接入企业微信自建应用身份，替换当前工作区身份头和演示用户兜底。

本次范围包括：

- 电脑浏览器通过企业微信官方页面扫码登录；
- 企业微信客户端内通过网页授权登录；
- 全站页面与业务 API 强制认证；
- 同步成员稳定身份、姓名、可用头像和部门；
- 服务端会话、退出登录、过期和撤销；
- 首页当前成员入口；
- Vercel 环境变量、数据库迁移和部署联调说明。

本次不建设角色权限后台、通讯录全量定时同步、企业微信消息通知或多企业工作空间。现有业务权限规则保持不变。

## 2. 技术决策

采用 Next.js 内自建企业微信 OAuth 适配器，不引入 Auth.js 或额外身份桥接服务。

原因：企业微信自建应用授权流程和标准 OIDC 存在差异，仍需定制授权 URL、成员身份获取和部门同步。当前系统是单体 Next.js 应用，自建适配器能保持调用链短、依赖少，并能直接复用 Supabase Postgres。

企业微信 `UserId` 是稳定外部身份。邮箱、手机号和头像可能因企业权限或成员资料设置而缺失，不参与账号唯一性判断。

## 3. 组件边界

### 3.1 登录页面

`/login` 是唯一公开业务页面：

- 未登录的电脑浏览器显示“企业微信扫码登录”主操作，点击后进入企业微信官方扫码授权页；
- 企业微信客户端内自动进入网页授权；
- 展示授权失败、成员不可见、配置错误和会话过期等受控错误；
- 已登录用户访问时跳回安全的 `return_to` 或首页。

页面不接收、不展示企业微信 Secret 或 access token。

### 3.2 企业微信适配器

`lib/auth/wecom.ts` 负责：

- 构造电脑扫码和客户端网页授权 URL；
- 使用企业 ID 与应用 Secret 获取应用 access token；
- 在 Supabase 中加密缓存 access token，并在过期前五分钟刷新；
- 使用一次性 code 获取访问成员 `UserId`；
- 读取成员资料和部门信息；
- 将企业微信错误转换为内部受控错误。

所有网络请求设置超时。仅对幂等的 token、成员和部门读取请求做一次短退避重试；OAuth code 交换不盲目重试，避免重复消费。

### 3.3 会话服务

`lib/auth/session.ts` 负责：

- 生成至少 256 位随机会话令牌；
- 数据库只保存令牌 SHA-256 哈希；
- Cookie 保存原始令牌，并设置 `HttpOnly`、`Secure`、`SameSite=Lax`、`Path=/`；
- 校验、过期、主动退出和惰性清理；
- 返回统一 `CurrentUser`。

会话绝对有效期为 24 小时。退出登录立即删除数据库会话并清除 Cookie。

### 3.4 访问控制

`proxy.ts` 负责未携带会话 Cookie 时的快速跳转，但不能把“存在 Cookie”等同于已认证。

服务端页面通过 `requireCurrentUser()` 校验数据库会话；业务 API 通过 `requireApiUser(request)` 校验，失败统一返回 `401`。登录页、授权入口、回调、静态资源和 Next.js 内部资源是白名单。

客户端请求遇到 `401` 时跳转 `/login`，并保留当前站内路径。`return_to` 只接受单斜杠开头的站内相对路径，拒绝协议、域名和双斜杠，防止开放重定向。

## 4. 数据模型

### 4.1 users

- `id TEXT PRIMARY KEY`：内部稳定用户 ID；
- `wecom_corp_id TEXT NOT NULL`；
- `wecom_user_id TEXT NOT NULL`；
- `identity_key TEXT NOT NULL UNIQUE`：由企业 ID 与成员 ID 生成的不可变业务身份键；
- `display_name TEXT NOT NULL`；
- `avatar_url TEXT`；
- `email TEXT`；
- `status TEXT NOT NULL DEFAULT 'ACTIVE'`；
- `last_login_at TEXT NOT NULL`；
- `last_synced_at TEXT NOT NULL`；
- `created_at TEXT NOT NULL`；
- `updated_at TEXT NOT NULL`；
- 唯一索引：`(wecom_corp_id, wecom_user_id)`。

### 4.2 user_departments

- `user_id TEXT NOT NULL REFERENCES users(id)`；
- `wecom_department_id TEXT NOT NULL`；
- `department_name TEXT NOT NULL`；
- `is_primary INTEGER NOT NULL DEFAULT 0`；
- `synced_at TEXT NOT NULL`；
- 主键：`(user_id, wecom_department_id)`。

每次成功登录以企业微信当前结果替换该用户的部门快照。部门信息仅用于展示和后续筛选，不构成内容保密边界。

### 4.3 auth_sessions

- `id TEXT PRIMARY KEY`；
- `user_id TEXT NOT NULL REFERENCES users(id)`；
- `token_hash TEXT NOT NULL UNIQUE`；
- `expires_at TEXT NOT NULL`；
- `last_seen_at TEXT NOT NULL`；
- `created_at TEXT NOT NULL`；
- `revoked_at TEXT`。

### 4.4 oauth_states

- `id TEXT PRIMARY KEY`；
- `state_hash TEXT NOT NULL UNIQUE`；
- `browser_nonce_hash TEXT NOT NULL`；
- `return_to TEXT NOT NULL DEFAULT '/'`；
- `flow_type TEXT NOT NULL`，取值 `QR` 或 `IN_APP`；
- `expires_at TEXT NOT NULL`；
- `consumed_at TEXT`；
- `created_at TEXT NOT NULL`。

OAuth state 有效期 10 分钟，只能消费一次。浏览器另持有短期 `HttpOnly` nonce Cookie，回调必须同时匹配 state 与 nonce。消费使用带 `consumed_at IS NULL` 和有效期条件的原子更新，避免并发回调重放。

### 4.5 wecom_app_tokens

- `corp_id TEXT NOT NULL`；
- `agent_id TEXT NOT NULL`；
- `token_ciphertext TEXT NOT NULL`；
- `token_iv TEXT NOT NULL`；
- `expires_at TEXT NOT NULL`；
- `updated_at TEXT NOT NULL`；
- 主键：`(corp_id, agent_id)`。

access token 使用由 `AUTH_SECRET` 通过 HKDF 派生的独立密钥进行 AES-GCM 加密。刷新采用数据库事务和唯一键 upsert，避免 Vercel 多实例把冷启动放大为重复刷新请求。

### 4.6 现有业务表兼容

当前 `videos.created_by_email`、`annotations.author_email`、`assignment_reviews.grader_email` 和 `audit_logs.actor_email` 已承担作者唯一键作用。本次不做高风险全表重构；认证用户写入 `users.identity_key`，姓名字段继续写入 `display_name`。

`CurrentUser` 明确提供 `identityKey`、`displayName`、可选 `email` 和 `avatarUrl`。业务代码使用 `identityKey` 做权限和唯一性比较，不再把企业邮箱当稳定主键。旧演示数据保留但不会映射到真实企业微信账号。

## 5. 授权与会话流程

### 5.1 电脑扫码

1. 未登录用户访问受保护页面；
2. 跳转 `/login?return_to=...`；
3. 用户点击扫码登录；
4. `/api/auth/wecom/start` 生成 state 与浏览器 nonce，保存其哈希；
5. 服务端重定向企业微信官方扫码授权页；
6. 用户扫码确认后，企业微信携带 code 与 state 回调；
7. 回调校验 state、nonce、有效期、流程类型和一次性消费状态；
8. 服务端换取 `UserId`，读取成员与部门；
9. 新增或更新用户和部门，创建会话；
10. 设置会话 Cookie 并跳回 `return_to`。

### 5.2 企业微信客户端内授权

登录页识别企业微信客户端后进入同一个 start 路由，并选择客户端网页授权 URL。回调后的身份同步、会话创建和安全校验与扫码流程相同。

### 5.3 退出

退出使用 `POST /api/auth/logout`。服务端校验请求来源，撤销当前数据库会话、清除 Cookie，再返回登录页。不得通过 GET 触发状态修改。

## 6. 路由

- `GET /login`：登录页；
- `GET /api/auth/wecom/start`：创建授权事务并重定向；
- `GET /api/auth/wecom/callback`：处理企业微信回调；
- `GET /api/auth/me`：返回当前成员的最小展示资料；
- `POST /api/auth/logout`：撤销当前会话；
- 现有页面：服务端校验会话；
- 现有业务 API：未认证统一返回 `401`。

授权入口只接受 `QR` 或 `IN_APP` 两种服务端判定的流程，不接受客户端传入任意企业微信 endpoint。

## 7. 环境变量

```env
APP_URL=https://hamark.boga.plus
AUTH_SECRET=至少32字节的高熵随机密钥
WECOM_CORP_ID=企业ID
WECOM_AGENT_ID=自建应用AgentId
WECOM_SECRET=自建应用Secret
```

`APP_URL` 是生成可信回调地址的唯一来源，生产环境不根据任意请求头拼接 OAuth 回调。所有变量只在服务端读取；`.env.example` 仅保留占位符。

企业微信管理后台需要把 `hamark.boga.plus` 配为应用可信域名和授权回调域。应用可见范围决定哪些成员允许登录。

## 8. 安全要求

- 不把 `WECOM_SECRET`、access token、OAuth code、会话令牌写入日志、响应或前端 bundle；
- state 和浏览器 nonce 使用密码学安全随机数，并使用常量时间比较；
- OAuth code 只能在通过 state 校验后交换；
- 会话固定攻击通过登录成功后创建全新令牌规避；
- Cookie 在生产环境强制 `Secure`；本地开发允许 HTTP，但不能启用生产密钥旁路；
- 所有写接口继续依赖服务端认证身份，不接受请求正文中的用户 ID、邮箱或姓名；
- 成员不在应用可见范围、被禁用或身份接口未返回 `UserId` 时拒绝登录；
- 错误页不显示企业微信原始响应、Secret、code、token 或数据库细节；
- 数据库迁移可重复执行，不删除现有业务数据；
- 新增认证表全部启用 PostgreSQL Row Level Security 且不创建匿名策略；应用只通过服务端数据库连接访问。

## 9. 错误处理

用户可见错误使用稳定错误码映射：

- `auth_cancelled`：用户取消或未确认；
- `auth_expired`：state 或 code 过期；
- `member_not_allowed`：成员不在应用可见范围；
- `profile_unavailable`：无法读取必要成员资料；
- `service_unavailable`：企业微信接口暂时不可用；
- `auth_misconfigured`：服务端环境变量或可信域配置错误。

服务端日志只记录内部请求 ID、阶段、企业微信错误码和耗时，不记录凭据或完整成员资料。

## 10. 测试

单元测试覆盖：

- 两类授权 URL 的固定参数和 URL 编码；
- `return_to` 白名单与开放重定向攻击；
- state、nonce、过期和一次性消费；
- 会话令牌哈希、创建、校验、撤销和过期；
- 企业微信响应解析与受控错误映射；
- `identity_key` 稳定性；
- 部门快照替换。

集成测试覆盖：

- 无 Cookie 的页面重定向；
- 伪造或过期 Cookie 无法通过服务端校验；
- 未认证业务 API 返回 `401`；
- 合法回调创建或更新用户并创建会话；
- 重放同一 state 失败；
- 退出后原会话立即失效；
- 现有上传、标注、提交和评分均使用真实身份键。

真实联调验收覆盖：

- Vercel Production 环境变量完整；
- 电脑扫码成功并返回原页面；
- 企业微信客户端内授权成功；
- 不在应用可见范围的成员不能进入；
- 姓名和部门正确，头像不可用时页面正常降级；
- 刷新、跨页面、会话过期和退出行为正确；
- 线上未登录 API 不再读写演示用户数据。

## 11. 发布顺序与回滚

1. 在 Supabase 执行新增表迁移；
2. 在 Vercel 配置五项环境变量；
3. 在企业微信后台配置可信域名、回调域和应用可见范围；
4. 部署代码并先用受控成员完成扫码与客户端联调；
5. 验证全站和所有 API 后再扩大应用可见范围。

发布采用一次性切换：新版本不提供演示身份回退。若真实授权不可用，回滚应用版本；新增表可保留，不影响旧业务表和既有数据。
