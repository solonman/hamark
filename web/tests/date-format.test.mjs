import assert from "node:assert/strict";
import test from "node:test";

import { formatLongDate, formatShortDate, formatShortDateTime } from "../lib/date-format.ts";

test("formatShortDate accepts PostgreSQL timezone offsets without producing an invalid date", () => {
  assert.equal(formatShortDate("2026-08-02 23:46:11.747437+00"), "08/03");
  assert.equal(formatShortDate("2026-08-02 23:46:11.747437+00:00"), "08/03");
  assert.equal(formatShortDate("2026-08-02T23:46:11.747Z"), "08/03");
});

test("formatShortDate renders malformed timestamps safely", () => {
  assert.equal(formatShortDate("not-a-date"), "未知日期");
  assert.equal(formatLongDate("not-a-date"), "未知日期");
});

// 评论气泡里挤在一行列表项里的时间戳：MM-DD HH:mm，本地时区，不带 "T" 或时区后缀——
// 见 docs/20_最终版与评论跨版本_实施规格_V0.1.md 五之 20，仿照 V04StudioClient.tsx 的
// formatV19Date / formatV19Clock 手动 pad，同一份 parseDatabaseDate 兜底畸形输入。
test("formatShortDateTime renders MM-DD HH:mm in the local timezone, never the raw ISO string", () => {
  // 同 formatShortDate 的用例一样假定测试环境时区为 Asia/Shanghai（UTC+8）。
  assert.equal(formatShortDateTime("2026-09-02T06:53:11.000Z"), "09-02 14:53");
  assert.equal(formatShortDateTime("2026-08-02 23:46:11.747437+00"), "08-03 07:46");
  const rendered = formatShortDateTime("2026-09-02T06:53:11.000Z");
  assert.doesNotMatch(rendered, /T/, "must not leak the raw ISO separator");
  assert.doesNotMatch(rendered, /Z$/, "must not leak the raw ISO UTC suffix");
});

test("formatShortDateTime renders malformed timestamps safely", () => {
  assert.equal(formatShortDateTime("not-a-date"), "未知时间");
});
