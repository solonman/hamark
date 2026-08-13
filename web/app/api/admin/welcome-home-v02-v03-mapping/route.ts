import { getDbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import {
  applyWelcomeHomeMapping,
  previewWelcomeHomeMapping,
  WelcomeHomeMappingError,
} from "@/lib/welcome-home-production-mapping";

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  return Response.json(body, { ...init, headers });
}

async function requireAdmin(request: Request) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  if (!(await isAppAdmin(user))) {
    return noStoreJson({ error: "仅数据库管理员可以访问该一次性数据操作。" }, { status: 403 });
  }
  return user;
}

export async function GET(request: Request) {
  const user = await requireAdmin(request);
  if (user instanceof Response) return user;
  try {
    return noStoreJson({ preview: await previewWelcomeHomeMapping(user, getDbClient()) });
  } catch (error) {
    console.error("Welcome Home mapping preview failed", error);
    return noStoreJson({ error: "PREVIEW 读取失败，未执行任何数据修改。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireAdmin(request);
  if (user instanceof Response) return user;
  let body: { action?: unknown; confirmation?: unknown; previewToken?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return noStoreJson({ error: "请求格式无效。" }, { status: 400 });
  }
  if (body.action !== "APPLY") {
    return noStoreJson({ error: "只允许显式 APPLY 操作。" }, { status: 400 });
  }
  try {
    const result = await applyWelcomeHomeMapping({
      actor: user,
      confirmation: String(body.confirmation ?? ""),
      previewToken: String(body.previewToken ?? ""),
      db: getDbClient(),
    });
    return noStoreJson({ result });
  } catch (error) {
    if (error instanceof WelcomeHomeMappingError) {
      return noStoreJson({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("Welcome Home mapping apply failed", error);
    return noStoreJson({ error: "APPLY 未完成，事务已回滚。" }, { status: 500 });
  }
}
