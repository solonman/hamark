import { getDbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import {
  applyV02V03BatchCandidate,
  previewV02V03BatchMapping,
  V02V03BatchMappingError,
} from "@/lib/v02-v03-batch-mapping";

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  return Response.json(body, { ...init, headers });
}

async function requireAdmin(request: Request) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  if (!(await isAppAdmin(user))) {
    return noStoreJson({ error: "仅数据库管理员可以访问批量数据操作。" }, { status: 403 });
  }
  return user;
}

export async function GET(request: Request) {
  const user = await requireAdmin(request);
  if (user instanceof Response) return user;
  try {
    return noStoreJson({ preview: await previewV02V03BatchMapping(getDbClient()) });
  } catch (error) {
    console.error("V0.2 to V0.3 batch preview failed", error);
    return noStoreJson({ error: "批量 PREVIEW 读取失败，未执行任何数据修改。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireAdmin(request);
  if (user instanceof Response) return user;
  let body: {
    action?: unknown;
    confirmation?: unknown;
    candidateKey?: unknown;
    candidateToken?: unknown;
  };
  try {
    body = await request.json() as typeof body;
  } catch {
    return noStoreJson({ error: "请求格式无效。" }, { status: 400 });
  }
  if (body.action !== "APPLY_CANDIDATE") {
    return noStoreJson({ error: "只允许显式 APPLY_CANDIDATE 操作。" }, { status: 400 });
  }
  try {
    const result = await applyV02V03BatchCandidate({
      actor: user,
      candidateKey: String(body.candidateKey ?? ""),
      candidateToken: String(body.candidateToken ?? ""),
      confirmation: String(body.confirmation ?? ""),
      db: getDbClient(),
    });
    return noStoreJson({ result });
  } catch (error) {
    if (error instanceof V02V03BatchMappingError) {
      return noStoreJson({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("V0.2 to V0.3 batch candidate apply failed", error);
    return noStoreJson({ error: "该案例 APPLY 未完成，事务已回滚。" }, { status: 500 });
  }
}
