import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authFlowForUserAgent } from "@/lib/auth/routes";
import { safeReturnTo } from "@/lib/auth/security";
import { isLocalDemoMode } from "@/lib/local-demo";

type LoginPageProps = {
  searchParams: Promise<{ return_to?: string; error?: string }>;
};

const errorMessages: Record<string, string> = {
  auth_cancelled: "授权已取消，请重新扫码登录。",
  auth_expired: "登录已过期，请重新扫码。",
  member_not_allowed: "当前成员不在应用可见范围内。",
  profile_unavailable: "暂时无法读取成员资料。",
  service_unavailable: "登录服务暂时不可用。",
  auth_misconfigured: "登录配置尚未完成。",
  database_credentials_invalid: "数据库账号或密码不正确。",
  database_password_invalid: "数据库密码不正确。",
  database_pooler_identity_invalid: "数据库连接串的项目账号不正确。",
  database_schema_missing: "数据库表尚未初始化。",
  database_unreachable: "暂时无法连接数据库。",
  wecom_token_unavailable: "无法获取企业微信应用凭证，请检查应用 Secret。",
  wecom_untrusted_ip: "企业微信拒绝了服务器 IP，请配置企业可信 IP。",
  wecom_userinfo_unavailable: "企业微信未能确认扫码成员身份。",
  wecom_member_unavailable: "暂时无法读取企业微信成员资料。",
  wecom_department_unavailable: "暂时无法读取企业微信部门信息。",
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.return_to);
  const error = params.error ? errorMessages[params.error] : null;
  const requestHeaders = await headers();
  const localDemo = isLocalDemoMode();

  if (!localDemo && !error && authFlowForUserAgent(requestHeaders.get("user-agent")) === "IN_APP") {
    redirect(`/api/auth/wecom/start?return_to=${encodeURIComponent(returnTo)}`);
  }

  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="wordmark" aria-label="RE:VERSE">
          <span className="wordmark-mark">RE</span>
          <span>
            RE:VERSE
            <small>HAMARK</small>
          </span>
        </div>
        <h1>{localDemo ? "本机演示登录" : "企业微信登录"}</h1>
        {error ? <p className="login-error">{error}</p> : null}
        {localDemo ? (
          <div className="login-demo-actions">
            <form action="/api/auth/local-demo" method="post">
              <input type="hidden" name="profile" value="owner" />
              <input type="hidden" name="return_to" value={returnTo} />
              <button className="button button-dark login-action" type="submit">
                以案例作者进入
              </button>
            </form>
            <form action="/api/auth/local-demo" method="post">
              <input type="hidden" name="profile" value="reviewer" />
              <input type="hidden" name="return_to" value={returnTo} />
              <button className="button button-ghost login-action" type="submit">
                以评审同事进入
              </button>
            </form>
            <form action="/api/auth/local-demo" method="post">
              <input type="hidden" name="profile" value="peer" />
              <input type="hidden" name="return_to" value={returnTo} />
              <button className="button button-ghost login-action" type="submit">
                以协作同事进入
              </button>
            </form>
            <p className="login-demo-note">仅用于这台电脑的演示与验收，生产环境不会显示此入口。</p>
          </div>
        ) : (
          <a className="button button-dark login-action" href={`/api/auth/wecom/start?return_to=${encodeURIComponent(returnTo)}`}>
            企业微信扫码登录
          </a>
        )}
      </section>
    </main>
  );
}
