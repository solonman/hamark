import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  evaluateV04GrayAccess,
  hashV04GrayUserId,
  loadV04GrayConfig,
  type V04GrayFacts,
} from "../lib/v04-gray-access.ts";

const USER_A = ["user", "testonly", "actor", "a"].join("_");
const USER_B = ["user", "testonly", "actor", "b"].join("_");
const VIDEO_TEST = "video_testonly_media_a";
const VIDEO_CONTROLLED = "video_controlled_media_a";

const activeFacts: V04GrayFacts = {
  userStatus: "ACTIVE",
  contractsActive: true,
  video: {
    id: VIDEO_TEST,
    status: "READY",
    dataScope: "TEST_ONLY",
    objectKey: "test-only/gray/media.mp4",
    fileSize: 1024,
    deletedAt: null,
    deletionState: "ACTIVE",
  },
};

function config(overrides: Record<string, string | undefined> = {}) {
  return loadV04GrayConfig({
    V04_GRAY_ROLLOUT_ENABLED: "true",
    V04_GRAY_USER_ID_SHA256S: `${hashV04GrayUserId(USER_A)},${hashV04GrayUserId(USER_B)}`,
    V04_GRAY_TEST_VIDEO_IDS: VIDEO_TEST,
    V04_GRAY_CONTROLLED_VIDEO_IDS: VIDEO_CONTROLLED,
    ...overrides,
  });
}

test("gray rollout is closed by default and rejects empty, duplicate or non-stable allowlists", () => {
  assert.equal(loadV04GrayConfig({}).enabled, false);
  assert.equal(loadV04GrayConfig({ V04_GRAY_ROLLOUT_ENABLED: "true" }).valid, false);
  assert.equal(config({ V04_GRAY_USER_ID_SHA256S: "老孙" }).valid, false);
  assert.equal(config({ V04_GRAY_USER_ID_SHA256S: "abc" }).valid, false);
  const digest = hashV04GrayUserId(USER_A);
  assert.equal(config({ V04_GRAY_USER_ID_SHA256S: `${digest},${digest}` }).valid, false);
  assert.equal(config({ V04_GRAY_USER_ID_SHA256S: "" }).valid, false);
  assert.equal(config({ V04_GRAY_TEST_VIDEO_IDS: "*" }).valid, false);
});

test("two explicit stable actors can access only a ready approved TEST_ONLY video", () => {
  assert.deepEqual(evaluateV04GrayAccess(config(), USER_A, activeFacts, VIDEO_TEST), {
    allowed: true,
    reason: "GRANTED",
  });
  assert.equal(evaluateV04GrayAccess(config(), USER_B, activeFacts, VIDEO_TEST).allowed, true);
  assert.equal(evaluateV04GrayAccess(config(), ["user", "unknown", "actor"].join("_"), activeFacts, VIDEO_TEST).reason,
    "USER_NOT_ALLOWED");
  assert.equal(evaluateV04GrayAccess(config(), USER_A, { ...activeFacts, userStatus: "DISABLED" }, VIDEO_TEST).reason,
    "USER_NOT_ACTIVE");
  assert.equal(evaluateV04GrayAccess(config(), USER_A, { ...activeFacts, contractsActive: false }, VIDEO_TEST).reason,
    "CONTRACT_NOT_ACTIVE");
  assert.equal(evaluateV04GrayAccess(config(), USER_A, activeFacts, "video_unknown_media_a").reason,
    "VIDEO_NOT_ALLOWED");
  assert.equal(evaluateV04GrayAccess(config(), USER_A, {
    ...activeFacts,
    video: { ...activeFacts.video!, fileSize: 0 },
  }, VIDEO_TEST).reason, "VIDEO_NOT_READY");
  assert.equal(evaluateV04GrayAccess(config(), USER_A, {
    ...activeFacts,
    video: { ...activeFacts.video!, dataScope: "BUSINESS" },
  }, VIDEO_TEST).reason, "VIDEO_NOT_TEST_ONLY");
});

