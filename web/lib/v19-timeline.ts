/**
 * V1.9 timecode parsing and timeline cascade — pure functions ported from the
 * approved interaction demo (`docs/demos/2026-08-24-二合一工作台交互demo.html`,
 * see `parseTcInput` / `fmtTc` / `nextTc` / `cascadeTimeline`) per spec rules
 * 6 and 7 in `docs/18_V1.9_二合一工作台重构实施规格_V0.1.md`.
 *
 * No React, no DOM, no network — safe to import from both server and client
 * code.
 */

/**
 * Parses what a user types into a timecode field, in total seconds.
 *
 * Accepted forms:
 * - `mm:ss` / `m:ss` / `hhh:ss` with a colon — seconds part must be ≤ 59;
 * - pure digits, speed-entry style: the last two digits are seconds, the
 *   rest are minutes (`"0102"` → 62, `"102"` → 62, `"45"` → 45, `"5"` → 5,
 *   `"0000"` → 0). A lone digit is seconds, not minutes.
 *
 * Returns `null` for empty/whitespace input (caller treats that as
 * "cleared"), and for anything else that doesn't parse or whose seconds
 * part exceeds 59.
 */
export function parseV19TimecodeInput(raw: string): number | null {
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  const withColon = trimmed.match(/^(\d{1,3}):(\d{2})$/);
  if (withColon) {
    const seconds = Number(withColon[2]);
    if (seconds > 59) return null;
    return Number(withColon[1]) * 60 + seconds;
  }

  const digitsOnly = trimmed.match(/^\d{1,5}$/);
  if (!digitsOnly) return null;
  if (trimmed.length === 1) return Number(trimmed);

  const seconds = Number(trimmed.slice(-2));
  const minutes = Number(trimmed.slice(0, -2) || "0");
  if (seconds > 59) return null;
  return minutes * 60 + seconds;
}

/** Formats total seconds as zero-padded `mm:ss`; minutes may exceed 99. */
export function formatV19Timecode(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Previous end time + 1 second, formatted as `mm:ss`. Returns `""` when the
 * input isn't a parseable stored timecode. Same semantics as the existing
 * `nextV04Timecode` in `lib/v04-ui-client-state.ts`, kept self-contained here
 * so this module has no dependency on the V0.4 UI layer.
 */
export function nextV19StartTime(previousEndTime: string): string {
  const parsed = parseV19TimecodeInput(previousEndTime);
  if (parsed == null) return "";
  return formatV19Timecode(parsed + 1);
}

export type V19CascadeResult<T> = {
  shots: T[];
  changedShotIds: string[];
};

/**
 * Spec rule 6: after the shot identified by `fromShotId` had its END time
 * changed (the caller has already written that new end time into `shots`),
 * every following shot shifts so its start = previous shot's end + 1
 * second, preserving that shot's own original duration.
 *
 * Stops as soon as either:
 * - a shot already satisfies `start === previousEnd + 1` (timeline is
 *   already continuous from there on), or
 * - the previous shot's end time is missing/unparseable (nothing more can
 *   be derived).
 *
 * A shot whose own start or end is missing/unparseable keeps an undefined
 * duration: only its start is set, its end is left untouched.
 *
 * Returns new objects — the input array and its items are never mutated —
 * plus the ids of shots that were actually changed.
 */
export function cascadeV19Timeline<T extends { id: string; startTime: string; endTime: string }>(
  shots: readonly T[],
  fromShotId: string,
): V19CascadeResult<T> {
  const next = shots.map((shot) => ({ ...shot }));
  const changedShotIds: string[] = [];

  const fromIndex = next.findIndex((shot) => shot.id === fromShotId);
  if (fromIndex < 0) return { shots: next, changedShotIds };

  for (let index = fromIndex + 1; index < next.length; index += 1) {
    const previous = next[index - 1];
    const shot = next[index];

    const previousEnd = parseV19TimecodeInput(previous.endTime);
    if (previousEnd == null) break;

    const newStart = formatV19Timecode(previousEnd + 1);
    if (shot.startTime === newStart) break;

    const ownStart = parseV19TimecodeInput(shot.startTime);
    const ownEnd = parseV19TimecodeInput(shot.endTime);
    const duration = ownStart != null && ownEnd != null ? ownEnd - ownStart : null;

    next[index] = {
      ...shot,
      startTime: newStart,
      endTime: duration != null ? formatV19Timecode(previousEnd + 1 + duration) : shot.endTime,
    } as T;
    changedShotIds.push(shot.id);
  }

  return { shots: next, changedShotIds };
}

/**
 * 开始时间是推导值，不是录入值：除全片第一个镜头外，每个镜头的开始时间
 * ＝上一镜头结束时间＋1秒。用户只填结束时间，增删镜头后时间线自动闭合，
 * 重叠与倒挂在结构上不可能发生。
 *
 * 上一镜头的结束时间为空或无法解析时，保留该镜头原有的开始时间——推导不出来
 * 的地方不去猜，宁可原样留着让人看见。
 */
export function deriveV19StartTimes<T extends { id: string; startTime: string; endTime: string }>(
  shots: readonly T[],
): { shots: T[]; changedShotIds: string[] } {
  const next: T[] = [];
  const changedShotIds: string[] = [];
  for (let index = 0; index < shots.length; index += 1) {
    const shot = shots[index];
    if (index === 0) { next.push(shot); continue; }
    const previousEnd = parseV19TimecodeInput(next[index - 1].endTime);
    if (previousEnd == null) { next.push(shot); continue; }
    const derived = formatV19Timecode(previousEnd + 1);
    if (derived === shot.startTime) { next.push(shot); continue; }
    next.push({ ...shot, startTime: derived });
    changedShotIds.push(shot.id);
  }
  return { shots: next, changedShotIds };
}

/**
 * 存量内容里已有的开始时间未必符合上面的规则——它们是在自由录入的年代填的。
 * 这里只报告哪些不符合，不动数据：要不要按规则重排，得由人决定，
 * 不能因为换了规则就悄悄改写别人写下的时间。
 */
export function findV19NonCompliantStarts<T extends { id: string; startTime: string; endTime: string }>(
  shots: readonly T[],
): string[] {
  return deriveV19StartTimes(shots).changedShotIds;
}
