const WECOM_API_BASE = "https://qyapi.weixin.qq.com/cgi-bin";
const FETCH_TIMEOUT_MS = 8000;
const TOKEN_REFRESH_SKEW_MS = 300_000;
const DEPARTMENT_CACHE_TTL_MS = 300_000;
export const MAX_UPSTREAM_BODY_BYTES = 1024 * 1024;

const ACCESS_TOKEN_INVALID_CODES = new Set([40014, 42001]);
const AUTH_EXPIRED_CODES = new Set([40029, 42003, 42022]);
const TOKEN_CONFIGURATION_CODES = new Set([40001, 40013, 60020]);
const MEMBER_NOT_ALLOWED_CODES = new Set([
  48002,
  50001,
  60011,
  60021,
  60111,
  60120,
  60121,
  81013,
]);

export class WeComServiceError extends Error {
  constructor(code, message = "WeCom proxy request failed.") {
    super(message);
    this.name = "WeComServiceError";
    this.code = code;
  }
}

export function createWeComService({
  corpId,
  secret,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  if (!readString(corpId) || !readString(secret) || typeof fetchImpl !== "function") {
    throw serviceError("PROXY_MISCONFIGURED");
  }

  let tokenCache = null;
  let tokenRefresh = null;
  let departmentCache = null;

  async function getMemberByCode(code, { signal } = {}) {
    const accessToken = await getAccessToken(signal);
    try {
      return await getMemberWithToken(code, accessToken, signal);
    } catch (error) {
      if (!(error instanceof AccessTokenInvalidError)) {
        throw error;
      }
    }

    invalidateCachedToken(accessToken);
    const refreshedToken = await getAccessToken(signal);
    try {
      return await getMemberWithToken(code, refreshedToken, signal);
    } catch (error) {
      if (error instanceof AccessTokenInvalidError) {
        invalidateCachedToken(refreshedToken);
        throw serviceError("WECOM_UNAVAILABLE");
      }
      throw error;
    }
  }

  async function getMemberWithToken(code, accessToken, signal) {
    const userInfo = await fetchJson(
      "userinfo",
      buildUserInfoUrl(accessToken, code),
      signal,
    );
    const userId = readString(userInfo.UserId);
    if (!userId) {
      throw serviceError("MEMBER_NOT_ALLOWED");
    }

    const profile = await fetchJson("member", buildMemberUrl(accessToken, userId), signal);
    assertUsableProfile(profile);
    const departments = await getDepartments(accessToken, signal);
    return mapMember(profile, departments);
  }

  async function getDepartments(accessToken, signal) {
    const nowMs = readNow(now);
    if (departmentCache && departmentCache.expiresAtMs > nowMs) {
      return departmentCache.value;
    }

    const value = await fetchJson("department", buildDepartmentUrl(accessToken), signal);
    departmentCache = {
      value,
      expiresAtMs: nowMs + DEPARTMENT_CACHE_TTL_MS,
    };
    return value;
  }

  async function getAccessToken(signal) {
    const nowMs = readNow(now);
    if (tokenCache && tokenCache.expiresAtMs - nowMs > TOKEN_REFRESH_SKEW_MS) {
      return tokenCache.value;
    }

    if (!tokenRefresh) {
      tokenRefresh = createTokenRefresh();
    }
    return waitForTokenRefresh(tokenRefresh, signal);
  }

  function createTokenRefresh() {
    const refresh = {
      controller: new AbortController(),
      promise: null,
      settled: false,
      waiters: 0,
    };
    refresh.promise = requestAccessToken(refresh.controller.signal).finally(() => {
      refresh.settled = true;
      if (tokenRefresh === refresh) {
        tokenRefresh = null;
      }
    });
    return refresh;
  }

  async function waitForTokenRefresh(refresh, signal) {
    refresh.waiters += 1;
    try {
      return await waitForPromise(refresh.promise, signal);
    } finally {
      refresh.waiters -= 1;
      if (!refresh.settled && refresh.waiters === 0) {
        refresh.controller.abort();
      }
    }
  }

  async function requestAccessToken(signal) {
    const body = await fetchJson("token", buildTokenUrl(corpId, secret), signal);
    const value = readString(body.access_token);
    const expiresIn = readPositiveNumber(body.expires_in);
    if (!value || !expiresIn) {
      throw serviceError("WECOM_UNAVAILABLE");
    }

    tokenCache = {
      value,
      expiresAtMs: readNow(now) + expiresIn * 1000,
    };
    return value;
  }

  function invalidateCachedToken(expectedToken) {
    if (tokenCache?.value === expectedToken) {
      tokenCache = null;
    }
  }

  async function fetchJson(kind, url, parentSignal) {
    const timeout = createTimeout(parentSignal);
    try {
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        signal: timeout.signal,
      });
      if (!response.ok) {
        throw serviceError("WECOM_UNAVAILABLE");
      }

      const body = await readLimitedJson(response, timeout.signal);
      if (!isRecord(body)) {
        throw serviceError("WECOM_UNAVAILABLE");
      }

      const errcode = readErrcode(body.errcode);
      if (errcode !== 0) {
        throw mapWeComError(kind, errcode);
      }
      return body;
    } catch (error) {
      if (error instanceof WeComServiceError || error instanceof AccessTokenInvalidError) {
        throw error;
      }
      throw serviceError("WECOM_UNAVAILABLE");
    } finally {
      timeout.cancel();
    }
  }

  return { getMemberByCode };
}

