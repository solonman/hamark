import { getDbClient } from "@/db";
import type { CurrentUser } from "@/lib/current-user";

export async function isAppAdmin(user: CurrentUser) {
  const row = await getDbClient()
    .prepare("SELECT display_name FROM app_admins WHERE display_name = ?")
    .bind(user.displayName)
    .first<{ display_name: string }>();
  return Boolean(row);
}
