import type { WeComAuthConfig } from "./config.ts";
import { decryptSecret, encryptSecret } from "./security.ts";
import type { AuthStore, EncryptedAppToken } from "./store.ts";
import { AuthError, type AuthFlow, type WeComMember } from "./types.ts";

const WECOM_API_BASE = "https://qyapi.weixin.qq.com/cgi-bin";
const QR_AUTH_URL = "https://open.work.weixin.qq.com/wwopen/sso/qrConnect";
const IN_APP_AUTH_URL = "https://open.weixin.qq.com/connect/oauth2/authorize";
const CALLBACK_PATH = "/api/auth/wecom/callback";
const FETCH_TIMEOUT_MS = 8000;
const TOKEN_REFRESH_SKEW_MS = 300_000;

type WeComJson = Record<string, unknown> & {
  errcode?: unknown;
  errmsg?: unknown;
};

type MemberProfile = {
  userid?: unknown;
  name?: unknown;
  avatar?: unknown;
  thumb_avatar?: unknown;
  email?: unknown;
  department?: unknown;
  main_department?: unknown;
};

type DepartmentProfile = {
  id?: unknown;
  name?: unknown;
};

export function buildWeComAuthorizationUrl(
  config: WeComAuthConfig,
  flow: AuthFlow,
  state: string,
): string {
  const callbackUrl = new URL(CALLBACK_PATH, config.appUrl).toString();

  if (flow === "QR") {
    const url = new URL(QR_AUTH_URL);
    url.searchParams.set("appid", config.corpId);
    url.searchParams.set("agentid", config.agentId);
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("state", state);
    return url.toString();
  }

  const url = new URL(IN_APP_AUTH_URL);
  url.searchParams.set("appid", config.corpId);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "snsapi_base");
  url.searchParams.set("state", state);
  url.searchParams.set("agentid", config.agentId);
  return `${url.toString()}#wechat_redirect`;
}

export class WeComClient {
  private readonly config: WeComAuthConfig;
  private readonly store: AuthStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: {
    config: WeComAuthConfig;
    store: AuthStore;
    fetchImpl?: typeof fetch;
    now?: () => Date;
  }) {
    this.config = options.config;
    this.store = options.store;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getMemberByCode(code: string): Promise<WeComMember> {
    const accessToken = await this.getAppToken();
    const userInfo = await this.fetchJson("userinfo", buildUserInfoUrl(accessToken, code));
    const userId = readString(userInfo.UserId);
    if (!userId) {
      throw new AuthError("member_not_allowed", "WeCom member is not available for this application.");
    }

    const profile = (await this.fetchJson(
      "member",
      buildMemberUrl(accessToken, userId),
    )) as MemberProfile & WeComJson;
    assertUsableProfile(profile);
    const departments = await this.fetchDepartments(accessToken);

    return mapMember(profile, departments);
  }

  private async getAppToken(): Promise<string> {
    const cached = await this.readFreshCachedToken();
    if (cached) {
      return cached;
    }

    return this.store.withAppTokenRefreshLock(this.config.corpId, this.config.agentId, async () => {
      const rechecked = await this.readFreshCachedToken();
      if (rechecked) {
        return rechecked;
      }

      const body = await this.fetchJson("token", buildTokenUrl(this.config));
      const token = readString(body.access_token);
      const expiresIn = readPositiveNumber(body.expires_in);
      if (!token || !expiresIn) {
        throw new AuthError("auth_misconfigured", "Unable to obtain WeCom application token.");
      }

      const now = this.now();
      const record: EncryptedAppToken = {
        corpId: this.config.corpId,
        agentId: this.config.agentId,
        token: await encryptSecret(token, this.config.authSecret),
        expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
        updatedAt: now.toISOString(),
      };
      await this.store.putAppToken(record);
      return token;
    });
  }

  private async readFreshCachedToken(): Promise<string | null> {
    const now = this.now();
    const record = await this.store.getAppToken(
      this.config.corpId,
      this.config.agentId,
      now.toISOString(),
    );
    if (!record || !isTokenFresh(record, now)) {
      return null;
    }
    return decryptSecret(record.token, this.config.authSecret);
  }

  private async fetchDepartments(accessToken: string): Promise<Map<string, string>> {
    const body = await this.fetchJson("department", buildDepartmentUrl(accessToken));
    const items = Array.isArray(body.department_id)
      ? body.department_id
      : Array.isArray(body.department)
        ? body.department
        : [];
    const names = new Map<string, string>();

    for (const item of items) {
      if (!isRecord(item)) {
        continue;
      }
      const id = readId((item as DepartmentProfile).id);
      const name = readString((item as DepartmentProfile).name);
      if (id && name && !names.has(id)) {
        names.set(id, name);
      }
    }

    return names;
  }

  private async fetchJson(kind: WeComEndpointKind, url: URL): Promise<WeComJson> {
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: "GET",
        signal: createTimeoutSignal(),
      });
    } catch {
      throw new AuthError("service_unavailable", `WeCom ${kind} request failed.`);
    }

    if (!response.ok) {
      throw new AuthError("service_unavailable", `WeCom ${kind} request failed.`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AuthError("service_unavailable", `WeCom ${kind} response was invalid.`);
    }

    if (!isRecord(body)) {
      throw new AuthError("service_unavailable", `WeCom ${kind} response was invalid.`);
    }

    const json = body as WeComJson;
    const errcode = readErrcode(json.errcode);
    if (errcode !== 0) {
      throw mapWeComError(kind, errcode);
    }

    return json;
  }
}