function buildTokenUrl(corpId, secret) {
  const url = new URL(`${WECOM_API_BASE}/gettoken`);
  url.searchParams.set("corpid", corpId);
  url.searchParams.set("corpsecret", secret);
  return url;
}

function buildUserInfoUrl(accessToken, code) {
  const url = new URL(`${WECOM_API_BASE}/user/getuserinfo`);
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("code", code);
  return url;
}

function buildMemberUrl(accessToken, userId) {
  const url = new URL(`${WECOM_API_BASE}/user/get`);
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("userid", userId);
  return url;
}

function buildDepartmentUrl(accessToken) {
  const url = new URL(`${WECOM_API_BASE}/department/simplelist`);
  url.searchParams.set("access_token", accessToken);
  return url;
}

function mapMember(profile, departmentBody) {
  const userId = readString(profile.userid);
  const displayName = readString(profile.name);
  if (!userId || !displayName) {
    throw serviceError("PROFILE_UNAVAILABLE");
  }

  const departmentIds = Array.isArray(profile.department)
    ? profile.department.map(readId).filter(Boolean)
    : [];
  const dedupedIds = [...new Set(departmentIds)];
  const requestedPrimaryId = readId(profile.main_department);
  const primaryId = requestedPrimaryId && dedupedIds.includes(requestedPrimaryId)
    ? requestedPrimaryId
    : dedupedIds[0] ?? null;
  const names = readDepartmentNames(departmentBody);

  return {
    userId,
    displayName,
    avatarUrl: readString(profile.avatar) ?? readString(profile.thumb_avatar),
    email: readString(profile.email),
    departments: dedupedIds.map((id) => ({
      id,
      name: names.get(id) ?? `Department ${id}`,
      isPrimary: id === primaryId,
    })),
  };
}

function assertUsableProfile(profile) {
  if (!readString(profile.userid) || !readString(profile.name)) {
    throw serviceError("PROFILE_UNAVAILABLE");
  }
}

function readDepartmentNames(body) {
  const values = Array.isArray(body.department_id)
    ? body.department_id
    : Array.isArray(body.department)
      ? body.department
      : [];
  const names = new Map();

  for (const value of values) {
    if (!isRecord(value)) {
      continue;
    }
    const id = readId(value.id);
    const name = readString(value.name);
    if (id && name && !names.has(id)) {
      names.set(id, name);
    }
  }
  return names;
}

