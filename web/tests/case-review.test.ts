import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CASE_ENGAGEMENT_SCHEMA_STATEMENTS } from "../db/case-engagement-schema.ts";
import {
  CASE_REVIEWER_NAME,
  CASE_REVIEW_COMMENT_MAX_LENGTH,
  CASE_REVIEW_TARGETS,
  commentsByTarget,
  isCaseReviewer,
  normalizeReviewComment,
  normalizeReviewStars,
} from "../lib/case-review.ts";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("only the reviewer can write; everyone else is a reader", () => {
  assert.equal(CASE_REVIEWER_NAME, "老孙");
  assert.ok(isCaseReviewer("老孙"));
  assert.ok(isCaseReviewer("  老孙  "));
  assert.equal(isCaseReviewer("演示同事"), false);
  assert.equal(isCaseReviewer(""), false);
  assert.equal(isCaseReviewer(null), false);
  assert.equal(isCaseReviewer(undefined), false);
});

test("a rating is one to five stars, and zero means the reviewer took it back", () => {
  assert.equal(normalizeReviewStars(4), 4);
  assert.equal(normalizeReviewStars("5"), 5);
  assert.equal(normalizeReviewStars(0), 0);
  for (const bad of [6, -1, 2.5, "abc", "", null, undefined, true, Number.NaN, Infinity]) {
    assert.throws(() => normalizeReviewStars(bad), /评分只能是/);
  }
});

test("an emptied comment is a deletion, and an over-long one is refused before it reaches the database", () => {
  assert.equal(normalizeReviewComment("  这里再具体一点  "), "这里再具体一点");
  assert.equal(normalizeReviewComment("   "), "");
  assert.equal(normalizeReviewComment(undefined), "");
  assert.equal(normalizeReviewComment("字".repeat(CASE_REVIEW_COMMENT_MAX_LENGTH)).length, CASE_REVIEW_COMMENT_MAX_LENGTH);
  assert.throws(() => normalizeReviewComment("字".repeat(CASE_REVIEW_COMMENT_MAX_LENGTH + 1)), /最多/);
});

test("comment anchors are stable per bridge, shot and path item", () => {
  assert.equal(CASE_REVIEW_TARGETS.bridge("g1"), "bridge:g1");
  assert.equal(CASE_REVIEW_TARGETS.shot("s1"), "shot:s1");
  assert.equal(CASE_REVIEW_TARGETS.primaryPathDetail("FUN", 2), "path.primaryDetails.FUN.2");
  assert.equal(CASE_REVIEW_TARGETS.auxiliaryPath("LOVE"), "path.auxiliary.LOVE");
  const index = commentsByTarget([
    { targetKey: "bridge:g1", targetLabel: "桥段01", body: "a", authorName: "老孙", updatedAt: "" },
    { targetKey: "shot:s1", targetLabel: "镜头01", body: "b", authorName: "老孙", updatedAt: "" },
  ]);
  assert.equal(index.get("bridge:g1")?.body, "a");
  assert.equal(index.get("missing"), undefined);
});

test("one comment per item per version, enforced by the table itself", async () => {
  const schema = CASE_ENGAGEMENT_SCHEMA_STATEMENTS.join("\n");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS analysis_version_comments[\s\S]*PRIMARY KEY \(version_id, target_key\)/);
  // 评论挂在版本上：评的是这个人这一版的写法，不该跟着案例漂到别人的版本上。
  // version_id 从 spec 20（最终版）起不再是外键：最终版的 id 不在 analysis_versions
  // 里，服务端自己校验 version_id 属于该案例（普通版本或最终版）——
  // 见 db/final-version-schema.ts 与 db/migrations/2026-09-02-final-version.sql。
  assert.match(schema, /version_id TEXT NOT NULL,/);
  assert.doesNotMatch(schema, /version_id TEXT NOT NULL REFERENCES analysis_versions\(id\)/);
  assert.match(schema, /body TEXT NOT NULL CHECK \(length\(body\) > 0\)/);
  assert.match(schema, /ALTER TABLE analysis_version_comments ENABLE ROW LEVEL SECURITY/);
  const migration = await source("../db/migrations/2026-09-01-case-engagement.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS analysis_version_comments[\s\S]*PRIMARY KEY \(version_id, target_key\)/);
  assert.match(migration, /ALTER TABLE analysis_version_comments ENABLE ROW LEVEL SECURITY/);
});

