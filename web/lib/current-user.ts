import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isTrustedOrigin } from "@/lib/auth/routes";
import { getAuthServices } from "@/lib/auth/server";
import { getUserForToken, SESSION_COOKIE } from "@/lib/auth/session";
import { safeReturnTo } from "@/lib/auth/security";
import type { CurrentUser } from "@/lib/auth/types";

export type { CurrentUser } from "@/lib/auth/types";

export async function getCurrentUserFromRequest(request: Request): Promise<CurrentUser | null> {
  const cookieHeader = request.headers.get("cookie");
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  return getUserForToken(getAuthServices().store, token);
}

export async function requireApiUser(request: Request): Promise<CurrentUser | Response> {
  const user = await getCurrentUserFromRequest(request);
  if (user) {
    return user;
  }

  const url = new URL(request.url);
  const returnTo = safeReturnTo(`${url.pathname}${url.search}`);
  return Response.json(
    { error: "请先登录", loginUrl: `/login?return_to=${encodeURIComponent(returnTo)}` },
    { status: 401 },
  );
}

export function requireSameOriginMutation(request: Request): Response | null {
  if (isTrustedOrigin(request.headers.get("origin"), getAuthServices().config)) {
    return null;
  }

  return Response.json({ error: "请求来源不被允许。" }, { status: 403 });
}

export async function requirePageUser(returnTo: string): Promise<CurrentUser> {
  const cookieStore = await cookies();
  const user = await getUserForToken(
    getAuthServices().store,
    cookieStore.get(SESSION_COOKIE)?.value ?? null,
  );
  if (user) {
    return user;
  }
  redirect(`/login?return_to=${encodeURIComponent(safeReturnTo(returnTo))}`);
}

export function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function readCookie(header: string | null, name: string) {
  if (!header) {
    return null;
  }

  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return null;
}
