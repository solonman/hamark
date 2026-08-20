import { requirePageUser } from "@/lib/current-user";
import { V04_UI_CASES } from "@/lib/v04-ui-fixture";
import V04LibraryClient from "@/components/v04/V04LibraryClient";

export default async function V04ShadowLibraryPage() {
  const user = await requirePageUser("/v04-shadow");
  return <V04LibraryClient cases={V04_UI_CASES} viewerName={user.displayName} />;
}
