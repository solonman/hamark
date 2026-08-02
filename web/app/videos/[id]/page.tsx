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
  await requirePageUser(`/videos/${encodeURIComponent(id)}`);
  return <VideoDetailClient videoId={id} />;
}
