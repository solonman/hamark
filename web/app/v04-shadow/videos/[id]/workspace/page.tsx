import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/current-user";
import { getV04UiCase } from "@/lib/v04-ui-fixture";
import V04WorkspaceClient from "@/components/v04/V04WorkspaceClient";

export default async function V04ShadowWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = getV04UiCase(id);
  if (!item) notFound();
  const user = await requirePageUser(`/v04-shadow/videos/${encodeURIComponent(id)}/workspace`);
  return <V04WorkspaceClient item={item} viewerName={user.displayName} />;
}
