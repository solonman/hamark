import { getDbClient } from "@/db";
import { toggleCaseFavorite } from "@/lib/case-engagement-server";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const forbidden = requireSameOriginMutation(request);
  if (forbidden) return forbidden;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  try {
    return Response.json(await toggleCaseFavorite(getDbClient(), {
      videoId: id,
      userId: user.id,
    }));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "收藏失败，请稍后重试。" },
      { status: 400 },
    );
  }
}
