import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import V04BrowserCompatibilityGate from "@/components/v04/V04BrowserCompatibilityGate";
import V04BrowserCompatibilityMessage from "@/components/v04/V04BrowserCompatibilityMessage";
import { V04VideoSessionProvider } from "@/components/v04/V04VideoSessionProvider";
import V04WorkspaceClient from "@/components/v04/V04WorkspaceClient";
import { getDbClient } from "@/db";
import { requirePageUser } from "@/lib/current-user";
import { canAccessV04Surface } from "@/lib/v04-gray-access";
import { detectV04LegacyBrowser } from "@/lib/v04-browser-compat";
import PracticeClient from "./PracticeClient";
import type { TaxonomyVersion } from "@/lib/types";

export const metadata: Metadata = {
  title: "逆向练习",
};

export default async function PracticePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ taxonomy?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const v04DefaultEnabled = process.env.V04_DEFAULT_UI_ENABLED === "true";
  const explicitLegacy = query.taxonomy === "V0.2" || query.taxonomy === "V0.3-PILOT";
  const isV04 = query.taxonomy === "V0.4" || (v04DefaultEnabled && !explicitLegacy);
  const taxonomyVersion: TaxonomyVersion =
    query.taxonomy === "V0.2" ? "V0.2" : "V0.3-PILOT";
  const returnTo = isV04
    ? `/videos/${encodeURIComponent(id)}/practice?taxonomy=V0.4`
    : `/videos/${encodeURIComponent(id)}/practice?taxonomy=${encodeURIComponent(taxonomyVersion)}`;
  const user = await requirePageUser(returnTo);
  if (isV04) {
    if (process.env.V04_WORKFLOW_UI_ENABLED !== "true") notFound();
    if (!await canAccessV04Surface(getDbClient(), user.id, id)) notFound();
    const requestHeaders = await headers();
    if (detectV04LegacyBrowser(requestHeaders.get("user-agent") ?? "")) {
      return <V04BrowserCompatibilityMessage mode="EDIT" />;
    }
    const encodedId = encodeURIComponent(id);
    return (
      <V04BrowserCompatibilityGate mode="EDIT">
        <V04VideoSessionProvider>
          <V04WorkspaceClient
            videoId={id}
            viewerName={user.displayName}
            viewerUserId={user.id}
            navigation={{
              libraryHref: "/",
              detailHref: `/videos/${encodedId}`,
              workspaceHref: v04DefaultEnabled
                ? `/videos/${encodedId}/practice`
                : `/videos/${encodedId}/practice?taxonomy=V0.4`,
              detailLabel: "只读成果",
              workspaceLabel: "V0.4 工作稿",
            }}
          />
        </V04VideoSessionProvider>
      </V04BrowserCompatibilityGate>
    );
  }
  return (
    <PracticeClient
      videoId={id}
      taxonomyVersion={taxonomyVersion}
    />
  );
}
