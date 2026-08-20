import { requirePageUser } from "@/lib/current-user";
import V04LibraryClient from "@/components/v04/V04LibraryClient";

export default async function V04ShadowLibraryPage() {
  const user = await requirePageUser("/v04-shadow");
  return <V04LibraryClient viewerName={user.displayName} />;
}
