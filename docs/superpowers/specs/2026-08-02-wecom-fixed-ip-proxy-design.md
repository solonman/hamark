# 企业微信固定 IP 代理设计

日期：2026-08-02  
状态：已确认，待实施

## 1. 目标与范围

为部署在 Vercel 的 Hamark 企业微信登录增加固定出口 IP，解决企业微信错误码 `60020`。企业微信服务端 API 由腾讯云服务器 `111.229.151.122` 代为调用；OAuth 授权入口、回调、用户会话、Supabase 和 COS 继续由现有 Hamark 应用负责。

本次只代理登录所需的成员身份读取，不建设通用企业微信 API 网关，也不修改该服务器上的 BOGACLAW、OpenClaw 或 Advault 服务。

## 2. 技术决策

采用独立的 Hamark 业务代理，而不是复用服务器现有的公开 `/cgi-bin/` 透明转发。

原因：现有 Advault 代理证明固定 IP 路线可用，但其公网 HTTP 通配转发会让企业微信 Secret、access token 和授权 code 出现在 URL 与 Nginx 访问日志中。Hamark 代理只接受一个受签名保护的业务请求，并在服务器内部完成 token、成员和部门查询，不向 Vercel 返回 access token。

## 3. 组件与边界

### 3.1 Hamark Vercel 应用

现有 `/api/auth/wecom/start` 和 `/api/auth/wecom/callback` 保持不变。回调校验 OAuth state 后，`WeComClient` 把一次性授权 `code` 通过 HTTPS POST 发给固定 IP 代理，接收最小化成员资料，再执行现有用户同步和会话创建。

Vercel 不再直接请求 `qyapi.weixin.qq.com`，生产环境也不再需要保存 `WECOM_SECRET`。授权 URL 仍需要 `WECOM_CORP_ID` 和 `WECOM_AGENT_ID`。

### 3.2 固定 IP 代理

代理作为独立 Node.js 服务部署在 `111.229.151.122`：

- 独立目录，不读取 BOGACLAW 或 Advault 文件；
- 仅监听 `127.0.0.1:3201`，公网不能直接访问进程端口；
- 只提供 `POST /v1/member-by-code` 和不含敏感信息的 `GET /health`；
- 使用服务器环境变量保存企业 ID、应用 Secret 和代理签名密钥；
- 在内存中缓存企业微信 access token，并在过期前五分钟刷新；
- 调用 `gettoken`、`user/getuserinfo`、`user/get` 和 `department/simplelist`；
- 只返回 Hamark 需要的成员 ID、姓名、头像、邮箱和部门；
- 通过独立 systemd 服务启动、自动重启并限制运行权限。

### 3.3 Nginx 与域名

新增 HTTPS 子域名 `hamark-wecom.boga.plus`，A 记录指向 `111.229.151.122`。Nginx 终止 TLS，并只把该域名的请求转发到 `127.0.0.1:3201`。

该虚拟主机使用独立配置和证书，不修改 BOGACLAW、OpenClaw、Advault 的 server block。访问日志使用不包含查询参数和请求头的格式；代理业务请求使用 POST JSON，避免敏感值进入 URL。

## 4. 请求协议

Vercel 请求体：

```json
{"code":"企业微信一次性授权码"}
```

请求头：

- `Content-Type: application/json`；
- `X-Hamark-Timestamp`：Unix 秒；
- `X-Hamark-Signature`：`HMAC-SHA256(secret, timestamp + "." + rawBody)` 的十六进制值。

代理必须验证：

- 时间戳与服务器时间相差不超过 60 秒；
- 签名长度正确并使用常量时间比较；
- JSON 正文大小不超过 4 KiB；
- `code` 是非空字符串且长度不超过 512；
- Content-Type、HTTP 方法和路径完全匹配。

成功响应：

```json
{
  "ok": true,
  "member": {
    "userId": "zhangsan",
    "displayName": "张三",
    "avatarUrl": null,
    "email": null,
    "departments": [
      {"id": "1", "name": "市场部", "isPrimary": true}
    ]
  }
}
```

失败只返回稳定错误码，不返回企业微信原始响应、Secret、token、code 或成员资料：

