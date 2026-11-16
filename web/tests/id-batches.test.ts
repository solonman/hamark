import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chunkIds, MAX_IDS_PER_QUERY } from "../lib/id-batches.ts";

test("chunkIds keeps order and caps each batch at the per-query limit", () => {
  assert.equal(MAX_IDS_PER_QUERY, 200);
  assert.deepEqual(chunkIds([]), []);
  assert.deepEqual(chunkIds(["a", "b", "c"], 2), [["a", "b"], ["c"]]);
  const ids = Array.from({ length: 401 }, (_, index) => String(index));
  assert.deepEqual(chunkIds(ids).map((batch) => batch.length), [200, 200, 1]);
  assert.deepEqual(chunkIds(ids).flat(), ids);
});

test("library engagement reads batch their ids instead of sending the whole library at once", () => {
  for (const path of ["../components/v04/V04LibraryClient.tsx", "../components/report/library/ReportLibrary.tsx"]) {
    assert.match(readFileSync(new URL(path, import.meta.url), "utf8"), /chunkIds\(/);
  }
  for (const path of [
    "../app/api/videos/analysis/v04/cards/route.ts",
    "../app/api/case-engagement/route.ts",
    "../app/api/report-engagement/route.ts",
  ]) {
    assert.match(readFileSync(new URL(path, import.meta.url), "utf8"), /> MAX_IDS_PER_QUERY/);
  }
});
