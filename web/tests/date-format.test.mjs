import assert from "node:assert/strict";
import test from "node:test";

import { formatLongDate, formatShortDate } from "../lib/date-format.ts";

test("formatShortDate accepts PostgreSQL timezone offsets without producing an invalid date", () => {
  assert.equal(formatShortDate("2026-08-02 23:46:11.747437+00"), "08/03");
  assert.equal(formatShortDate("2026-08-02 23:46:11.747437+00:00"), "08/03");
  assert.equal(formatShortDate("2026-08-02T23:46:11.747Z"), "08/03");
});

test("formatShortDate renders malformed timestamps safely", () => {
  assert.equal(formatShortDate("not-a-date"), "未知日期");
  assert.equal(formatLongDate("not-a-date"), "未知日期");
});
