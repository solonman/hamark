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
    { targetKey: "bridge:g1", targetLabel: "桥段01", body: "a", authorName: "老孙", updatedAt: "", versionId: "v1", versionLabel: "v1" },
    { targetKey: "shot:s1", targetLabel: "镜头01", body: "b", authorName: "老孙", updatedAt: "", versionId: "v1", versionLabel: "v1" },
  ]);
  assert.equal(index.get("bridge:g1")?.[0]?.body, "a");
  assert.equal(index.get("missing"), undefined);
});

test("comments跨版本汇总到同一个条目下，组内按写入时间升序排列", () => {
  // 一个条目现在可能挂着好几个版本各写的一条评论——不再是「一个条目一条」，
  // 汇总到同一个 key 下，且不依赖调用方已经按时间排好序。
  const grouped = commentsByTarget([
    { targetKey: "bridge:g1", targetLabel: "桥段01", body: "后写的", authorName: "老孙", updatedAt: "2026-09-02T10:00:00Z", versionId: "final", versionLabel: "最终版" },
    { targetKey: "shot:s1", targetLabel: "镜头01", body: "无关条目", authorName: "老孙", updatedAt: "2026-09-01T09:00:00Z", versionId: "v2", versionLabel: "v2" },
    { targetKey: "bridge:g1", targetLabel: "桥段01", body: "先写的", authorName: "老孙", updatedAt: "2026-09-01T09:00:00Z", versionId: "v2", versionLabel: "v2" },
  ]);
  const bridgeComments = grouped.get("bridge:g1");
  assert.equal(bridgeComments?.length, 2);
  assert.deepEqual(bridgeComments?.map((c) => c.body), ["先写的", "后写的"]);
  assert.deepEqual(bridgeComments?.map((c) => c.versionLabel), ["v2", "最终版"]);
  assert.equal(grouped.get("shot:s1")?.length, 1);
});

test("one comment per item per version, enforced by the table itself", async () => {
  const schema = CASE_ENGAGEMENT_SCHEMA_STATEMENTS.join("\n");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS analysis_version_comments[\s\S]*PRIMARY KEY \(version_id, target_key\)/);
  // 评论挂在版本上：评的是这个人这一版的写法，不该跟着案例漂到别人的版本上。
  assert.match(schema, /version_id TEXT NOT NULL REFERENCES analysis_versions\(id\)/);
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
  // 评论现在可以锚定在普通版本或最终版上：查不到普通版本再当最终版查,
  // 两处都查不到才拒绝——同样不给别的案例的版本号／最终版 id 可乘之机。
  assert.match(
    server,
    /function requireCommentVersionOfVideo[\s\S]*FROM analysis_versions[\s\S]*FROM analysis_final_versions WHERE id = \? AND video_id = \?[\s\S]*指定的版本不存在/,
  );
  assert.match(server, /export async function saveCaseReviewComment[\s\S]*requireCommentVersionOfVideo\(db, input\.videoId, input\.versionId\)/);
});

test("loadCaseReview fetches every version's comments for the case, and only a real version can be rated", async () => {
  const server = await source("../lib/case-review-server.ts");
  // 评论按整案例取，不再按单一版本——不管正看着哪一版都要看得见别版写了什么。
  assert.match(server, /FROM analysis_version_comments c[\s\S]*LEFT JOIN analysis_versions av ON av\.id = c\.version_id[\s\S]*WHERE c\.video_id = \?/);
  // 找不到版本号（联查落空）就是写在最终版上。
  assert.match(server, /row\.version_number != null \? `v\$\{row\.version_number\}` : "最终版"/);
  // 星级仍只锚定 `?version=` 指定的那一版；version 不在 analysis_versions 里（最终版）时不能评分。
  assert.match(server, /const canRate = ratableVersionId != null;/);
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
  // 评分摆在正文之后：读完整份作业才谈得上给分。最终版不评分——`isFinalVersionView`
  // 与 `review.canRate` 任一为假都不渲染评分组件。
  assert.match(
    studio,
    /<V19StudioDocument[\s\S]*\/>\s*\{\/\*[\s\S]*?\*\/\}\s*\{!isFinalVersionView && review\.canRate && \(\s*<V19AssignmentRating/,
  );
  // 不能评分、又还没有评分时，整条评分栏不该出现——一排空星星对读者只是噪音。
  assert.match(rating, /if \(!canReview && stars == null\) return null;/);
  // 只读的人看到星级，但看不到可点的控件。
  assert.match(rating, /canReview \? \([\s\S]*<button[\s\S]*\) : \([\s\S]*data-readonly="true"/);
  // 没有评论、也没有权限的人，条目上不该留下任何痕迹。
  assert.match(comment, /if \(!comments\.length && !canReview\) return null;/);
  // 评论气泡改成列表：每条前缀版本标签，本版那条高亮「本版」。
  assert.match(comment, /item\.versionId === currentVersionId/);
  assert.match(comment, /"·本版"/);
  // 老孙在别版写过的条目上看到「切到该版可改」，不能就地改别版那条。
  assert.match(comment, /切到该版可改/);
  // `commentsByTarget` 现在按条目分组返回一个列表，不再是一条。
  assert.match(studio, /commentsByTarget\(review\.comments\)/);
});
