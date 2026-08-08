import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  COMMENT_BODY_MAX_LENGTH,
  COMMENT_QUOTE_MAX_LENGTH,
  normalizeCommentTarget,
  normalizeCommentText,
  validateCommentBody,
} from "../lib/analysis-comments.ts";

test("comment anchors accept only stable semantic target keys", () => {
  assert.equal(normalizeCommentTarget("field:A1"), "field:A1");
  assert.equal(
    normalizeCommentTarget("shot:shot_123:visual-content"),
    "shot:shot_123:visual-content",
  );
  assert.equal(normalizeCommentTarget("../../another-record"), "");
  assert.equal(normalizeCommentTarget("field:A1<script>"), "");
});

test("comments require content and cap stored text", () => {
  assert.equal(validateCommentBody("   ").error, "请填写批注内容。");
  const longBody = "批".repeat(COMMENT_BODY_MAX_LENGTH + 50);
  assert.equal(validateCommentBody(longBody).body.length, COMMENT_BODY_MAX_LENGTH);
  const longQuote = "原".repeat(COMMENT_QUOTE_MAX_LENGTH + 50);
  assert.equal(
    normalizeCommentText(longQuote, COMMENT_QUOTE_MAX_LENGTH).length,
    COMMENT_QUOTE_MAX_LENGTH,
  );
});

test("inline comment migration is additive and version-bound", async () => {
  const migration = await readFile(
    new URL("../db/migrations/2026-08-07-analysis-comments.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS analysis_comments/);
  assert.match(
    migration,
    /submission_id TEXT NOT NULL REFERENCES annotation_snapshots\(id\)/,
  );
  assert.match(migration, /parent_id TEXT REFERENCES analysis_comments\(id\)/);
  assert.match(migration, /is_excellent INTEGER NOT NULL DEFAULT 0/);
  assert.doesNotMatch(migration, /\bDROP\b|\bDELETE\b|\bTRUNCATE\b/);
});

test("inline revision migration preserves anchors, decisions, and draft revision audit", async () => {
  const migration = await readFile(
    new URL(
      "../db/migrations/2026-08-08-inline-revision-suggestions.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /anchor_start INTEGER NOT NULL DEFAULT -1/);
  assert.match(migration, /anchor_end INTEGER NOT NULL DEFAULT -1/);
  assert.match(
    migration,
    /submission_id TEXT NOT NULL REFERENCES annotation_snapshots\(id\)/,
  );
  assert.match(migration, /replacement_text TEXT NOT NULL DEFAULT ''/);
  assert.match(migration, /applied_revision INTEGER/);
  assert.match(migration, /PENDING.*ACCEPTED.*REJECTED/s);
  assert.doesNotMatch(migration, /\bDROP\b|\bDELETE\b|\bTRUNCATE\b/);
});
