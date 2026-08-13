import { requireApiUser } from "@/lib/current-user";
import { loadCollaborationBaseline } from "@/lib/v03-collaboration";

export async function GET(
  request: Request,
  context: { params: Promise<{ baselineId: string }> },
) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { baselineId } = await context.params;
  const baseline = await loadCollaborationBaseline(baselineId);
  if (!baseline) {
    return Response.json({ error: "公共 V0.3 初始基线不存在。" }, { status: 404 });
  }
  return Response.json({ baseline });
}
