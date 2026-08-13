import { getDbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import {
  applyV03SharedBackfillCandidate,
  previewV03SharedBackfill,
  V03SharedBackfillError,
} from "@/lib/v03-shared-backfill";
import {
  installV03SharedSchema,
  isV03SharedSchemaReady,
} from "@/lib/v03-shared-schema";
import { V03_SHARED_SCHEMA_CONFIRMATION } from "@/lib/v03-shared-backfill-contract";

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  return Response.json(body, { ...init, headers });
}

async function requireAdmin(request: Request) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  if (!(await isAppAdmin(user))) {
    return noStoreJson({ error: "只有管理员可以执行共享主线接入。" }, { status: 403 });
  }
  return user;
}

export async function GET(request: Request) {
  const user = await requireAdmin(request);
  if (user instanceof Response) return user;
  try {
    const db = getDbClient();
    const schemaReady = await isV03SharedSchemaReady(db);
    return noStoreJson({
      schemaReady,
      schemaConfirmation: V03_SHARED_SCHEMA_CONFIRMATION,
      preview: schemaReady ? await previewV03SharedBackfill(db) : null,
    });
  } catch (error) {
    console.error("V0.3 shared backfill preview failed", error);
    return noStoreJson({ error: "共享主线 PREVIEW 失败，没有写入业务数据。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireAdmin(request);
  if (user instanceof Response) return user;
  const body = (await request.json().catch(() => ({}))) as {
    action?: unknown;
    confirmation?: unknown;
    candidateKey?: unknown;
    previewToken?: unknown;
  };
  if (body.action === "INSTALL_SCHEMA") {
    if (body.confirmation !== V03_SHARED_SCHEMA_CONFIRMATION) {
      return noStoreJson({ error: "数据结构确认口令不匹配。" }, { status: 400 });
    }
    try {
      await installV03SharedSchema(getDbClient());
      return noStoreJson({ ok: true, schemaReady: true });
    } catch (error) {
      console.error("V0.3 shared schema install failed", error);
      return noStoreJson({ error: "共享协作数据结构未完成；没有执行业务回填。" }, { status: 500 });
    }
  }
  if (body.action !== "APPLY_CANDIDATE") {
    return noStoreJson({ error: "只允许显式 INSTALL_SCHEMA 或 APPLY_CANDIDATE。" }, { status: 400 });
  }
  try {
    const result = await applyV03SharedBackfillCandidate({
      actor: user,
      candidateKey: String(body.candidateKey ?? ""),
      previewToken: String(body.previewToken ?? ""),
      confirmation: String(body.confirmation ?? ""),
      db: getDbClient(),
    });
    return noStoreJson({ result });
  } catch (error) {
    if (error instanceof V03SharedBackfillError) {
      return noStoreJson({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("V0.3 shared backfill apply failed", error);
    return noStoreJson({ error: "该案例未接入，事务已回滚。" }, { status: 500 });
  }
}