test("an explicitly approved controlled existing video stays separate from TEST_ONLY classification", () => {
  const controlledFacts = {
    ...activeFacts,
    video: { ...activeFacts.video!, id: VIDEO_CONTROLLED, dataScope: "BUSINESS" },
  };
  assert.equal(evaluateV04GrayAccess(config(), USER_A, controlledFacts, VIDEO_CONTROLLED).allowed, true);
  assert.equal(evaluateV04GrayAccess(config({ V04_GRAY_CONTROLLED_VIDEO_IDS: "" }),
    USER_A, controlledFacts, VIDEO_CONTROLLED).reason, "VIDEO_NOT_ALLOWED");
});

test("all official V0.4 surfaces reuse one server gray guard and deployment only opens the test-object tool", () => {
  const api = readFileSync(new URL("../lib/v04-api.ts", import.meta.url), "utf8");
  const gray = readFileSync(new URL("../lib/v04-gray-access.ts", import.meta.url), "utf8");
  const practice = readFileSync(new URL("../app/videos/[id]/practice/page.tsx", import.meta.url), "utf8");
  const detail = readFileSync(new URL("../app/videos/[id]/page.tsx", import.meta.url), "utf8");
  const home = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const cards = readFileSync(new URL("../app/api/videos/analysis/v04/cards/route.ts", import.meta.url), "utf8");
  const deployment = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.match(api, /assertV04GrayAccess/);
  assert.match(api, /v04GrayVideoIdFromRequest/);
  assert.match(gray, /V04_GRAY_USER_ID_SHA256S/);
  assert.match(gray, /timingSafeEqual/);
  const legacyRawIdEnvironmentName = ["V04", "GRAY", "USER", "IDS"].join("_");
  assert.equal(gray.includes(legacyRawIdEnvironmentName), false);
  assert.match(gray, /V04_GRAY_TEST_VIDEO_IDS/);
  assert.match(gray, /V04_GRAY_CONTROLLED_VIDEO_IDS/);
  assert.doesNotMatch(gray, /displayName|display_name|app_admins/);
  assert.match(practice, /canAccessV04Gray\(getDbClient\(\), user\.id, id\)/);
  assert.match(detail, /canAccessV04Gray\(getDbClient\(\), user\.id, id\)/);
  assert.match(home, /canAccessV04Gray\(getDbClient\(\), user\.id\)/);
  assert.match(cards, /filterV04GrayVideoIds/);
  assert.deepEqual(deployment.env, { V04_GRAY_TEST_OBJECT_ENABLED: "true" });
});

test("identity digest is deterministic and the self-service proof page never renders stable ids", () => {
  assert.match(hashV04GrayUserId(USER_A), /^[a-f0-9]{64}$/);
  assert.equal(hashV04GrayUserId(USER_A), hashV04GrayUserId(USER_A));
  assert.notEqual(hashV04GrayUserId(USER_A), hashV04GrayUserId(USER_B));
  const page = readFileSync(new URL("../app/v04-gray-identity/page.tsx", import.meta.url), "utf8");
  assert.match(page, /V04_GRAY_IDENTITY_DIGEST_ENABLED/);
  assert.match(page, /requirePageUser/);
  assert.match(page, /hashV04GrayUserId\(user\.id\)/);
  assert.match(page, /status='ACTIVE'/);
  assert.doesNotMatch(page, /displayName|display_name|email|identityKey|user\.id\}/);
});

test("tracked repository has no legacy raw-id gray configuration boundary", () => {
  const legacyRawIdEnvironmentName = ["V04", "GRAY", "USER", "IDS"].join("_");
  let matches = "";
  try {
    matches = execFileSync("git", ["grep", "-n", legacyRawIdEnvironmentName], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 1) throw error;
  }
  assert.equal(matches, "");
});

test("gray rollback is non-destructive: closing the gate denies access without touching contracts or content", () => {
  const closed = config({ V04_GRAY_ROLLOUT_ENABLED: "false" });
  assert.equal(evaluateV04GrayAccess(closed, USER_A, activeFacts, VIDEO_TEST).reason, "GATE_CLOSED");
  const source = readFileSync(new URL("../lib/v04-gray-access.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b|\bTRUNCATE\b/);
});
