import assert from "node:assert/strict";
import test from "node:test";
import {
  cascadeV19Timeline,
  formatV19Timecode,
  nextV19StartTime,
  parseV19TimecodeInput,
  deriveV19StartTimes,
  findV19NonCompliantStarts,
} from "../lib/v19-timeline.ts";

type FixtureShot = { id: string; startTime: string; endTime: string };

test("parseV19TimecodeInput accepts colon and speed-entry digit forms", () => {
  assert.equal(parseV19TimecodeInput("5"), 5);
  assert.equal(parseV19TimecodeInput("45"), 45);
  assert.equal(parseV19TimecodeInput("102"), 62);
  assert.equal(parseV19TimecodeInput("0102"), 62);
  assert.equal(parseV19TimecodeInput("0000"), 0);
  assert.equal(parseV19TimecodeInput("01:02"), 62);
  assert.equal(parseV19TimecodeInput("1:02"), 62);
  assert.equal(parseV19TimecodeInput(" 45 "), 45);
});

test("parseV19TimecodeInput rejects invalid seconds and empty/blank input", () => {
  assert.equal(parseV19TimecodeInput("75"), null);
  assert.equal(parseV19TimecodeInput("1:75"), null);
  assert.equal(parseV19TimecodeInput(""), null);
  assert.equal(parseV19TimecodeInput("   "), null);
  assert.equal(parseV19TimecodeInput("abc"), null);
  assert.equal(parseV19TimecodeInput("1:2"), null);
  assert.equal(parseV19TimecodeInput("123456"), null);
});

test("formatV19Timecode zero-pads and allows minutes beyond 99", () => {
  assert.equal(formatV19Timecode(0), "00:00");
  assert.equal(formatV19Timecode(62), "01:02");
  assert.equal(formatV19Timecode(5), "00:05");
  assert.equal(formatV19Timecode(100 * 60 + 5), "100:05");
});

test("nextV19StartTime adds one second, or empty string when unparseable", () => {
  assert.equal(nextV19StartTime("00:04"), "00:05");
  assert.equal(nextV19StartTime("00:59"), "01:00");
  assert.equal(nextV19StartTime(""), "");
  assert.equal(nextV19StartTime("not-a-time"), "");
});

function demoFixtureShots(): FixtureShot[] {
  return [
    { id: "s1", startTime: "00:00", endTime: "00:04" },
    { id: "s2", startTime: "00:05", endTime: "00:09" },
    { id: "s3", startTime: "00:10", endTime: "00:12" },
    { id: "s4", startTime: "00:13", endTime: "00:18" },
    { id: "s5", startTime: "00:19", endTime: "00:24" },
    { id: "s6", startTime: "00:25", endTime: "00:30" },
  ];
}

test("cascadeV19Timeline shifts every following shot while preserving each one's own duration", () => {
  const shots = demoFixtureShots();
  shots[0].endTime = "00:06"; // caller already applied the edit that triggers cascade

  const result = cascadeV19Timeline(shots, "s1");

  assert.deepEqual(
    result.shots.map((s) => [s.startTime, s.endTime]),
    [
      ["00:00", "00:06"],
      ["00:07", "00:11"],
      ["00:12", "00:14"],
      ["00:15", "00:20"],
      ["00:21", "00:26"],
      ["00:27", "00:32"],
    ],
  );
  assert.deepEqual(result.changedShotIds, ["s2", "s3", "s4", "s5", "s6"]);

  // Input must not be mutated (aside from the caller's own pre-applied edit).
  assert.equal(shots[1].startTime, "00:05");
  assert.equal(shots[1].endTime, "00:09");
});

test("cascadeV19Timeline stops early once the timeline is already continuous", () => {
  const shots: FixtureShot[] = [
    { id: "a", startTime: "00:00", endTime: "00:05" },
    { id: "b", startTime: "00:06", endTime: "00:10" }, // already continuous with "a"
    { id: "c", startTime: "00:20", endTime: "00:25" }, // discontinuous, but never reached
  ];

  const result = cascadeV19Timeline(shots, "a");

  assert.deepEqual(result.changedShotIds, []);
  assert.equal(result.shots[1].startTime, "00:06");
  assert.equal(result.shots[2].startTime, "00:20");
});