test("the server refuses every write that is not the reviewer's, and never trusts a version id from another case", async () => {
  const [server, route] = await Promise.all([
    source("../lib/case-review-server.ts"),
    source("../app/api/videos/[id]/review/route.ts"),
  ]);
  assert.match(server, /function requireReviewer[\s\S]*isCaseReviewer\(viewer\.displayName\)[\s\S]*只有评审可以评分和评论/);
  assert.match(server, /export async function saveCaseReviewRating[\s\S]*requireReviewer\(input\.viewer\)/);
  assert.match(server, /export async function saveCaseReviewComment[\s\S]*requireReviewer\(input\.viewer\)/);
  assert.match(server, /function requireVersionOfVideo[\s\S]*row\.video_id !== videoId[\s\S]*指定的版本不存在/);
  assert.match(route, /requireSameOriginMutation\(request\)/);
  // 读不设门槛：其他人要看得见评审说了什么。
  assert.match(route, /export async function GET[\s\S]*loadCaseReview\(getDbClient\(\)/);
});

test("comment buttons sit on open-ended items only, and on bridges and shots in module two", async () => {
  const document = await source("../components/v04/V19StudioDocument.tsx");
  for (const label of ["商业意图", "故事梗概", "创意母题", "张力按钮", "创意思维链", "创意承重载体具体说明", "评价理由"]) {
    assert.match(document, new RegExp(`labelWithComment\\("${label}`), label);
  }
  // 固定选项没有可评的写法：评它等于评这份词表，所以这些条目上没有评论入口。
  for (const label of ["故事参照类型", "创意主导手法及机制", "创意辅助手法及机制", "创意承重载体"]) {
    assert.match(document, new RegExp(`<small>${label}</small>`), label);
  }
  assert.match(document, /CASE_REVIEW_TARGETS\.bridge\(group\.id\)/);
  assert.match(document, /CASE_REVIEW_TARGETS\.shot\(shot\.id\)/);
  assert.match(document, /CASE_REVIEW_TARGETS\.primaryPathDetail\(path, index\)/);
  assert.match(document, /CASE_REVIEW_TARGETS\.auxiliaryPath\(auxPath\)/);
  // 没接评审时正文与从前一模一样，只读页和既有用例不受影响。
  assert.match(document, /function commentAnchor[\s\S]*if \(!review\) return null;/);
});

test("the studio anchors both the rating and the comments to the version being viewed", async () => {
  const [studio, rating, comment] = await Promise.all([
    source("../components/v04/V04StudioClient.tsx"),
    source("../components/v04/V19AssignmentRating.tsx"),
    source("../components/v04/V19ReviewComment.tsx"),
  ]);
  assert.match(studio, /const reviewVersionId = model\?\.current\.id \?\? null;/);
  assert.match(studio, /\/review\$\{search\}`[\s\S]*\}, \[videoId, reviewVersionId\]\);/);
  assert.match(studio, /const versionId = modelRef\.current\?\.current\.id;[\s\S]*kind: "COMMENT"/);
  assert.match(studio, /const versionId = modelRef\.current\?\.current\.id;[\s\S]*kind: "RATING"/);
  assert.match(studio, /<V19AssignmentRating[\s\S]*versionLabel=\{`v\$\{model\.current\.number\} · \$\{model\.current\.ownerName\}`\}/);
  // 评分摆在正文之后：读完整份作业才谈得上给分。
  assert.match(studio, /<V19StudioDocument[\s\S]*\/>\s*\{\/\*[\s\S]*?\*\/\}\s*<V19AssignmentRating/);
  // 不能评分、又还没有评分时，整条评分栏不该出现——一排空星星对读者只是噪音。
  assert.match(rating, /if \(!canReview && stars == null\) return null;/);
  // 只读的人看到星级，但看不到可点的控件。
  assert.match(rating, /canReview \? \([\s\S]*<button[\s\S]*\) : \([\s\S]*data-readonly="true"/);
  // 没有评论、也没有权限的人，条目上不该留下任何痕迹。
  assert.match(comment, /if \(!comment && !canReview\) return null;/);
});
