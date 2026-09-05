import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CASE_ENGAGEMENT_SCHEMA_STATEMENTS } from "../db/case-engagement-schema.ts";
import {
  CASE_WEEKLY_BALLOT_LIMIT,
  applyFrozenWeeklyOrder,
  ballotHint,
  deriveWeekKey,
  firstFreeBallotSlot,
  formatStars,
  formatWeekTitle,
  groupByWeek,
  pickTopCaseRating,
  remainingBallots,
  snapshotWeeklyOrder,
  viewerBallotsByWeek,
  weekRangeLabel,
} from "../lib/case-engagement.ts";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("the week a case belongs to is fixed to Beijing time, not the server's timezone", () => {
  // 北京时间 2026-08-31 00:30 是周一，属于第 36 周；同一天更早半小时仍是周日，属于第 35 周。
  assert.equal(deriveWeekKey("2026-08-30T16:30:00.000Z"), "2026-W36");
  assert.equal(deriveWeekKey("2026-08-30T15:30:00.000Z"), "2026-W35");
  // 旧数据里的 `YYYY-MM-DD HH:MM:SS` 写法按 UTC 读，和 lib/date-format.ts 一致。
  assert.equal(deriveWeekKey("2026-07-31 07:15:48"), "2026-W31");
  // 跨年按 ISO-8601：2027-01-01 是周五，仍归 2026 年最后一周。
  assert.equal(deriveWeekKey("2026-12-31T16:00:00.000Z"), "2026-W53");
  assert.equal(deriveWeekKey("not-a-date"), "");
});

test("week labels name the week and the days it covers", () => {
  assert.equal(formatWeekTitle("2026-W36"), "2026 年第 36 周");
  assert.equal(weekRangeLabel("2026-W36"), "08-31 ~ 09-06");
  assert.equal(formatWeekTitle(""), "时间未知");
  assert.equal(weekRangeLabel(""), "");
});

test("weekly view puts recent weeks first and the most collected case first inside a week", () => {
  const cases = [
    { id: "a", weekKey: "2026-W35", favoriteCount: 1, createdAt: "2026-08-25T02:00:00.000Z" },
    { id: "b", weekKey: "2026-W36", favoriteCount: 2, createdAt: "2026-09-01T02:00:00.000Z" },
    { id: "c", weekKey: "2026-W36", favoriteCount: 5, createdAt: "2026-08-31T02:00:00.000Z" },
    { id: "d", weekKey: "2026-W36", favoriteCount: 2, createdAt: "2026-09-02T02:00:00.000Z" },
    { id: "e", weekKey: "", favoriteCount: 9, createdAt: "" },
  ];
  const groups = groupByWeek(cases, (item) => item);
  assert.deepEqual(groups.map((group) => group.weekKey), ["2026-W36", "2026-W35", ""]);
  // 同票数时新上传的排在前面，票数未知的一组永远垫底。
  assert.deepEqual(groups[0].items.map((item) => item.id), ["c", "d", "b"]);
  assert.equal(groups[2].title, "时间未知");
});

test("stars always render five slots so an unrated case reads as unrated, not as zero", () => {
  assert.equal(formatStars(5), "★★★★★");
  assert.equal(formatStars(3), "★★★☆☆");
  assert.equal(formatStars(0), "☆☆☆☆☆");
  assert.equal(formatStars(9), "★★★★★");
});

