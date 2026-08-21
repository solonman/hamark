import type { Metadata } from "next";
import { getDbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import { requirePageUser } from "@/lib/current-user";
import { canAccessV04Surface } from "@/lib/v04-gray-access";
import HomeClient from "./components/HomeClient";

export const metadata: Metadata = {
  title: "创意片库",
  description: "看片、拆片、交作业，让优秀作品成为团队共同的创意教材。",
};

export default async function Home() {
  const user = await requirePageUser("/");
  const isAdmin = await isAppAdmin(user);
  const v04DefaultEnabled = process.env.V04_DEFAULT_UI_ENABLED === "true";
  const v04LibraryEnabled = process.env.V04_LIBRARY_UI_ENABLED === "true"
    && await canAccessV04Surface(getDbClient(), user.id);
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
      isAdmin={isAdmin}
      v04LibraryEnabled={v04LibraryEnabled}
      v04DefaultEnabled={v04DefaultEnabled}
    />
  );
}
