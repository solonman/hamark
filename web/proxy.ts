import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";

const publicPrefixes = [
  "/login",
  "/api/auth/logout",
  "/api/auth/wecom/start",
  "/api/auth/wecom/callback",
  "/_next/",
];

const publicExact = new Set(["/favicon.svg", "/og.png"]);

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
  return publicExact.has(pathname) || publicPrefixes.some((prefix) => pathname.startsWith(prefix));
}
