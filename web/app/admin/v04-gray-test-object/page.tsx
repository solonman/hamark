import Link from "next/link";
import { getDbClient } from "@/db";
import { requirePageUser } from "@/lib/current-user";
import { assertV04PreviewAdmin } from "@/lib/v04-migration-preview";
import V04GrayTestObjectClient from "./V04GrayTestObjectClient";
import styles from "../v04-schema/page.module.css";

export const dynamic = "force-dynamic";

export default async function V04GrayTestObjectPage() {
  const user = await requirePageUser("/admin/v04-gray-test-object");
  try {
    await assertV04PreviewAdmin(getDbClient(), {
      userId: user.id,
      displayName: user.displayName,
    });
  } catch {
    return (
      <main className={styles.shell}>
        <section className={styles.panel}>
          <p className={styles.eyebrow}>受保护的 TEST_ONLY 操作面</p>
          <h1>仅稳定系统管理员可访问</h1>
          <p>不使用显示姓名授权，也不向普通成员展示创建计划。</p>
          <Link className={styles.secondaryButton} href="/">返回全部作品</Link>
        </section>
      </main>
    );
  }
  return (
    <V04GrayTestObjectClient
      enabled={process.env.V04_GRAY_TEST_OBJECT_ENABLED === "true"}
    />
  );
}
