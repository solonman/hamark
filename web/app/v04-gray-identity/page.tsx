import { notFound } from "next/navigation";
import { getDbClient } from "@/db";
import { requirePageUser } from "@/lib/current-user";
import { hashV04GrayUserId } from "@/lib/v04-gray-access";

export const dynamic = "force-dynamic";

export default async function V04GrayIdentityDigestPage() {
  if (process.env.V04_GRAY_IDENTITY_DIGEST_ENABLED !== "true") notFound();
  const user = await requirePageUser("/v04-gray-identity");
  const active = Boolean(await getDbClient().prepare(
    "SELECT 1 FROM users WHERE id=? AND status='ACTIVE'",
  ).bind(user.id).first());
  const digest = hashV04GrayUserId(user.id);
  return (
    <main style={{ minHeight: "100vh", padding: 32, background: "#090a0b", color: "#e7e3db" }}>
      <section style={{ maxWidth: 760, margin: "0 auto", padding: 24, border: "1px solid #303238", borderRadius: 16 }}>
        <p style={{ color: "#c9a977" }}>只读 · 当前登录会话本人 · 不连接显示姓名</p>
        <h1>V0.4 灰度身份摘要证明</h1>
        <p>账号状态：<strong>{active ? "ACTIVE" : "NOT_ACTIVE"}</strong></p>
        <p>请只向工程统筹提供以下不可逆摘要；页面不会显示原始稳定 ID、邮箱或身份键。</p>
        <code style={{ display: "block", overflowWrap: "anywhere", padding: 16, background: "#111315", borderRadius: 10 }}>
          {digest}
        </code>
        <p>短摘要：<code>{digest.slice(0, 12)}…{digest.slice(-8)}</code></p>
      </section>
    </main>
  );
}
