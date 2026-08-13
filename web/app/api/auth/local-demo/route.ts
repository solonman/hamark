import { NextResponse, type NextRequest } from "next/server";
import { isTrustedOrigin } from "@/lib/auth/routes";
import { getAuthServices } from "@/lib/auth/server";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { safeReturnTo } from "@/lib/auth/security";
import { isLocalDemoMode } from "@/lib/local-demo";

const profiles = {
  owner: {
    userId: "owner",
    identityKey: "demo@reverse.local",
    displayName: "老孙",
    departmentName: "创意训练组",
  },
  reviewer: {
    userId: "reviewer",
    identityKey: "reviewer@reverse.local",
    displayName: "演示同事",
    departmentName: "创意评审组",
  },
  peer: {
    userId: "peer",
    identityKey: "peer@reverse.local",
    displayName: "协作同事",
    departmentName: "创意学习组",
  },
} as const;

export async function POST(request: NextRequest) {
  if (!isLocalDemoMode()) {
    return Response.json({ error: "本机演示登录未开启。" }, { status: 404 });
  }

  const services = getAuthServices();
  if (!isTrustedOrigin(request.headers.get("origin"), services.config)) {
    return Response.json({ error: "请求来源无效。" }, { status: 403 });
  }

  const form = await request.formData();
  const requestedProfile = String(form.get("profile") ?? "");
  const profileKey = requestedProfile === "reviewer" || requestedProfile === "peer"
    ? requestedProfile
    : "owner";
  const profile = profiles[profileKey];
  const now = new Date();
  const user = await services.store.syncUser(
    "local-demo",
    {
      userId: profile.userId,
      displayName: profile.displayName,
      avatarUrl: null,
      email: profile.identityKey,
      departments: [
        {
          id: profileKey,
          name: profile.departmentName,
          isPrimary: true,
        },
      ],
    },
    profile.identityKey,
    now.toISOString(),
  );
  const session = await createSession(services.store, user, now);
  const returnTo = safeReturnTo(String(form.get("return_to") || "/"));
  const response = NextResponse.redirect(new URL(returnTo, services.config.appUrl), 303);
  response.cookies.set(SESSION_COOKIE, session.token, {
    expires: session.expiresAt,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: false,
  });
  return response;
}
