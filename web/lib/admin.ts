import { getDbClient } from "@/db";
import type { CurrentUser } from "@/lib/current-user";

export async function isAppAdmin(user: CurrentUser) {
  const row = await getDbClient()
    .prepare("SELECT display_name FROM app_admins WHERE display_name = ?")
    .bind(user.displayName)
    .first<{ display_name: string }>();
  return Boolean(row);
}

// V0.3.1 exposes a business role, not a technical administrator role. The
// pilot deliberately reuses the existing allow-list so no production identity
// migration is required; callers should use this business-facing helper.
export async function isFinalReviewer(user: CurrentUser) {
  return isAppAdmin(user);
}
