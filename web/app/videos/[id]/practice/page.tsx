import type { Metadata } from "next";
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
  searchParams: Promise<{ taxonomy?: string; start?: string; releaseId?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const taxonomyVersion: TaxonomyVersion =
    query.taxonomy === "V0.2" ? "V0.2" : "V0.3-PILOT";
  const returnTo = `/videos/${encodeURIComponent(id)}/practice?taxonomy=${encodeURIComponent(taxonomyVersion)}`;
  await requirePageUser(returnTo);
  const startReleaseId =
    taxonomyVersion === "V0.3-PILOT" && query.start === "active-release"
      ? query.releaseId
      : undefined;
  return (
    <PracticeClient
      videoId={id}
      taxonomyVersion={taxonomyVersion}
      startReleaseId={startReleaseId}
    />
  );
}
