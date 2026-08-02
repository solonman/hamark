import type { NextRequest } from "next/server";
import { getUserForToken, SESSION_COOKIE } from "@/lib/auth/session";
import { getAuthServices } from "@/lib/auth/server";

export async function GET(request: NextRequest) {
  const services = getAuthServices();
  const user = await getUserForToken(
    services.store,
    request.cookies.get(SESSION_COOKIE)?.value ?? null,
  );
  if (!user) {
    return Response.json({ error: "请先登录" }, { status: 401 });
  }

  return Response.json({
    user: {
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      departments: user.departments,
    },
  });
}
