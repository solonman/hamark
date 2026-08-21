import Link from "next/link";
import { getDbClient } from "@/db";
import { requirePageUser } from "@/lib/current-user";
import { assertWelcomeHomeV19AuditAdmin } from "@/lib/welcome-home-v19-conflict-audit";
import { loadWelcomeHomeV19MappingConfig } from "@/lib/welcome-home-v19-mapping";
import WelcomeHomeV19MappingClient from "./WelcomeHomeV19MappingClient";
import styles from "../v04-schema/page.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function WelcomeHomeV19MappingPage() {
  const user = await requirePageUser("/admin/welcome-home-v19-mapping");
  try {
    await assertWelcomeHomeV19AuditAdmin(getDbClient(), user.id);
  } catch {
    return <main className={styles.shell}><section className={styles.panel}>
      <p className={styles.eyebrow}>固定单案例 · 19 种／196 实例</p>
      <h1>仅稳定系统管理员可访问</h1>
      <p>页面不使用姓名授权，也不会展示正文、原始身份、完整 token 或底层异常。</p>
      <Link className={styles.secondaryButton} href="/">返回全部作品</Link>
    </section></main>;
  }
  return <WelcomeHomeV19MappingClient {...loadWelcomeHomeV19MappingConfig()} />;
}
