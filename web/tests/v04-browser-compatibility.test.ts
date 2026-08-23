import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import V04BrowserCompatibilityMessage from "../components/v04/V04BrowserCompatibilityMessage.tsx";
import {
  detectV04LegacyBrowser,
  probeV04BrowserCompatibility,
  type V04BrowserEnvironment,
  type V04BrowserLockManager,
} from "../lib/v04-browser-compat.ts";

class WritableStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
}

const fullEnvironment = (overrides: Partial<V04BrowserEnvironment> = {}): V04BrowserEnvironment => ({
  secureContext: true,
  hasFetch: true,
  hasAbortController: true,
  hasRandomUUID: true,
  hasStructuredClone: true,
  hasFormData: true,
  hasFile: true,
  hasReadableStream: true,
  hasVideo: true,
  hasIntersectionObserver: true,
  hasPageLifecycle: true,
  sessionStorage: new WritableStorage(),
  localStorage: new WritableStorage(),
  lockManager: {
    request: async (_name, _options, callback) => callback({}),
  },
  createAbortController: () => new AbortController(),
  createId: () => "123e4567-e89b-42d3-a456-426614174000",
  ...overrides,
});

test("the official current browser capability set passes read and editing probes", async () => {
  assert.deepEqual(await probeV04BrowserCompatibility({ mode: "READ", environment: fullEnvironment() }), {
    supported: true,
    issues: [],
  });
  const editing = await probeV04BrowserCompatibility({ mode: "EDIT", environment: fullEnvironment() });
  assert.equal(editing.supported, true);
  assert.deepEqual(editing.issues, []);
});

test("missing structured clone, UUID, lifecycle and observers fail before a V1.9 surface mounts", async () => {
  const result = await probeV04BrowserCompatibility({
    mode: "READ",
    environment: fullEnvironment({
      hasStructuredClone: false,
      hasRandomUUID: false,
      hasIntersectionObserver: false,
      hasPageLifecycle: false,
    }),
  });
  assert.equal(result.supported, false);
  assert.deepEqual(result.issues, [
    "RANDOM_UUID_UNAVAILABLE",
    "STRUCTURED_CLONE_UNAVAILABLE",
    "INTERSECTION_OBSERVER_UNAVAILABLE",
    "PAGE_LIFECYCLE_UNAVAILABLE",
  ]);
});

test("blocked storage and absent, rejected or hanging Web Locks fail closed", async () => {
  const brokenStorage = {
    get length() { return 0; },
    setItem() { throw new Error("blocked"); },
    getItem() { return null; },
    removeItem() {},
    key() { return null; },
  };
  const absent = await probeV04BrowserCompatibility({
    mode: "EDIT",
    environment: fullEnvironment({ sessionStorage: brokenStorage, localStorage: null, lockManager: null }),
    lockTimeoutMs: 5,
  });
  assert.equal(absent.supported, false);
  assert.deepEqual(absent.issues, [
    "SESSION_STORAGE_UNAVAILABLE",
    "LOCAL_STORAGE_UNAVAILABLE",
    "WEB_LOCKS_UNAVAILABLE",
  ]);

  const rejectedLocks: V04BrowserLockManager = { request: () => Promise.reject(new Error("private")) };
  const rejected = await probeV04BrowserCompatibility({
    mode: "EDIT",
    environment: fullEnvironment({ lockManager: rejectedLocks }),
    lockTimeoutMs: 5,
  });
  assert.deepEqual(rejected.issues, ["WEB_LOCKS_UNAVAILABLE"]);

  let hangingOptions: Record<string, unknown> | null = null;
  const hangingLocks: V04BrowserLockManager = {
    request: (_name, options) => {
      hangingOptions = options as unknown as Record<string, unknown>;
      return new Promise(() => undefined);
    },
  };
  const startedAt = Date.now();
  const hanging = await probeV04BrowserCompatibility({
    mode: "EDIT",
    environment: fullEnvironment({ lockManager: hangingLocks }),
    lockTimeoutMs: 5,
  });
  assert.deepEqual(hanging.issues, ["WEB_LOCKS_UNAVAILABLE"]);
  assert.equal((hangingOptions as Record<string, unknown> | null)?.signal, undefined);
  assert(Date.now() - startedAt < 250, "a hanging capability probe must not hang the first workspace GET");
});

