import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";

const publicExact = new Set([
  "/login",
  "/api/auth/logout",
  "/api/auth/local-demo",
  "/api/auth/wecom/start",
  "/api/auth/wecom/callback",
  "/favicon.svg",
  "/og.png",
]);

// /api/agent/ 不靠会话 Cookie，由 lib/agent-api/route.ts 逐请求校验 Bearer 令牌。
const publicPrefixes = ["/_next/", "/api/agent/"];

// 复盘库月度整理的内部接力（docs/26 6.3）：服务端自己发起、不带会话 Cookie，由路由逐请求校验 HMAC 令牌。
const publicPatterns = [/^\/api\/retro-months\/[^/]+\/jobs\/[^/]+\/advance$/];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname) || request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return Response.json(
      { error: "请先登录", loginUrl: `/login?return_to=${encodeURIComponent(pathname + search)}` },
      { status: 401 },
    );
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = `?return_to=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!.*\\.[\\w]+$).*)", "/api/:path*"],
};

function isPublicPath(pathname: string) {
  return publicExact.has(pathname)
    || publicPrefixes.some((prefix) => pathname.startsWith(prefix))
    || publicPatterns.some((pattern) => pattern.test(pathname));
}