test("the database itself enforces three ballots per person per week and a 1-5 star scale", () => {
  const schema = CASE_ENGAGEMENT_SCHEMA_STATEMENTS.join("\n");
  // 三个票位是主键的一部分：一周物理上放不下第四票，不靠应用层数得准。
  assert.match(schema, /CREATE TABLE IF NOT EXISTS case_weekly_favorites[\s\S]*PRIMARY KEY \(user_id, week_key, slot\)/);
  assert.match(schema, /CHECK \(slot BETWEEN 1 AND 3\)/);
  // 一票只能投给一个作品：三票堆在同一部片上会撞这条唯一约束。
  assert.match(schema, /case_weekly_favorites_one_ballot_per_case\s*\n?\s*UNIQUE \(user_id, week_key, video_id\)/);
  // 老库是每周一票的两列主键，升级要显式换掉，CREATE TABLE IF NOT EXISTS 不管这事。
  assert.match(schema, /ALTER TABLE case_weekly_favorites ADD COLUMN IF NOT EXISTS slot/);
  assert.match(schema, /DROP CONSTRAINT case_weekly_favorites_pkey[\s\S]*ADD PRIMARY KEY \(user_id, week_key, slot\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS analysis_version_ratings[\s\S]*stars INTEGER NOT NULL CHECK \(stars BETWEEN 1 AND 5\)/);
  // 一个版本一条评级：改分覆盖同一行，不会叠出第二个分数。
  assert.match(schema, /version_id TEXT PRIMARY KEY REFERENCES analysis_versions\(id\)/);
  assert.match(schema, /ALTER TABLE case_weekly_favorites ENABLE ROW LEVEL SECURITY/);
  assert.match(schema, /ALTER TABLE analysis_version_ratings ENABLE ROW LEVEL SECURITY/);
});

test("the migration file mirrors the schema module so production can apply it by hand", async () => {
  const migration = await source("../db/migrations/2026-09-01-case-engagement.sql");
  // 这一份是当初建表的那次迁移，生产早已执行过，保持原样不改写。
  assert.match(migration, /PRIMARY KEY \(user_id, week_key\)/);
  assert.match(migration, /stars INTEGER NOT NULL CHECK \(stars BETWEEN 1 AND 5\)/);
  assert.match(migration, /ALTER TABLE case_weekly_favorites ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE analysis_version_ratings ENABLE ROW LEVEL SECURITY/);
});

test("the ballot migration upgrades both libraries from one vote to three, without dropping votes", async () => {
  const migration = await source("../db/migrations/2026-09-05-weekly-ballots.sql");
  for (const table of ["case_weekly_favorites", "report_weekly_favorites"]) {
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS slot INTEGER NOT NULL DEFAULT 1`));
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ADD PRIMARY KEY \\(user_id, week_key, slot\\)`));
    assert.match(migration, new RegExp(`ADD CONSTRAINT ${table}_slot_range CHECK \\(slot BETWEEN 1 AND 3\\)`));
  }
  assert.match(migration, /UNIQUE \(user_id, week_key, video_id\)/);
  assert.match(migration, /UNIQUE \(user_id, week_key, report_id\)/);
  // 只加不删：既有的那一票落在 slot 1，迁移不会让任何人掉票。
  assert.doesNotMatch(migration, /DELETE FROM|TRUNCATE|DROP TABLE/);
});

test("three ballots go into three fixed slots, and a full week has no slot left", () => {
  assert.equal(CASE_WEEKLY_BALLOT_LIMIT, 3);
  assert.equal(firstFreeBallotSlot([]), 1);
  // 撤掉中间那一票后再投，补的是空出来的那个位，不是往后接。
  assert.equal(firstFreeBallotSlot([1, 3]), 2);
  assert.equal(firstFreeBallotSlot([2, 3]), 1);
  // 三个位都占满就没有第四票——0 是「投不了」，调用方据此拒绝。
  assert.equal(firstFreeBallotSlot([1, 2, 3]), 0);
});

test("used ballots are counted per week from the viewer's own hearts", () => {
  const used = viewerBallotsByWeek([
    { weekKey: "2026-W36", viewerFavorited: true },
    { weekKey: "2026-W36", viewerFavorited: true },
    { weekKey: "2026-W36", viewerFavorited: false },
    { weekKey: "2026-W35", viewerFavorited: true },
  ]);
  assert.equal(used.get("2026-W36"), 2);
  assert.equal(used.get("2026-W35"), 1);
  // 一票没投的周不在表里，读出来就是 0 票。
  assert.equal(used.get("2026-W34"), undefined);
  assert.equal(remainingBallots(2), 1);
  assert.equal(remainingBallots(3), 0);
  // 数据脏了也不该冒出负数票。
  assert.equal(remainingBallots(9), 0);
  assert.equal(ballotHint(1), "本周还剩 2 票");
  assert.equal(ballotHint(3), "本周 3 票已投完");
});

