import { requirePageUser } from "@/lib/current-user";
import V04WorkspaceClient from "@/components/v04/V04WorkspaceClient";

export default async function V04ShadowWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageUser(`/v04-shadow/videos/${encodeURIComponent(id)}/workspace`);
  return <V04WorkspaceClient videoId={id} viewerName={user.displayName} viewerUserId={user.id} />;
}
