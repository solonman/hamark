// 客户需求复盘库的数据表：schema 模块与生产迁移文件逐句一致，词表与 lib/retro-model.ts 一致，
// RLS 收口、部分唯一索引、时间列写法都在（docs/26 八）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  RETRO_ASSET_TYPES,
  RETRO_DOC_FORMATS,
  RETRO_JOB_FAILED_STEPS,
  RETRO_JOB_STATUSES,
  RETRO_LINK_KINDS,
  RETRO_METHOD_DIMENSIONS,
  RETRO_METHOD_KINDS,
  RETRO_METHOD_TRANSFERS,
  RETRO_RECORDING_STATUSES,
  RETRO_SCHEMA_STATEMENTS,
  RETRO_SCHEMA_TABLES,
  RETRO_TRANSCRIBE_STATUSES,
} from "../db/retro-schema";
import {
  RETRO_ASSET_TYPE_LIST,
  RETRO_DOC_FORMAT_LIST,
  RETRO_JOB_FAILED_STEP_LIST,
  RETRO_JOB_STATUS_LIST,
  RETRO_LINK_KIND_LIST,
  RETRO_METHOD_DIMENSION_LIST,
  RETRO_METHOD_KIND_LIST,
  RETRO_METHOD_TRANSFER_LIST,
  RETRO_RECORDING_STATUS_LIST,
  RETRO_TRANSCRIBE_STATUS_LIST,
  classifyRetroFile,
  currentRetroMonthKey,
  formatRetroMonth,
  formatRetroSourceLabel,
  retroCaseNumbers,
  shiftRetroMonthKey,
} from "../lib/retro-model";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const normalise = (text: string) => text.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
const schema = RETRO_SCHEMA_STATEMENTS.join("\n");

test("every retro schema statement appears verbatim (modulo whitespace) in the frozen migration, in order, and nothing else", async () => {
  const sql = normalise(await source("../db/migrations/2026-10-19-retro-library.sql"));
  let cursor = 0;
  for (const statement of RETRO_SCHEMA_STATEMENTS) {
    const expected = normalise(statement);
    const at = sql.indexOf(expected, cursor);
    assert.ok(at >= 0, `frozen SQL is missing or out of order: ${expected.slice(0, 90)}…`);
    cursor = at + expected.length;
  }
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;$/);
  let rest = sql;
  for (const statement of RETRO_SCHEMA_STATEMENTS) rest = rest.replace(normalise(statement), "");
  assert.equal(rest.replace(/BEGIN;|COMMIT;|;|\s/g, ""), "");
});

test("the schema module is expanded in bootstrap after the visual schema", async () => {
  const bootstrap = await source("../db/bootstrap.ts");
  const visualAt = bootstrap.indexOf("...VISUAL_SCHEMA_STATEMENTS");
  const retroAt = bootstrap.indexOf("...RETRO_SCHEMA_STATEMENTS");
  assert.ok(visualAt > 0 && retroAt > visualAt);
});

test("vocabularies in the schema and in lib/retro-model.ts are identical", () => {
  assert.deepEqual([...RETRO_RECORDING_STATUSES], [...RETRO_RECORDING_STATUS_LIST]);
  assert.deepEqual([...RETRO_ASSET_TYPES], [...RETRO_ASSET_TYPE_LIST]);
  assert.deepEqual([...RETRO_DOC_FORMATS], [...RETRO_DOC_FORMAT_LIST]);
  assert.deepEqual([...RETRO_TRANSCRIBE_STATUSES], [...RETRO_TRANSCRIBE_STATUS_LIST]);
  assert.deepEqual([...RETRO_LINK_KINDS], [...RETRO_LINK_KIND_LIST]);
  assert.deepEqual([...RETRO_JOB_STATUSES], [...RETRO_JOB_STATUS_LIST]);
  assert.deepEqual([...RETRO_JOB_FAILED_STEPS], [...RETRO_JOB_FAILED_STEP_LIST]);
  assert.deepEqual([...RETRO_METHOD_DIMENSIONS], [...RETRO_METHOD_DIMENSION_LIST]);
  assert.deepEqual([...RETRO_METHOD_KINDS], [...RETRO_METHOD_KIND_LIST]);
  assert.deepEqual([...RETRO_METHOD_TRANSFERS], [...RETRO_METHOD_TRANSFER_LIST]);
  for (const status of RETRO_JOB_STATUSES) assert.ok(schema.includes(`'${status}'`), status);
});

