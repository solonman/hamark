import { requireApiUser } from "@/lib/current-user";
import { loadCollaborationRevisionHistory } from "@/lib/v03-collaboration";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const result = await loadCollaborationRevisionHistory(id);
  if (!result.collaboration) {
    return Response.json({ error: "公共 V0.3 主线不存在。" }, { status: 404 });
  }
  return Response.json(result);
}