test("the editing probe passes against a spec-accurate Web Locks implementation", async () => {
  // Real browsers reject with NotSupportedError when `signal` is combined with
  // `ifAvailable`, so a mock that accepts both hides a total editing outage.
  const heldNames = new Set<string>();
  const specAccurateLocks: V04BrowserLockManager = {
    request: async (name, options, callback) => {
      const requested = options as unknown as Record<string, unknown>;
      if ("signal" in requested && (requested.ifAvailable === true || requested.steal === true)) {
        throw Object.assign(
          new Error("The 'signal' and 'ifAvailable' options cannot be used together."),
          { name: "NotSupportedError" },
        );
      }
      if (heldNames.has(name)) return callback(null);
      heldNames.add(name);
      try {
        return await callback({ name });
      } finally {
        heldNames.delete(name);
      }
    },
  };
  const result = await probeV04BrowserCompatibility({
    mode: "EDIT",
    environment: fullEnvironment({ lockManager: specAccurateLocks }),
  });
  assert.deepEqual(result.issues, []);
  assert.equal(result.supported, true);
});

test("editing storage probes verify readback, deletion and local key enumeration before children mount", async () => {
  type StorageFactory = () => WritableStorage;
  const cases: Array<{
    name: string;
    issue: "SESSION_STORAGE_UNAVAILABLE" | "LOCAL_STORAGE_UNAVAILABLE";
    target: "sessionStorage" | "localStorage";
    makeStorage: StorageFactory;
    removalUnavailable?: boolean;
  }> = [
    {
      name: "session getItem throws",
      issue: "SESSION_STORAGE_UNAVAILABLE",
      target: "sessionStorage",
      makeStorage: () => Object.assign(new WritableStorage(), {
        getItem() { throw new Error("blocked"); },
      }),
    },
    {
      name: "session getItem returns the wrong value",
      issue: "SESSION_STORAGE_UNAVAILABLE",
      target: "sessionStorage",
      makeStorage: () => Object.assign(new WritableStorage(), {
        getItem() { return "wrong"; },
      }),
    },
    {
      name: "session remove is a no-op",
      issue: "SESSION_STORAGE_UNAVAILABLE",
      target: "sessionStorage",
      removalUnavailable: true,
      makeStorage: () => Object.assign(new WritableStorage(), {
        removeItem() { /* deliberately does not remove */ },
      }),
    },
    {
      name: "local getItem throws",
      issue: "LOCAL_STORAGE_UNAVAILABLE",
      target: "localStorage",
      makeStorage: () => Object.assign(new WritableStorage(), {
        getItem() { throw new Error("blocked"); },
      }),
    },
    {
      name: "local length throws",
      issue: "LOCAL_STORAGE_UNAVAILABLE",
      target: "localStorage",
      makeStorage: () => {
        const storage = new WritableStorage();
        Object.defineProperty(storage, "length", { get() { throw new Error("blocked"); } });
        return storage;
      },
    },
    {
      name: "local key enumeration throws",
      issue: "LOCAL_STORAGE_UNAVAILABLE",
      target: "localStorage",
      makeStorage: () => Object.assign(new WritableStorage(), {
        key() { throw new Error("blocked"); },
      }),
    },
    {
      name: "local enumeration cannot find the probe key",
      issue: "LOCAL_STORAGE_UNAVAILABLE",
      target: "localStorage",
      makeStorage: () => Object.assign(new WritableStorage(), {
        key() { return "an-existing-unrelated-key"; },
      }),
    },
    {
      name: "local remove is a no-op",
      issue: "LOCAL_STORAGE_UNAVAILABLE",
      target: "localStorage",
      removalUnavailable: true,
      makeStorage: () => Object.assign(new WritableStorage(), {
        removeItem() { /* deliberately does not remove */ },
      }),
    },
  ];

  for (const storageCase of cases) {
    const storage = storageCase.makeStorage();
    const result = await probeV04BrowserCompatibility({
      mode: "EDIT",
      environment: fullEnvironment({ [storageCase.target]: storage }),
    });
    assert.equal(result.supported, false, storageCase.name);
    assert.deepEqual(result.issues, [storageCase.issue], storageCase.name);
    const probeRemains = [...storage.values.keys()].some((key) => key.startsWith("hamark:v04:probe:"));
    assert.equal(
      probeRemains,
      storageCase.removalUnavailable ?? false,
      `${storageCase.name}: cleanup is mandatory whenever storage removal actually works`,
    );
  }

  const gate = await readFile(
    new URL("../components/v04/V04BrowserCompatibilityGate.tsx", import.meta.url),
    "utf8",
  );
  assert.match(gate, /if \(supported === null\) return <V04BrowserCompatibilityMessage/);
  assert.match(gate, /if \(!supported\) return <V04BrowserCompatibilityMessage/);
  assert.ok(
    gate.indexOf("if (!supported)") < gate.indexOf("return children"),
    "negative storage results must block before identity/workspace children mount",
  );
});

