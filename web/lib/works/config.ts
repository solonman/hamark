// 作品库（AdVault）的开关与配置（docs/27 第八节）。缺任何一项都当关着，页签不出现、端点 404。
import { getOptionalEnv } from "../env";
import { advaultEntryUrl } from "./sso";

const MIN_SECRET_BYTES = 32;

export type WorksConfig = {
  /** AdVault 的 origin，例如 https://advault.boga.plus */
  advaultOrigin: string;
  secret: string;
};

export function getWorksConfig(): WorksConfig | null {
  if (process.env.WORKS_LIBRARY_ENABLED !== "true") {
    return null;
  }
  const advaultUrl = getOptionalEnv("ADVAULT_URL");
  const secret = getOptionalEnv("ADVAULT_SSO_SECRET");
  if (!advaultUrl || !secret || new TextEncoder().encode(secret).byteLength < MIN_SECRET_BYTES) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(advaultUrl);
  } catch {
    return null;
  }
  const allowedProtocol = parsed.protocol === "https:" ||
    (process.env.NODE_ENV === "development" && parsed.protocol === "http:");
  if (!allowedProtocol) {
    return null;
  }
  return { advaultOrigin: parsed.origin, secret };
}

/** 顶栏「作品库」的链接；开关关着时为 null，这一项不出现。 */
export function worksLibraryUrl(): string | null {
  const config = getWorksConfig();
  return config ? advaultEntryUrl(config.advaultOrigin) : null;
}
