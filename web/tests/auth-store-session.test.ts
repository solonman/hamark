import assert from "node:assert/strict";
import test from "node:test";
import { PostgresAuthStore } from "../lib/auth/store.ts";
import type {
  AuthStore,
  CurrentUser,
  EncryptedAppToken,
  NewOAuthState,
  NewSession,
  OAuthStateRecord,
  WeComMember,
} from "../lib/auth/store.ts";

test("PostgresAuthStore is exported as the production AuthStore implementation", () => {
  assert.equal(typeof PostgresAuthStore, "function");
});

test("OAuth state is consumed exactly once", async () => {
  const store = new InMemoryAuthStore();
  await store.createOAuthState({
    id: "state-1",
    stateHash: "state-hash",
    browserNonceHash: "nonce-hash",
    returnTo: "/videos",
    flowType: "QR",
    expiresAt: "2026-08-02T12:00:00.000Z",
    createdAt: "2026-08-02T11:00:00.000Z",
  });

  const consumed = await store.consumeOAuthState(
    "state-hash",
    "nonce-hash",
    "2026-08-02T11:30:00.000Z",
  );
  assert.equal(consumed?.returnTo, "/videos");
  assert.equal(consumed?.flowType, "QR");

  assert.equal(
    await store.consumeOAuthState("state-hash", "nonce-hash", "2026-08-02T11:31:00.000Z"),
    null,
  );
});

test("Expired and nonce-mismatched OAuth states are rejected", async () => {
  const store = new InMemoryAuthStore();
  await store.createOAuthState({
    id: "state-expired",
    stateHash: "expired-hash",
    browserNonceHash: "nonce-hash",
    returnTo: "/",
    flowType: "IN_APP",
    expiresAt: "2026-08-02T12:00:00.000Z",
    createdAt: "2026-08-02T11:00:00.000Z",
  });
  await store.createOAuthState({
    id: "state-nonce",
    stateHash: "nonce-state-hash",
    browserNonceHash: "expected-nonce",
    returnTo: "/practice",
    flowType: "QR",
    expiresAt: "2026-08-02T12:00:00.000Z",
    createdAt: "2026-08-02T11:00:00.000Z",
  });

  assert.equal(
    await store.consumeOAuthState("expired-hash", "nonce-hash", "2026-08-02T12:00:00.000Z"),
    null,
  );
  assert.equal(
    await store.consumeOAuthState("nonce-state-hash", "wrong-nonce", "2026-08-02T11:30:00.000Z"),
    null,
  );
  assert.notEqual(
    await store.consumeOAuthState("nonce-state-hash", "expected-nonce", "2026-08-02T11:30:00.000Z"),
    null,
  );
});

test("User upsert is stable for the same corp/user and identity key", async () => {
  const store = new InMemoryAuthStore();
  const first = await store.syncUser(
    "corp-a",
    member({ userId: "alice", displayName: "Alice" }),
    "identity-alice",
    "2026-08-02T11:00:00.000Z",
  );
  const second = await store.syncUser(
    "corp-a",
    member({ userId: "alice", displayName: "Alice Renamed" }),
    "identity-alice",
    "2026-08-02T12:00:00.000Z",
  );
  const third = await store.syncUser(
    "corp-b",
    member({ userId: "external-alice", displayName: "Alice Again" }),
    "identity-alice",
    "2026-08-02T13:00:00.000Z",
  );

  assert.equal(second.id, first.id);
  assert.equal(third.id, first.id);
  assert.equal(second.identityKey, "identity-alice");
  assert.equal(second.displayName, "Alice Renamed");
});

test("Department replacement on resync removes stale department snapshot", async () => {
  const store = new InMemoryAuthStore();
  const first = await store.syncUser(
    "corp-a",
    member({
      departments: [
        { id: "1", name: "Brand", isPrimary: true },
        { id: "2", name: "Growth", isPrimary: false },
      ],
    }),
    "identity-alice",
    "2026-08-02T11:00:00.000Z",
  );
  const second = await store.syncUser(
    "corp-a",
    member({
      departments: [
        { id: "2", name: "Growth", isPrimary: true },
        { id: "3", name: "Retail", isPrimary: false },
      ],
    }),
    "identity-alice",
    "2026-08-02T12:00:00.000Z",
  );

  assert.equal(second.id, first.id);
  assert.deepEqual(second.departments, [
    { id: "2", name: "Growth", isPrimary: true },
    { id: "3", name: "Retail", isPrimary: false },
  ]);
});

