import assert from "node:assert/strict";
import test from "node:test";
import { getOrCreateV04WorkspaceTabToken } from "../components/v04/V04VideoSessionProvider.tsx";

test("workspace tab identity survives a same-tab refresh without persisting lease proof", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const firstUuid = "123e4567-e89b-42d3-a456-426614174010";
  const first = getOrCreateV04WorkspaceTabToken("video-a", storage, () => firstUuid);
  const refreshed = getOrCreateV04WorkspaceTabToken("video-a", storage, () => {
    assert.fail("a full-page refresh must reuse the exact non-credential tab identity");
  });
  assert.deepEqual(refreshed, first);
  assert.match(first.tabToken, /^v04-workspace-/);
  assert.doesNotMatch(JSON.stringify([...values]), /leaseToken|leaseVersion|sessionToken|credential/i);
});

test("different browser tabs remain isolated and unavailable storage falls back safely", () => {
  const storageA = new Map<string, string>();
  const storageB = new Map<string, string>();
  const adapt = (values: Map<string, string>) => ({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  });
  const tabA = getOrCreateV04WorkspaceTabToken(
    "video-a", adapt(storageA), () => "123e4567-e89b-42d3-a456-426614174011",
  );
  const tabB = getOrCreateV04WorkspaceTabToken(
    "video-a", adapt(storageB), () => "123e4567-e89b-42d3-a456-426614174012",
  );
  assert.notEqual(tabA.tabToken, tabB.tabToken);
  const fallback = getOrCreateV04WorkspaceTabToken(
    "video-a", null, () => "123e4567-e89b-42d3-a456-426614174013",
  );
  assert.equal(fallback.persisted, false);
});
