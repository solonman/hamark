import { requirePageUser } from "@/lib/current-user";
import V04DetailClient from "@/components/v04/V04DetailClient";

export default async function V04ShadowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageUser(`/v04-shadow/videos/${encodeURIComponent(id)}`);
  return <V04DetailClient videoId={id} viewerName={user.displayName} />;
}
