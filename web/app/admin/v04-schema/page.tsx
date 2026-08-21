import Link from "next/link";
import { getDbClient } from "@/db";
import { requirePageUser } from "@/lib/current-user";
import { assertV04PreviewAdmin } from "@/lib/v04-migration-preview";
import { inspectV04SystemAdminBootstrapCandidate } from "@/lib/v04-system-admin-bootstrap";
import { v04TargetCodeSha } from "@/lib/v04-schema-catalog";
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
    const bootstrapEnabled = process.env.V04_SYSTEM_ADMIN_BOOTSTRAP_ENABLED === "true";
    const candidate = bootstrapEnabled
      ? await inspectV04SystemAdminBootstrapCandidate(getDbClient(), {
        userId: user.id,
        displayName: user.displayName,
      })
      : null;
    if (candidate?.eligible) {
      return (
        <V04SchemaAdminClient
          previewEnabled={false}
          applyEnabled={false}
          contractLifecycleEnabled={false}
          bootstrapEnabled
          bootstrapEligible
          targetCodeSha={v04TargetCodeSha()}
        />
      );
    }
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
      contractLifecycleEnabled={process.env.V04_CONTRACT_ACTIVATE_ENABLED === "true"}
      bootstrapEnabled={process.env.V04_SYSTEM_ADMIN_BOOTSTRAP_ENABLED === "true"}
      bootstrapEligible={false}
      targetCodeSha={v04TargetCodeSha()}
    />
  );
}
