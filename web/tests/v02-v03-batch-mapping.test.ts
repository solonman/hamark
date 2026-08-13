import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { deriveBatchGroups } from "../lib/v02-v03-batch-mapping.ts";

test("contiguous V0.2 group names become variable-length V0.3 bridge groups", () => {
  const groups = deriveBatchGroups([
    { group_name: "建立世界", creative_comment: "建立重复动作" },
    { group_name: "建立世界", creative_comment: "" },
    { group_name: "反转", creative_comment: "打破原始预期" },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].shots.length, 2);
  assert.equal(groups[0].note, "建立重复动作");
  assert.equal(groups[1].title, "反转");
  assert.deepEqual(deriveBatchGroups([{ group_name: "" }]), []);
});

test("generic batch route and service enforce the frozen safety boundary", async () => {
  const route = await read("app/api/admin/v02-v03-batch-mapping/route.ts");
  const service = await read("lib/v02-v03-batch-mapping.ts");
  const bootstrap = await read("db/bootstrap.ts");
  const home = await read("app/components/HomeClient.tsx");
  assert.match(route, /requireApiUser\(request\)/);
  assert.match(route, /isAppAdmin\(user\)/);
  assert.match(route, /requireSameOriginMutation\(request\)/);
  assert.match(route, /body\.action !== "APPLY_CANDIDATE"/);
  assert.match(service, /author_user\.identity_key = submitted\.author_email/);
  assert.match(service, /author_user\.status AS current_author_status/);
  assert.match(service, /candidate\.video_id = submitted\.video_id/);
  assert.match(service, /candidate\.taxonomy_version = 'V0\.3-PILOT'/);
  assert.match(service, /targetAnnotationId\) status = "SKIP_EXISTING"/);
  assert.match(service, /pg_advisory_xact_lock/);
  assert.match(service, /FOR UPDATE/);
  assert.match(service, /withTransaction/);
  assert.match(service, /SYSTEM_MAPPED/);
  assert.match(service, /primary_creative_path/);
  assert.match(service, /批量映射不得猜测 V0\.3 主导创意路径/);
  assert.match(service, /source_snapshot_id/);
  assert.match(home, /\/admin\/v02-v03-batch-mapping/);
  assert.doesNotMatch(bootstrap, /V02_TO_V03_AUTHOR_BATCH/);
});

function read(file: string) {
  return readFile(path.join(process.cwd(), file), "utf8");
}