function mapWeComError(kind, errcode) {
  if (kind === "token") {
    return TOKEN_CONFIGURATION_CODES.has(errcode)
      ? serviceError("PROXY_MISCONFIGURED")
      : serviceError("WECOM_UNAVAILABLE");
  }
  if (errcode === 60020) {
    return serviceError("PROXY_MISCONFIGURED");
  }
  if (ACCESS_TOKEN_INVALID_CODES.has(errcode)) {
    return new AccessTokenInvalidError();
  }
  if (AUTH_EXPIRED_CODES.has(errcode)) {
    return serviceError("AUTH_EXPIRED");
  }
  if (MEMBER_NOT_ALLOWED_CODES.has(errcode)) {
    return serviceError("MEMBER_NOT_ALLOWED");
  }
  if (kind === "member") {
    return serviceError("PROFILE_UNAVAILABLE");
  }
  return serviceError("WECOM_UNAVAILABLE");
}

async function readLimitedJson(response, signal) {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null
    && /^\d+$/.test(declaredLength)
    && Number(declaredLength) > MAX_UPSTREAM_BODY_BYTES
  ) {
    await cancelBody(response.body);
    throw serviceError("WECOM_UNAVAILABLE");
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    throw serviceError("WECOM_UNAVAILABLE");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, signal);
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_UPSTREAM_BODY_BYTES) {
        await cancelReader(reader);
        throw serviceError("WECOM_UNAVAILABLE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw serviceError("WECOM_UNAVAILABLE");
  }
}

function readStreamChunk(reader, signal) {
  if (!signal) {
    return reader.read();
  }
  if (signal.aborted) {
    void cancelReader(reader);
    return Promise.reject(new RequestAbortedError());
  }

  return new Promise((resolveRead, rejectRead) => {
    let settled = false;
    const settle = (operation, value) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation(value);
    };
    const onAbort = () => {
      void cancelReader(reader);
      settle(rejectRead, new RequestAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (value) => settle(resolveRead, value),
      () => settle(rejectRead, new RequestAbortedError()),
    );
  });
}

function waitForPromise(promise, signal) {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(serviceError("WECOM_UNAVAILABLE"));
  }

  return new Promise((resolveWait, rejectWait) => {
    let settled = false;
    const settle = (operation, value) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation(value);
    };
    const onAbort = () => settle(rejectWait, serviceError("WECOM_UNAVAILABLE"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => settle(resolveWait, value),
      (error) => settle(rejectWait, error),
    );
  });
}

function createTimeout(parentSignal) {
  if (typeof AbortSignal.timeout === "function") {
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    if (!parentSignal) {
      return { signal: timeoutSignal, cancel() {} };
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (parentSignal.aborted || timeoutSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener("abort", onAbort, { once: true });
      timeoutSignal.addEventListener("abort", onAbort, { once: true });
    }
    return {
      signal: controller.signal,
      cancel() {
        parentSignal.removeEventListener("abort", onAbort);
        timeoutSignal.removeEventListener("abort", onAbort);
      },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timer.unref?.();
  const onParentAbort = () => controller.abort();
  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

async function cancelBody(body) {
  try {
    await body?.cancel();
  } catch {
    // Cancellation is best effort after the response has already been rejected.
  }
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is best effort after the response has already been rejected.
  }
}

function readNow(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) {
    throw serviceError("PROXY_MISCONFIGURED");
  }
  return milliseconds;
}

function readErrcode(value) {
  if (value === undefined) {
    return 0;
  }
  return typeof value === "number" && Number.isInteger(value) ? value : -1;
}

function readPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function readString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readId(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return readString(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serviceError(code) {
  return new WeComServiceError(code);
}

class AccessTokenInvalidError extends Error {}

class RequestAbortedError extends Error {}
