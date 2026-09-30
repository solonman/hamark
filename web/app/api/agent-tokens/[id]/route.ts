import { agentTokenRoute } from "@/lib/agent-api/token-route";
import { revokeAgentToken } from "@/lib/agent-api/tokens";

export const dynamic = "force-dynamic";

/** 停用（不删行）：令牌立即失效，列表里保留停用记录。 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return agentTokenRoute(request, { mutation: true }, async ({ user, db }) => {
    const { id } = await context.params;
    return { tokenInfo: await revokeAgentToken(db, user.id, id) };
  });
}