test("cascadeV19Timeline does not crash and stops when a previous end time is empty/unparseable", () => {
  const shots: FixtureShot[] = [
    { id: "a", startTime: "00:00", endTime: "" },
    { id: "b", startTime: "00:05", endTime: "00:09" },
    { id: "c", startTime: "00:10", endTime: "00:15" },
  ];

  const result = cascadeV19Timeline(shots, "a");

  assert.deepEqual(result.changedShotIds, []);
  assert.deepEqual(result.shots, shots);
});

test("cascadeV19Timeline leaves a shot's own end untouched when its start/end can't establish a duration", () => {
  const shots: FixtureShot[] = [
    { id: "a", startTime: "00:00", endTime: "00:04" },
    { id: "b", startTime: "bogus", endTime: "00:09" },
    { id: "c", startTime: "00:10", endTime: "00:15" },
  ];

  const result = cascadeV19Timeline(shots, "a");

  // "b" has no derivable duration (its own start doesn't parse), so only its
  // start moves; "c" already sits at prev-end+1 once "b" is fixed up, so the
  // cascade stops there without touching it.
  assert.deepEqual(result.changedShotIds, ["b"]);
  assert.equal(result.shots[1].startTime, "00:05");
  assert.equal(result.shots[1].endTime, "00:09"); // unchanged: no derivable duration
  assert.equal(result.shots[2].startTime, "00:10"); // prev end (00:09) + 1 already continuous
});

test("cascadeV19Timeline returns an unchanged copy when fromShotId is unknown", () => {
  const shots = demoFixtureShots();
  const result = cascadeV19Timeline(shots, "does-not-exist");
  assert.deepEqual(result.changedShotIds, []);
  assert.deepEqual(result.shots, shots);
  assert.notEqual(result.shots, shots);
});

// ---------------------------------------------------------------------------
// 开始时间由上一镜头结束时间推导（用户只填结束时间）
// ---------------------------------------------------------------------------

test("every start after the first is derived from the previous end", () => {
  const shots = [
    { id: "a", startTime: "00:00", endTime: "00:04" },
    { id: "b", startTime: "99:99", endTime: "00:09" },
    { id: "c", startTime: "", endTime: "00:12" },
  ];
  const result = deriveV19StartTimes(shots);
  assert.deepEqual(result.shots.map((s) => s.startTime), ["00:00", "00:05", "00:10"]);
  assert.deepEqual(result.changedShotIds, ["b", "c"]);
  assert.equal(shots[1].startTime, "99:99", "input is left untouched");
});

test("the first shot keeps whatever start it was given", () => {
  const result = deriveV19StartTimes([{ id: "a", startTime: "00:07", endTime: "00:09" }]);
  assert.equal(result.shots[0].startTime, "00:07");
  assert.deepEqual(result.changedShotIds, []);
});

test("a shot whose predecessor has no usable end keeps its own start", () => {
  const result = deriveV19StartTimes([
    { id: "a", startTime: "00:00", endTime: "" },
    { id: "b", startTime: "00:20", endTime: "00:25" },
    { id: "c", startTime: "00:99", endTime: "00:30" },
  ]);
  // b 推不出来就原样保留；c 能从 b 的结束时间推出。
  assert.deepEqual(result.shots.map((s) => s.startTime), ["00:00", "00:20", "00:26"]);
  assert.deepEqual(result.changedShotIds, ["c"]);
});

test("an already-compliant timeline reports nothing to change", () => {
  const shots = [
    { id: "a", startTime: "00:00", endTime: "00:04" },
    { id: "b", startTime: "00:05", endTime: "00:09" },
  ];
  assert.deepEqual(findV19NonCompliantStarts(shots), []);
});

test("legacy free-form starts are reported, not rewritten", () => {
  const shots = [
    { id: "a", startTime: "00:00", endTime: "00:04" },
    { id: "b", startTime: "00:30", endTime: "00:35" },
  ];
  assert.deepEqual(findV19NonCompliantStarts(shots), ["b"]);
  assert.equal(shots[1].startTime, "00:30", "reporting must not mutate");
});
