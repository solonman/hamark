import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CASE_ENGAGEMENT_SCHEMA_STATEMENTS } from "../db/case-engagement-schema.ts";
import {
  deriveWeekKey,
  formatStars,
  formatWeekTitle,
  groupByWeek,
  pickTopCaseRating,
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

test("the database itself enforces one ballot per person per week and a 1-5 star scale", () => {
  const schema = CASE_ENGAGEMENT_SCHEMA_STATEMENTS.join("\n");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS case_weekly_favorites[\s\S]*PRIMARY KEY \(user_id, week_key\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS analysis_version_ratings[\s\S]*stars INTEGER NOT NULL CHECK \(stars BETWEEN 1 AND 5\)/);
  // 一个版本一条评级：改分覆盖同一行，不会叠出第二个分数。
  assert.match(schema, /version_id TEXT PRIMARY KEY REFERENCES analysis_versions\(id\)/);
  assert.match(schema, /ALTER TABLE case_weekly_favorites ENABLE ROW LEVEL SECURITY/);
  assert.match(schema, /ALTER TABLE analysis_version_ratings ENABLE ROW LEVEL SECURITY/);
});

test("the migration file mirrors the schema module so production can apply it by hand", async () => {
  const migration = await source("../db/migrations/2026-09-01-case-engagement.sql");
  assert.match(migration, /PRIMARY KEY \(user_id, week_key\)/);
  assert.match(migration, /stars INTEGER NOT NULL CHECK \(stars BETWEEN 1 AND 5\)/);
  assert.match(migration, /ALTER TABLE case_weekly_favorites ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE analysis_version_ratings ENABLE ROW LEVEL SECURITY/);
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
  // 收藏是按钮，评级不是：卡片上的星级只读，这一点由标签本身保证。
  assert.match(library, /className=\{`\$\{styles\.caseFavorite\}[\s\S]*onClick=\{\(\) => void toggleFavorite\(item\.id\)\}/);
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
