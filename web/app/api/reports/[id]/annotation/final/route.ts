// 报告集成版：定稿 / 取消定稿 / 采纳未纳入的修改。
// 见 docs/21_报告集成版_实施规格_V0.1.md 四、4.3。三个动作都只有老孙能做；
// setReportFinalVersionStatus / adoptReportFinalIntakes 自己校验身份并抛
// FORBIDDEN，这里不重复判断，交给 reportVersionErrorResponse 统一映射成 403。
//
// 请求体形状 `{action:"SET_STATUS",status}` / `{action:"ADOPT",...}`——与规格
// 原文的 `{action:"DONE"}` / `{action:"OPEN"}` 两个独立动作不同，是任务交底
// 时用户明确改定的口径（单一 SET_STATUS 动作 + status 参数），非本实现自行
// 引入的偏差；见最终报告「与规格不一致的地方」。

import { getDbClient } from "@/db";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isReportFeatureEnabled, reportFeatureDisabledResponse } from "@/lib/report-model";
import {
  adoptReportFinalIntakes,
  setReportFinalVersionStatus,
} from "@/lib/report-final-version";
import { reportVersionErrorResponse, ReportVersionError } from "@/lib/report-version-chain";

type FinalActionRequestBody =
  | { action: "SET_STATUS"; status: "OPEN" | "DONE" }
  | { action: "ADOPT"; intakeIds?: string[]; all?: boolean };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isReportFeatureEnabled()) return reportFeatureDisabledResponse();
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id: reportId } = await context.params;
  const actor = { userId: user.id, displayName: user.displayName, email: user.email };

  const body = (await request.json().catch(() => null)) as FinalActionRequestBody | null;
  if (!body || typeof body !== "object") {
    return Response.json({ error: "请求体格式不正确。" }, { status: 400 });
  }

  try {
    if (body.action === "SET_STATUS") {
      if (body.status !== "OPEN" && body.status !== "DONE") {
        throw new ReportVersionError("INVALID_INPUT", "status 必须是 OPEN 或 DONE。");
      }
      const final = await setReportFinalVersionStatus(getDbClient(), actor, { reportId, status: body.status });
      return Response.json({ final });
    }
    if (body.action === "ADOPT") {
      const { final, adopted } = await adoptReportFinalIntakes(getDbClient(), actor, {
        reportId,
        intakeIds: Array.isArray(body.intakeIds) ? body.intakeIds : undefined,
        all: body.all === true,
      });
      return Response.json({ final, adopted });
    }
    throw new ReportVersionError("INVALID_INPUT", "未知的集成版操作。");
  } catch (error) {
    return reportVersionErrorResponse(error);
  }
}
