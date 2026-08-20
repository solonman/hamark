import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/current-user";
import { decideV04ShadowAccess } from "@/lib/v04-shadow-access";
import { V04VideoSessionProvider } from "@/components/v04/V04VideoSessionProvider";

export const metadata: Metadata = {
  title: "V0.4 影子审核",
  robots: { index: false, follow: false },
};

export default async function V04ShadowLayout({ children }: { children: React.ReactNode }) {
  if (process.env.V04_UI_SHADOW_ENABLED !== "true") notFound();
  const user = await requirePageUser("/v04-shadow");
  const access = decideV04ShadowAccess({
    enabled: process.env.V04_UI_SHADOW_ENABLED,
    reviewerUserIds: process.env.V04_UI_SHADOW_REVIEWER_USER_IDS,
    stableUserId: user.id,
  });
  if (!access.allowed) notFound();
  return <>
    <style>{"html { scroll-behavior: auto !important; }"}</style>
    <V04VideoSessionProvider>{children}</V04VideoSessionProvider>
  </>;
}
