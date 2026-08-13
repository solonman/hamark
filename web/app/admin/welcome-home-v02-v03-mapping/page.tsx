import Link from "next/link";
import { isAppAdmin } from "@/lib/admin";
import { requirePageUser } from "@/lib/current-user";
import { WELCOME_HOME_MAPPING_PATH } from "@/lib/welcome-home-mapping-contract";
import WelcomeHomeMappingClient from "./WelcomeHomeMappingClient";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export default async function WelcomeHomeMappingPage() {
  const user = await requirePageUser(WELCOME_HOME_MAPPING_PATH);
  const admin = await isAppAdmin(user);
  if (!admin) {
    return (
      <main className={styles.shell}>
        <div className={styles.panel}>
          <p className={styles.eyebrow}>受保护的数据操作</p>
          <h1>仅管理员可访问</h1>
          <p>该页面不会向普通用户公开预检内容或执行入口。</p>
          <Link className={styles.secondaryButton} href="/">返回全部作品</Link>
        </div>
      </main>
    );
  }
  return <WelcomeHomeMappingClient />;
}
