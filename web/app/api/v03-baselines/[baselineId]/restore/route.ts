import { isFinalReviewer } from "@/lib/admin";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import {
  restoreSharedV03FromBaseline,
  V03CollaborationError,
} from "@/lib/v03-collaboration";

export async function POST(
  request: Request,
  context: { params: Promise<{ baselineId: string }> },
) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  if (!(await isFinalReviewer(user))) {
    return Response.json({ error: "只有专家可以从初始基线创建恢复轮。" }, { status: 403 });
  }
  const { baselineId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    action?: unknown;
    confirmation?: unknown;
  };
  if (
    body.action !== "RESTORE_BASELINE_AS_NEW_ROUND" ||
    body.confirmation !== "确认从公共初始基线创建新的共享恢复轮"
  ) {
    return Response.json({ error: "请明确确认创建非破坏性的初始基线恢复轮。" }, { status: 400 });
  }
  try {
    const result = await restoreSharedV03FromBaseline({ baselineId, actor: user });
    return Response.json({ result });
  } catch (error) {
    if (error instanceof V03CollaborationError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("Shared V0.3 baseline restore failed", { baselineId, error });
    return Response.json({ error: "恢复轮未建立，事务已回滚。" }, { status: 500 });
  }
}
