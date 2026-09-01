import { getDbClient } from "@/db";
import {
  loadCaseReview,
  saveCaseReviewComment,
  saveCaseReviewRating,
  type CaseReviewViewer,
} from "@/lib/case-review-server";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";

type ReviewRequestBody =
  | { kind: "RATING"; versionId: string; stars: number }
  | { kind: "COMMENT"; versionId: string; targetKey: string; targetLabel?: string; body: string };

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const versionId = new URL(request.url).searchParams.get("version");
  const review = await loadCaseReview(getDbClient(), {
    videoId: id,
    versionId,
    viewer: viewerOf(user),
  });
  const response = Response.json(review);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const forbidden = requireSameOriginMutation(request);
  if (forbidden) return forbidden;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const viewer = viewerOf(user);
  try {
    const body = await request.json() as ReviewRequestBody;
    if (body.kind === "RATING") {
      return Response.json(await saveCaseReviewRating(getDbClient(), {
        videoId: id,
        versionId: body.versionId ?? "",
        stars: body.stars,
        viewer,
      }));
    }
    if (body.kind === "COMMENT") {
      return Response.json(await saveCaseReviewComment(getDbClient(), {
        videoId: id,
        versionId: body.versionId ?? "",
        targetKey: body.targetKey ?? "",
        targetLabel: body.targetLabel ?? "",
        body: body.body,
        viewer,
      }));
    }
    return Response.json({ error: "无法识别的评审操作。" }, { status: 400 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "评审保存失败，请稍后重试。" },
      { status: 400 },
    );
  }
}

function viewerOf(user: { id: string; displayName: string }): CaseReviewViewer {
  return { userId: user.id, displayName: user.displayName };
}
