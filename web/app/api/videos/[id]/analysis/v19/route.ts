import { getDbClient } from "@/db";
import { v04Route } from "@/lib/v04-api";
import { loadV04WorkspaceReadModel } from "@/lib/v04-read-models";
import type { V04Change } from "@/lib/v04-contract";
import { loadV19VersionChain, saveV19VersionChanges } from "@/lib/v19-version-chain";
import type { V19SaveRequestBody, V19StudioModel } from "@/lib/v19-ui-model";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const response = await v04Route(request, { mutation: false }, async (actor) => {
    const { id } = await context.params;
    const versionId = new URL(request.url).searchParams.get("version")?.trim() || undefined;
    const db = getDbClient();
    // Two independent reads (case/viewer context vs. the version chain) run
    // concurrently against the pool — neither writes, so there is nothing to
    // sequence them against.
    const [workspace, chain] = await Promise.all([
      loadV04WorkspaceReadModel(db, id, {
        actor,
        tabToken: request.headers.get("x-v04-tab-token"),
      }),
      loadV19VersionChain(db, id, actor, versionId ? { versionId } : {}),
    ]);
    const { media, ...caseFields } = workspace.video;
    // The shared read model still derives canEdit from holding the edit lease,
    // which the old single-draft surface needs. This surface has no lease at
    // all: every ACTIVE member writes to their own version, so edit rights
    // follow read rights. Submission and lease controls do not exist here.
    const viewerCapabilities = {
      ...workspace.viewerCapabilities,
      canEdit: workspace.viewerCapabilities.canRead,
      canSubmit: false,
      canAcquireLease: false,
      canForceRelease: false,
    };
    const model: V19StudioModel = {
      case: caseFields,
      media,
      viewerCapabilities,
      versions: chain.versions,
      current: chain.current,
      myVersionId: chain.myVersionId,
    };
    return Response.json(model);
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return v04Route(request, { mutation: true }, async (actor) => {
    const { id } = await context.params;
    const body = await request.json() as V19SaveRequestBody;
    const result = await saveV19VersionChanges(getDbClient(), actor, {
      videoId: id,
      basedOnVersionId: body.basedOnVersionId ?? null,
      changeSetId: body.changeSetId ?? "",
      changes: Array.isArray(body.changes) ? body.changes as V04Change[] : [],
    });
    return Response.json(result);
  });
}
