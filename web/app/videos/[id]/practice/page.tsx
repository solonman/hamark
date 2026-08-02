import type { Metadata } from "next";
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
  return <PracticeClient videoId={id} />;
}