- `INVALID_REQUEST`：方法、正文或字段无效；
- `INVALID_SIGNATURE`：签名或时间戳无效；
- `AUTH_EXPIRED`：授权 code 无效或过期；
- `MEMBER_NOT_ALLOWED`：成员不可见、禁用或无权访问应用；
- `PROFILE_UNAVAILABLE`：必要成员资料缺失；
- `WECOM_UNAVAILABLE`：企业微信网络或服务异常；
- `PROXY_MISCONFIGURED`：代理端环境变量错误。

## 5. 环境变量

Vercel Production：

```env
WECOM_PROXY_URL=https://hamark-wecom.boga.plus
WECOM_PROXY_SECRET=至少32字节的高熵随机密钥
```

Vercel 保留 `APP_URL`、`AUTH_SECRET`、`WECOM_CORP_ID` 和 `WECOM_AGENT_ID`。代理启用后移除 Vercel 的 `WECOM_SECRET`，避免同一高权限凭据散落在两个平台。

固定 IP 服务器：

```env
WECOM_CORP_ID=企业ID
WECOM_SECRET=Hamark自建应用Secret
WECOM_PROXY_SECRET=与Vercel一致的高熵随机密钥
PORT=3201
HOST=127.0.0.1
```

服务器环境文件权限设为 `0600`，由代理专用系统用户读取。密钥不写入 Git、systemd unit、Nginx 配置或命令行参数。

## 6. 安全与可靠性

- 企业微信后台将 Hamark 应用的可信 IP 设置为 `111.229.151.122`；
- Vercel 到代理、代理到企业微信均使用 HTTPS；
- 代理不提供任意上游 URL、任意路径或原始转发能力；
- HMAC 请求有效期为 60 秒，降低被截获请求的重放窗口；
- Nginx 对业务接口设置小请求体、超时和每 IP 限速；
- 代理请求企业微信的超时为 8 秒，不对一次性 OAuth code 请求盲目重试；
- access token 只存在代理进程内存，日志不记录 token、Secret、code、完整请求体或完整企业微信响应；
- systemd 使用专用低权限用户、自动重启、只读文件系统和最小写目录；
- 健康检查只报告进程是否可用，不检查或泄露企业微信配置值。

## 7. 错误映射与回滚

Hamark 将代理错误码映射到现有 `AuthError`，继续使用当前登录页错误提示。网络超时、非 JSON、无效签名响应和代理 `5xx` 均映射为登录服务暂不可用。

上线顺序：先部署并验证代理健康检查，再配置 DNS 和 TLS，再向企业微信添加可信 IP，最后在 Vercel 配置代理变量并重新部署。回滚只需移除 Vercel 的 `WECOM_PROXY_URL` 和 `WECOM_PROXY_SECRET` 并恢复 `WECOM_SECRET`；代理服务可独立停止，不影响 BOGACLAW 或 Advault。

## 8. 测试与验收

自动测试覆盖：

- HMAC 签名固定向量、错误签名、过期时间戳和常量时间比较路径；
- 请求体大小、字段类型、code 长度和方法限制；
- 企业微信四个接口的成功解析与 token 缓存；
- 企业微信常见错误到稳定代理错误码的映射；
- Hamark `WeComClient` 只调用代理且不直接请求企业微信；
- 代理异常不泄露 code、token 或 Secret；
- 现有登录、会话和访问控制测试继续通过。

生产验收包括：

1. `https://hamark-wecom.boga.plus/health` 返回健康状态；
2. 未签名和过期签名请求返回 `401`；
3. Nginx 与服务日志不出现查询参数、Secret、access token 或授权 code；
4. 桌面浏览器扫码后成功登录 Hamark；
5. 企业微信客户端内授权成功；
6. BOGACLAW、OpenClaw 和 Advault 的现有健康检查与登录不受影响。

## 9. 非目标

- 不把 Hamark 全站迁移到腾讯云服务器；
- 不建设多应用、多租户或通用企业微信代理；
- 不复用或修改 Advault 的 `WECOM_API_PROXY`；
- 不将 Supabase、COS 或会话逻辑迁入代理；
- 不在本次工作中修复 Advault 现有公开转发，相关风险单独处理。
