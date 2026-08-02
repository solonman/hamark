import type { Metadata } from "next";
import { requirePageUser } from "@/lib/current-user";
import HomeClient from "./components/HomeClient";

export const metadata: Metadata = {
  title: "创意片库",
  description: "看片、拆片、交作业，让优秀作品成为团队共同的创意教材。",
};

export default async function Home() {
  await requirePageUser("/");
  return <HomeClient />;
}
