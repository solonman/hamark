import type { Metadata } from "next";
import { headers } from "next/headers";
import { getDbClient } from "@/db";
import V04BrowserCompatibilityGate from "@/components/v04/V04BrowserCompatibilityGate";
import V04BrowserCompatibilityMessage from "@/components/v04/V04BrowserCompatibilityMessage";
import { V04VideoSessionProvider } from "@/components/v04/V04VideoSessionProvider";
import V04DetailClient from "@/components/v04/V04DetailClient";
import V04StudioClient from "@/components/v04/V04StudioClient";
import { requirePageUser } from "@/lib/current-user";
import { canAccessV04Surface } from "@/lib/v04-gray-access";
import { detectV04LegacyBrowser } from "@/lib/v04-browser-compat";
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
  const explicitLegacyView = query.view === "legacy";
  const user = await requirePageUser(`/videos/${encodeURIComponent(id)}`);
  const v04DefaultEnabled = process.env.V04_DEFAULT_UI_ENABLED === "true";
  const v04SurfaceAccess = await canAccessV04Surface(getDbClient(), user.id, id);
  const v04DetailEnabled = process.env.V04_DETAIL_UI_ENABLED === "true"
    && v04SurfaceAccess;
  // V1.9 二合一工作台：新开关独立于既有 V04_DEFAULT_UI_ENABLED / V04_DETAIL_UI_ENABLED，
  // 复用同一套 V0.4 访问判定（v04SurfaceAccess）。开关关闭时下方两个既有分支完全不受影响。
  const v19StudioEnabled = process.env.V19_STUDIO_UI_ENABLED === "true";
  if (v19StudioEnabled && v04SurfaceAccess && !explicitLegacyView) {
    const requestHeaders = await headers();
    if (detectV04LegacyBrowser(requestHeaders.get("user-agent") ?? "")) {
      return <V04BrowserCompatibilityMessage mode="EDIT" />;
    }
    const encodedId = encodeURIComponent(id);
    return (
      <V04BrowserCompatibilityGate mode="EDIT">
        <V04VideoSessionProvider>
          <V04StudioClient
            videoId={id}
            viewerName={user.displayName}
            viewerUserId={user.id}
            navigation={{
              libraryHref: "/",
              detailHref: `/videos/${encodedId}`,
            }}
          />
        </V04VideoSessionProvider>
      </V04BrowserCompatibilityGate>
    );
  }
  if (v04DefaultEnabled && v04DetailEnabled && !explicitLegacyView) {
    const requestHeaders = await headers();
    if (detectV04LegacyBrowser(requestHeaders.get("user-agent") ?? "")) {
      return <V04BrowserCompatibilityMessage mode="READ" />;
    }
    const encodedId = encodeURIComponent(id);
    return (
      <V04BrowserCompatibilityGate mode="READ">
        <V04VideoSessionProvider>
          <V04DetailClient
            videoId={id}
            viewerName={user.displayName}
            showVideo
            navigation={{
              libraryHref: "/",
              detailHref: `/videos/${encodedId}`,
              workspaceHref: `/videos/${encodedId}/practice`,
              detailLabel: "只读成果",
              workspaceLabel: "编辑工作稿",
              compatibilityLinks: [
                { href: `/videos/${encodedId}/practice?taxonomy=V0.3-PILOT`, label: "V0.3" },
                { href: `/videos/${encodedId}/practice?taxonomy=V0.2`, label: "V0.2" },
              ],
              managementHref: `/videos/${encodedId}?view=legacy`,
            }}
          />
        </V04VideoSessionProvider>
      </V04BrowserCompatibilityGate>
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
