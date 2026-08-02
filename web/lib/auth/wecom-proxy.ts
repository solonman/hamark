import { createHmac } from "node:crypto";
import type { WeComAuthConfig } from "./config.ts";
import { AuthError, type WeComMember } from "./types.ts";

const FETCH_TIMEOUT_MS = 8000;

type ProxyOptions = {
  code: string;
  proxy: NonNullable<WeComAuthConfig["proxy"]>;
  fetchImpl: typeof fetch;
  now: () => Date;
};

export async function fetchMemberFromProxy(options: ProxyOptions): Promise<WeComMember> {
  const rawBody = JSON.stringify({ code: options.code });
  const timestamp = String(Math.floor(options.now().getTime() / 1000));
  const signature = createHmac("sha256", options.proxy.secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  let response: Response;
  try {
    response = await options.fetchImpl(buildProxyUrl(options.proxy.url).toString(), {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "X-Hamark-Timestamp": timestamp,
        "X-Hamark-Signature": signature,
      },
      body: rawBody,
      signal: createTimeoutSignal(),
    });
  } catch {
    throw proxyUnavailable("WeCom proxy request failed.");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw proxyUnavailable("WeCom proxy response was invalid.");
  }

  if (!isRecord(body)) {
    throw proxyUnavailable("WeCom proxy response was invalid.");
  }

  if (response.ok && body.ok === true) {
    return readMember(body.member);
  }

  if (body.ok === false) {
    throw mapProxyError(body.error);
  }

  throw proxyUnavailable("WeCom proxy response was invalid.");
}

function buildProxyUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/member-by-code`;
  url.search = "";
  url.hash = "";
  return url;
}

function readMember(value: unknown): WeComMember {
  if (!isRecord(value)) {
    throw proxyUnavailable("WeCom proxy response was invalid.");
  }

  const userId = readRequiredString(value.userId);
  const displayName = readRequiredString(value.displayName);
  const avatarUrl = readNullableString(value.avatarUrl);
  const email = readNullableString(value.email);
  if (!userId || !displayName || avatarUrl === undefined || email === undefined) {
    throw proxyUnavailable("WeCom proxy response was invalid.");
  }
  if (!Array.isArray(value.departments)) {
    throw proxyUnavailable("WeCom proxy response was invalid.");
  }

  const departments = value.departments.map((department) => {
    if (!isRecord(department)) {
      throw proxyUnavailable("WeCom proxy response was invalid.");
    }
    const id = readRequiredString(department.id);
    const name = readRequiredString(department.name);
    if (!id || !name || typeof department.isPrimary !== "boolean") {
      throw proxyUnavailable("WeCom proxy response was invalid.");
    }
    return { id, name, isPrimary: department.isPrimary };
  });

  return { userId, displayName, avatarUrl, email, departments };
}

function mapProxyError(value: unknown): AuthError {
  if (value === "AUTH_EXPIRED") {
    return new AuthError("auth_expired", "WeCom authorization has expired.");
  }
  if (value === "MEMBER_NOT_ALLOWED") {
    return new AuthError(
      "member_not_allowed",
      "WeCom member is not allowed to access this application.",
    );
  }
  if (value === "PROFILE_UNAVAILABLE") {
    return new AuthError("profile_unavailable", "WeCom member profile is unavailable.");
  }
  return proxyUnavailable("WeCom proxy request failed.");
}

function proxyUnavailable(message: string): AuthError {
  return new AuthError("service_unavailable", message);
}

function readRequiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return readRequiredString(value) ?? undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createTimeoutSignal(): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(FETCH_TIMEOUT_MS);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return controller.signal;
}
