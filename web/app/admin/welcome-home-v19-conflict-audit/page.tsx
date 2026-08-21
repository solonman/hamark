import Link from "next/link";
import { getDbClient } from "@/db";
import { requirePageUser } from "@/lib/current-user";
import {
  assertWelcomeHomeV19AuditAdmin,
  loadWelcomeHomeV19AuditConfig,
} from "@/lib/welcome-home-v19-conflict-audit";
import WelcomeHomeV19ConflictAuditClient from "./WelcomeHomeV19ConflictAuditClient";
import styles from "../v04-schema/page.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function WelcomeHomeV19ConflictAuditPage() {
  const user = await requirePageUser("/admin/welcome-home-v19-conflict-audit");
  try {
    await assertWelcomeHomeV19AuditAdmin(getDbClient(), user.id);
  } catch {
    return <main className={styles.shell}><section className={styles.panel}>
      <p className={styles.eyebrow}>固定案例 · 服务端只读 · 19 种／196 实例</p>
      <h1>仅稳定系统管理员可访问</h1>
      <p>页面不使用姓名授权，也不会展示正文、身份、租约持有人或凭据。</p>
      <Link className={styles.secondaryButton} href="/">返回全部作品</Link>
    </section></main>;
  }
  return <WelcomeHomeV19ConflictAuditClient
    enabled={loadWelcomeHomeV19AuditConfig().enabled}
  />;
}
