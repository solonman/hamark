import type { Metadata } from "next";
import { requirePageUser } from "@/lib/current-user";
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
  return (
    <VideoDetailClient
      videoId={id}
      viewerName={user.displayName}
      v04DetailEnabled={process.env.V04_DETAIL_UI_ENABLED === "true"}
    />
  );
}