test("partial unique indexes, RLS lock-down and timestamp conventions are present", () => {
  for (const table of RETRO_SCHEMA_TABLES) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
    assert.match(schema, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
  }
  assert.match(schema, /REVOKE ALL ON TABLE retro_cases, .*retro_method_candidates FROM anon/);
  assert.match(schema, /retro_recordings_case_part_uidx ON retro_recordings \(case_id, part_no\) WHERE case_id IS NOT NULL AND status <> 'REMOVED'/);
  assert.match(schema, /retro_recordings_summary_part_uidx ON retro_recordings \(month_key, part_no\) WHERE case_id IS NULL AND status <> 'REMOVED'/);
  assert.match(schema, /retro_month_jobs_live_uidx ON retro_month_jobs \(month_key\) WHERE status NOT IN \('PUBLISHED', 'ABANDONED'\)/);
  assert.match(schema, /UNIQUE \(month_key, version_number\)/);
  assert.match(schema, /background TEXT NOT NULL DEFAULT ''/);
  assert.match(schema, /round_id TEXT REFERENCES retro_case_rounds\(id\)/);
  assert.doesNotMatch(schema, /CURRENT_TIMESTAMP/);
});

test("file classification follows spec 4.3: images, video, audio, documents; SVG/GIF and unknown types are refused", () => {
  assert.deepEqual(classifyRetroFile("a.JPG", ""), { type: "IMAGE", docFormat: null });
  assert.deepEqual(classifyRetroFile("a.heic", ""), { type: "IMAGE", docFormat: null });
  assert.deepEqual(classifyRetroFile("a.mov", ""), { type: "VIDEO", docFormat: null });
  assert.deepEqual(classifyRetroFile("客户语音.m4a", ""), { type: "AUDIO", docFormat: null });
  assert.deepEqual(classifyRetroFile("x", "audio/amr"), { type: "AUDIO", docFormat: null });
  assert.deepEqual(classifyRetroFile("brief.pdf", ""), { type: "DOC", docFormat: "PDF" });
  assert.deepEqual(classifyRetroFile("需求说明.docx", ""), { type: "DOC", docFormat: "WORD" });
  assert.deepEqual(classifyRetroFile("报价.xlsx", ""), { type: "DOC", docFormat: "EXCEL" });
  assert.deepEqual(classifyRetroFile("提案.pptx", ""), { type: "DOC", docFormat: "PPT" });
  assert.deepEqual(classifyRetroFile("提案.key", ""), { type: "DOC", docFormat: "PPT" });
  assert.equal(classifyRetroFile("logo.svg", "image/svg+xml"), null);
  assert.equal(classifyRetroFile("动图.gif", ""), null);
  assert.equal(classifyRetroFile("压缩包.zip", "application/zip"), null);
});

test("month helpers use Beijing time and roll over years", () => {
  assert.equal(currentRetroMonthKey(new Date("2026-10-31T16:30:00Z")), "2026-11");
  assert.equal(currentRetroMonthKey(new Date("2026-10-31T15:30:00Z")), "2026-10");
  assert.equal(shiftRetroMonthKey("2026-01", -1), "2025-12");
  assert.equal(shiftRetroMonthKey("2026-12", 1), "2027-01");
  assert.equal(formatRetroMonth("2026-09"), "2026 年 9 月");
});

test("case numbers follow creation order and source labels follow spec 6.7", () => {
  const numbers = retroCaseNumbers([
    { id: "b", createdAt: "2026-10-09T10:00:00Z" },
    { id: "a", createdAt: "2026-10-08T10:00:00Z" },
  ]);
  assert.deepEqual(numbers, { a: 1, b: 2 });
  assert.equal(formatRetroSourceLabel({ kind: "REVIEW", caseNumber: 2, partNo: 1, partCount: 1, startMs: 760000 }), "案例 2 · 12:40");
  assert.equal(formatRetroSourceLabel({ kind: "REVIEW", caseNumber: 1, partNo: 2, partCount: 2, startMs: 310000 }), "案例 1 · 第 2 段 05:10");
  assert.equal(formatRetroSourceLabel({ kind: "REVIEW", caseNumber: null, partNo: 1, partCount: 1, startMs: 195000 }), "总结 · 03:15");
  assert.equal(formatRetroSourceLabel({ kind: "CLIENT", caseNumber: 1, partNo: null, partCount: 0, startMs: 42000 }), "客户录音 · 00:42");
});
