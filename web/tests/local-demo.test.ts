import assert from "node:assert/strict";
import test from "node:test";
import { isLocalDemoMode, localDemoAppUrl } from "../lib/local-demo.ts";
import { localObjectPath, localStorageRoot } from "../storage/local.ts";

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("local demo mode is available only in development", () => {
  const previousMode = process.env.LOCAL_DEMO_MODE;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.LOCAL_DEMO_MODE = "1";
    process.env.NODE_ENV = "production";
    assert.equal(isLocalDemoMode(), false);
    process.env.NODE_ENV = "test";
    assert.equal(isLocalDemoMode(), false);
    process.env.NODE_ENV = "development";
    assert.equal(isLocalDemoMode(), true);
  } finally {
    restore("LOCAL_DEMO_MODE", previousMode);
    restore("NODE_ENV", previousNodeEnv);
  }
});

test("local demo URL accepts only an HTTP loopback origin", () => {
  const previousMode = process.env.LOCAL_DEMO_MODE;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAppUrl = process.env.APP_URL;
  try {
    process.env.LOCAL_DEMO_MODE = "1";
    process.env.NODE_ENV = "development";
    process.env.APP_URL = "http://localhost:3000";
    assert.equal(localDemoAppUrl(), "http://localhost:3000");
    process.env.APP_URL = "http://192.168.1.20:3000";
    assert.throws(() => localDemoAppUrl(), /HTTP loopback/);
    process.env.APP_URL = "https://localhost:3000";
    assert.throws(() => localDemoAppUrl(), /HTTP loopback/);
  } finally {
    restore("LOCAL_DEMO_MODE", previousMode);
    restore("NODE_ENV", previousNodeEnv);
    restore("APP_URL", previousAppUrl);
  }
});

test("local object keys stay inside the isolated demo storage root", () => {
  const object = localObjectPath("videos/demo/original");
  assert.match(object, new RegExp(`^${escapeRegExp(localStorageRoot())}`));
  assert.throws(() => localObjectPath("../outside"), /Invalid local object key/);
  assert.throws(() => localObjectPath("/absolute"), /Invalid local object key/);
  assert.throws(() => localObjectPath("videos//original"), /Invalid local object key/);
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
