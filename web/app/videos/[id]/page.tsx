import type { Metadata } from "next";
import { getDbClient } from "@/db";
import { V04VideoSessionProvider } from "@/components/v04/V04VideoSessionProvider";
import V04DetailClient from "@/components/v04/V04DetailClient";
import { requirePageUser } from "@/lib/current-user";
import { canAccessV04Surface } from "@/lib/v04-gray-access";
import VideoDetailClient from "./VideoDetailClient";

export const metadata: Metadata = {
  title: "作品与创意分析",
};

export default async function VideoDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const user = await requirePageUser(`/videos/${encodeURIComponent(id)}`);
  const v04DefaultEnabled = process.env.V04_DEFAULT_UI_ENABLED === "true";
  const v04DetailEnabled = process.env.V04_DETAIL_UI_ENABLED === "true"
    && await canAccessV04Surface(getDbClient(), user.id, id);
  const explicitLegacyView = query.view === "legacy";
  if (v04DefaultEnabled && v04DetailEnabled && !explicitLegacyView) {
    const encodedId = encodeURIComponent(id);
    return (
      <V04VideoSessionProvider>
        <V04DetailClient
          videoId={id}
          viewerName={user.displayName}
          showVideo
          navigation={{
            libraryHref: "/",
            detailHref: `/videos/${encodedId}`,
            workspaceHref: `/videos/${encodedId}/practice`,
            detailLabel: "案例成果",
            workspaceLabel: "编辑工作稿",
            compatibilityLinks: [
              { href: `/videos/${encodedId}/practice?taxonomy=V0.3-PILOT`, label: "V0.3" },
              { href: `/videos/${encodedId}/practice?taxonomy=V0.2`, label: "V0.2" },
            ],
            managementHref: `/videos/${encodedId}?view=legacy`,
          }}
        />
      </V04VideoSessionProvider>
    );
  }
  return (
    <VideoDetailClient
      videoId={id}
      viewerName={user.displayName}
      v04DetailEnabled={v04DetailEnabled && !v04DefaultEnabled}
      v04DefaultEnabled={v04DefaultEnabled}
    />
  );
}
