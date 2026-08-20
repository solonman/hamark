import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { V04VideoSessionProvider } from "@/components/v04/V04VideoSessionProvider";
import V04WorkspaceClient from "@/components/v04/V04WorkspaceClient";
import { requirePageUser } from "@/lib/current-user";
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
  const isV04 = query.taxonomy === "V0.4";
  const taxonomyVersion: TaxonomyVersion =
    query.taxonomy === "V0.2" ? "V0.2" : "V0.3-PILOT";
  const returnTo = isV04
    ? `/videos/${encodeURIComponent(id)}/practice?taxonomy=V0.4`
    : `/videos/${encodeURIComponent(id)}/practice?taxonomy=${encodeURIComponent(taxonomyVersion)}`;
  const user = await requirePageUser(returnTo);
  if (isV04) {
    if (process.env.V04_WORKFLOW_UI_ENABLED !== "true") notFound();
    const encodedId = encodeURIComponent(id);
    return (
      <V04VideoSessionProvider>
        <V04WorkspaceClient
          videoId={id}
          viewerName={user.displayName}
          viewerUserId={user.id}
          navigation={{
            libraryHref: "/",
            detailHref: `/videos/${encodedId}`,
            workspaceHref: `/videos/${encodedId}/practice?taxonomy=V0.4`,
            detailLabel: "作品详情",
            workspaceLabel: "V0.4 工作稿",
          }}
        />
      </V04VideoSessionProvider>
    );
  }
  return (
    <PracticeClient
      videoId={id}
      taxonomyVersion={taxonomyVersion}
    />
  );
}
