import { getDbClient } from "@/db";
import { adoptFinalIntakes, adoptFinalReviewCandidates, setFinalVersionStatus } from "@/lib/final-version";
import { v04Route } from "@/lib/v04-api";
import { V04ServiceError } from "@/lib/v04-errors";
import type { V19FinalActionRequestBody, V19FinalActionResponseBody } from "@/lib/v19-ui-model";

// 定稿 / 取消定稿 / 采纳未纳入的修改 — spec 4.3；采纳点评版的写法 — docs/25 六。
// 四个动作都只有老孙能做；setFinalVersionStatus / adoptFinalIntakes /
// adoptFinalReviewCandidates 自己校验身份并抛 FORBIDDEN，这里不重复判断，
// 交给 v04Route 的错误映射统一处理成 403。
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return v04Route(request, { mutation: true }, async (actor) => {
    const { id } = await context.params;
    const body = await request.json() as V19FinalActionRequestBody;
    const db = getDbClient();

    if (body.action === "DONE" || body.action === "OPEN") {
      const final = await setFinalVersionStatus(db, actor, { videoId: id, status: body.action });
      return Response.json({ final } satisfies V19FinalActionResponseBody);
    }
    if (body.action === "ADOPT") {
      const { final, adopted } = await adoptFinalIntakes(db, actor, {
        videoId: id,
        intakeIds: Array.isArray(body.intakeIds) ? body.intakeIds : undefined,
        all: body.all === true,
      });
      return Response.json({ final, adopted } satisfies V19FinalActionResponseBody);
    }
    if (body.action === "ADOPT_REVIEW") {
      // 只传点评版 id 和要采纳的键；写进集成版的值由服务端按点评版当前内容重算。
      const { final, adopted } = await adoptFinalReviewCandidates(db, actor, {
        videoId: id,
        reviewVersionId: typeof body.reviewVersionId === "string" ? body.reviewVersionId : "",
        targetKeys: Array.isArray(body.targetKeys) ? body.targetKeys : [],
      });
      return Response.json({ final, adopted } satisfies V19FinalActionResponseBody);
    }
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "未知的集成版操作。");
  });
}
