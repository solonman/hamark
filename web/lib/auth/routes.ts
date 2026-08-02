import type { WeComAuthConfig } from "./config.ts";
import type { AuthError } from "./types.ts";

const errorCodes = new Set([
  "auth_cancelled",
  "auth_expired",
  "member_not_allowed",
  "profile_unavailable",
  "service_unavailable",
  "auth_misconfigured",
  "database_credentials_invalid",
  "database_schema_missing",
  "database_unreachable",
]);

const databaseErrorCodes = new Map([
  ["28P01", "database_credentials_invalid"],
  ["42P01", "database_schema_missing"],
  ["ECONNREFUSED", "database_unreachable"],
  ["ECONNRESET", "database_unreachable"],
  ["EAI_AGAIN", "database_unreachable"],
  ["ENETUNREACH", "database_unreachable"],
  ["ETIMEDOUT", "database_unreachable"],
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
    const code = String((error as AuthError).code);
    if (errorCodes.has(code)) {
      return code;
    }
    const databaseCode = databaseErrorCodes.get(code);
    if (databaseCode) {
      return databaseCode;
    }
  }

  const message = error instanceof Error ? error.message : "";
  if (/Missing required environment variable: DATABASE_URL/i.test(message)) {
    return "auth_misconfigured";
  }
  if (/password authentication failed|tenant or user not found|invalid (?:database )?(?:user|password)/i.test(message)) {
    return "database_credentials_invalid";
  }
  if (/relation .+ does not exist/i.test(message)) {
    return "database_schema_missing";
  }
  if (/connect(?:ion)? (?:terminated|timeout)|connection refused|ENETUNREACH|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT/i.test(message)) {
    return "database_unreachable";
  }
  return "service_unavailable";
}

export function isProductionAppUrl(config: Pick<WeComAuthConfig, "appUrl">) {
  return new URL(config.appUrl).protocol === "https:";
}
