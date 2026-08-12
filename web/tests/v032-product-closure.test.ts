import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveReviewEntry } from "../lib/review-entry.ts";
import type { AnalysisReviewContext } from "../lib/types.ts";

function review(patch: Partial<AnalysisReviewContext> = {}): AnalysisReviewContext {
  return {
    round: null,
    isAuthor: false,
    isFinalReviewer: false,
    canReview: false,
    canReturn: false,
    canApprove: false,
    canWithdraw: false,
    activeReleaseNumber: null,
    ...patch,
  };
}

test("V0.3.2 state-role matrix never exposes review on approved or historical content", () => {
  assert.equal(resolveReviewEntry({ taxonomyVersion: "V0.2" }), "V02_READ_ONLY");
  assert.equal(
    resolveReviewEntry({ taxonomyVersion: "V0.3-PILOT", workflowStatus: "APPROVED", review: review() }),
    "APPROVED_READ_ONLY",
  );
  assert.equal(
    resolveReviewEntry({ taxonomyVersion: "V0.3-PILOT", workflowStatus: "APPROVED", review: review({ isAuthor: true }) }),
    "AUTHOR_NEW_ROUND",
  );
  assert.equal(
    resolveReviewEntry({ taxonomyVersion: "V0.3-PILOT", workflowStatus: "PENDING_REVIEW", review: review({ canReview: true, isFinalReviewer: true }) }),
    "ENTER_REVIEW",
  );
  assert.equal(
    resolveReviewEntry({ taxonomyVersion: "V0.3-PILOT", workflowStatus: "CHANGES_REQUESTED", review: review({ isAuthor: true }) }),
    "AUTHOR_EDIT",
  );
});

test("V0.3.2 migration is additive and preserves historical values", async () => {
  const migration = await readFile(new URL("../db/migrations/2026-08-12-v032-structured-review.sql", import.meta.url), "utf8");
  assert.match(migration, /vocabulary_version/);
  assert.match(migration, /value_type/);
  assert.match(migration, /original_value_json/);
  assert.match(migration, /replacement_value_json/);
  assert.doesNotMatch(migration, /DROP|TRUNCATE|DELETE|UPDATE annotation_snapshots/i);
});

test("V0.3.2 freezes terminology, theme tokens and discoverable review controls", async () => {
  const [taxonomy, detail, comments, content, styles, authorTasks] = await Promise.all([
    readFile(new URL("../lib/taxonomy-v0.3.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/VideoDetailClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/AnalysisComments.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/SubmittedAnalysisContent.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/practice/AuthorRevisionTasks.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(taxonomy, /重复变义/);
  assert.match(taxonomy, /跨桥段渐进形成/);
  assert.match(content, /全片主要形成方式/);
  assert.match(content, /InlineStructuredAnnotation/);
  assert.match(detail, /canEnterReview/);
  assert.match(comments, /选择文字可做局部批注／修订/);
  assert.match(styles, /--reading-subject: #c7aa72/);
  assert.match(styles, /is-review-enabled \.inline-annotation-entry-actions/);
  assert.match(authorTasks, /定位到内容项/);
});
