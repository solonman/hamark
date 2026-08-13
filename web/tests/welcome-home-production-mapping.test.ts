import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  deriveWelcomeHomeGroups,
  validateWelcomeHomeInspection,
  type WelcomeHomeMappingConfig,
} from "../lib/welcome-home-production-mapping.ts";

const config: WelcomeHomeMappingConfig = {
  videoId: "TEST_ONLY_video",
  operationKey: "TEST_ONLY_operation",
  sourceAuthorName: "TEST_ONLY 来源",
  targetAuthorName: "TEST_ONLY 目标",
  activeReleaseNumber: 5,
  confirmation: "TEST_ONLY confirmation",
  dataScope: "TEST_ONLY",
};

function field(code: string, answer = `${code} answer`) {
  return { field_code: code, answer, evidence: "" };
}

function validInspection() {
  const groupEnds = [4, 8, 11, 14, 17, 20, 23];
  const shots = Array.from({ length: 23 }, (_, index) => ({
    id: `shot_${index}`,
    order_index: index,
    group_name: `桥段 ${groupEnds.findIndex((end) => index < end) + 1}`,
    creative_comment: index === (groupEnds[groupEnds.findIndex((end) => index < end) - 1] ?? 0)
      ? `作用 ${index}` : "",
  }));
  const fields = [
    ...Array.from({ length: 9 }, (_, index) => field(`A${index + 1}`)),
    ...Array.from({ length: 10 }, (_, index) => field(`B${index + 1}`)),
  ];
  const source = { status: "DRAFT", review_status: "DRAFT" };
  const target = { status: "SUBMITTED", review_status: "APPROVED" };
  return {
    video: { id: config.videoId, data_scope: "TEST_ONLY" },
    sourceCandidates: [source],
    targetCandidates: [target],
    source,
    target,
    sourceSnapshot: { author_name: config.sourceAuthorName, revision: 7 },
    release: { status: "ACTIVE", release_number: 5 },
    sourcePackage: { annotation: source, shots, groups: [], fields, structures: [] },
    derivedGroups: deriveWelcomeHomeGroups(shots),
    sourceFields: fields,
    ledger: null as Record<string, unknown> | null,
  };
}

test("contiguous V0.2 group names become seven mapped bridge groups", () => {
  const inspection = validInspection();
  assert.equal(inspection.derivedGroups.length, 7);
  assert.equal(inspection.derivedGroups.reduce((sum, group) => sum + group.shots.length, 0), 23);
  assert.equal(inspection.derivedGroups[0].note, "作用 0");
});

test("frozen 23/7/19, state, R5, and B2/B3 conditions are all blocking", () => {
  const valid = validInspection();
  assert.deepEqual(validateWelcomeHomeInspection(valid, config), []);

  const badCounts = validInspection();
  badCounts.sourcePackage.shots.pop();
  badCounts.derivedGroups = deriveWelcomeHomeGroups(badCounts.sourcePackage.shots);
  badCounts.sourceFields.pop();
  assert.match(validateWelcomeHomeInspection(badCounts, config).join("；"), /23|19/);

  const badState = validInspection();
  badState.target.status = "DRAFT";
  assert.match(validateWelcomeHomeInspection(badState, config).join("；"), /SUBMITTED\/APPROVED/);

  const badRelease = validInspection();
  badRelease.release.release_number = 6;
  assert.match(validateWelcomeHomeInspection(badRelease, config).join("；"), /ACTIVE R5/);

  const missingB2 = validInspection();
  missingB2.sourceFields.find((item) => item.field_code === "B2")!.answer = "";
  assert.match(validateWelcomeHomeInspection(missingB2, config).join("；"), /B2/);
});

test("completed operation ledger permanently blocks a fresh apply preview", () => {
  const inspection = validInspection();
  inspection.ledger = { status: "COMPLETED" };
  assert.match(validateWelcomeHomeInspection(inspection, config).join("；"), /永久只读/);
});

test("admin API is session protected, same-origin protected, fixed scope, and not wired to startup migration", async () => {
  const route = await read("app/api/admin/welcome-home-v02-v03-mapping/route.ts");
  const service = await read("lib/welcome-home-production-mapping.ts");
  const bootstrap = await read("db/bootstrap.ts");
  const packageJson = await read("package.json");
  assert.match(route, /requireApiUser\(request\)/);
  assert.match(route, /isAppAdmin\(user\)/);
  assert.match(route, /requireSameOriginMutation\(request\)/);
  assert.match(route, /body\.action !== "APPLY"/);
  assert.match(service, /WELCOME_HOME_MAPPING_VIDEO_ID/);
  assert.match(service, /pg_advisory_xact_lock/);
  assert.match(service, /FOR UPDATE/);
  assert.match(service, /backup_json JSONB NOT NULL/);
  assert.match(service, /ALTER TABLE admin_data_operations ENABLE ROW LEVEL SECURITY/);
  assert.match(service, /permanently locked/);
  assert.match(service, /status = 'COMPLETED'/);
  assert.match(service, /SYSTEM_MAPPED/);
  assert.doesNotMatch(bootstrap, /admin_data_operations/);
  assert.doesNotMatch(packageJson, /welcome-home.*(build|start)/i);
});

function read(file: string) {
  return readFile(path.join(process.cwd(), file), "utf8");
}
