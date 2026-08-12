import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertLocalDemoDatabase,
  isLocalDemoMode,
} from "../lib/local-demo.ts";

test("loopback databases are accepted in every spelling", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    const url = `postgresql://postgres:secret@${host}:55432/hamark`;
    assert.equal(assertLocalDemoDatabase(url), url);
  }
});

test("a remote database is refused before the pool is opened", () => {
  assert.throws(
    () =>
      assertLocalDemoDatabase(
        "postgresql://postgres:hunter2@db.abcdefgh.supabase.co:5432/postgres",
      ),
    /refuses to use the database at db\.abcdefgh\.supabase\.co/,
  );
});

test("the refusal never echoes the credentials it was handed", () => {
  try {
    assertLocalDemoDatabase(
      "postgresql://postgres:sup3r-s3cret@db.example.com:5432/postgres",
    );
    assert.fail("expected a refusal");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.doesNotMatch(message, /sup3r-s3cret/);
    assert.doesNotMatch(message, /postgresql:\/\//);
  }
});

test("an unparseable connection string is refused rather than assumed local", () => {
  assert.throws(
    () => assertLocalDemoDatabase("not-a-url"),
    /not a valid connection string/,
  );
});

test("the guard sits on the pool so every entry point is covered", async () => {
  const db = await readFile(
    path.join(process.cwd(), "db/index.ts"),
    "utf8",
  );

  assert.match(db, /assertLocalDemoDatabase/);
  assert.match(db, /connectionString: localDemoSafeConnectionString\(\)/);
  // The demo swaps storage and auth but not the database, so the pool is the only
  // place that catches both `next dev` and `npm run local:setup`.
  assert.match(db, /isLocalDemoMode\(\)\s*\?\s*assertLocalDemoDatabase\(connectionString\)/);
});

test("local demo mode is limited to development or explicit local acceptance", () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    localDemo: process.env.LOCAL_DEMO_MODE,
    acceptance: process.env.LOCAL_DEMO_ACCEPTANCE_MODE,
  };

  try {
    process.env.LOCAL_DEMO_MODE = "1";
    process.env.NODE_ENV = "development";
    delete process.env.LOCAL_DEMO_ACCEPTANCE_MODE;
    assert.equal(isLocalDemoMode(), true);

    process.env.NODE_ENV = "production";
    assert.equal(isLocalDemoMode(), false);

    process.env.LOCAL_DEMO_ACCEPTANCE_MODE = "1";
    assert.equal(isLocalDemoMode(), true);

    delete process.env.LOCAL_DEMO_MODE;
    assert.equal(isLocalDemoMode(), false);
  } finally {
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.localDemo === undefined) delete process.env.LOCAL_DEMO_MODE;
    else process.env.LOCAL_DEMO_MODE = previous.localDemo;
    if (previous.acceptance === undefined) delete process.env.LOCAL_DEMO_ACCEPTANCE_MODE;
    else process.env.LOCAL_DEMO_ACCEPTANCE_MODE = previous.acceptance;
  }
});