test("Session lookup returns valid users and rejects expired or revoked sessions", async () => {
  const store = new InMemoryAuthStore();
  const user = await store.syncUser(
    "corp-a",
    member({
      departments: [{ id: "1", name: "Brand", isPrimary: true }],
    }),
    "identity-alice",
    "2026-08-02T11:00:00.000Z",
  );
  await store.createSession({
    id: "session-valid",
    userId: user.id,
    tokenHash: "valid-token",
    expiresAt: "2026-08-02T12:00:00.000Z",
    lastSeenAt: "2026-08-02T11:00:00.000Z",
    createdAt: "2026-08-02T11:00:00.000Z",
  });
  await store.createSession({
    id: "session-expired",
    userId: user.id,
    tokenHash: "expired-token",
    expiresAt: "2026-08-02T11:15:00.000Z",
    lastSeenAt: "2026-08-02T11:00:00.000Z",
    createdAt: "2026-08-02T11:00:00.000Z",
  });

  assert.deepEqual(await store.getSession("valid-token", "2026-08-02T11:30:00.000Z"), user);
  assert.equal(await store.getSession("expired-token", "2026-08-02T11:30:00.000Z"), null);

  await store.revokeSession("valid-token", "2026-08-02T11:40:00.000Z");
  assert.equal(await store.getSession("valid-token", "2026-08-02T11:41:00.000Z"), null);
});

test("App token read rejects expired tokens", async () => {
  const store = new InMemoryAuthStore();
  await store.putAppToken({
    corpId: "corp-a",
    agentId: "agent-1",
    token: { ciphertext: "ciphertext", iv: "iv" },
    expiresAt: "2026-08-02T12:00:00.000Z",
    updatedAt: "2026-08-02T11:00:00.000Z",
  });

  assert.deepEqual(await store.getAppToken("corp-a", "agent-1", "2026-08-02T11:30:00.000Z"), {
    corpId: "corp-a",
    agentId: "agent-1",
    token: { ciphertext: "ciphertext", iv: "iv" },
    expiresAt: "2026-08-02T12:00:00.000Z",
    updatedAt: "2026-08-02T11:00:00.000Z",
  });
  assert.equal(await store.getAppToken("corp-a", "agent-1", "2026-08-02T12:00:00.000Z"), null);
});

test("withAppTokenRefreshLock serializes operations in memory", async () => {
  const store = new InMemoryAuthStore();
  const events: string[] = [];
  let active = 0;

  await Promise.all([
    store.withAppTokenRefreshLock("corp-a", "agent-1", async () => {
      active += 1;
      events.push(`first:start:${active}`);
      await Promise.resolve();
      events.push(`first:end:${active}`);
      active -= 1;
      return "first";
    }),
    store.withAppTokenRefreshLock("corp-a", "agent-1", async () => {
      active += 1;
      events.push(`second:start:${active}`);
      await Promise.resolve();
      events.push(`second:end:${active}`);
      active -= 1;
      return "second";
    }),
  ]);

  assert.deepEqual(events, ["first:start:1", "first:end:1", "second:start:1", "second:end:1"]);
});

function member(overrides: Partial<WeComMember> = {}): WeComMember {
  return {
    userId: "alice",
    displayName: "Alice",
    avatarUrl: null,
    email: "alice@example.com",
    departments: [{ id: "1", name: "Brand", isPrimary: true }],
    ...overrides,
  };
}

type StoredUser = CurrentUser & {
  wecomCorpId: string;
  wecomUserId: string;
  status: "ACTIVE" | "DISABLED";
};

