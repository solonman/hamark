import type { Metadata } from "next";
import { getDbClient } from "@/db";
import { requirePageUser } from "@/lib/current-user";
import { canAccessV04Surface } from "@/lib/v04-gray-access";
import VideoDetailClient from "./VideoDetailClient";

export const metadata: Metadata = {
  title: "作品与创意分析",
};

export default async function VideoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requirePageUser(`/videos/${encodeURIComponent(id)}`);
  const v04DefaultEnabled = process.env.V04_DEFAULT_UI_ENABLED === "true";
  const v04DetailEnabled = process.env.V04_DETAIL_UI_ENABLED === "true"
    && await canAccessV04Surface(getDbClient(), user.id, id);
  return (
    <VideoDetailClient
      videoId={id}
      viewerName={user.displayName}
      v04DetailEnabled={v04DetailEnabled}
      v04DefaultEnabled={v04DefaultEnabled}
    />
  );
}
