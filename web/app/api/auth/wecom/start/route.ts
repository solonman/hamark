import { NextResponse, type NextRequest } from "next/server";
import { beginWeComLogin } from "@/lib/auth/login";
import { OAUTH_NONCE_COOKIE } from "@/lib/auth/session";
import { getAuthServices } from "@/lib/auth/server";
import { authErrorCode, authFlowForUserAgent, isProductionAppUrl } from "@/lib/auth/routes";
import { safeReturnTo } from "@/lib/auth/security";

export async function GET(request: NextRequest) {
  try {
    const services = getAuthServices();
    const result = await beginWeComLogin(
      {
        config: services.config,
        corpId: services.config.corpId,
        store: services.store,
        wecom: services.wecom,
      },
      {
        flow: authFlowForUserAgent(request.headers.get("user-agent")),
        returnTo: safeReturnTo(request.nextUrl.searchParams.get("return_to")),
      },
    );
    const response = NextResponse.redirect(result.authorizationUrl);
    response.cookies.set(OAUTH_NONCE_COOKIE, result.nonce, {
      expires: result.nonceExpiresAt,
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: isProductionAppUrl(services.config),
    });
    return response;
  } catch (error) {
    console.error("WeCom login start failed", { error });
    return NextResponse.redirect(`/login?error=${authErrorCode(error)}`);
  }
}
