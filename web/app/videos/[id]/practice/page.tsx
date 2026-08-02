import type { Metadata } from "next";
import { requirePageUser } from "@/lib/current-user";
import PracticeClient from "./PracticeClient";

export const metadata: Metadata = {
  title: "逆向练习",
};

export default async function PracticePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requirePageUser(`/videos/${encodeURIComponent(id)}/practice`);
  return <PracticeClient videoId={id} />;
}
