import { getDbClient } from "@/db";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isReportFeatureEnabled, reportFeatureDisabledResponse } from "@/lib/report-model";
import {
  loadReportReview,
  saveReportReviewComment,
  saveReportReviewRating,
  type ReportReviewViewer,
} from "@/lib/report-review-server";

// 读取端与写入端都在这里，跟视频侧 app/api/videos/[id]/review/route.ts 同一个形状：
// GET 按 ?version= 取 canReview／评分／评论，POST 写评分或评论。工作台从
// GET /api/reports/[id]/annotation 拿到当前版本 id 之后，再拿它来查这里的评审数据——
// 评审数据不在 annotation 那条路由里拼（那边只管版本链本身，见该路由顶部注释）。
type ReviewRequestBody =
  | { kind: "RATING"; versionId: string; stars: number }
  | { kind: "COMMENT"; versionId: string; targetKey: string; targetLabel?: string; body: string };

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isReportFeatureEnabled()) return reportFeatureDisabledResponse();
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const versionId = new URL(request.url).searchParams.get("version");
  const review = await loadReportReview(getDbClient(), {
    reportId: id,
    versionId,
    viewer: viewerOf(user),
  });
  const response = Response.json(review);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isReportFeatureEnabled()) return reportFeatureDisabledResponse();
  const forbidden = requireSameOriginMutation(request);
  if (forbidden) return forbidden;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const viewer = viewerOf(user);
  try {
    const body = (await request.json()) as ReviewRequestBody;
    if (body.kind === "RATING") {
      return Response.json(
        await saveReportReviewRating(getDbClient(), {
          reportId: id,
          versionId: body.versionId ?? "",
          stars: body.stars,
          viewer,
        }),
      );
    }
    if (body.kind === "COMMENT") {
      return Response.json(
        await saveReportReviewComment(getDbClient(), {
          reportId: id,
          versionId: body.versionId ?? "",
          targetKey: body.targetKey ?? "",
          targetLabel: body.targetLabel ?? "",
          body: body.body,
          viewer,
        }),
      );
    }
    return Response.json({ error: "无法识别的评审操作。" }, { status: 400 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "评审保存失败，请稍后重试。" },
      { status: 400 },
    );
  }
}

function viewerOf(user: { id: string; displayName: string }): ReportReviewViewer {
  return { userId: user.id, displayName: user.displayName };
}
