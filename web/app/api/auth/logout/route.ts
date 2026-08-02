import { NextResponse, type NextRequest } from "next/server";
import { revokeToken, SESSION_COOKIE } from "@/lib/auth/session";
import { isProductionAppUrl, isTrustedOrigin } from "@/lib/auth/routes";
import { getAuthServices } from "@/lib/auth/server";

export async function POST(request: NextRequest) {
  const services = getAuthServices();
  if (!isTrustedOrigin(request.headers.get("origin"), services.config)) {
    return Response.json({ error: "请求来源无效" }, { status: 403 });
  }

  await revokeToken(services.store, request.cookies.get(SESSION_COOKIE)?.value ?? null);
  const response = NextResponse.json({ ok: true, redirectTo: "/login" });
  response.cookies.set(SESSION_COOKIE, "", {
    expires: new Date(0),
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: isProductionAppUrl(services.config),
  });
  return response;
}
