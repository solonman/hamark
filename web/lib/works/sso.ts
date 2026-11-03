// 作品库（AdVault）统一登录的票据签发（docs/27 第五节）。纯函数，路由和测试共用。
// 票据格式两站必须逐字一致：AdVault 侧的校验在 solonman/AdVault 的 src/lib/hamark-sso.ts。
import { createHmac, randomUUID } from "node:crypto";

export const ADVAULT_TICKET_VERSION = 1;
export const ADVAULT_TICKET_TTL_SECONDS = 60;
/** AdVault 接票据的固定落点；不接受外部传入的跳转路径。 */
export const ADVAULT_TICKET_LANDING_PATH = "/sso/hamark";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const RETURN_PATH_MAX_LENGTH = 2048;

export type AdvaultTicketPayload = {
  v: typeof ADVAULT_TICKET_VERSION;
  iss: string;
  aud: string;
  corp: string;
  sub: string;
  name: string;
  avatar: string | null;
  email: string | null;
  nonce: string;
  rt: string;
  iat: number;
  exp: number;
  jti: string;
};

export function isValidAdvaultNonce(value: string | null | undefined): value is string {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

/** AdVault 站内的相对路径。AdVault 收到后还会再过一遍自己的 normalizeAuthRedirectPath。 */
export function safeAdvaultReturnPath(value: string | null | undefined): string {
  if (
    !value ||
    value.length > RETURN_PATH_MAX_LENGTH ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\u0000-\u001f\\]/u.test(value)
  ) {
    return "/";
  }
  return value;
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function signAdvaultTicket(input: {
  secret: string;
  issuer: string;
  audience: string;
  corpId: string;
  userId: string;
  name: string;
  avatar: string | null;
  email: string | null;
  nonce: string;
  returnPath: string;
  now?: Date;
  jti?: string;
}): string {
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const payload: AdvaultTicketPayload = {
    v: ADVAULT_TICKET_VERSION,
    iss: input.issuer,
    aud: input.audience,
    corp: input.corpId,
    sub: input.userId,
    name: input.name,
    avatar: input.avatar,
    email: input.email,
    nonce: input.nonce,
    rt: safeAdvaultReturnPath(input.returnPath),
    iat,
    exp: iat + ADVAULT_TICKET_TTL_SECONDS,
    jti: input.jti ?? randomUUID(),
  };
  const body = base64Url(JSON.stringify(payload));
  const signature = base64Url(createHmac("sha256", input.secret).update(body).digest());
  return `${body}.${signature}`;
}

export function advaultTicketLocation(advaultOrigin: string, ticket: string): string {
  return `${advaultOrigin}${ADVAULT_TICKET_LANDING_PATH}#ticket=${ticket}`;
}

/** 顶栏「作品库」的链接：从 AdVault 发起，nonce 由它种（docs/27 第四节）。 */
export function advaultEntryUrl(advaultOrigin: string): string {
  return `${advaultOrigin}/api/auth/hamark/start?callbackUrl=%2F`;
}
