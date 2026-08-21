import { getDbClient } from "@/db";
import { getCurrentUserFromRequest, requireSameOriginMutation } from "@/lib/current-user";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { hashToken } from "@/lib/auth/security";
import { V04ServiceError, v04ErrorResponse } from "./v04-errors";
import {
  assertV04DefaultAccess,
  assertV04GrayAccess,
  v04GrayVideoIdFromRequest,
} from "./v04-gray-access";
import type { V04Actor } from "./v04-workspace-service";

function readCookie(header: string | null, name: string) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export function v04RequestId(request: Request) {
  const header = request.headers.get("x-request-id")?.trim();
  return header && header.length <= 128 ? header : `request_${crypto.randomUUID()}`;
}

export function v04IdempotencyKey(request: Request, fallback?: string) {
  return request.headers.get("idempotency-key")?.trim() || fallback?.trim() || "";
}

export async function requireV04Actor(
  request: Request,
  options: { mutation: boolean; requireFeature?: boolean; grayCollection?: boolean },
): Promise<{ actor: V04Actor; requestId: string } | Response> {
  const requestId = v04RequestId(request);
  if (options.requireFeature !== false && process.env.V04_WORKFLOW_API_ENABLED !== "true") {
    return v04ErrorResponse(new V04ServiceError(
      "UNSUPPORTED_WORKFLOW",
      "V0.4 工作流当前入口未激活。",
      {},
      requestId,
    ), requestId);
  }
  if (options.mutation && requireSameOriginMutation(request)) {
    return v04ErrorResponse(new V04ServiceError(
      "FORBIDDEN",
      "请求来源不被允许。",
      {},
      requestId,
    ), requestId);
  }
  const user = await getCurrentUserFromRequest(request);
  if (!user) {
    return v04ErrorResponse(new V04ServiceError(
      "AUTH_REQUIRED",
      "请先登录。",
      {},
      requestId,
    ), requestId);
  }
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token) {
    return v04ErrorResponse(new V04ServiceError(
      "AUTH_REQUIRED",
      "登录会话已失效。",
      {},
      requestId,
    ), requestId);
  }
  const tokenHash = await hashToken(token);
  const session = await getDbClient().prepare(
    `SELECT s.id FROM auth_sessions s
    INNER JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.user_id = ? AND s.revoked_at IS NULL
      AND s.expires_at > ? AND u.status = 'ACTIVE'`,
  ).bind(tokenHash, user.id, new Date().toISOString()).first<{ id: string }>();
  if (!session) {
    return v04ErrorResponse(new V04ServiceError(
      "AUTH_REQUIRED",
      "登录会话已失效。",
      {},
      requestId,
    ), requestId);
  }
  if (options.requireFeature !== false) {
    const videoId = options.grayCollection ? undefined : v04GrayVideoIdFromRequest(request);
    if (!options.grayCollection && !videoId) {
      return v04ErrorResponse(new V04ServiceError(
        "FORBIDDEN",
        "V0.4 受控灰度对象无法识别。",
        {},
        requestId,
      ), requestId);
    }
    try {
      if (process.env.V04_DEFAULT_UI_ENABLED === "true") {
        await assertV04DefaultAccess(getDbClient(), user.id, videoId);
      } else {
        await assertV04GrayAccess(getDbClient(), user.id, videoId);
      }
    } catch (error) {
      return v04ErrorResponse(error, requestId);
    }
  }
  return {
    requestId,
    actor: {
      userId: user.id,
      identityKey: user.identityKey,
      displayName: user.displayName,
      sessionId: session.id,
      requestId,
    },
  };
}

export async function v04Route(
  request: Request,
  options: { mutation: boolean; requireFeature?: boolean; grayCollection?: boolean },
  operation: (actor: V04Actor, requestId: string) => Promise<Response>,
) {
  const access = await requireV04Actor(request, options);
  if (access instanceof Response) return access;
  try {
    return await operation(access.actor, access.requestId);
  } catch (error) {
    return v04ErrorResponse(error, access.requestId);
  }
}
