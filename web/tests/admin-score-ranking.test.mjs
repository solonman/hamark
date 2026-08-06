import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const readRepoFile = (pathFromTestFile) => {
  const path = fileURLToPath(new URL(pathFromTestFile, import.meta.url));
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

test("admin bootstrap seeds the three approved WeCom display names", () => {
  const bootstrap = readRepoFile("../db/bootstrap.ts");
  const schema = readRepoFile("../db/supabase.sql");
  for (const source of [bootstrap, schema]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS app_admins/);
    assert.match(source, /老孙/);
    assert.match(source, /李丽萍/);
    assert.match(source, /晏恩华/);
  }
});

test("admin helper checks the current WeCom display name in the database", () => {
  const source = readRepoFile("../lib/admin.ts");
  assert.match(source, /WHERE display_name = \?/);
  assert.match(source, /user\.displayName/);
});