type WeComEndpointKind = "token" | "userinfo" | "member" | "department";

function buildTokenUrl(config: WeComAuthConfig): URL {
  const url = new URL(`${WECOM_API_BASE}/gettoken`);
  url.searchParams.set("corpid", config.corpId);
  url.searchParams.set("corpsecret", config.secret);
  return url;
}

function buildUserInfoUrl(accessToken: string, code: string): URL {
  const url = new URL(`${WECOM_API_BASE}/user/getuserinfo`);
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("code", code);
  return url;
}

function buildMemberUrl(accessToken: string, userId: string): URL {
  const url = new URL(`${WECOM_API_BASE}/user/get`);
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("userid", userId);
  return url;
}

function buildDepartmentUrl(accessToken: string): URL {
  const url = new URL(`${WECOM_API_BASE}/department/simplelist`);
  url.searchParams.set("access_token", accessToken);
  return url;
}

function isTokenFresh(record: EncryptedAppToken, now: Date): boolean {
  return new Date(record.expiresAt).getTime() - now.getTime() > TOKEN_REFRESH_SKEW_MS;
}

function createTimeoutSignal(): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(FETCH_TIMEOUT_MS);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return controller.signal;
}

function mapMember(profile: MemberProfile & WeComJson, departmentNames: Map<string, string>): WeComMember {
  const userId = readString(profile.userid);
  const displayName = readString(profile.name);
  if (!userId || !displayName) {
    throw new AuthError("profile_unavailable", "WeCom member profile is unavailable.");
  }

  const departmentIds = Array.isArray(profile.department)
    ? profile.department.map(readId).filter((id): id is string => Boolean(id))
    : [];
  const primaryDepartmentId = readId(profile.main_department);
  const seen = new Set<string>();
  const dedupedDepartmentIds = departmentIds.filter((id) => {
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
  const fallbackPrimaryId = primaryDepartmentId ?? dedupedDepartmentIds[0] ?? null;

  return {
    userId,
    displayName,
    avatarUrl: readString(profile.avatar) ?? readString(profile.thumb_avatar),
    email: readString(profile.email),
    departments: dedupedDepartmentIds.map((id) => ({
      id,
      name: departmentNames.get(id) ?? `部门 ${id}`,
      isPrimary: id === fallbackPrimaryId,
    })),
  };
}

function assertUsableProfile(profile: MemberProfile): void {
  if (!readString(profile.userid) || !readString(profile.name)) {
    throw new AuthError("profile_unavailable", "WeCom member profile is unavailable.");
  }
}

function readErrcode(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  return -1;
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return readString(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapWeComError(kind: WeComEndpointKind, errcode: number): AuthError {
  if (errcode === 60020) {
    return new AuthError("wecom_untrusted_ip", "WeCom rejected an untrusted server IP.");
  }

  if (kind === "token") {
    return new AuthError("auth_misconfigured", "Unable to obtain WeCom application token.");
  }

  if (isExpiredAuthErrcode(errcode)) {
    return new AuthError("auth_expired", "WeCom authorization has expired.");
  }

  if (isMemberNotAllowedErrcode(errcode)) {
    return new AuthError("member_not_allowed", "WeCom member is not allowed to access this application.");
  }

  if (kind === "member") {
    return new AuthError("profile_unavailable", "WeCom member profile is unavailable.");
  }

  return new AuthError("service_unavailable", `WeCom ${kind} request was rejected.`);
}

function isExpiredAuthErrcode(errcode: number): boolean {
  return new Set([40014, 40029, 42001, 42003, 42022]).has(errcode);
}

function isMemberNotAllowedErrcode(errcode: number): boolean {
  return new Set([48002, 50001, 60011, 60021, 60111, 60120, 60121, 81013]).has(errcode);
}