test("known legacy office engines and IE/EdgeHTML are server-blocked before client editing", () => {
  const userAgents = [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/109.0.0.0 Safari/537.36", "CHROME"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/109.0.0.0 Safari/537.36 Edg/109.0.1518.78", "EDGE"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:102.0) Gecko/20100101 Firefox/102.0", "FIREFOX"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 12_6) AppleWebKit/605.1.15 Version/15.6 Safari/605.1.15", "SAFARI"],
    ["Mozilla/5.0 (Windows NT 6.1; Trident/7.0; rv:11.0) like Gecko", "IE"],
    ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Edge/18.19045", "EDGEHTML"],
  ] as const;
  for (const [userAgent, engine] of userAgents) {
    assert.equal(detectV04LegacyBrowser(userAgent)?.engine, engine);
  }
  assert.equal(detectV04LegacyBrowser("Mozilla/5.0 Chrome/111.0.0.0 Safari/537.36"), null);
  assert.equal(detectV04LegacyBrowser("Mozilla/5.0 Firefox/111.0"), null);
  assert.equal(detectV04LegacyBrowser("Mozilla/5.0 Version/16.4 Safari/605.1.15"), null);

  const html = renderToStaticMarkup(createElement(V04BrowserCompatibilityMessage, { mode: "EDIT" }));
  assert.match(html, /请升级或更换浏览器/);
  assert.match(html, /没有进入编辑状态/);
  assert.doesNotMatch(html, /<(?:input|textarea|select|form)\b/);
});

test("formal routes gate V1.9 children and the provider rejects uncertain temporary identities", async () => {
  const [home, detail, practice, gate, provider] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/practice/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/v04/V04BrowserCompatibilityGate.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/v04/V04VideoSessionProvider.tsx", import.meta.url), "utf8"),
  ]);
  for (const page of [home, detail, practice]) {
    assert.match(page, /detectV04LegacyBrowser/);
    assert.match(page, /V04BrowserCompatibilityMessage/);
    assert.match(page, /V04BrowserCompatibilityGate/);
  }
  assert.ok(detail.lastIndexOf("detectV04LegacyBrowser") > detail.indexOf("v04DefaultEnabled && v04DetailEnabled && !explicitLegacyView"));
  assert.ok(practice.lastIndexOf("detectV04LegacyBrowser") > practice.indexOf("if (isV04)"));
  assert.match(practice, /V04BrowserCompatibilityGate mode="EDIT"/);
  assert.match(gate, /if \(supported === null\)[\s\S]*if \(!supported\)[\s\S]*return children/);
  assert.match(provider, /if \(claim\.failClosed\)[\s\S]*throw new Error\(V04_UNSAFE_EDITING_MESSAGE\)/);
});
