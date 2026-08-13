import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bootstrap = readFileSync(
  fileURLToPath(new URL("../db/bootstrap.ts", import.meta.url)),
  "utf8",
);

const collect = (pattern) =>
  [...bootstrap.matchAll(pattern)].map((match) => match[1]);

// Supabase serves the public schema over PostgREST, so a table without RLS is
// readable and writable by anyone holding the project URL and anon key. Adding a
// table means adding it to the RLS list at the bottom of db/bootstrap.ts.
test("every table in the schema has row level security enabled", () => {
  const tables = collect(/CREATE TABLE IF NOT EXISTS ([a-z0-9_]+)/g);
  const secured = collect(/ALTER TABLE ([a-z0-9_]+) ENABLE ROW LEVEL SECURITY/g);

  assert.ok(tables.length > 0, "no tables found in db/bootstrap.ts");

  const unsecured = tables.filter((table) => !secured.includes(table));
  assert.deepEqual(
    unsecured,
    [],
    `tables without RLS (add them to the list at the bottom of db/bootstrap.ts): ${unsecured.join(", ")}`,
  );

  const orphaned = secured.filter((table) => !tables.includes(table));
  assert.deepEqual(
    orphaned,
    [],
    `RLS enabled for tables the schema never creates: ${orphaned.join(", ")}`,
  );
});
