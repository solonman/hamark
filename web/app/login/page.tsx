import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authFlowForUserAgent } from "@/lib/auth/routes";
import { safeReturnTo } from "@/lib/auth/security";

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
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.return_to);
  const error = params.error ? errorMessages[params.error] : null;
  const requestHeaders = await headers();

  if (!error && authFlowForUserAgent(requestHeaders.get("user-agent")) === "IN_APP") {
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
        <h1>企业微信登录</h1>
        {error ? <p className="login-error">{error}</p> : null}
        <a className="button button-dark login-action" href={`/api/auth/wecom/start?return_to=${encodeURIComponent(returnTo)}`}>
          企业微信扫码登录
        </a>
      </section>
    </main>
  );
}
