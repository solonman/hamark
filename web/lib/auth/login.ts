import { buildWeComAuthorizationUrl, type WeComClient } from "./wecom.ts";
import type { WeComAuthConfig } from "./config.ts";
import { buildIdentityKey, hashToken, randomToken, safeReturnTo } from "./security.ts";
import { createSession } from "./session.ts";
import type { AuthStore, CurrentUser } from "./store.ts";
import { AuthError, type AuthFlow } from "./types.ts";

const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

type LoginDeps = {
  corpId: string;
  store: AuthStore;
  wecom: Pick<WeComClient, "getMemberByCode">;
  now?: () => Date;
};

type BeginLoginDeps = LoginDeps & {
  config: WeComAuthConfig;
};

export async function beginWeComLogin(
  deps: BeginLoginDeps,
  input: { flow: AuthFlow; returnTo: string },
): Promise<{ authorizationUrl: string; nonce: string; nonceExpiresAt: Date }> {
  const now = currentDate(deps);
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_MAX_AGE_MS);
  const state = randomToken();
  const nonce = randomToken();

  await deps.store.createOAuthState({
    id: `oauth_state_${crypto.randomUUID()}`,
    stateHash: await hashToken(state),
    browserNonceHash: await hashToken(nonce),
    returnTo: safeReturnTo(input.returnTo),
    flowType: input.flow,
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
  });

  return {
    authorizationUrl: buildWeComAuthorizationUrl(deps.config, input.flow, state),
    nonce,
    nonceExpiresAt: expiresAt,
  };
}

export async function completeWeComLogin(
  deps: LoginDeps,
  input: { code: string; state: string; nonce: string | null },
): Promise<{ user: CurrentUser; token: string; expiresAt: Date; returnTo: string }> {
  if (!input.code || !input.state || !input.nonce) {
    throw new AuthError("auth_expired", "WeCom login state has expired.");
  }

  const now = currentDate(deps);
  const state = await deps.store.consumeOAuthState(
    await hashToken(input.state),
    await hashToken(input.nonce),
    now.toISOString(),
  );
  if (!state) {
    throw new AuthError("auth_expired", "WeCom login state has expired.");
  }

  const member = await deps.wecom.getMemberByCode(input.code);
  const identityKey = buildIdentityKey(deps.corpId, member.userId);
  const user = await deps.store.syncUser(deps.corpId, member, identityKey, now.toISOString());
  const session = await createSession(deps.store, user, now);

  return {
    user,
    token: session.token,
    expiresAt: session.expiresAt,
    returnTo: safeReturnTo(state.returnTo),
  };
}

function currentDate(deps: { now?: () => Date }) {
  return deps.now?.() ?? new Date();
}
