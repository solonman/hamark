// 点评录音（retro_recordings）和附件里的客户录音（retro_case_assets 的 AUDIO）共用的转写推进（docs/26 5.2）。
// 两张表的列名略有不同（status / transcribe_status 等），这里用一份「目标描述」把差异收在一处，
// 推进逻辑只写一遍：照 lib/audio-review/service.ts 的 advanceAudioReview / runTranscription。
//
// 推进模型：没有常驻进程。上传完成、重试和每次 GET 都在响应发出后用 after() 调一次
// advanceRetroTranscription，deadline = 请求开始 + 280 秒。进门先抢租约（290 秒），抢不到说明另一次
// 推进正在跑，直接返回；抢到后在 deadline 之内能走多远走多远，退出时只清自己的租约。
// 每一步写入都带「状态仍是 TRANSCRIBING」的条件，所以中途被移除也不会被后台写回来。
// 外部错误（腾讯云、存储）一律翻成中文失败原因，绝不向外抛。

import type { DbClient, QueryResultRow } from "@/db";
import { parseStoredTranscript } from "@/lib/audio-review/transcript";
import { formatHotwordList, TENCENT_ASR_HOTWORD_LIMIT } from "@/lib/audio-review/tencent-asr";
import type { RetroTranscriptSegment } from "@/lib/retro-model";
import type { VideoBucket } from "@/storage/types";
import type { RetroAsrKind, RetroAsrProvider } from "./asr";

export const RETRO_AUDIO_URL_TTL_SECONDS = 3 * 60 * 60;
export const RETRO_TRANSCRIBE_DEADLINE_MS = 280_000;
export const RETRO_TRANSCRIBE_LEASE_SECONDS = 290;
/** 转写提交后（或一直提交不成功）超过这么久，就不再等了。腾讯云一般几分钟内返回。 */
export const RETRO_TRANSCRIBE_MAX_MS = 2 * 60 * 60 * 1000;
/** 留给每次轮询前后写库的余量。 */
const POLL_MARGIN_MS = 1_000;

export type RetroTranscribeTarget = "RECORDING" | "ASSET";

type TargetSpec = {
  table: "retro_recordings" | "retro_case_assets";
  statusColumn: "status" | "transcribe_status";
  failColumn: "fail_reason" | "transcribe_fail_reason";
  keyColumn: "audio_object_key" | "object_key";
  /** 转写完成时额外要写的列（纯 SQL 片段，常量，不含用户输入）。 */
  doneSql: string;
};

// 标识符都是下面这两行常量，不会来自请求，所以可以安全地拼进 SQL。
const SPECS: Record<RetroTranscribeTarget, TargetSpec> = {
  RECORDING: {
    table: "retro_recordings",
    statusColumn: "status",
    failColumn: "fail_reason",
    keyColumn: "audio_object_key",
    doneSql: ", transcribed_at = now()",
  },
  ASSET: {
    table: "retro_case_assets",
    statusColumn: "transcribe_status",
    failColumn: "transcribe_fail_reason",
    keyColumn: "object_key",
    doneSql: "",
  },
};

export function retroTranscribeSpec(target: RetroTranscribeTarget): Readonly<TargetSpec> {
  return SPECS[target];
}

export type RetroTranscribeDeps = {
  asr: RetroAsrProvider;
  bucket: Pick<VideoBucket, "createPresignedGetUrl">;
  sleep: (ms: number) => Promise<void>;
  clock: () => number;
  log?: (message: string, detail?: unknown) => void;
};

type AdvanceRow = QueryResultRow & {
  id: string;
  object_key: string;
  status: string;
  asr_task_id: string | null;
  asr_engine: string | null;
  asr_submitted_at: unknown;
  updated_at: unknown;
  lease_until: unknown;
};