test("the home page offers both libraries, weekly grouping, and per-card collect and rating", async () => {
  const [library, engagementRoute, favoriteRoute] = await Promise.all([
    source("../components/v04/V04LibraryClient.tsx"),
    source("../app/api/case-engagement/route.ts"),
    source("../app/api/videos/[id]/favorite/route.ts"),
  ]);
  assert.match(library, /onClick=\{\(\) => setLibrary\("VIDEO"\)\}>视频库/);
  assert.match(library, /onClick=\{\(\) => setLibrary\("REPORT"\)\}>报告库/);
  assert.match(library, /报告逆向工程建设中/);
  assert.match(library, /aria-pressed=\{weeklyView\}[\s\S]*按周显示/);
  assert.match(library, /groupByWeek\(visible/);
  // 投票不重排：进入按周视图时冻结名次，变了只给入口，不自己换位置。
  assert.match(library, /applyFrozenWeeklyOrder\(rankedGroups/);
  assert.match(library, /if \(next\) freezeCurrentOrder\(\); else setFrozenOrder\(null\);/);
  assert.match(library, /weeklyView && orderStale[\s\S]*顺序已变 · 重新排序/);
  // 收藏是按钮，评级不是：卡片上的星级只读，这一点由标签本身保证。
  assert.match(library, /className=\{`\$\{styles\.caseFavorite\}[\s\S]*onClick=\{\(\) => void toggleFavorite\(item\.id, engaged\.weekKey, engaged\.viewerFavorited\)\}/);
  // 票投完了不等服务端来回，本地就拦下并说清楚为什么。
  assert.match(library, /if \(!favorited && !remainingBallots\(ballotsUsedIn\(weekKey\)\)\)[\s\S]*notify\(CASE_BALLOT_EXHAUSTED_MESSAGE, "warn"\)/);
  // ♡ 与 ♥ 是两个字形，宽高对不齐；实心与描边必须是同一段路径只换填充。
  assert.doesNotMatch(library, /viewerFavorited \? "♥" : "♡"/);
  assert.match(library, /fill=\{engaged\.viewerFavorited \? "currentColor" : "none"\}/);
  assert.match(library, /className=\{styles\.caseRating\}/);
  // 星级本身永远不是按钮；卡片上唯一可点的是展开其余版本的「更多」。
  assert.doesNotMatch(library, /<button[^>]*styles\.caseRating\}/);
  assert.match(library, /className=\{styles\.caseRatingMore\}[\s\S]*更多/);
  assert.match(library, /fetch\(`\/api\/videos\/\$\{encodeURIComponent\(videoId\)\}\/favorite`/);
  assert.match(engagementRoute, /loadCaseEngagement\(getDbClient\(\), videoIds, user\.id\)/);
  assert.match(favoriteRoute, /requireSameOriginMutation\(request\)/);
  assert.match(favoriteRoute, /toggleCaseFavorite\(getDbClient\(\)/);
});

test("a blocked vote pops up in front of the reader instead of writing a banner off-screen", async () => {
  const [toast, videoLibrary, reportLibrary] = await Promise.all([
    source("../components/shared/LibraryToast.tsx"),
    source("../components/v04/V04LibraryClient.tsx"),
    source("../components/report/library/ReportLibrary.tsx"),
  ]);
  const toastCss = await source("../components/shared/LibraryToast.module.css");
  // 卡片可能在页面很深的地方，提示必须钉在视口上，而不是排在文档流里。
  assert.match(toastCss, /\.toastStack \{[^}]*position: fixed/);
  assert.match(toast, /createPortal\([\s\S]*document\.body/);
  for (const library of [videoLibrary, reportLibrary]) {
    assert.match(library, /useLibraryToast\(\)/);
    assert.match(library, /<LibraryToastStack toasts=\{toasts\} \/>/);
    // 收藏失败不再写回页面顶部那条 libraryNotice——那条要滚上去才看得见。
    assert.doesNotMatch(library, /favoriteError/);
    assert.match(library, /notify\(error instanceof Error \? error\.message : "收藏失败，请稍后重试。", "warn"\)/);
  }
});

test("a card leads with the best score the case has earned, not the first version rated", () => {
  assert.equal(pickTopCaseRating([]), null);
  const ratings = [
    { versionNumber: 1, ownerName: "演示同事", stars: 3 },
    { versionNumber: 2, ownerName: "协作同事", stars: 4 },
    { versionNumber: 3, ownerName: "老孙", stars: 2 },
  ];
  assert.equal(pickTopCaseRating(ratings)?.versionNumber, 2);
  // 同分取版本号大的：后写的那一版是在前一版基础上做的。
  assert.equal(pickTopCaseRating([
    { versionNumber: 1, ownerName: "甲", stars: 5 },
    { versionNumber: 4, ownerName: "乙", stars: 5 },
  ])?.versionNumber, 4);
});

test("a vote changes the count immediately but never moves the card under the cursor", () => {
  const read = (item: { weekKey: string; favoriteCount: number; createdAt: string }) => item;
  const before = groupByWeek([
    { id: "a", weekKey: "2026-W36", favoriteCount: 4, createdAt: "2026-09-01T00:00:00.000Z" },
    { id: "b", weekKey: "2026-W36", favoriteCount: 2, createdAt: "2026-09-02T00:00:00.000Z" },
  ], read);
  const frozen = snapshotWeeklyOrder(before, (item) => item.id);
  assert.deepEqual(before[0].items.map((item) => item.id), ["a", "b"]);

  // 把票从 a 挪到 b：真实名次变成 b 在前，但冻结的视图仍然是 a 在前。
  const after = groupByWeek([
    { id: "a", weekKey: "2026-W36", favoriteCount: 3, createdAt: "2026-09-01T00:00:00.000Z" },
    { id: "b", weekKey: "2026-W36", favoriteCount: 3, createdAt: "2026-09-02T00:00:00.000Z" },
  ], read);
  assert.deepEqual(after[0].items.map((item) => item.id), ["b", "a"]);
  const held = applyFrozenWeeklyOrder(after, (item) => item.id, frozen);
  assert.deepEqual(held.groups[0].items.map((item) => item.id), ["a", "b"]);
  // 名次确实变了，所以要给用户一个明确的重排入口。
  assert.equal(held.stale, true);

  // 重新冻结后视图与真实名次一致，提示随之消失。
  const refrozen = snapshotWeeklyOrder(after, (item) => item.id);
  const settled = applyFrozenWeeklyOrder(after, (item) => item.id, refrozen);
  assert.deepEqual(settled.groups[0].items.map((item) => item.id), ["b", "a"]);
  assert.equal(settled.stale, false);
  // 没有快照时就是真实名次，不冻结任何东西。
  assert.equal(applyFrozenWeeklyOrder(after, (item) => item.id, null).stale, false);
});

test("a case that appears after the order was frozen goes last and flags the order as changed", () => {
  const read = (item: { weekKey: string; favoriteCount: number; createdAt: string }) => item;
  const frozen = snapshotWeeklyOrder(groupByWeek([
    { id: "a", weekKey: "2026-W36", favoriteCount: 1, createdAt: "2026-09-01T00:00:00.000Z" },
  ], read), (item) => item.id);
  const withNewcomer = groupByWeek([
    { id: "a", weekKey: "2026-W36", favoriteCount: 1, createdAt: "2026-09-01T00:00:00.000Z" },
    { id: "z", weekKey: "2026-W36", favoriteCount: 9, createdAt: "2026-09-03T00:00:00.000Z" },
  ], read);
  const held = applyFrozenWeeklyOrder(withNewcomer, (item) => item.id, frozen);
  assert.deepEqual(held.groups[0].items.map((item) => item.id), ["a", "z"]);
  assert.equal(held.stale, true);
});
