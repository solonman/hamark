import { NextResponse, type NextRequest } from "next/server";
import { getDbClient, type QueryResultRow } from "@/db";
import { getAuthServices } from "@/lib/auth/server";
import { getUserForToken, SESSION_COOKIE } from "@/lib/auth/session";
import { safeReturnTo } from "@/lib/auth/security";
import { getWorksConfig } from "@/lib/works/config";
import { advaultTicketLocation, isValidAdvaultNonce, safeAdvaultReturnPath, signAdvaultTicket } from "@/lib/works/sso";

// 作品库统一登录（docs/27 5.4）：AdVault 带着 nonce 跳来，这里确认是谁，签 60 秒票据跳回。
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

export async function GET(request: NextRequest) {
  const works = getWorksConfig();
  if (!works) {
    return Response.json({ error: "作品库未开放。" }, { status: 404, headers: NO_STORE_HEADERS });
  }

  const nonce = request.nextUrl.searchParams.get("nonce");
  if (!isValidAdvaultNonce(nonce)) {
    return Response.json({ error: "登录请求无效，请回到作品库重试。" }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const returnPath = safeAdvaultReturnPath(request.nextUrl.searchParams.get("return_to"));

  const services = getAuthServices();
  const user = await getUserForToken(services.store, request.cookies.get(SESSION_COOKIE)?.value ?? null);
  if (!user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = `?return_to=${encodeURIComponent(safeReturnTo(`${request.nextUrl.pathname}${request.nextUrl.search}`))}`;
    return NextResponse.redirect(loginUrl, { headers: NO_STORE_HEADERS });
  }

  // 会话里的 CurrentUser 只带 identity_key（哈希），票据要的是企微原始 userid。
  const identity = await getDbClient()
    .prepare(`SELECT wecom_corp_id, wecom_user_id FROM users WHERE id = ?`)
    .bind(user.id)
    .first<{ wecom_corp_id: string; wecom_user_id: string } & QueryResultRow>();
  if (!identity) {
    return Response.json({ error: "找不到当前账号，请重新登录。" }, { status: 401, headers: NO_STORE_HEADERS });
  }

  const ticket = signAdvaultTicket({
    secret: works.secret,
    issuer: new URL(services.config.appUrl).origin,
    audience: works.advaultOrigin,
    corpId: identity.wecom_corp_id,
    userId: identity.wecom_user_id,
    name: user.displayName,
    avatar: user.avatarUrl,
    email: user.email,
    nonce,
    returnPath,
  });
  return new Response(null, {
    status: 302,
    headers: { ...NO_STORE_HEADERS, Location: advaultTicketLocation(works.advaultOrigin, ticket) },
  });
}