function columns(spec: TargetSpec) {
  return `id, ${spec.keyColumn} AS object_key, ${spec.statusColumn} AS status, asr_task_id, asr_engine, asr_submitted_at, updated_at, lease_until`;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

// ---------------------------------------------------------------------------
// 状态转换（上传完成、重试）
// ---------------------------------------------------------------------------

/**
 * 进入「转写中」：清掉上一次的任务信息和租约。fromStatuses 是允许的来源状态（并发保护）。
 * 返回是否真的转换了。
 */
export async function startRetroTranscription(
  db: DbClient,
  target: RetroTranscribeTarget,
  id: string,
  fromStatuses: readonly string[],
): Promise<boolean> {
  const spec = SPECS[target];
  const placeholders = fromStatuses.map(() => "?").join(", ");
  const row = await db.prepare(
    `UPDATE ${spec.table}
     SET ${spec.statusColumn} = 'TRANSCRIBING', ${spec.failColumn} = NULL,
         asr_task_id = NULL, asr_submitted_at = NULL, asr_checked_at = NULL, lease_until = NULL, updated_at = now()
     WHERE id = ? AND ${spec.statusColumn} IN (${placeholders})
     RETURNING id`,
  ).bind(id, ...fromStatuses).first<{ id: string } & QueryResultRow>();
  return Boolean(row);
}

/** GET 时要不要顺手推进一次：在途且租约空闲。 */
export function shouldAdvanceRetroTranscription(row: { status: string; lease_until?: unknown }, nowMs: number): boolean {
  if (row.status !== "TRANSCRIBING") return false;
  const lease = iso(row.lease_until);
  return !lease || Date.parse(lease) < nowMs;
}

// ---------------------------------------------------------------------------
// 热词（规格 5.2）：客户名、部门名、案例标题里的词、场景标签、回合标题、「老孙」、上传人姓名，
// 去重后最多 128 个。
// ---------------------------------------------------------------------------

export type RetroHotwordContext = {
  uploaderName: string;
  clientNames: readonly string[];
  departments: readonly string[];
  titles: readonly string[];
  sceneTags: readonly string[];
  roundTitles: readonly string[];
};

/** 单个热词「最多 10 个汉字或 30 个字符」：汉字记 3，其余记 1。 */
function hotwordWidth(word: string) {
  let width = 0;
  for (const ch of word) width += (ch.codePointAt(0) ?? 0) <= 0xff ? 1 : 3;
  return width;
}

function titleWords(title: string): string[] {
  try {
    const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
    return [...segmenter.segment(title)].filter((part) => part.isWordLike).map((part) => part.segment);
  } catch {
    return [];
  }
}

const DEFAULT_ROUND_TITLE = /^第\s*\d+\s*版$/;

export function buildRetroHotwords(context: RetroHotwordContext): string[] {
  const words: string[] = ["老孙", context.uploaderName];
  words.push(...context.clientNames, ...context.departments, ...context.sceneTags);
  words.push(...context.roundTitles.filter((title) => !DEFAULT_ROUND_TITLE.test(title.trim())));
  for (const title of context.titles) words.push(...titleWords(title));

  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of words) {
    const word = (raw ?? "").replace(/[\s,，|｜/／、。.：:；;（）()《》"“”'‘’!！?？]/g, "");
    // 单字词当热词没有意义，还容易误伤；超长的腾讯云不收。
    if (!word || [...word].length < 2 || seen.has(word) || hotwordWidth(word) > 30) continue;
    seen.add(word);
    result.push(word);
    if (result.length >= TENCENT_ASR_HOTWORD_LIMIT) break;
  }
  return result;
}

type CaseHotwordRow = QueryResultRow & { client_name: string; department: string; title: string; scene_tags_json: unknown };

function sceneTagsOf(value: unknown): string[] {
  const raw = typeof value === "string" ? safeParse(value) : value;
  return Array.isArray(raw) ? raw.filter((tag): tag is string => typeof tag === "string") : [];
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function loadRetroHotwordContext(db: DbClient, target: RetroTranscribeTarget, id: string): Promise<RetroHotwordContext> {
  const meta = target === "RECORDING"
    ? await db.prepare(`SELECT case_id, month_key, uploaded_by_name AS uploader FROM retro_recordings WHERE id = ?`)
        .bind(id).first<QueryResultRow & { case_id: string | null; month_key: string; uploader: string }>()
    : await db.prepare(
        `SELECT a.case_id, c.month_key, COALESCE(u.display_name, c.created_by_name) AS uploader
         FROM retro_case_assets a
         JOIN retro_cases c ON c.id = a.case_id
         LEFT JOIN users u ON u.id = a.created_by_user_id
         WHERE a.id = ?`,
      ).bind(id).first<QueryResultRow & { case_id: string | null; month_key: string; uploader: string }>();
  const context: RetroHotwordContext = {
    uploaderName: meta?.uploader ?? "",
    clientNames: [],
    departments: [],
    titles: [],
    sceneTags: [],
    roundTitles: [],
  };
  if (!meta) return context;

  // 案例录音按这个案例取词；整场总结取当月全部案例的客户、部门和标题。
  const cases = meta.case_id
    ? (await db.prepare(`SELECT client_name, department, title, scene_tags_json FROM retro_cases WHERE id = ?`).bind(meta.case_id).all<CaseHotwordRow>()).results
    : (await db.prepare(
        `SELECT client_name, department, title, scene_tags_json FROM retro_cases
         WHERE month_key = ? AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 20`,
      ).bind(meta.month_key).all<CaseHotwordRow>()).results;
  const rounds = meta.case_id
    ? (await db.prepare(`SELECT title FROM retro_case_rounds WHERE case_id = ? AND deleted_at IS NULL ORDER BY position ASC`)
        .bind(meta.case_id).all<QueryResultRow & { title: string }>()).results
    : [];
  return {
    uploaderName: meta.uploader ?? "",
    clientNames: cases.map((row) => row.client_name),
    departments: cases.map((row) => row.department),
    titles: cases.map((row) => row.title),
    sceneTags: cases.flatMap((row) => sceneTagsOf(row.scene_tags_json)),
    roundTitles: rounds.map((row) => row.title),
  };
}

// ---------------------------------------------------------------------------
// 推进
// ---------------------------------------------------------------------------

export type RetroAdvanceResult = { advanced: boolean; status: string | null };

async function failTranscription(db: DbClient, spec: TargetSpec, id: string, reason: string, extraSql = "") {
  return db.prepare(
    `UPDATE ${spec.table}
     SET ${spec.statusColumn} = 'FAILED', ${spec.failColumn} = ?, updated_at = now()${extraSql}
     WHERE id = ? AND ${spec.statusColumn} = 'TRANSCRIBING'
     RETURNING id`,
  ).bind(reason, id).first<{ id: string } & QueryResultRow>();
}

function hasTime(options: { deadline: number; deps: RetroTranscribeDeps }, ms: number) {
  return options.deadline - options.deps.clock() > ms + POLL_MARGIN_MS;
}

export async function advanceRetroTranscription(
  db: DbClient,
  target: RetroTranscribeTarget,
  id: string,
  options: { deadline: number; deps: RetroTranscribeDeps; kind: RetroAsrKind },
): Promise<RetroAdvanceResult> {
  const spec = SPECS[target];
  const { deps } = options;
  const log = deps.log ?? ((message: string, detail?: unknown) => console.error(message, detail));
  let leased: AdvanceRow | null;
  try {
    // 毫秒精度的租约值同时当令牌用：退出时只清自己的租约（pg 把 timestamptz 读成 Date 会丢微秒）。
    leased = await db.prepare(
      `UPDATE ${spec.table}
       SET lease_until = date_trunc('milliseconds', now() + interval '${RETRO_TRANSCRIBE_LEASE_SECONDS} seconds')
       WHERE id = ? AND ${spec.statusColumn} = 'TRANSCRIBING' AND (lease_until IS NULL OR lease_until < now())
       RETURNING ${columns(spec)}`,
    ).bind(id).first<AdvanceRow>();
  } catch (error) {
    log("[retro] 转写抢租约失败", error);
    return { advanced: false, status: null };
  }
  if (!leased) return { advanced: false, status: null };
  const leaseToken = iso(leased.lease_until);
  try {
    const finalStatus = await runTranscription(db, spec, target, leased, options);
    return { advanced: true, status: finalStatus };
  } catch (error) {
    // 代码或数据库层面的意外：记日志，把转写停在失败态，等重试，不往外抛。
    log("[retro] 转写推进时出错", error);
    await failTranscription(db, spec, id, "处理时出现内部错误，请重试。").catch((failure) => log("[retro] 写失败状态也失败了", failure));
    return { advanced: true, status: "FAILED" };
  } finally {
    await db.prepare(`UPDATE ${spec.table} SET lease_until = NULL WHERE id = ? AND lease_until = ?::timestamptz`)
      .bind(id, leaseToken).run().catch((error) => log("[retro] 释放转写租约失败", error));
  }
}

async function runTranscription(
  db: DbClient,
  spec: TargetSpec,
  target: RetroTranscribeTarget,
  row: AdvanceRow,
  options: { deadline: number; deps: RetroTranscribeDeps; kind: RetroAsrKind },
): Promise<string> {
  const { deps } = options;
  const { asr } = deps;
  let current = row;
  for (;;) {
    if (!current.asr_task_id) {
      const since = Date.parse(iso(current.updated_at) ?? "");
      if (Number.isFinite(since) && deps.clock() - since > RETRO_TRANSCRIBE_MAX_MS) {
        await failTranscription(db, spec, current.id, "转写一直没能提交成功，请重试。");
        return "FAILED";
      }
      let audioUrl: string;
      try {
        audioUrl = await deps.bucket.createPresignedGetUrl(current.object_key, { expiresInSeconds: RETRO_AUDIO_URL_TTL_SECONDS });
      } catch {
        await failTranscription(db, spec, current.id, "生成录音下载链接失败，请检查存储配置后重试。");
        return "FAILED";
      }
      const hotwordList = formatHotwordList(buildRetroHotwords(await loadRetroHotwordContext(db, target, current.id)));
      const submitted = await asr.submit({ audioUrl, hotwordList, kind: options.kind });
      if (!submitted.ok) {
        if (submitted.transient) return "TRANSCRIBING"; // 临时错误：留给下一次推进。
        await failTranscription(db, spec, current.id, submitted.reason);
        return "FAILED";
      }
      const saved = await db.prepare(
        `UPDATE ${spec.table} SET asr_task_id = ?, asr_engine = ?, asr_submitted_at = now(), updated_at = now()
         WHERE id = ? AND ${spec.statusColumn} = 'TRANSCRIBING' AND asr_task_id IS NULL
         RETURNING ${columns(spec)}`,
      // 写实际用上的引擎：大模型额度不足时 tencent-asr 会退到 16k_zh。
      ).bind(submitted.taskId, submitted.engine || asr.engine, current.id).first<AdvanceRow>();
      if (!saved) return "TRANSCRIBING";
      current = saved;
      if (!hasTime(options, asr.pollIntervalMs)) return "TRANSCRIBING";
      await deps.sleep(asr.pollIntervalMs);
    }

    const outcome = await asr.describe(current.asr_task_id!);
    if (outcome.kind === "SUCCESS") {
      // 腾讯云只保留 24 小时，拿到就落库。
      const transcript = { segments: outcome.segments, durationMs: outcome.durationMs, engine: current.asr_engine ?? asr.engine };
      const done = await db.prepare(
        `UPDATE ${spec.table}
         SET ${spec.statusColumn} = 'READY', ${spec.failColumn} = NULL, transcript_json = ?::jsonb, audio_duration_ms = ?,
             asr_checked_at = now(), updated_at = now()${spec.doneSql}
         WHERE id = ? AND ${spec.statusColumn} = 'TRANSCRIBING'
         RETURNING id`,
      ).bind(JSON.stringify(transcript), outcome.durationMs, current.id).first<{ id: string } & QueryResultRow>();
      return done ? "READY" : "TRANSCRIBING";
    }
    if (outcome.kind === "FAILED" || (outcome.kind === "ERROR" && !outcome.transient)) {
      await failTranscription(db, spec, current.id, outcome.reason, ", asr_checked_at = now()");
      return "FAILED";
    }
    const checked = await db.prepare(
      `UPDATE ${spec.table} SET asr_checked_at = now(), updated_at = now()
       WHERE id = ? AND ${spec.statusColumn} = 'TRANSCRIBING'
       RETURNING ${columns(spec)}`,
    ).bind(current.id).first<AdvanceRow>();
    if (!checked) return "TRANSCRIBING";
    current = checked;
    if (outcome.kind === "ERROR") return "TRANSCRIBING"; // 临时错误：留给下一次推进。
    const submittedAt = Date.parse(iso(current.asr_submitted_at) ?? "");
    if (Number.isFinite(submittedAt) && deps.clock() - submittedAt > RETRO_TRANSCRIBE_MAX_MS) {
      await failTranscription(db, spec, current.id, "转写超过 2 小时仍未完成，请重试。");
      return "FAILED";
    }
    if (!hasTime(options, asr.pollIntervalMs)) return "TRANSCRIBING";
    await deps.sleep(asr.pollIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// 读：库里的 transcript_json → 给前端的片段
// ---------------------------------------------------------------------------

export function retroSegmentsFromStored(value: unknown): RetroTranscriptSegment[] | null {
  const transcript = parseStoredTranscript(value);
  return transcript ? transcript.segments : null;
}

// ---------------------------------------------------------------------------
// 找出该推进的转写：详情、库首页 GET 顺手推进用（上传完成、重试之外的兜底）
// ---------------------------------------------------------------------------

export type RetroAdvanceable = { target: RetroTranscribeTarget; id: string; kind: RetroAsrKind };

/** 在途且租约空闲的点评录音和客户录音。caseId 不传就扫全库（最多 limit 条）。 */
export async function listAdvanceableRetroTranscriptions(
  db: DbClient,
  options: { caseId?: string; limit?: number } = {},
): Promise<RetroAdvanceable[]> {
  const limit = options.limit ?? 8;
  const scoped = options.caseId ? "AND case_id = ?" : "";
  const binds = options.caseId ? [options.caseId] : [];
  const [recordings, assets] = await Promise.all([
    db.prepare(
      `SELECT id, case_id FROM retro_recordings
       WHERE status = 'TRANSCRIBING' AND (lease_until IS NULL OR lease_until < now()) ${scoped}
       ORDER BY updated_at ASC LIMIT ${Math.floor(limit)}`,
    ).bind(...binds).all<QueryResultRow & { id: string; case_id: string | null }>(),
    db.prepare(
      `SELECT id FROM retro_case_assets
       WHERE type = 'AUDIO' AND transcribe_status = 'TRANSCRIBING' AND (lease_until IS NULL OR lease_until < now()) ${scoped}
       ORDER BY updated_at ASC LIMIT ${Math.floor(limit)}`,
    ).bind(...binds).all<QueryResultRow & { id: string }>(),
  ]);
  return [
    ...recordings.results.map((row): RetroAdvanceable => ({ target: "RECORDING", id: row.id, kind: row.case_id ? "REVIEW" : "SUMMARY" })),
    ...assets.results.map((row): RetroAdvanceable => ({ target: "ASSET", id: row.id, kind: "CLIENT" })),
  ];
}
