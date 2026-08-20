import Link from "next/link";
import { getDbClient } from "@/db";
import { requirePageUser } from "@/lib/current-user";
import { assertV04PreviewAdmin } from "@/lib/v04-migration-preview";
import V04SchemaAdminClient from "./V04SchemaAdminClient";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export default async function V04SchemaAdminPage() {
  const user = await requirePageUser("/admin/v04-schema");
  try {
    await assertV04PreviewAdmin(getDbClient(), {
      userId: user.id,
      displayName: user.displayName,
    });
  } catch {
    return (
      <main className={styles.shell}>
        <section className={styles.panel}>
          <p className={styles.eyebrow}>受保护的 schema 操作面</p>
          <h1>仅稳定系统管理员可访问</h1>
          <p>该页面不使用姓名作为一般授权，也不会向普通成员展示 PREVIEW 或 APPLY 信息。</p>
          <Link className={styles.secondaryButton} href="/">返回全部作品</Link>
        </section>
      </main>
    );
  }

  return (
    <V04SchemaAdminClient
      previewEnabled={process.env.V04_MIGRATION_PREVIEW_ENABLED === "true"}
      applyEnabled={process.env.V04_SCHEMA_APPLY_ENABLED === "true"}
    />
  );
}
