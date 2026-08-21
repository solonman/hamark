import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isV04ThirdModuleTargetKey } from "../lib/v04-production-write-audit";

test("third-module audit target allowlist matches approved backend keys", () => {
  for (const key of [
    "path.primaryType",
    "path.primaryDetails",
    "path.primaryDetails.emotionalFoundation",
    "path.auxiliaryTypes",
    "path.auxiliary:FUN.description",
  ]) assert.equal(isV04ThirdModuleTargetKey(key), true, key);
  for (const key of ["facts.creativeMotif", "shot:s1.visualContent", "pathology.note"])
    assert.equal(isV04ThirdModuleTargetKey(key), false, key);
});

test("production audit is aggregate-only, no-store and stable-admin protected", () => {
  const source = readFileSync(new URL("../lib/v04-production-write-audit.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/admin/v04-write-audit/page.tsx", import.meta.url), "utf8");
  assert.match(source, /role_key = 'SYSTEM_ADMIN'/);
  assert.match(source, /COUNT\(\*\)/);
  assert.match(source, /target_key/);
  assert.doesNotMatch(source, /payload_json\s*->|SELECT\s+[^;]*payload_json\s+FROM/i);
  assert.doesNotMatch(page, /payload_json|before_value_json|after_value_json/);
  assert.match(page, /dynamic = "force-dynamic"/);
  assert.match(page, /revalidate = 0/);
  assert.match(page, /不读取、渲染或导出任何正文/);
});
