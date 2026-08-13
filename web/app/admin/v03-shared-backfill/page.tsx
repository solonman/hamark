import type { Metadata } from "next";
import { requirePageUser } from "@/lib/current-user";
import V03SharedBackfillClient from "./V03SharedBackfillClient";

export const metadata: Metadata = { title: "V0.3 共享主线接入" };

export default async function Page() {
  await requirePageUser("/admin/v03-shared-backfill");
  return <V03SharedBackfillClient />;
}
