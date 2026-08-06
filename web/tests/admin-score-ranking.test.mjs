import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseScoreRankingDateRange } from "../lib/score-ranking.ts";

const readRepoFile = (pathFromTestFile) => {
  const path = fileURLToPath(new URL(pathFromTestFile, import.meta.url));
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

test("admin bootstrap seeds the three approved WeCom display names", () => {
  const bootstrap = readRepoFile("../db/bootstrap.ts");
  const schema = readRepoFile("../db/supabase.sql");
  for (const source of [bootstrap, schema]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS app_admins/);
    assert.match(source, /老孙/);
    assert.match(source, /李丽萍/);
    assert.match(source, /晏恩华/);
  }
});

test("admin helper checks the current WeCom display name in the database", () => {
  const source = readRepoFile("../lib/admin.ts");
  assert.match(source, /WHERE display_name = \?/);
  assert.match(source, /user\.displayName/);
});

test("score ranking endpoint restricts access and aggregates submitted valid reviews", () => {
  const source = readRepoFile("../app/api/admin/video-score-ranking/route.ts");
  assert.match(source, /isAppAdmin/);
  assert.match(source, /status = 'SUBMITTED'/);
  assert.match(source, /is_valid_for_aggregate = 1/);
  assert.match(source, /AVG\(r\.total_score\)/);
  assert.match(source, /ORDER BY average_score DESC, valid_review_count DESC, uploaded_at DESC/);
});

test("score ranking includes the whole end day", () => {
  assert.deepEqual(parseScoreRankingDateRange("2026-07-01", "2026-07-31"), {
    start: "2026-07-01T00:00:00.000Z",
    endExclusive: "2026-08-01T00:00:00.000Z",
  });
});

test("score ranking rejects reversed and invalid dates", () => {
  assert.throws(() => parseScoreRankingDateRange("2026-08-01", "2026-07-31"), /起始日期/);
  assert.throws(() => parseScoreRankingDateRange("2026-02-31", "2026-03-01"), /有效/);
});

test("ranking dialog opens video details in a safe new tab", () => {
  const source = readRepoFile("../app/components/ScoreRankingDialog.tsx");
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noopener noreferrer"/);
  assert.match(source, /href=\{`\/videos\/\$\{item\.videoId\}`\}/);
});

test("home receives server-computed admin access before rendering ranking controls", () => {
  const page = readRepoFile("../app/page.tsx");
  const home = readRepoFile("../app/components/HomeClient.tsx");
  assert.match(page, /isAppAdmin\(user\)/);
  assert.match(home, /isAdmin \? \(/);
});

test("ranking styles provide a modal overlay and narrow-screen layout", () => {
  const css = readRepoFile("../app/globals.css");
  assert.match(css, /\.score-ranking-backdrop/);
  assert.match(css, /\.score-ranking-dialog/);
  assert.match(css, /\.score-ranking-row/);
  assert.match(css, /@media \(max-width: 760px\)/);
});
