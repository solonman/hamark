import { NextResponse, type NextRequest } from "next/server";
import { completeWeComLogin } from "@/lib/auth/login";
import { OAUTH_NONCE_COOKIE, SESSION_COOKIE } from "@/lib/auth/session";
import { authErrorCode, callbackErrorLocation, isProductionAppUrl } from "@/lib/auth/routes";
import { getAuthServices } from "@/lib/auth/server";

export async function GET(request: NextRequest) {
  const services = getAuthServices();
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const nonce = request.cookies.get(OAUTH_NONCE_COOKIE)?.value ?? null;
  const secure = isProductionAppUrl(services.config);

  try {
    const result = await completeWeComLogin(
      {
        corpId: services.config.corpId,
        store: services.store,
        wecom: services.wecom,
      },
      { code: code ?? "", state: state ?? "", nonce },
    );
    const response = NextResponse.redirect(new URL(result.returnTo, services.config.appUrl));
    response.cookies.set(SESSION_COOKIE, result.token, {
      expires: result.expiresAt,
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure,
    });
    response.cookies.set(OAUTH_NONCE_COOKIE, "", {
      expires: new Date(0),
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure,
    });
    return response;
  } catch (error) {
    if (authErrorCode(error) === "service_unavailable") {
      console.error("WeCom callback failed", { requestId: crypto.randomUUID() });
    }
    const response = NextResponse.redirect(
      new URL(callbackErrorLocation(services.config, authErrorCode(error), code), services.config.appUrl),
    );
    response.cookies.set(OAUTH_NONCE_COOKIE, "", {
      expires: new Date(0),
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure,
    });
    return response;
  }
}
