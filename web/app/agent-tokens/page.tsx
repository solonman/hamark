import type { Metadata } from "next";
import Link from "next/link";
import { requirePageUser } from "@/lib/current-user";
import { canManageAgentTokens } from "@/lib/agent-api/access";
import v04 from "@/components/v04/V04Surface.module.css";
import AgentTokensClient from "./AgentTokensClient";

export const metadata: Metadata = { title: "外部 Agent 令牌" };
export const dynamic = "force-dynamic";

export default async function AgentTokensPage() {
  const user = await requirePageUser("/agent-tokens");
  const userView = {
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    departmentName:
      user.departments.find((item) => item.isPrimary)?.name ?? user.departments[0]?.name ?? null,
  };
  if (!canManageAgentTokens(user.displayName)) {
    return (
      <main className={v04.surface}>
        <section className={v04.emptyState}>
          <h2>外部 Agent 令牌只对指定成员开放</h2>
          <p>如需让 Agent 读取案例数据，请联系老孙。</p>
          <Link href="/">回到案例库</Link>
        </section>
      </main>
    );
  }
  return <AgentTokensClient user={userView} />;
}
