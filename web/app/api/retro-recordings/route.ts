// POST /api/retro-recordings：{ monthKey, caseId | null, fileName, contentType, sizeBytes } → { recording, uploadUrl }。
// 任何登录成员都能传；段号自动取下一个空闲的，满 3 段回 409。caseId 为 null 是当月的整场总结。
import { getDbClient } from "@/db";
import { createRetroRecording } from "@/lib/retro/recordings";
import { lazyRetroBucket, readRetroJsonBody, retroRoute } from "@/lib/retro/route";

export const maxDuration = 300;

export async function POST(request: Request) {
  return retroRoute(request, { mutation: true }, async ({ viewer }) => {
    const result = await createRetroRecording(getDbClient(), lazyRetroBucket, viewer, await readRetroJsonBody(request));
    return Response.json(result, { status: 201 });
  });
}
