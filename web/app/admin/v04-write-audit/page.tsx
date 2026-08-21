import Link from "next/link";
import { getDbClient } from "@/db";
import { requirePageUser } from "@/lib/current-user";
import { getV04ProductionWriteAudit } from "@/lib/v04-production-write-audit";
import type { V04ProductionWriteAudit } from "@/lib/v04-production-write-audit";
import styles from "../v04-schema/page.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const time = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN") : "—";

export default async function V04WriteAuditPage() {
  const user = await requirePageUser("/admin/v04-write-audit");
  let audit: V04ProductionWriteAudit | null = null;
  try {
    audit = await getV04ProductionWriteAudit(getDbClient(), user.id);
  } catch {
    audit = null;
  }
  if (!audit) {
    return <main className={styles.shell}><section className={styles.panel}>
      <p className={styles.eyebrow}>V0.4 生产写入脱敏只读核查</p>
      <h1>仅稳定系统管理员可访问</h1>
      <p>页面不使用姓名授权，也不会展示正文、身份或凭据。</p>
      <Link className={styles.secondaryButton} href="/">返回全部作品</Link>
    </section></main>;
  }
  return <main className={styles.shell} data-v04-write-audit>
      <section className={styles.panel}>
        <p className={styles.eyebrow}>V0.4 生产写入脱敏只读核查</p>
        <h1>{audit.conclusion === "NO_PRODUCTION_V19_WRITES" ? "无受影响生产事实" : "发现需产品判断的生产事实"}</h1>
        <p>仅聚合数量、状态、时间范围和字段键；不读取、渲染或导出任何正文。</p>
        <dl>
          <dt>公共工作区</dt><dd>{audit.workspace.count}</dd>
          <dt>工作区状态</dt><dd>{audit.workspace.statuses.map((item) => `${item.status} ${item.count}`).join("；") || "—"}</dd>
          <dt>工作区时间范围</dt><dd>{time(audit.workspace.firstCreatedAt)} — {time(audit.workspace.lastUpdatedAt)}</dd>
          <dt>不可变提交</dt><dd>{audit.submission.count}</dd>
          <dt>提交时间范围</dt><dd>{time(audit.submission.firstSubmittedAt)} — {time(audit.submission.lastSubmittedAt)}</dd>
          <dt>按冻结合同含第三模块的提交</dt><dd>{audit.submission.withThirdModuleStructureCount}</dd>
          <dt>修订事件</dt><dd>{audit.revision.count}</dd>
          <dt>第三模块修订事件</dt><dd>{audit.revision.thirdModuleCount}</dd>
          <dt>命中字段键</dt><dd>{audit.revision.affectedTargetKeys.map((item) => `${item.targetKey} × ${item.count}`).join("；") || "—"}</dd>
          <dt>生成时间</dt><dd>{time(audit.generatedAt)}</dd>
        </dl>
        <p><strong>结论码：</strong>{audit.conclusion}</p>
        <Link className={styles.secondaryButton} href="/">返回全部作品</Link>
      </section>
    </main>;
}
