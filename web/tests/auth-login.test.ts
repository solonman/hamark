import assert from "node:assert/strict";
import test from "node:test";
import { completeWeComLogin } from "../lib/auth/login.ts";
import { buildIdentityKey, hashToken } from "../lib/auth/security.ts";
import type {
  AuthStore,
  CurrentUser,
  EncryptedAppToken,
  NewOAuthState,
  NewSession,
  OAuthStateRecord,
  WeComMember,
} from "../lib/auth/store.ts";

const now = new Date("2026-08-02T00:00:00.000Z");
const expectedIdentityKey = buildIdentityKey("wwcorp", "alice");
const expectedUser: CurrentUser = {
  id: "user-1",
  identityKey: expectedIdentityKey,
  displayName: "Alice",
  avatarUrl: null,
  email: "alice@example.com",
  departments: [{ id: "1", name: "Brand", isPrimary: true }],
};

test("completeWeComLogin consumes state before exchanging code", async () => {
  const events: string[] = [];
  const store = new LoginStore(events);
  const wecom = new LoginWeComClient(events);

  const result = await completeWeComLogin(
    {
      corpId: "wwcorp",
      store,
      wecom,
      now: () => now,
    },
    { code: "code", state: "state", nonce: "nonce" },
  );

  assert.equal(result.returnTo, "/videos/1");
  assert.equal(result.user.identityKey, expectedUser.identityKey);
  assert.equal(store.sessions.length, 1);
  assert.equal(store.sessions[0].tokenHash, await hashToken(result.token));
  assert.deepEqual(events, ["consume-state", "get-member", "sync-user", "create-session"]);
});

test("replayed state never reaches WeCom", async () => {
  const events: string[] = [];
  const store = new LoginStore(events);
  const wecom = new LoginWeComClient(events);
  const deps = {
    corpId: "wwcorp",
    store,
    wecom,
    now: () => now,
  };

  await completeWeComLogin(deps, { code: "code", state: "state", nonce: "nonce" });
  await assert.rejects(
    () => completeWeComLogin(deps, { code: "code", state: "state", nonce: "nonce" }),
    { code: "auth_expired" },
  );
  assert.equal(wecom.calls, 1);
});

class LoginWeComClient {
  calls = 0;

  constructor(private readonly events: string[]) {}

  async getMemberByCode(code: string): Promise<WeComMember> {
    assert.equal(code, "code");
    this.calls += 1;
    this.events.push("get-member");
    return {
      userId: "alice",
      displayName: "Alice",
      avatarUrl: null,
      email: "alice@example.com",
      departments: [{ id: "1", name: "Brand", isPrimary: true }],
    };
  }
}

class LoginStore implements AuthStore {
  private consumed = false;
  readonly sessions: NewSession[] = [];

  constructor(private readonly events: string[]) {}

  async createOAuthState(input: NewOAuthState): Promise<void> {
    void input;
    throw new Error("not used");
  }

  async consumeOAuthState(
    stateHash: string,
    nonceHash: string,
    stateNow: string,
  ): Promise<OAuthStateRecord | null> {
    this.events.push("consume-state");
    assert.equal(stateHash, await hashToken("state"));
    assert.equal(nonceHash, await hashToken("nonce"));
    assert.equal(stateNow, now.toISOString());
    if (this.consumed) {
      return null;
    }
    this.consumed = true;
    return {
      id: "state-1",
      stateHash,
      browserNonceHash: nonceHash,
      returnTo: "/videos/1",
      flowType: "QR",
      expiresAt: "2026-08-02T00:10:00.000Z",
      consumedAt: "2026-08-02T00:00:00.000Z",
      createdAt: "2026-08-01T23:59:00.000Z",
    };
  }

  async syncUser(
    corpId: string,
    member: WeComMember,
    identityKey: string,
    syncNow: string,
  ): Promise<CurrentUser> {
    this.events.push("sync-user");
    assert.equal(corpId, "wwcorp");
    assert.equal(member.userId, "alice");
    assert.equal(identityKey, expectedIdentityKey);
    assert.equal(syncNow, now.toISOString());
    return expectedUser;
  }

  async createSession(input: NewSession): Promise<void> {
    this.events.push("create-session");
    this.sessions.push(input);
  }

  async getSession(tokenHash: string, sessionNow: string): Promise<CurrentUser | null> {
    void tokenHash;
    void sessionNow;
    return null;
  }

  async revokeSession(tokenHash: string, revokeNow: string): Promise<void> {
    void tokenHash;
    void revokeNow;
  }

  async getAppToken(corpId: string, agentId: string, tokenNow: string): Promise<EncryptedAppToken | null> {
    void corpId;
    void agentId;
    void tokenNow;
    return null;
  }

  async putAppToken(input: EncryptedAppToken): Promise<void> {
    void input;
  }

  async withAppTokenRefreshLock<T>(
    corpId: string,
    agentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    void corpId;
    void agentId;
    return operation();
  }
}
