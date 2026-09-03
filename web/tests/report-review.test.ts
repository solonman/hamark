import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 报告侧评审契约与视频侧同构（见 lib/report-review-server.ts 顶部注释），这份测试
// 照抄 tests/case-review.test.ts 的做法：不接真数据库，直接断言源码里该有的规则
// 还在——`docs/20_最终版与评论跨版本_实施规格_V0.1.md` 只写了视频工作台，报告侧
// 没有集成版，是这次改动照着视频侧「评论跨版本汇总 + canRate」这两条口径，
// 手动搬到报告侧时留下的判断依据。

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("report review writes still gate on the same reviewer, and never trust a version id from another report", async () => {
  const [server, route] = await Promise.all([
    source("../lib/report-review-server.ts"),
    source("../app/api/reports/[id]/review/route.ts"),
  ]);
  assert.match(server, /function requireReviewer[\s\S]*isCaseReviewer\(viewer\.displayName\)[\s\S]*只有评审可以评分和评论/);
  assert.match(server, /export async function saveReportReviewRating[\s\S]*requireReviewer\(input\.viewer\)/);
  assert.match(server, /export async function saveReportReviewComment[\s\S]*requireReviewer\(input\.viewer\)/);
  assert.match(server, /function requireVersionOfReport[\s\S]*row\.report_id !== reportId[\s\S]*指定的版本不存在/);
  assert.match(route, /requireSameOriginMutation\(request\)/);
  // 读不设门槛：其他人要看得见评审说了什么。
  assert.match(route, /export async function GET[\s\S]*loadReportReview\(getDbClient\(\)/);
});

test("loadReportReview fetches every version's comments for the report, and only a version that really exists can be rated", async () => {
  const server = await source("../lib/report-review-server.ts");
  // 评论按整份报告取，不再按单一版本——不管正看着哪一版都要看得见别的版本写了什么
  // （对齐视频侧 loadCaseReview 的 `WHERE c.video_id = ?`，见 case-review-server.ts）。
  // docs/21 四、4.4：集成版的评论会 LEFT JOIN 落空（集成版 id 不在
  // report_versions 里），不能再用 INNER JOIN。
  assert.match(
    server,
    /FROM report_version_comments c[\s\S]*LEFT JOIN report_versions v ON v\.id = c\.version_id[\s\S]*WHERE c\.report_id = \?/,
  );
  // 联查落空（写在集成版上的评论）时退化成"集成版"，同视频侧 loadCaseReview。
  assert.match(server, /versionLabel: row\.version_number != null \? `v\$\{row\.version_number\}` : "集成版"/);
  // 星级仍只锚定 `?version=` 指定的那一版；版本不存在或不属于这份报告都不能评分。
  assert.match(server, /const canRate = ratableVersionId != null;/);
  assert.match(server, /canRate,\s*\n\s*comments: comments\.results\.map/);
});

test("a saved comment carries the version it was written on, resolved from the same lookup that guarded the write", async () => {
  const server = await source("../lib/report-review-server.ts");
  // 评论现在可能锚定在集成版上，写入前的校验改走 requireCommentVersionOfReport
  // （普通版本或集成版都行），不再是只认 report_versions 的 requireVersionOfReport
  // （那个函数继续存在，只用于评分——见上一个测试）。
  assert.match(server, /export async function saveReportReviewComment[\s\S]*requireCommentVersionOfReport\(db, input\.reportId, input\.versionId\)/);
  assert.match(server, /versionId: version\.id,\s*\n\s*versionLabel: version\.label,/);
});

test("a comment's updatedAt is serialized through toIsoTimestamp, not String(), so the bubble can parse it", async () => {
  // pg 把 timestamptz 解析成 JS Date；String(date) 得到的是
  // Date.prototype.toString()，不是 ISO，V19ReviewComment 的 formatShortDateTime
  // 认不出这种格式，评论气泡里的时间就会显示「未知时间」——照视频侧
  // lib/case-review-server.ts 的做法，直接复用它导出的 toIsoTimestamp，
  // 不在报告侧另抄一份等价实现。
  const server = await source("../lib/report-review-server.ts");
  assert.match(server, /import \{ toIsoTimestamp \} from "@\/lib\/case-review-server";/);
  assert.match(server, /updatedAt: toIsoTimestamp\(row\.updated_at\)/);
  assert.match(server, /updatedAt: toIsoTimestamp\(saved\.updated_at\)/);
  assert.doesNotMatch(server, /updatedAt: String\(/);
});

test("report_version_comments keeps one row per version per item; the schema wasn't touched by this alignment", async () => {
  const [schema, migration] = await Promise.all([
    source("../db/report-schema.ts"),
    source("../db/migrations/2026-09-02-report-reverse.sql"),
  ]);
  for (const source_ of [schema, migration]) {
    assert.match(source_, /CREATE TABLE IF NOT EXISTS report_version_comments[\s\S]*PRIMARY KEY \(version_id, target_key\)/);
    // 报告没有集成版，version_id 仍然是外键——不像视频侧那样为了集成版把它拆掉。
    assert.match(source_, /version_id TEXT NOT NULL REFERENCES report_versions\(id\)/);
  }
});

test("ReportFieldItem forwards a per-item comment list and the version being viewed to V19ReviewComment", async () => {
  const field = await source("../components/report/studio/ReportFieldItem.tsx");
  assert.match(field, /comments: readonly CaseReviewComment\[\];/);
  assert.match(field, /currentVersionId: string \| null;/);
  assert.match(field, /comments=\{review\.comments\}/);
  assert.match(field, /currentVersionId=\{review\.currentVersionId\}/);
});

test("ReportPartOne and ReportPartTwo pass the whole per-target comment list through, not just one comment", async () => {
  const [partOne, partTwo] = await Promise.all([
    source("../components/report/studio/ReportPartOne.tsx"),
    source("../components/report/studio/ReportPartTwo.tsx"),
  ]);
  assert.match(partOne, /comments: ReadonlyMap<string, CaseReviewComment\[\]>;/);
  assert.match(partOne, /comments: review\.comments\.get\(targetKey\) \?\? \[\]/);
  assert.match(partTwo, /comments: ReadonlyMap<string, CaseReviewComment\[\]>;/);
  assert.match(partTwo, /comments: review\.comments\.get\("strategy\.narrative"\) \?\? \[\]/);
});

test("the studio only shows the rating widget when the version being viewed can actually be rated", async () => {
  const studio = await source("../components/report/studio/ReportStudioClient.tsx");
  // 对齐视频侧 `!isFinalVersionView && review.canRate`——报告没有集成版，
  // 所以只剩 `review.canRate` 这一半判断，但同一个字段、同一条规则。
  assert.match(studio, /\{review\.canRate && \(\s*<V19AssignmentRating/);
  // 第一、二部分把 currentVersionId 接给 review，V19ReviewComment 才知道哪条是本版。
  assert.match(studio, /comments: reviewComments,\s*\n\s*currentVersionId: chain\.current\.id,/);
});

test("saving a comment replaces only this version's row for the item, not every version's comment on it", async () => {
  // review.comments 现在是跨版本汇总列表；乐观更新如果只按 targetKey 过滤，会把
  // 别的版本写的那条也一并顶掉（对齐 V04StudioClient.tsx 的 saveReviewComment
  // 同一处修复）。
  const studio = await source("../components/report/studio/ReportStudioClient.tsx");
  assert.match(
    studio,
    /const others = current\.comments\.filter\(\s*\n\s*\(item\) => !\(item\.targetKey === input\.targetKey && item\.versionId === versionId\),/,
  );
});

test("deck now shows the same cross-version comment summary as the first two parts, not just the current version's row", async () => {
  // deck（第三部分）的评论契约由外壳 agent 交付（见 deck-types.ts 顶部注释），
  // 现在已经改成与 ReportPartOne/ReportPartTwo/V19StudioDocument 同一套口径：
  // 「一个条目在所有版本上各写的一条，汇总展示」，不再是「只留当前版本那条」。
  const deckTypes = await source("../components/report/studio/deck/deck-types.ts");
  assert.match(deckTypes, /comments: Record<string, CaseReviewComment\[\]>;/);
  assert.match(deckTypes, /currentVersionId: string;/);

  const deckField = await source("../components/report/studio/deck/DeckField.tsx");
  assert.match(deckField, /comments: readonly CaseReviewComment\[\];/);
  assert.match(deckField, /currentVersionId: string;/);
  // 不再做"只留一条"的适配——直接把 comments/currentVersionId 透传给 V19ReviewComment。
  assert.match(deckField, /comments=\{comments\}/);
  assert.match(deckField, /currentVersionId=\{currentVersionId\}/);

  const studio = await source("../components/report/studio/ReportStudioClient.tsx");
  // `reviewComments`（Map<targetKey, CaseReviewComment[]>）直接转成 deck 要的
  // Record，不再单独挑出"只有当前版本写的那条"。
  assert.match(studio, /const deckComments = Object\.fromEntries\(reviewComments\);/);
  assert.match(studio, /currentVersionId: chain\.current\.id \?\? "",\s*\n\s*comments: deckComments,/);
});
