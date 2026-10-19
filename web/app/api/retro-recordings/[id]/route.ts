// GET  /api/retro-recordings/[id]：状态与文字稿（全员可见）；未到终态且租约空闲时，响应发出后用 after() 推进一次。
// POST /api/retro-recordings/[id]：{ action: "UPLOADED" | "RETRY" | "REMOVE" }（录音上传者、案例上传者、管理员）。
import { getDbClient } from "@/db";
import { loadRetroRecording, retroRecordingAsrKind, runRetroRecordingAction } from "@/lib/retro/recordings";
import { lazyRetroBucket, readRetroJsonBody, retroRoute, scheduleRetroTranscription } from "@/lib/retro/route";
import { shouldAdvanceRetroTranscription } from "@/lib/retro/transcription";

export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Params) {
  return retroRoute(request, { mutation: false }, async ({ viewer, startedAt }) => {
    const { id } = await context.params;
    const { row, view } = await loadRetroRecording(getDbClient(), viewer, id);
    if (shouldAdvanceRetroTranscription(row, Date.now())) {
      scheduleRetroTranscription("RECORDING", row.id, retroRecordingAsrKind(row), startedAt);
    }
    return Response.json({ recording: view });
  });
}

export async function POST(request: Request, context: Params) {
  return retroRoute(request, { mutation: true }, async ({ viewer, startedAt }) => {
    const { id } = await context.params;
    const result = await runRetroRecordingAction(getDbClient(), lazyRetroBucket, viewer, id, await readRetroJsonBody(request));
    if (result.advance) scheduleRetroTranscription("RECORDING", id, retroRecordingAsrKind(result.row), startedAt);
    return Response.json({ recording: result.view });
  });
}
