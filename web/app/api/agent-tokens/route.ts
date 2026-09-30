import { agentTokenRoute } from "@/lib/agent-api/token-route";
import { createAgentToken, listAgentTokens } from "@/lib/agent-api/tokens";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return agentTokenRoute(request, { mutation: false }, async ({ user, db }) => ({
    tokens: await listAgentTokens(db, user.id),
  }));
}

export async function POST(request: Request) {
  return agentTokenRoute(request, { mutation: true }, async ({ user, db }) => {
    const body = (await request.json().catch(() => ({}))) as { name?: unknown };
    // 明文只在这一次响应里出现，库里只有哈希。
    const { token, view } = await createAgentToken(db, user.id, body.name);
    return { token, tokenInfo: view };
  }, 201);
}
