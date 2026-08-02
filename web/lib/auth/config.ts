import { getRequiredEnv } from "../env";

const MIN_AUTH_SECRET_BYTES = 32;

export type WeComAuthConfig = {
  appUrl: string;
  authSecret: string;
  corpId: string;
  agentId: string;
  secret: string;
};

export function getWeComAuthConfig(): WeComAuthConfig {
  const appUrl = getRequiredEnv("APP_URL");
  const authSecret = getRequiredEnv("AUTH_SECRET");
  const corpId = getRequiredEnv("WECOM_CORP_ID");
  const agentId = getRequiredEnv("WECOM_AGENT_ID");
  const secret = getRequiredEnv("WECOM_SECRET");

  const parsedAppUrl = new URL(appUrl);
  if (parsedAppUrl.protocol !== "http:" && parsedAppUrl.protocol !== "https:") {
    throw new Error("APP_URL must use HTTP or HTTPS.");
  }

  if (process.env.NODE_ENV !== "development" && parsedAppUrl.protocol !== "https:") {
    throw new Error("APP_URL must use HTTPS outside development.");
  }

  if (new TextEncoder().encode(authSecret).byteLength < MIN_AUTH_SECRET_BYTES) {
    throw new Error("AUTH_SECRET must contain at least 32 UTF-8 bytes.");
  }

  return { appUrl, authSecret, corpId, agentId, secret };
}
