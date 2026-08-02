import type { Metadata } from "next";
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
  return <VideoDetailClient videoId={id} />;
}
