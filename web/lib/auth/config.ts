import { getOptionalEnv, getRequiredEnv } from "../env";

const MIN_AUTH_SECRET_BYTES = 32;

export type WeComAuthConfig = {
  appUrl: string;
  authSecret: string;
  corpId: string;
  agentId: string;
  secret: string | null;
  proxy: { url: string; secret: string } | null;
};

export function getWeComAuthConfig(): WeComAuthConfig {
  const appUrl = getRequiredEnv("APP_URL");
  const authSecret = getRequiredEnv("AUTH_SECRET");
  const corpId = getRequiredEnv("WECOM_CORP_ID");
  const agentId = getRequiredEnv("WECOM_AGENT_ID");
  const secret = getOptionalEnv("WECOM_SECRET") ?? null;
  const proxyUrl = getOptionalEnv("WECOM_PROXY_URL");
  const proxySecret = getOptionalEnv("WECOM_PROXY_SECRET");

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

  if (Boolean(proxyUrl) !== Boolean(proxySecret)) {
    throw new Error("WECOM_PROXY_URL and WECOM_PROXY_SECRET must be configured together.");
  }

  let proxy: WeComAuthConfig["proxy"] = null;
  if (proxyUrl && proxySecret) {
    const parsedProxyUrl = new URL(proxyUrl);
    if (parsedProxyUrl.protocol !== "http:" && parsedProxyUrl.protocol !== "https:") {
      throw new Error("WECOM_PROXY_URL must use HTTP or HTTPS.");
    }
    if (parsedProxyUrl.username || parsedProxyUrl.password) {
      throw new Error("WECOM_PROXY_URL must not include username or password.");
    }
    if (parsedProxyUrl.search || parsedProxyUrl.hash) {
      throw new Error("WECOM_PROXY_URL must not include query parameters or fragments.");
    }
    if (process.env.NODE_ENV !== "development" && parsedProxyUrl.protocol !== "https:") {
      throw new Error("WECOM_PROXY_URL must use HTTPS outside development.");
    }
    if (new TextEncoder().encode(proxySecret).byteLength < MIN_AUTH_SECRET_BYTES) {
      throw new Error("WECOM_PROXY_SECRET must contain at least 32 UTF-8 bytes.");
    }
    proxy = { url: proxyUrl, secret: proxySecret };
  }

  if (!secret && !proxy) {
    throw new Error("Either WECOM_SECRET or a complete WeCom proxy configuration is required.");
  }

  return { appUrl, authSecret, corpId, agentId, secret, proxy };
}