class InMemoryAuthStore implements AuthStore {
  private nextUserId = 1;
  private readonly oauthStates = new Map<string, OAuthStateRecord>();
  private readonly stateHashToId = new Map<string, string>();
  private readonly users = new Map<string, StoredUser>();
  private readonly corpUserToId = new Map<string, string>();
  private readonly identityKeyToId = new Map<string, string>();
  private readonly sessions = new Map<string, NewSession & { revokedAt: string | null }>();
  private readonly appTokens = new Map<string, EncryptedAppToken>();
  private readonly locks = new Map<string, Promise<void>>();

  async createOAuthState(input: NewOAuthState): Promise<void> {
    const record: OAuthStateRecord = {
      ...input,
      consumedAt: null,
    };
    this.oauthStates.set(input.id, record);
    this.stateHashToId.set(input.stateHash, input.id);
  }

  async consumeOAuthState(
    stateHash: string,
    nonceHash: string,
    now: string,
  ): Promise<OAuthStateRecord | null> {
    const id = this.stateHashToId.get(stateHash);
    const record = id ? this.oauthStates.get(id) : null;
    if (
      !record ||
      record.browserNonceHash !== nonceHash ||
      record.consumedAt !== null ||
      record.expiresAt <= now
    ) {
      return null;
    }

    const consumed = { ...record, consumedAt: now };
    this.oauthStates.set(record.id, consumed);
    return consumed;
  }

  async syncUser(
    corpId: string,
    wecomMember: WeComMember,
    identityKey: string,
    now: string,
  ): Promise<CurrentUser> {
    void now;
    const corpUserKey = `${corpId}:${wecomMember.userId}`;
    const existingId = this.corpUserToId.get(corpUserKey) ?? this.identityKeyToId.get(identityKey);
    const id = existingId ?? `user-${this.nextUserId}`;
    if (!existingId) {
      this.nextUserId += 1;
    }

    this.corpUserToId.set(corpUserKey, id);
    this.identityKeyToId.set(identityKey, id);
    const current: StoredUser = {
      id,
      wecomCorpId: corpId,
      wecomUserId: wecomMember.userId,
      identityKey,
      displayName: wecomMember.displayName,
      avatarUrl: wecomMember.avatarUrl,
      email: wecomMember.email,
      departments: wecomMember.departments.map((department) => ({ ...department })),
      status: "ACTIVE",
    };
    this.users.set(id, current);
    return this.toCurrentUser(current);
  }

  async createSession(input: NewSession): Promise<void> {
    this.sessions.set(input.tokenHash, { ...input, revokedAt: null });
  }

  async getSession(tokenHash: string, now: string): Promise<CurrentUser | null> {
    const session = this.sessions.get(tokenHash);
    const user = session ? this.users.get(session.userId) : null;
    if (!session || !user || session.revokedAt !== null || session.expiresAt <= now || user.status !== "ACTIVE") {
      return null;
    }
    session.lastSeenAt = now;
    return this.toCurrentUser(user);
  }

  async revokeSession(tokenHash: string, now: string): Promise<void> {
    const session = this.sessions.get(tokenHash);
    if (session) {
      session.revokedAt = now;
    }
  }

  async getAppToken(corpId: string, agentId: string, now: string): Promise<EncryptedAppToken | null> {
    const record = this.appTokens.get(`${corpId}:${agentId}`);
    if (!record || record.expiresAt <= now) {
      return null;
    }
    return { ...record, token: { ...record.token } };
  }

  async putAppToken(input: EncryptedAppToken): Promise<void> {
    this.appTokens.set(`${input.corpId}:${input.agentId}`, {
      ...input,
      token: { ...input.token },
    });
  }

  async withAppTokenRefreshLock<T>(
    corpId: string,
    agentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${corpId}:${agentId}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === queued) {
        this.locks.delete(key);
      }
    }
  }

  private toCurrentUser(user: StoredUser): CurrentUser {
    return {
      id: user.id,
      identityKey: user.identityKey,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      email: user.email,
      departments: user.departments.map((department) => ({ ...department })),
    };
  }
}
