// 录音点评的数据表：schema 模块与生产迁移文件逐句一致（同 tests/v19-api-contract.test.ts 的做法），
// bootstrap 排在 FINAL_VERSION 之后，以及「迁移没执行」的识别。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AUDIO_REVIEW_SCHEMA_STATEMENTS, AUDIO_REVIEW_STATUSES } from "../db/audio-review-schema";
import { AUDIO_REVIEW_STATUS_LIST } from "../lib/audio-review-model";
import { AUDIO_REVIEW_MISSING_SCHEMA_MESSAGE, isMissingAudioReviewSchema } from "../lib/audio-review/errors";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const normalise = (text: string) => text.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();

test("every audio review schema statement appears verbatim (modulo whitespace) in the frozen migration, in order", async () => {
  const sql = normalise(await source("../db/migrations/2026-10-10-audio-review.sql"));
  let cursor = 0;
  for (const statement of AUDIO_REVIEW_SCHEMA_STATEMENTS) {
    const expected = normalise(statement);
    const at = sql.indexOf(expected, cursor);
    assert.ok(at >= 0, `frozen SQL is missing or out of order: ${expected.slice(0, 90)}…`);
    cursor = at + expected.length;
  }
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;$/);
  // 迁移文件里没有 schema 模块之外的语句：去掉所有语句和 BEGIN/COMMIT 之后只剩分号。
  let rest = sql;
  for (const statement of AUDIO_REVIEW_SCHEMA_STATEMENTS) rest = rest.replace(normalise(statement), "");
  assert.equal(rest.replace(/BEGIN;|COMMIT;|;|\s/g, ""), "");
});

test("the schema module runs after the final-version schema in bootstrap", async () => {
  const bootstrap = await source("../db/bootstrap.ts");
  const finalAt = bootstrap.indexOf("...FINAL_VERSION_SCHEMA_STATEMENTS");
  const audioAt = bootstrap.indexOf("...AUDIO_REVIEW_SCHEMA_STATEMENTS");
  assert.ok(finalAt > 0 && audioAt > finalAt);
});

test("the status check, partial unique indexes and RLS lock-down are all present", () => {
  const schema = AUDIO_REVIEW_SCHEMA_STATEMENTS.join("\n");
  assert.deepEqual([...AUDIO_REVIEW_STATUSES], [...AUDIO_REVIEW_STATUS_LIST]);
  for (const status of AUDIO_REVIEW_STATUSES) assert.ok(schema.includes(`'${status}'`), status);
  assert.match(schema, /audio_reviews_live_base_uidx ON audio_reviews \(base_version_id\) WHERE status <> 'ABANDONED'/);
  assert.match(schema, /analysis_versions_personal_owner_uidx ON analysis_versions \(workspace_id, owner_user_id\) WHERE version_kind = 'PERSONAL'/);
  assert.match(schema, /analysis_versions_audio_review_base_uidx ON analysis_versions \(base_version_id\) WHERE version_kind = 'AUDIO_REVIEW'/);
  assert.match(schema, /ALTER TABLE audio_reviews ENABLE ROW LEVEL SECURITY/);
  assert.match(schema, /REVOKE ALL ON TABLE audio_reviews FROM anon/);
  assert.match(schema, /lease_until TIMESTAMPTZ/);
  assert.doesNotMatch(schema, /CURRENT_TIMESTAMP/);
});

test("a missing table or column from the unapplied migration is recognised, other errors are not", () => {
  assert.equal(isMissingAudioReviewSchema({ code: "42P01", message: 'relation "audio_reviews" does not exist' }), true);
  assert.equal(isMissingAudioReviewSchema({ code: "42703", message: 'column "version_kind" does not exist' }), true);
  assert.equal(isMissingAudioReviewSchema({ code: "42703", message: 'column v.audio_review_id does not exist' }), true);
  assert.equal(isMissingAudioReviewSchema({ code: "42P01", message: 'relation "videos" does not exist' }), false);
  assert.equal(isMissingAudioReviewSchema({ code: "42703", message: 'column "title" does not exist' }), false);
  assert.equal(isMissingAudioReviewSchema(new Error("boom")), false);
  assert.equal(isMissingAudioReviewSchema(null), false);
  assert.match(AUDIO_REVIEW_MISSING_SCHEMA_MESSAGE, /web\/db\/migrations\/2026-10-10-audio-review\.sql/);
});
