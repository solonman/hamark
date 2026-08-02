import { randomUUID } from "node:crypto";
import { hashToken, randomToken } from "./security.ts";
import type { AuthStore, CurrentUser } from "./store.ts";

export const SESSION_COOKIE = "hamark_session";
export const OAUTH_NONCE_COOKIE = "hamark_oauth_nonce";

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function createSession(
  store: AuthStore,
  user: CurrentUser,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_MS);
  await store.createSession({
    id: `session_${randomUUID()}`,
    userId: user.id,
    tokenHash: await hashToken(token),
    expiresAt: expiresAt.toISOString(),
    lastSeenAt: now.toISOString(),
    createdAt: now.toISOString(),
  });
  return { token, expiresAt };
}

export async function getUserForToken(
  store: AuthStore,
  token: string | null,
  now: Date = new Date(),
): Promise<CurrentUser | null> {
  if (!token) {
    return null;
  }
  return store.getSession(await hashToken(token), now.toISOString());
}

export async function revokeToken(
  store: AuthStore,
  token: string | null,
  now: Date = new Date(),
): Promise<void> {
  if (!token) {
    return;
  }
  await store.revokeSession(await hashToken(token), now.toISOString());
}

export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  return serializeCookie(SESSION_COOKIE, token, {
    expires: expiresAt,
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: "/",
  });
}

export function clearedSessionCookie(secure: boolean): string {
  return serializeCookie(SESSION_COOKIE, "", {
    expires: new Date(0),
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: "/",
  });
}

export function oauthNonceCookie(nonce: string, expiresAt: Date, secure: boolean): string {
  return serializeCookie(OAUTH_NONCE_COOKIE, nonce, {
    expires: expiresAt,
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: "/",
  });
}

export function clearedOAuthNonceCookie(secure: boolean): string {
  return serializeCookie(OAUTH_NONCE_COOKIE, "", {
    expires: new Date(0),
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: "/",
  });
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    expires: Date;
    httpOnly: boolean;
    sameSite: "Lax";
    secure: boolean;
    path: string;
  },
) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Expires=${options.expires.toUTCString()}`,
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}
