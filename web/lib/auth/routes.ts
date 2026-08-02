import type { WeComAuthConfig } from "./config.ts";
import type { AuthError } from "./types.ts";

const errorCodes = new Set([
  "auth_cancelled",
  "auth_expired",
  "member_not_allowed",
  "profile_unavailable",
  "service_unavailable",
  "auth_misconfigured",
]);

export function authFlowForUserAgent(userAgent: string | null) {
  return /wxwork/i.test(userAgent ?? "") ? "IN_APP" : "QR";
}

export function isTrustedOrigin(origin: string | null, config: Pick<WeComAuthConfig, "appUrl">) {
  if (!origin) {
    return false;
  }
  try {
    return new URL(origin).origin === new URL(config.appUrl).origin;
  } catch {
    return false;
  }
}

export function callbackErrorLocation(
  _config: Pick<WeComAuthConfig, "appUrl">,
  code: string,
  oauthCode: string | null,
) {
  void oauthCode;
  const stableCode = errorCodes.has(code) ? code : "service_unavailable";
  return `/login?error=${stableCode}`;
}

export function authErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as AuthError).code;
    return errorCodes.has(code) ? code : "service_unavailable";
  }
  return "service_unavailable";
}

export function isProductionAppUrl(config: Pick<WeComAuthConfig, "appUrl">) {
  return new URL(config.appUrl).protocol === "https:";
}
