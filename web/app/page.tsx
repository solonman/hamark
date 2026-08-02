import type { Metadata } from "next";
import { requirePageUser } from "@/lib/current-user";
import HomeClient from "./components/HomeClient";

export const metadata: Metadata = {
  title: "创意片库",
  description: "看片、拆片、交作业，让优秀作品成为团队共同的创意教材。",
};

export default async function Home() {
  const user = await requirePageUser("/");
  return (
    <HomeClient
      user={{
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        departmentName:
          user.departments.find((item) => item.isPrimary)?.name ??
          user.departments[0]?.name ??
          null,
      }}
    />
  );
}
