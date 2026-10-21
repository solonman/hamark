// 录音点评服务层（docs/25 四）：建任务（含虚拟 v1 物化）、UPLOADED / RETRY / ABANDON / CONFIRM、
// advanceAudioReview 的租约与时间预算、两次失败转 FAILED、确认生成的事务内容与幂等、权限与可见性。
//
// 数据库是一个只认本模块 SQL 的小模拟器：UPDATE audio_reviews 按 SET / WHERE 逐项解释执行，
// 其余语句按形状匹配；遇到没见过的 SQL 直接报错，保证测试真的覆盖了服务层发出的每一句。
// 时钟是模拟的：sleep 只拨时钟，不真等。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { DbClient } from "../db";
import { buildFakeModelOutput } from "../lib/audio-review/fake";
import { AudioReviewError } from "../lib/audio-review/errors";
import type { AudioReviewProviders } from "../lib/audio-review/providers";
import type { AsrDescribeOutcome } from "../lib/audio-review/tencent-asr";
import type { LlmOutcome } from "../lib/audio-review/deepseek";
import type { AudioReviewTranscriptSegment } from "../lib/audio-review/transcript";
import {
  advanceAudioReview,
  audioReviewOriginalFileOverrides,
  createAudioReview,
  listAudioReviewSummaries,
  loadAudioReviewForViewer,
  loadAudioReviewStudioState,
  normalizeCreateAudioReviewBody,
  runAudioReviewAction,
  shouldAdvanceAudioReview,
  type AudioReviewDeps,
} from "../lib/audio-review/service";
import { toAudioReviewView, type AudioReviewRow } from "../lib/audio-review/view";
import { readAudioReviewConfig } from "../lib/audio-review/config";
import { AUDIO_REVIEW_CRITIC_NAME, isAudioReviewCriticVersion, isAudioReviewUploader } from "../lib/audio-review/access";
import { AUDIO_REVIEW_DOCUMENT_REASONS } from "../lib/audio-review/document";
import { AUDIO_REVIEW_DOCUMENT_SYSTEM_PROMPT, AUDIO_REVIEW_SYSTEM_PROMPT } from "../lib/audio-review/prompt";
import { AUDIO_REVIEW_DOCX_CONTENT_TYPE, AUDIO_REVIEW_PASTED_FILE_NAME } from "../lib/audio-review-model";
import { buildDocx, wordParagraph } from "./audio-review-docx-fixtures";
import { formatV19VersionLabel as formatClientLabel } from "../lib/v19-ui-model";
import { formatV19VersionLabel as formatServerLabel } from "../lib/v19-version-chain";
import type { V04DraftPayloadV1 } from "../lib/v04-contract";
import { V04ServiceError } from "../lib/v04-errors";
import type { V04Actor } from "../lib/v04-workspace-service";

const sample = JSON.parse(readFileSync(new URL("../scripts/fixtures/audio-review-sample.json", import.meta.url), "utf8")) as {
  snapshot: V04DraftPayloadV1;
  transcript: AudioReviewTranscriptSegment[];
};

const REVIEWER: V04Actor = { userId: "user-sun", identityKey: "wecom:sun", displayName: "老孙", sessionId: "s1", requestId: "req-1" };
const AUTHOR: V04Actor = { userId: "user-liu", identityKey: "wecom:liu", displayName: "刘梦娜", sessionId: "s2", requestId: "req-2" };
const OTHER: V04Actor = { userId: "user-wang", identityKey: "wecom:wang", displayName: "王一凡", sessionId: "s3", requestId: "req-3" };
const VIDEO = "video-1";
const START = Date.parse("2026-10-10T08:00:00.000Z");

// ---------------------------------------------------------------------------
// 数据库模拟器
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Clock = { now: number };

const REVIEW_DEFAULTS: Row = {
  failed_step: null, fail_reason: null, audio_duration_ms: null, asr_engine: null, asr_task_id: null,
  asr_submitted_at: null, asr_checked_at: null, transcript_json: null, llm_model: null, prompt_version: null,
  llm_attempts: 0, llm_started_at: null, llm_finished_at: null, llm_usage_json: null, input_content_hash: null,
  proposal_json: null, selected_change_ids: null, review_version_id: null, lease_until: null,
  uploaded_at: null, proposed_at: null, confirmed_at: null, abandoned_at: null,
};

function splitTopLevel(text: string, separator: string) {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === "(") depth += 1;
    if (!quoted && ch === ")") depth -= 1;
    if (!quoted && depth === 0 && text.startsWith(separator, index)) {
      parts.push(current.trim());
      current = "";
      index += separator.length - 1;
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : new Date(String(value)).toISOString());

class FakeDb {
  log: Array<{ sql: string; params: unknown[] }> = [];
  videos = new Map<string, Row>();
  users = new Map<string, string>();
  snapshots = new Map<string, V04DraftPayloadV1>();
  workspace: Row | null = null;
  versions: Row[] = [];
  reviews = new Map<string, Row>();
  events: Row[] = [];
  audits: Row[] = [];
  fail: ((sql: string) => Error | null) | null = null;
  constructor(readonly clock: Clock) {}

  prepare(sql: string) {
    let params: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => {
        params = values;
        return statement;
      },
      first: async () => this.execute(sql, params).rows[0] ?? null,
      all: async () => ({ results: this.execute(sql, params).rows }),
      run: async () => ({ success: true, meta: { rows_read: 0, rows_written: this.execute(sql, params).rowCount } }),
    };
    return statement;
  }

  async withTransaction<T>(operation: (db: DbClient) => Promise<T>): Promise<T> {
    this.log.push({ sql: "BEGIN", params: [] });
    const snapshot = this.snapshotState();
    try {
      const result = await operation(this as unknown as DbClient);
      this.log.push({ sql: "COMMIT", params: [] });
      return result;
    } catch (error) {
      this.restoreState(snapshot);
      this.log.push({ sql: "ROLLBACK", params: [] });
      throw error;
    }
  }

  private snapshotState() {
    return {
      versions: structuredClone(this.versions),
      reviews: structuredClone([...this.reviews.entries()]),
      events: structuredClone(this.events),
      audits: structuredClone(this.audits),
    };
  }

  private restoreState(state: ReturnType<FakeDb["snapshotState"]>) {
    this.versions = state.versions;
    this.reviews = new Map(state.reviews);
    this.events = state.events;
    this.audits = state.audits;
  }

  get sqls() {
    return this.log.map((entry) => entry.sql);
  }

  private now() {
    return new Date(this.clock.now);
  }

  execute(rawSql: string, params: unknown[]): { rows: Row[]; rowCount: number } {
    const sql = rawSql.replace(/\s+/g, " ").trim();
    this.log.push({ sql, params });
    const injected = this.fail?.(sql);
    if (injected) throw injected;
    const one = (row: Row | null | undefined) => (row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 });

    if (sql.startsWith("UPDATE audio_reviews SET")) return this.updateReviews(sql, params);
    if (sql.startsWith("INSERT INTO audio_reviews")) {
      const [id, workspaceId, videoId, baseId, baseNumber, baseOwner, basePayload, reviewerId, reviewerName,
        objectKey, fileName, contentType, size] = params;
      const live = [...this.reviews.values()].some((row) => row.base_version_id === baseId && row.status !== "ABANDONED");
      if (live || this.reviews.has(String(id))) return { rows: [], rowCount: 0 };
      this.reviews.set(String(id), {
        ...REVIEW_DEFAULTS,
        id, workspace_id: workspaceId, video_id: videoId, base_version_id: baseId, base_version_number: baseNumber,
        base_owner_name: baseOwner, base_payload_json: JSON.parse(String(basePayload)), reviewer_user_id: reviewerId,
        reviewer_name: reviewerName, status: "UPLOADING", audio_object_key: objectKey, audio_file_name: fileName,
        audio_content_type: contentType, audio_size_bytes: String(size), created_at: this.now(), updated_at: this.now(),
      });
      return one({ id });
    }
    if (sql.startsWith("SELECT id FROM audio_reviews WHERE base_version_id = ? AND status <> 'ABANDONED'")) {
      return one([...this.reviews.values()].find((row) => row.base_version_id === params[0] && row.status !== "ABANDONED"));
    }
    if (sql.includes("FROM audio_reviews ar LEFT JOIN analysis_versions rv") && sql.includes("WHERE ar.id = ? AND ar.video_id = ?")) {
      const row = this.reviews.get(String(params[0]));
      if (!row || row.video_id !== params[1]) return one(null);
      const version = this.versions.find((item) => item.id === row.review_version_id);
      return one({ ...structuredClone(row), review_version_number: version ? version.version_number : null });
    }
    if (sql.includes("FROM audio_reviews WHERE id = ? AND video_id = ? FOR UPDATE")) {
      const row = this.reviews.get(String(params[0]));
      return one(row && row.video_id === params[1] ? structuredClone(row) : null);
    }
    if (sql.includes("FROM audio_reviews ar LEFT JOIN analysis_versions rv") && sql.includes("WHERE ar.video_id = ?")) {
      const onlyGenerated = sql.includes("AND ar.status = 'GENERATED'");
      const rows = [...this.reviews.values()]
        .filter((row) => row.video_id === params[0] && row.status !== "ABANDONED" && (!onlyGenerated || row.status === "GENERATED"))
        .map((row) => ({
          id: row.id, base_version_id: row.base_version_id, audio_content_type: row.audio_content_type,
          status: row.status, failed_step: row.failed_step, fail_reason: row.fail_reason,
          proposal_change_count: Array.isArray((row.proposal_json as Row | null)?.changes) ? ((row.proposal_json as Row).changes as unknown[]).length : 0,
          selected_change_count: Array.isArray(row.selected_change_ids) ? (row.selected_change_ids as unknown[]).length : 0,
          review_version_id: row.review_version_id,
          review_version_number: this.versions.find((item) => item.id === row.review_version_id)?.version_number ?? null,
        }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT id, deleted_at, deletion_state FROM videos WHERE id = ?")) return one(this.videos.get(String(params[0])));
    if (sql.startsWith("SELECT title FROM videos WHERE id = ?")) return one(this.videos.get(String(params[0])));
    if (sql.includes("FROM collaboration_workspaces WHERE video_id = ? AND workflow_version = ?")) {
      return one(this.workspace && this.workspace.video_id === params[0] ? structuredClone(this.workspace) : null);
    }
    if (sql.startsWith("SELECT payload_json FROM annotation_snapshots WHERE id = ?")) {
      const payload = this.snapshots.get(String(params[0]));
      return one(payload ? { payload_json: structuredClone(payload) } : null);
    }
    if (sql.startsWith("SELECT display_name FROM users WHERE id = ?")) {
      const name = this.users.get(String(params[0]));
      return one(name ? { display_name: name } : null);
    }
    if (sql.startsWith("SELECT COUNT(*) AS count FROM analysis_versions WHERE workspace_id = ? AND version_kind = 'PERSONAL'")) {
      return one({ count: String(this.versions.filter((row) => row.workspace_id === params[0] && row.version_kind === "PERSONAL").length) });
    }
    if (sql.includes("FROM analysis_versions WHERE workspace_id = ? AND version_kind = 'PERSONAL' AND version_number = 1")) {
      return one(this.versions.find((row) => row.workspace_id === params[0] && row.version_kind === "PERSONAL" && row.version_number === 1));
    }
    if (sql.startsWith("SELECT id FROM analysis_versions WHERE base_version_id = ? AND version_kind = 'AUDIO_REVIEW'")) {
      return one(this.versions.find((row) => row.base_version_id === params[0] && row.version_kind === "AUDIO_REVIEW"));
    }
    if (sql.includes("FROM analysis_versions WHERE workspace_id = ? ORDER BY version_number ASC")) {
      const rows = this.versions.filter((row) => row.workspace_id === params[0]).toSorted((a, b) => Number(a.version_number) - Number(b.version_number));
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (sql.includes("FROM analysis_versions WHERE id = ?")) return one(structuredClone(this.versions.find((row) => row.id === params[0])));
    if (sql.startsWith("INSERT INTO analysis_versions")) {
      const review = sql.includes("'AUDIO_REVIEW'");
      const row: Row = review
        ? {
          id: params[0], workspace_id: params[1], video_id: params[2], version_number: params[3], owner_user_id: params[4],
          owner_name_snapshot: params[5], base_version_id: params[6], base_version_number: params[7],
          base_payload_json: JSON.parse(String(params[8])), base_captured_at: params[9], payload_json: JSON.parse(String(params[10])),
          content_hash: params[11], revision: 1, version_kind: "AUDIO_REVIEW", audio_review_id: params[16], base_is_final: false,
          created_at: this.now(), updated_at: this.now(),
        }
        : {
          id: params[0], workspace_id: params[1], video_id: params[2], version_number: 1, owner_user_id: params[3],
          owner_name_snapshot: params[4], base_version_id: null, base_version_number: null, base_payload_json: null,
          base_captured_at: null, payload_json: JSON.parse(String(params[5])), content_hash: params[6], revision: 1,
          version_kind: "PERSONAL", audio_review_id: null, base_is_final: false, created_at: params[11], updated_at: params[12],
        };
      const clash = this.versions.some((item) =>
        item.workspace_id === row.workspace_id && (
          item.version_number === row.version_number ||
          (row.version_kind === "PERSONAL" && item.version_kind === "PERSONAL" && item.owner_user_id === row.owner_user_id) ||
          (row.version_kind === "AUDIO_REVIEW" && item.version_kind === "AUDIO_REVIEW" && item.base_version_id === row.base_version_id)
        ));
      if (clash) return { rows: [], rowCount: 0 };
      this.versions.push(row);
      return one({ id: row.id });
    }
    if (sql.startsWith("INSERT INTO collaboration_revision_events")) {
      const [id, workspaceId, roundId, annotationId, changeSetId, targetKey, label, valueType, before, after, sourceObjectId, reason,
        actorUserId, actorName, versionId] = params;
      const literals = /VALUES \(\?, \?, \?, \?, \?, (\d+), (\d+), .*'(\w+)', '(\w+)', \?/.exec(sql)!;
      this.events.push({
        id, workspace_id: workspaceId, round_id: roundId, annotation_id: annotationId, change_set_id: changeSetId,
        base_revision: Number(literals[1]), applied_revision: Number(literals[2]), source_kind: literals[3], source_object_type: literals[4],
        target_key: targetKey, target_label_snapshot: label, value_type: valueType,
        before_value_json: JSON.parse(String(before)), after_value_json: JSON.parse(String(after)),
        source_object_id: sourceObjectId, reason, actor_user_id: actorUserId, actor_name_snapshot: actorName, version_id: versionId,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO audit_logs")) {
      this.audits.push({ action: params[2], object_type: params[3], object_id: params[4], detail: JSON.parse(String(params[5])), actor_user_id: params[6] });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`FakeDb: unexpected SQL: ${sql}`);
  }

  private updateReviews(sql: string, params: unknown[]) {
    const match = /^UPDATE audio_reviews SET (.+?) WHERE (.+?)(?: RETURNING (.+))?$/.exec(sql);
    if (!match) throw new Error(`FakeDb: cannot parse ${sql}`);
    let cursor = 0;
    const take = () => params[cursor++];
    const assignments = splitTopLevel(match[1], ",").map((assignment) => {
      const [column, expression] = assignment.split(/ = (.+)/);
      if (expression === "?" || expression === "?::jsonb" || expression === "?::timestamptz") {
        const value = take();
        return [column, () => (expression === "?::jsonb" ? JSON.parse(String(value)) : expression === "?::timestamptz" ? new Date(String(value)) : value)] as const;
      }
      if (expression === "now()") return [column, () => this.now()] as const;
      if (expression === "NULL") return [column, () => null] as const;
      if (/^'.*'$/.test(expression)) return [column, () => expression.slice(1, -1)] as const;
      if (/^\d+$/.test(expression)) return [column, () => Number(expression)] as const;
      if (expression === "COALESCE(uploaded_at, now())") return [column, (row: Row) => row.uploaded_at ?? this.now()] as const;
      const lease = /^date_trunc\('milliseconds', now\(\) \+ interval '(\d+) seconds'\)$/.exec(expression);
      if (lease) return [column, () => new Date(this.clock.now + Number(lease[1]) * 1000)] as const;
      throw new Error(`FakeDb: unknown expression ${expression}`);
    });
    const conditions = splitTopLevel(match[2], " AND ").map((condition): ((row: Row) => boolean) => {
      if (condition === "(lease_until IS NULL OR lease_until < now())") {
        return (row) => row.lease_until === null || (row.lease_until as Date).getTime() < this.clock.now;
      }
      let m = /^(\w+) = \?(?:::(\w+))?$/.exec(condition);
      if (m) {
        const value = take();
        const column = m[1];
        return m[2] === "timestamptz" ? (row) => iso(row[column]) === iso(value) : (row) => row[column] === value;
      }
      m = /^(\w+) = '(\w+)'$/.exec(condition);
      if (m) {
        const [, column, literal] = m;
        return (row) => row[column] === literal;
      }
      m = /^(\w+) (NOT IN|IN) \((.+)\)$/.exec(condition);
      if (m) {
        const [, column, operator, list] = m;
        const values = list.split(",").map((item) => item.trim().replace(/^'|'$/g, ""));
        return (row) => values.includes(String(row[column])) === (operator === "IN");
      }
      m = /^(\w+) IS NULL$/.exec(condition);
      if (m) {
        const column = m[1];
        return (row) => row[column] === null || row[column] === undefined;
      }
      throw new Error(`FakeDb: unknown condition ${condition}`);
    });
    const matched = [...this.reviews.values()].filter((row) => conditions.every((check) => check(row)));
    for (const row of matched) {
      const next: Row = {};
      for (const [column, value] of assignments) next[column] = value(row);
      Object.assign(row, next);
    }
    const returning = match[3];
    const rows = returning ? matched.map((row) => (returning.trim() === "id" ? { id: row.id } : structuredClone(row))) : [];
    return { rows, rowCount: matched.length };
  }
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

function versionRow(id: string, number: number, owner: V04Actor, extra: Row = {}): Row {
  return {
    id, workspace_id: "ws-1", video_id: VIDEO, version_number: number, owner_user_id: owner.userId,
    owner_name_snapshot: owner.displayName, base_version_id: null, base_version_number: null, base_payload_json: null,
    base_captured_at: null, payload_json: structuredClone(sample.snapshot), content_hash: "hash", revision: 3,
    taxonomy_version: "t", workflow_version: "w", vocabulary_version: "v", payload_schema_version: "p",
    base_is_final: false, version_kind: "PERSONAL", audio_review_id: null,
    created_at: new Date(START - 86400000), updated_at: new Date(START - 3600000), ...extra,
  };
}

function setup(options: { versions?: Row[] } = {}) {
  const clock: Clock = { now: START };
  const db = new FakeDb(clock);
  db.videos.set(VIDEO, { id: VIDEO, title: "捉迷藏", deleted_at: null, deletion_state: "ACTIVE" });
  db.users.set(AUTHOR.userId, AUTHOR.displayName);
  db.users.set(REVIEWER.userId, REVIEWER.displayName);
  db.workspace = {
    id: "ws-1", video_id: VIDEO, canonical_annotation_id: "annotation-1", active_round_id: "round-1",
    current_working_snapshot_id: "snapshot-1", created_by_user_id: AUTHOR.userId, status: "ACTIVE", updated_at: new Date(START),
  };
  db.snapshots.set("snapshot-1", structuredClone(sample.snapshot));
  db.versions = options.versions ?? [versionRow("v-liu", 1, AUTHOR)];
  return { db, clock, asDb: db as unknown as DbClient };
}

type Scripted = {
  describe?: AsrDescribeOutcome[];
  llm?: Array<LlmOutcome | ((context: Parameters<AudioReviewProviders["llm"]["complete"]>[1]) => LlmOutcome)>;
  llmLatencyMs?: number;
  head?: { size: number } | null | Error;
  submit?: Array<{ ok: true; taskId: string; usedHotwords: boolean; engine: string } | { ok: false; reason: string; transient: boolean; code: string | null }>;
  /** bucket.get 抛错（存储不可用）。 */
  getError?: Error;
};

/** 一次吐出若干块的流，模拟存储读回来的对象。 */
function streamOf(bytes: Uint8Array, chunkSize = 7) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
      controller.close();
    },
  });
}

function deps(clock: Clock, script: Scripted = {}) {
  const calls = {
    submit: [] as Array<{ audioUrl: string; hotwordList: string }>,
    describe: [] as string[],
    llm: 0,
    efforts: [] as string[],
    sleeps: [] as number[],
    put: [] as Array<[string, unknown]>,
    get: [] as Array<[string, unknown]>,
    head: [] as string[],
    objects: [] as string[],
    messages: [] as Array<{ system: string; user: string }>,
    logs: [] as unknown[],
  };
  /** 存储里的对象（文档来源从这里读）；测试可以随时换内容。 */
  const store = new Map<string, Uint8Array>();
  const fakeSuccess = (context: Parameters<AudioReviewProviders["llm"]["complete"]>[1]): LlmOutcome => ({
    ok: true,
    content: JSON.stringify(buildFakeModelOutput(context)),
    finishReason: "stop",
    usage: { total_tokens: 100 },
    model: "test-model",
    durationMs: script.llmLatencyMs ?? 0,
  });
  const describeQueue = [...(script.describe ?? [{ kind: "PENDING", status: 1 }, { kind: "SUCCESS", segments: sample.transcript, durationMs: 684000 }])];
  const llmQueue = [...(script.llm ?? [fakeSuccess])];
  const submitQueue = [...(script.submit ?? [])];
  const value: AudioReviewDeps = {
    providers: {
      kind: "fake",
      asr: {
        engine: "test-engine",
        pollIntervalMs: 4000,
        submit: async (input) => {
          calls.submit.push(input);
          // 默认模拟「大模型额度不足、退到通用引擎」：提交结果里带回实际用上的引擎。
          return submitQueue.shift() ?? { ok: true, taskId: `task-${calls.submit.length}`, usedHotwords: true, engine: "16k_zh" };
        },
        describe: async (taskId) => {
          calls.describe.push(taskId);
          const next = describeQueue.shift();
          if (!next) throw new Error("describe called too often");
          return next;
        },
      },
      llm: {
        model: "test-model",
        complete: async (messages, context, options) => {
          calls.llm += 1;
          calls.messages.push(messages);
          calls.efforts.push(options.reasoningEffort);
          clock.now += script.llmLatencyMs ?? 0;
          const next = llmQueue.shift() ?? fakeSuccess;
          return typeof next === "function" ? next(context) : next;
        },
      },
    },
    bucket: {
      head: async (key) => {
        calls.head.push(key);
        if (script.head instanceof Error) throw script.head;
        return script.head === undefined ? { size: 1234 } : script.head;
      },
      createPresignedPutUrl: async (key, options) => {
        calls.put.push([key, options]);
        return `https://upload.test/${key}`;
      },
      createPresignedGetUrl: async (key, options) => {
        calls.get.push([key, options]);
        return `https://get.test/${key}`;
      },
      get: async (key) => {
        calls.objects.push(key);
        if (script.getError) throw script.getError;
        const bytes = store.get(key);
        return { body: bytes ? streamOf(bytes) : null };
      },
    },
    sleep: async (ms) => {
      calls.sleeps.push(ms);
      clock.now += ms;
    },
    clock: () => clock.now,
    log: (...args) => calls.logs.push(args),
  };
  return { deps: value, calls, store };
}

const createBody = (extra: Record<string, unknown> = {}) => ({ baseVersionId: "v-liu", fileName: "捉迷藏点评-1009.m4a", contentType: "", sizeBytes: 1234, ...extra });

async function created(context = setup(), script: Scripted = {}) {
  const harness = deps(context.clock, script);
  const { row } = await createAudioReview(context.asDb, REVIEWER, { videoId: VIDEO, body: createBody() }, harness.deps);
  return { ...context, ...harness, reviewId: row.id };
}

async function inState(status: string, patch: Row = {}, script: Scripted = {}) {
  const context = await created(setup(), script);
  Object.assign(context.db.reviews.get(context.reviewId)!, { status, ...patch });
  return context;
}

const review = (db: FakeDb, id: string) => db.reviews.get(id)!;
const deadlineFrom = (clock: Clock, ms = 280_000) => clock.now + ms;

async function expectError(promise: Promise<unknown>, status: number, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AudioReviewError, String(error));
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

// ---------------------------------------------------------------------------
// 建任务
// ---------------------------------------------------------------------------

test("create: 老孙 only; bad files are refused before touching the database", async () => {
  const { asDb, clock, db } = setup();
  const { deps: d } = deps(clock);
  await expectError(createAudioReview(asDb, AUTHOR, { videoId: VIDEO, body: createBody() }, d), 403, "FORBIDDEN");
  await expectError(createAudioReview(asDb, REVIEWER, { videoId: VIDEO, body: createBody({ fileName: "notes.pdf", contentType: "application/pdf" }) }, d), 400, "INVALID_AUDIO_FILE");
  await expectError(createAudioReview(asDb, REVIEWER, { videoId: VIDEO, body: createBody({ sizeBytes: 500 * 1024 * 1024 + 1 }) }, d), 400, "INVALID_AUDIO_FILE");
  await expectError(createAudioReview(asDb, REVIEWER, { videoId: VIDEO, body: createBody({ sizeBytes: 0 }) }, d), 400, "INVALID_AUDIO_FILE");
  await expectError(createAudioReview(asDb, REVIEWER, { videoId: VIDEO, body: null }, d), 400, "INVALID_AUDIO_FILE");
  assert.equal(db.log.length, 0);
});

test("create: locks the workspace, snapshots the base at upload time, stores an UPLOADING task and signs a 900 s PUT", async () => {
  const context = await created();
  const row = review(context.db, context.reviewId);
  assert.match(context.reviewId, /^arv_/);
  assert.equal(row.status, "UPLOADING");
  assert.equal(row.audio_object_key, `audio-reviews/${context.reviewId}/original`);
  assert.equal(row.audio_content_type, "audio/mp4");
  assert.equal(row.base_version_id, "v-liu");
  assert.equal(row.base_version_number, 1);
  assert.equal(row.base_owner_name, "刘梦娜");
  assert.equal(row.reviewer_name, "老孙");
  assert.deepEqual(row.base_payload_json, sample.snapshot);
  assert.deepEqual(context.calls.put, [[`audio-reviews/${context.reviewId}/original`, { contentType: "audio/mp4", expiresInSeconds: 900 }]]);
  assert.ok(context.db.sqls.some((sql) => /FROM collaboration_workspaces .* FOR UPDATE/.test(sql)));
  assert.deepEqual(context.db.audits.map((audit) => audit.action), ["V19_AUDIO_REVIEW_CREATED"]);
});

test("create: refuses 老孙's own version, a review version, a missing base, a base with a live review, and an untouched case", async () => {
  const own = setup({ versions: [versionRow("v-sun", 1, REVIEWER)] });
  await expectError(createAudioReview(own.asDb, REVIEWER, { videoId: VIDEO, body: createBody({ baseVersionId: "v-sun" }) }, deps(own.clock).deps), 409, "AUDIO_REVIEW_NOT_ALLOWED");

  const reviewVersion = setup({ versions: [versionRow("v-liu", 1, AUTHOR), versionRow("v-review", 2, REVIEWER, { version_kind: "AUDIO_REVIEW" })] });
  await expectError(createAudioReview(reviewVersion.asDb, REVIEWER, { videoId: VIDEO, body: createBody({ baseVersionId: "v-review" }) }, deps(reviewVersion.clock).deps), 409, "AUDIO_REVIEW_NOT_ALLOWED");

  const missing = setup();
  await assert.rejects(
    createAudioReview(missing.asDb, REVIEWER, { videoId: VIDEO, body: createBody({ baseVersionId: "v-nope" }) }, deps(missing.clock).deps),
    (error: unknown) => error instanceof V04ServiceError && error.code === "VERSION_NOT_FOUND",
  );

  const twice = await created();
  await expectError(createAudioReview(twice.asDb, REVIEWER, { videoId: VIDEO, body: createBody() }, twice.deps), 409, "AUDIO_REVIEW_EXISTS");
  assert.equal(twice.db.sqls.at(-1), "ROLLBACK");

  const untouched = setup();
  untouched.db.workspace = null;
  await expectError(createAudioReview(untouched.asDb, REVIEWER, { videoId: VIDEO, body: createBody() }, deps(untouched.clock).deps), 409, "AUDIO_REVIEW_NOT_ALLOWED");
});

test("create: a null base means the virtual v1, which is materialised in the same transaction", async () => {
  const context = setup({ versions: [] });
  const { deps: d } = deps(context.clock);
  const { row } = await createAudioReview(context.asDb, REVIEWER, { videoId: VIDEO, body: createBody({ baseVersionId: null }) }, d);
  assert.equal(context.db.versions.length, 1);
  const v1 = context.db.versions[0];
  assert.equal(v1.version_number, 1);
  assert.equal(v1.owner_user_id, AUTHOR.userId);
  assert.equal(v1.version_kind, "PERSONAL");
  assert.equal(row.base_version_id, v1.id);
  const sqls = context.db.sqls;
  const begin = sqls.indexOf("BEGIN");
  const materialise = sqls.findIndex((sql) => sql.startsWith("INSERT INTO analysis_versions"));
  const insertReview = sqls.findIndex((sql) => sql.startsWith("INSERT INTO audio_reviews"));
  const commit = sqls.indexOf("COMMIT");
  assert.ok(begin < materialise && materialise < insertReview && insertReview < commit);
});

// ---------------------------------------------------------------------------
// UPLOADED / RETRY / ABANDON
// ---------------------------------------------------------------------------

test("UPLOADED: a missing or short object fails the upload step; a matching one starts transcription", async () => {
  const missing = await created(setup(), { head: null });
  const outcome = await runAudioReviewAction(missing.asDb, REVIEWER, { videoId: VIDEO, reviewId: missing.reviewId, body: { action: "UPLOADED" } }, missing.deps);
  assert.equal(outcome.advance, false);
  assert.equal(outcome.row.status, "FAILED");
  assert.equal(outcome.row.failed_step, "UPLOAD");
  assert.equal(outcome.row.fail_reason, "没有找到上传的文件，请重新上传。");

  const short = await created(setup(), { head: { size: 1000 } });
  const shortOutcome = await runAudioReviewAction(short.asDb, REVIEWER, { videoId: VIDEO, reviewId: short.reviewId, body: { action: "UPLOADED" } }, short.deps);
  assert.match(String(shortOutcome.row.fail_reason), /不完整/);

  const ok = await created();
  const started = await runAudioReviewAction(ok.asDb, REVIEWER, { videoId: VIDEO, reviewId: ok.reviewId, body: { action: "UPLOADED" } }, ok.deps);
  assert.equal(started.advance, true);
  assert.equal(started.row.status, "TRANSCRIBING");
  assert.ok(review(ok.db, ok.reviewId).uploaded_at instanceof Date);
  assert.deepEqual(ok.calls.head, [`audio-reviews/${ok.reviewId}/original`]);
  // 重复上报不重复处理。
  const again = await runAudioReviewAction(ok.asDb, REVIEWER, { videoId: VIDEO, reviewId: ok.reviewId, body: { action: "UPLOADED" } }, ok.deps);
  assert.equal(again.row.status, "TRANSCRIBING");
  assert.equal(ok.calls.head.length, 1);
});

test("UPLOADED: a storage outage is reported without changing the task", async () => {
  const context = await created(setup(), { head: new Error("cos down") });
  await expectError(
    runAudioReviewAction(context.asDb, REVIEWER, { videoId: VIDEO, reviewId: context.reviewId, body: { action: "UPLOADED" } }, context.deps),
    503,
    "STORAGE_UNAVAILABLE",
  );
  assert.equal(review(context.db, context.reviewId).status, "UPLOADING");
});

test("RETRY only from FAILED and back to the failed step; ABANDON from any live state; GENERATED is final", async () => {
  const notFailed = await inState("PENDING_CONFIRM");
  await expectError(
    runAudioReviewAction(notFailed.asDb, REVIEWER, { videoId: VIDEO, reviewId: notFailed.reviewId, body: { action: "RETRY" } }, notFailed.deps),
    409,
    "AUDIO_REVIEW_INVALID_STATE",
  );

  const upload = await inState("FAILED", { failed_step: "UPLOAD", fail_reason: "x" });
  const fromUpload = await runAudioReviewAction(upload.asDb, REVIEWER, { videoId: VIDEO, reviewId: upload.reviewId, body: { action: "RETRY" } }, upload.deps);
  assert.equal(fromUpload.row.status, "TRANSCRIBING");
  assert.equal(fromUpload.advance, true);

  const transcribe = await inState("FAILED", { failed_step: "TRANSCRIBE", fail_reason: "x", asr_task_id: "old-task", transcript_json: null });
  const fromTranscribe = await runAudioReviewAction(transcribe.asDb, REVIEWER, { videoId: VIDEO, reviewId: transcribe.reviewId, body: { action: "RETRY" } }, transcribe.deps);
  assert.equal(fromTranscribe.row.status, "TRANSCRIBING");
  assert.equal(fromTranscribe.row.asr_task_id, null);
  assert.equal(fromTranscribe.row.fail_reason, null);

  const understand = await inState("FAILED", { failed_step: "UNDERSTAND", fail_reason: "x", llm_attempts: 2 });
  const fromUnderstand = await runAudioReviewAction(understand.asDb, REVIEWER, { videoId: VIDEO, reviewId: understand.reviewId, body: { action: "RETRY" } }, understand.deps);
  assert.equal(fromUnderstand.row.status, "UNDERSTANDING");
  assert.equal(fromUnderstand.row.llm_attempts, 0);
  assert.deepEqual(understand.db.audits.map((audit) => audit.action), ["V19_AUDIO_REVIEW_CREATED", "V19_AUDIO_REVIEW_RETRIED"]);

  for (const status of ["UPLOADING", "TRANSCRIBING", "UNDERSTANDING", "PENDING_CONFIRM", "FAILED"]) {
    const live = await inState(status, { lease_until: new Date(START + 100_000) });
    const abandoned = await runAudioReviewAction(live.asDb, REVIEWER, { videoId: VIDEO, reviewId: live.reviewId, body: { action: "ABANDON" } }, live.deps);
    assert.equal(abandoned.row.status, "ABANDONED", status);
    assert.equal(abandoned.row.lease_until, null);
    assert.ok(abandoned.row.abandoned_at instanceof Date);
    // 放弃是幂等的
    const again = await runAudioReviewAction(live.asDb, REVIEWER, { videoId: VIDEO, reviewId: live.reviewId, body: { action: "ABANDON" } }, live.deps);
    assert.equal(again.row.status, "ABANDONED");
  }
  const generated = await inState("GENERATED");
  await expectError(
    runAudioReviewAction(generated.asDb, REVIEWER, { videoId: VIDEO, reviewId: generated.reviewId, body: { action: "ABANDON" } }, generated.deps),
    409,
    "AUDIO_REVIEW_INVALID_STATE",
  );
});

test("after ABANDON the same base can take a new upload (re-upload = abandon + create)", async () => {
  const context = await created();
  await runAudioReviewAction(context.asDb, REVIEWER, { videoId: VIDEO, reviewId: context.reviewId, body: { action: "ABANDON" } }, context.deps);
  const { row } = await createAudioReview(context.asDb, REVIEWER, { videoId: VIDEO, body: createBody() }, context.deps);
  assert.notEqual(row.id, context.reviewId);
  assert.equal(row.status, "UPLOADING");
  assert.equal(review(context.db, context.reviewId).status, "ABANDONED");
});

// ---------------------------------------------------------------------------
// 推进
// ---------------------------------------------------------------------------

test("advance: does nothing without the lease, and nothing for states that need a person", async () => {
  const leased = await inState("TRANSCRIBING", { lease_until: new Date(START + 60_000) });
  assert.deepEqual(await advanceAudioReview(leased.asDb, leased.reviewId, { deadline: deadlineFrom(leased.clock), deps: leased.deps }), { advanced: false, status: null });
  assert.equal(leased.calls.submit.length + leased.calls.describe.length + leased.calls.llm, 0);

  for (const status of ["UPLOADING", "PENDING_CONFIRM", "FAILED", "GENERATED", "ABANDONED"]) {
    const idle = await inState(status);
    assert.equal((await advanceAudioReview(idle.asDb, idle.reviewId, { deadline: deadlineFrom(idle.clock), deps: idle.deps })).advanced, false, status);
  }
});

test("advance: two concurrent runs never both hold the lease", async () => {
  const context = await inState("TRANSCRIBING");
  const [first, second] = await Promise.all([
    advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps }),
    advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps }),
  ]);
  assert.equal([first.advanced, second.advanced].filter(Boolean).length, 1);
  assert.equal(context.calls.submit.length, 1);
});

test("advance: submits, polls every 4 s, stores the transcript and goes straight on to a proposal; the lease is released", async () => {
  const context = await inState("TRANSCRIBING", { uploaded_at: new Date(START) });
  const result = await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
  assert.deepEqual(result, { advanced: true, status: "PENDING_CONFIRM" });
  const row = review(context.db, context.reviewId);
  assert.equal(row.status, "PENDING_CONFIRM");
  assert.equal(row.lease_until, null);
  assert.equal(row.asr_task_id, "task-1");
  // 记的是实际用上的引擎（提供方配置的是 test-engine，提交时退到了 16k_zh）。
  assert.equal(row.asr_engine, "16k_zh");
  assert.equal((row.transcript_json as { engine: string }).engine, "16k_zh");
  assert.equal(row.audio_duration_ms, 684000);
  assert.equal((row.transcript_json as { segments: unknown[] }).segments.length, 15);
  assert.deepEqual(context.calls.sleeps, [4000, 4000]);
  assert.deepEqual(context.calls.describe, ["task-1", "task-1"]);
  assert.deepEqual(context.calls.get, [[`audio-reviews/${context.reviewId}/original`, { expiresInSeconds: 10800 }]]);
  assert.equal(context.calls.submit[0].audioUrl, `https://get.test/audio-reviews/${context.reviewId}/original`);
  assert.match(context.calls.submit[0].hotwordList, /^老孙\|10,刘梦娜\|10,/);
  assert.equal(row.llm_attempts, 1);
  assert.equal(row.llm_model, "test-model");
  assert.equal(row.prompt_version, "2026-10-21.1");
  assert.match(String(row.input_content_hash), /^[0-9a-f]{64}$/);
  assert.ok(row.proposed_at instanceof Date);
  assert.ok((row.proposal_json as { changes: unknown[] }).changes.length > 10);
  assert.equal((row.llm_usage_json as { calls: unknown[] }).calls.length, 1);
  // 每一步写入都带状态条件，租约只按自己的令牌释放。
  assert.ok(context.db.sqls.some((sql) => /SET lease_until = NULL WHERE id = \? AND lease_until = \?::timestamptz/.test(sql)));
  assert.ok(context.db.sqls.some((sql) => /SET status = 'UNDERSTANDING', transcript_json = \?::jsonb.* WHERE id = \? AND status = 'TRANSCRIBING'/.test(sql)));
});

test("advance: when the next poll would not fit before the deadline it stops and leaves the task for the next GET", async () => {
  const context = await inState("TRANSCRIBING", {}, { describe: [{ kind: "PENDING", status: 1 }] });
  const result = await advanceAudioReview(context.asDb, context.reviewId, { deadline: context.clock.now + 6_000, deps: context.deps });
  assert.deepEqual(result, { advanced: true, status: null });
  const row = review(context.db, context.reviewId);
  assert.equal(row.status, "TRANSCRIBING");
  assert.equal(row.asr_task_id, "task-1");
  assert.ok(row.asr_checked_at instanceof Date);
  assert.equal(row.lease_until, null);
  assert.deepEqual(context.calls.describe, ["task-1"]);
});

test("advance: with less than 245 s left the model is not started; the next run with a fresh deadline starts it", async () => {
  const context = await inState("UNDERSTANDING", {
    transcript_json: { segments: sample.transcript, durationMs: 684000, engine: "x" },
  });
  await advanceAudioReview(context.asDb, context.reviewId, { deadline: context.clock.now + 244_000, deps: context.deps });
  assert.equal(context.calls.llm, 0);
  assert.equal(review(context.db, context.reviewId).status, "UNDERSTANDING");
  assert.equal(review(context.db, context.reviewId).llm_attempts, 0);
  assert.equal(review(context.db, context.reviewId).lease_until, null);
  await advanceAudioReview(context.asDb, context.reviewId, { deadline: context.clock.now + 280_000, deps: context.deps });
  assert.equal(context.calls.llm, 1);
  assert.equal(review(context.db, context.reviewId).status, "PENDING_CONFIRM");
});

const understanding = (script: Scripted) => inState("UNDERSTANDING", {
  transcript_json: { segments: sample.transcript, durationMs: 684000, engine: "x" },
}, script);
const llmText = (content: string): LlmOutcome => ({ ok: true, content, finishReason: "stop", usage: { total_tokens: 1 }, model: "m", durationMs: 1 });

test("advance: two failed attempts (invalid JSON) turn into FAILED(UNDERSTAND) with the reason and both usages recorded", async () => {
  const context = await understanding({ llm: [llmText("not json"), llmText("still not json")] });
  await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
  const row = review(context.db, context.reviewId);
  assert.equal(context.calls.llm, 2);
  assert.equal(row.status, "FAILED");
  assert.equal(row.failed_step, "UNDERSTAND");
  assert.equal(row.fail_reason, "模型返回的内容不是合法的 JSON。");
  assert.equal(row.llm_attempts, 2);
  assert.deepEqual((row.llm_usage_json as { calls: Array<{ attempt: number; ok: boolean }> }).calls.map((call) => [call.attempt, call.ok]), [[1, false], [2, false]]);
});

test("advance: a failed first attempt is retried automatically; a proposal without any usable change counts as a failure", async () => {
  const empty = JSON.stringify({ opinions: [{ id: "o1", kind: "GENERAL", summary: "x", segmentIds: [3] }], changes: [{ key: "facts.nope", value: "x", opinionIds: ["o1"] }] });
  const context = await understanding({ llm: [llmText(empty)] });
  await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
  const row = review(context.db, context.reviewId);
  assert.equal(context.calls.llm, 2);
  // 再试换低思考强度换速度（第一次多半是超时或没给出可用结果）。
  assert.deepEqual(context.calls.efforts, ["high", "low"]);
  assert.equal(row.status, "PENDING_CONFIRM");
  assert.equal(row.llm_attempts, 2);
  assert.deepEqual((row.llm_usage_json as { calls: Array<{ reason?: string }> }).calls[0].reason, "模型没有给出任何可用的改动。");
});

test("advance: a slow failed first attempt leaves the retry to the next GET (not enough time left)", async () => {
  const context = await understanding({ llm: [llmText("nope")], llmLatencyMs: 100_000 });
  await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
  assert.equal(context.calls.llm, 1);
  assert.equal(review(context.db, context.reviewId).status, "UNDERSTANDING");
  assert.equal(review(context.db, context.reviewId).llm_attempts, 1);
});

test("advance: errors that a retry cannot fix (balance, key) fail at once", async () => {
  const context = await understanding({ llm: [{ ok: false, reason: "DeepSeek 账户余额不足，请充值后重试。", retryable: false, status: 402, durationMs: 5 }] });
  await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
  const row = review(context.db, context.reviewId);
  assert.equal(context.calls.llm, 1);
  assert.equal(row.status, "FAILED");
  assert.equal(row.fail_reason, "DeepSeek 账户余额不足，请充值后重试。");
});

test("advance: two attempts that started but never finished (function recycled) are not tried a third time", async () => {
  const context = await inState("UNDERSTANDING", {
    transcript_json: { segments: sample.transcript, durationMs: 684000, engine: "x" },
    llm_attempts: 2,
  });
  await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
  assert.equal(context.calls.llm, 0);
  assert.equal(review(context.db, context.reviewId).status, "FAILED");
});

test("advance: a failed ASR task fails the transcribe step; RETRY resubmits and continues from transcription", async () => {
  const context = await inState("TRANSCRIBING", {}, {
    describe: [
      { kind: "FAILED", reason: "腾讯云没能下载录音文件（链接过期或存储权限不够），请重试；仍然失败时请重新上传。" },
      { kind: "SUCCESS", segments: sample.transcript, durationMs: 684000 },
    ],
  });
  await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
  let row = review(context.db, context.reviewId);
  assert.equal(row.status, "FAILED");
  assert.equal(row.failed_step, "TRANSCRIBE");
  assert.match(String(row.fail_reason), /下载录音/);
  assert.equal(context.calls.llm, 0);

  const retried = await runAudioReviewAction(context.asDb, REVIEWER, { videoId: VIDEO, reviewId: context.reviewId, body: { action: "RETRY" } }, context.deps);
  assert.equal(retried.advance, true);
  await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
  row = review(context.db, context.reviewId);
  assert.equal(context.calls.submit.length, 2);
  assert.equal(row.asr_task_id, "task-2");
  assert.equal(row.status, "PENDING_CONFIRM");
});

test("advance: RETRY after an understanding failure calls the model again without re-transcribing", async () => {
  const context = await inState("FAILED", {
    failed_step: "UNDERSTAND",
    fail_reason: "x",
    llm_attempts: 2,
    asr_task_id: "task-old",
    transcript_json: { segments: sample.transcript, durationMs: 684000, engine: "x" },
  });
  await runAudioReviewAction(context.asDb, REVIEWER, { videoId: VIDEO, reviewId: context.reviewId, body: { action: "RETRY" } }, context.deps);
  await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
  assert.equal(context.calls.submit.length + context.calls.describe.length, 0);
  assert.equal(context.calls.llm, 1);
  assert.equal(review(context.db, context.reviewId).status, "PENDING_CONFIRM");
  assert.equal(review(context.db, context.reviewId).llm_attempts, 1);
});

test("advance: transient ASR errors leave the task transcribing; non-transient ones fail it", async () => {
  const transient = await inState("TRANSCRIBING", { asr_task_id: "task-9", asr_submitted_at: new Date(START) }, {
    describe: [{ kind: "ERROR", reason: "腾讯云转写请求超出频率限制，稍后会自动重试。", transient: true, code: "RequestLimitExceeded" }],
  });
  await advanceAudioReview(transient.asDb, transient.reviewId, { deadline: deadlineFrom(transient.clock), deps: transient.deps });
  assert.equal(review(transient.db, transient.reviewId).status, "TRANSCRIBING");
  assert.equal(review(transient.db, transient.reviewId).fail_reason, null);

  const submitFails = await inState("TRANSCRIBING", {}, { submit: [{ ok: false, reason: "腾讯云转写鉴权失败。", transient: false, code: "AuthFailure" }] });
  await advanceAudioReview(submitFails.asDb, submitFails.reviewId, { deadline: deadlineFrom(submitFails.clock), deps: submitFails.deps });
  assert.equal(review(submitFails.db, submitFails.reviewId).status, "FAILED");
  assert.equal(review(submitFails.db, submitFails.reviewId).fail_reason, "腾讯云转写鉴权失败。");
});

test("advance: a task submitted more than two hours ago stops waiting", async () => {
  const context = await inState("TRANSCRIBING", { asr_task_id: "task-9", asr_submitted_at: new Date(START - 2 * 3600_000 - 1) }, {
    describe: [{ kind: "PENDING", status: 0 }],
  });
  await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
  assert.equal(review(context.db, context.reviewId).status, "FAILED");
  assert.match(String(review(context.db, context.reviewId).fail_reason), /2 小时/);
});

test("advance: abandoning mid-run is respected — the background run never writes the task back", async () => {
  const context = await inState("TRANSCRIBING");
  const originalDescribe = context.deps.providers.asr.describe;
  context.deps.providers.asr.describe = async (taskId) => {
    const outcome = await originalDescribe(taskId);
    if (outcome.kind === "SUCCESS") Object.assign(review(context.db, context.reviewId), { status: "ABANDONED" });
    return outcome;
  };
  await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
  const row = review(context.db, context.reviewId);
  assert.equal(row.status, "ABANDONED");
  assert.equal(row.transcript_json, null);
  assert.equal(context.calls.llm, 0);
});

test("advance: an unexpected internal error parks the task in FAILED instead of throwing", async () => {
  const context = await understanding({});
  context.db.fail = (sql) => (sql.startsWith("SELECT title FROM videos") ? new Error("connection reset") : null);
  const result = await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
  assert.deepEqual(result, { advanced: true, status: "FAILED" });
  assert.equal(review(context.db, context.reviewId).failed_step, "UNDERSTAND");
  assert.equal(review(context.db, context.reviewId).fail_reason, "处理时出现内部错误，请重试。");
  assert.equal(review(context.db, context.reviewId).lease_until, null);
});

test("GET schedules a run only while in flight and the lease is free", () => {
  assert.equal(shouldAdvanceAudioReview({ status: "TRANSCRIBING", lease_until: null }, START), true);
  assert.equal(shouldAdvanceAudioReview({ status: "UNDERSTANDING", lease_until: new Date(START - 1) }, START), true);
  assert.equal(shouldAdvanceAudioReview({ status: "UNDERSTANDING", lease_until: new Date(START + 1000) }, START), false);
  for (const status of ["UPLOADING", "PENDING_CONFIRM", "GENERATED", "FAILED", "ABANDONED"] as const) {
    assert.equal(shouldAdvanceAudioReview({ status, lease_until: null }, START), false, status);
  }
});

// ---------------------------------------------------------------------------
// 确认生成
// ---------------------------------------------------------------------------

async function pendingConfirm() {
  const context = await inState("TRANSCRIBING");
  await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
  assert.equal(review(context.db, context.reviewId).status, "PENDING_CONFIRM");
  const proposal = review(context.db, context.reviewId).proposal_json as {
    changes: Array<{ id: string; key: string; targetKey: string; opinionIds: string[] }>;
    opinions: Array<{ id: string; number: number }>;
  };
  return { ...context, proposal };
}

const confirm = (context: Awaited<ReturnType<typeof pendingConfirm>>, selectedChangeIds: unknown, actor = REVIEWER) =>
  runAudioReviewAction(context.asDb, actor, { videoId: VIDEO, reviewId: context.reviewId, body: { action: "CONFIRM", selectedChangeIds } }, context.deps);

test("CONFIRM needs a non-empty selection of proposal change ids and a pending task", async () => {
  const context = await pendingConfirm();
  await expectError(confirm(context, []), 400, "INVALID_SELECTION");
  await expectError(confirm(context, undefined), 400, "INVALID_SELECTION");
  await expectError(confirm(context, ["c1", "c999"]), 400, "INVALID_SELECTION");
  const early = await inState("UNDERSTANDING");
  await expectError(
    runAudioReviewAction(early.asDb, REVIEWER, { videoId: VIDEO, reviewId: early.reviewId, body: { action: "CONFIRM", selectedChangeIds: ["c1"] } }, early.deps),
    409,
    "AUDIO_REVIEW_INVALID_STATE",
  );
  assert.equal(context.db.versions.length, 1);
});

test("CONFIRM writes one AUDIO_REVIEW version, AI_ACCEPTANCE_RESERVED events and an audit in one transaction, without the final version", async () => {
  const context = await pendingConfirm();
  context.db.versions.push(versionRow("v-wang", 2, OTHER));
  const all = context.proposal.changes.map((change) => change.id);
  const skipped = context.proposal.changes.find((change) => change.key === "facts.creativeMotif")!;
  const selected = all.filter((id) => id !== skipped.id);
  const before = context.db.log.length;
  const result = await confirm(context, selected);
  const sqls = context.db.sqls.slice(before);

  const version = context.db.versions.find((row) => row.version_kind === "AUDIO_REVIEW")!;
  assert.equal(result.reviewVersionId, version.id);
  assert.equal(version.version_number, 3);
  assert.equal(version.owner_user_id, REVIEWER.userId);
  assert.equal(version.owner_name_snapshot, "老孙");
  assert.equal(version.base_version_id, "v-liu");
  assert.equal(version.base_version_number, 1);
  assert.deepEqual(version.base_payload_json, sample.snapshot);
  assert.equal(version.base_captured_at, (review(context.db, context.reviewId).created_at as Date).toISOString());
  assert.equal(version.audio_review_id, context.reviewId);
  assert.equal(version.revision, 1);
  const payload = version.payload_json as V04DraftPayloadV1;
  assert.equal(payload.factsAndCoreJudgement.creativeMotif, sample.snapshot.factsAndCoreJudgement.creativeMotif, "the unselected change stays out");
  assert.equal(payload.factsAndCoreJudgement.overallCreativeRating, "A");
  assert.match(payload.script.shotGroups[1].shots[2].visualContent, /警察/);
  assert.equal(payload.script.shotGroups[1].shots[2].startTime, "00:12");

  const targetKeys = new Set(context.proposal.changes.filter((change) => change.id !== skipped.id).map((change) => change.targetKey));
  assert.equal(context.db.events.length, targetKeys.size);
  for (const event of context.db.events) {
    assert.equal(event.source_kind, "AI_ACCEPTANCE_RESERVED");
    assert.equal(event.source_object_type, "AUDIO_REVIEW");
    assert.equal(event.source_object_id, context.reviewId);
    assert.equal(event.version_id, version.id);
    assert.equal(event.round_id, "round-1");
    assert.equal(event.annotation_id, "annotation-1");
    assert.equal(event.change_set_id, `audio-review:${context.reviewId}`);
    assert.equal(event.base_revision, 0);
    assert.equal(event.applied_revision, 1);
    assert.match(String(event.reason), /^老孙点评 意见 \d+(、\d+)*$/);
  }
  const details = context.db.events.find((event) => event.target_key === "path.primaryDetails")!;
  assert.equal(details.value_type, "STRUCTURE");
  assert.equal(details.reason, "老孙点评 意见 1");

  assert.deepEqual(context.db.audits.at(-1)!.action, "V19_AUDIO_REVIEW_GENERATED");
  const row = review(context.db, context.reviewId);
  assert.equal(row.status, "GENERATED");
  assert.equal(row.review_version_id, version.id);
  assert.deepEqual(row.selected_change_ids, selected);
  assert.ok(row.confirmed_at instanceof Date);
  assert.equal(result.row.review_version_number, 3);

  assert.equal(sqls[0], "BEGIN");
  assert.equal(sqls.filter((sql) => sql === "COMMIT").length, 1);
  assert.ok(sqls.some((sql) => /FROM collaboration_workspaces .* FOR UPDATE/.test(sql)));
  assert.ok(sqls.some((sql) => /FROM audio_reviews WHERE id = \? AND video_id = \? FOR UPDATE/.test(sql)));
  assert.ok(!sqls.some((sql) => /final_version|analysis_final/i.test(sql)), "never touches the final version");
});

test("CONFIRM is idempotent: a second call returns the existing version and writes nothing", async () => {
  const context = await pendingConfirm();
  const ids = context.proposal.changes.map((change) => change.id);
  const first = await confirm(context, ids);
  const events = context.db.events.length;
  const versions = context.db.versions.length;
  const second = await confirm(context, ids.slice(0, 1));
  assert.equal(second.reviewVersionId, first.reviewVersionId);
  assert.equal(context.db.events.length, events);
  assert.equal(context.db.versions.length, versions);
  assert.equal(second.row.status, "GENERATED");
});

test("CONFIRM refuses a selection that breaks the option rules and rolls everything back", async () => {
  const context = await pendingConfirm();
  const row = review(context.db, context.reviewId);
  const proposal = structuredClone(row.proposal_json) as { changes: Array<Record<string, unknown>> };
  // 手工塞一处与主导机制相同的辅助机制（正常校验会丢弃它，这里模拟坏数据）。
  proposal.changes.push({
    id: "c-bad", key: "facts.auxiliaryMechanism", targetKey: "facts.auxiliaryMechanism", subKey: null,
    label: "第一模块 · 创意辅助手法及机制", valueType: "MECHANISM", before: null,
    after: { selectedOptionIds: ["FORMAL_PLAY"], customText: "", advancedText: "", vocabularyVersion: "AD_VIDEO_VOCAB_V1" },
    beforeText: "", afterText: "", opinionIds: ["o4"],
  });
  row.proposal_json = proposal;
  await expectError(confirm(context, ["c-bad"]), 422, "CHOICE_RULE_VIOLATION");
  assert.equal(context.db.versions.length, 1);
  assert.equal(context.db.events.length, 0);
  assert.equal(review(context.db, context.reviewId).status, "PENDING_CONFIRM");
});

test("CONFIRM refuses when the base already has a review version", async () => {
  const context = await pendingConfirm();
  context.db.versions.push(versionRow("v-old-review", 5, REVIEWER, { version_kind: "AUDIO_REVIEW", base_version_id: "v-liu" }));
  await expectError(confirm(context, ["c1"]), 409, "AUDIO_REVIEW_EXISTS");
});

// ---------------------------------------------------------------------------
// 权限与可见性
// ---------------------------------------------------------------------------

test("every write is 老孙-only: create, UPLOADED, RETRY, ABANDON, CONFIRM all answer 403 to anyone else", async () => {
  const context = await inState("FAILED", { failed_step: "UNDERSTAND" });
  for (const actor of [AUTHOR, OTHER]) {
    for (const body of [{ action: "UPLOADED" }, { action: "RETRY" }, { action: "ABANDON" }, { action: "CONFIRM", selectedChangeIds: ["c1"] }]) {
      await expectError(runAudioReviewAction(context.asDb, actor, { videoId: VIDEO, reviewId: context.reviewId, body }, context.deps), 403, "FORBIDDEN");
    }
    await expectError(createAudioReview(context.asDb, actor, { videoId: VIDEO, body: createBody() }, context.deps), 403, "FORBIDDEN");
  }
  assert.equal(review(context.db, context.reviewId).status, "FAILED");
});

test("visibility: others get 404 until the review is generated; 老孙 sees every state", async () => {
  for (const status of ["UPLOADING", "TRANSCRIBING", "UNDERSTANDING", "PENDING_CONFIRM", "FAILED", "ABANDONED"]) {
    const context = await inState(status);
    await expectError(loadAudioReviewForViewer(context.asDb, AUTHOR, VIDEO, context.reviewId), 404, "AUDIO_REVIEW_NOT_FOUND");
    assert.equal((await loadAudioReviewForViewer(context.asDb, REVIEWER, VIDEO, context.reviewId)).status, status);
  }
  const generated = await inState("GENERATED");
  assert.equal((await loadAudioReviewForViewer(generated.asDb, OTHER, VIDEO, generated.reviewId)).status, "GENERATED");
  await expectError(loadAudioReviewForViewer(generated.asDb, REVIEWER, "video-other", generated.reviewId), 404, "AUDIO_REVIEW_NOT_FOUND");
});

test("studio summaries: 老孙 sees every live task with change counts, others only generated ones; a missing table degrades quietly", async () => {
  const context = await pendingConfirm();
  const pending = await listAudioReviewSummaries(context.asDb, VIDEO, "老孙");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "PENDING_CONFIRM");
  assert.equal(pending[0].step, 2);
  assert.equal(pending[0].changeCount, context.proposal.changes.length);
  assert.deepEqual(await listAudioReviewSummaries(context.asDb, VIDEO, "刘梦娜"), []);
  assert.ok(context.db.sqls.at(-1)!.includes("AND ar.status = 'GENERATED'"));

  await confirm(context, ["c1", "c2"]);
  const generated = await listAudioReviewSummaries(context.asDb, VIDEO, "刘梦娜");
  assert.equal(generated.length, 1);
  assert.equal(generated[0].changeCount, 2);
  assert.equal(generated[0].reviewVersionNumber, 2);

  const configured = readAudioReviewConfig({}, true);
  assert.deepEqual(
    (await loadAudioReviewStudioState(context.asDb, VIDEO, { displayName: "老孙" }, configured)).audioReviewAvailable,
    true,
  );
  assert.equal((await loadAudioReviewStudioState(context.asDb, VIDEO, { displayName: "刘梦娜" }, configured)).audioReviewAvailable, false);
  const logs: unknown[] = [];
  context.db.fail = () => Object.assign(new Error('relation "audio_reviews" does not exist'), { code: "42P01" });
  assert.deepEqual(
    await loadAudioReviewStudioState(context.asDb, VIDEO, { displayName: "老孙" }, configured, (...args) => logs.push(args)),
    { audioReviews: [], audioReviewAvailable: false },
  );
  assert.equal(logs.length, 0);
  context.db.fail = () => new Error("boom");
  assert.deepEqual(
    await loadAudioReviewStudioState(context.asDb, VIDEO, { displayName: "老孙" }, configured, (...args) => logs.push(args)),
    { audioReviews: [], audioReviewAvailable: false },
  );
  assert.equal(logs.length, 1);
});

test("view: speakers by content, corrected transcript, expanded unaddressed remarks; once generated everyone gets the full proposal", async () => {
  const context = await pendingConfirm();
  const pendingRow = (await loadAudioReviewForViewer(context.asDb, REVIEWER, VIDEO, context.reviewId)) as AudioReviewRow;
  const view = toAudioReviewView(pendingRow, { viewerDisplayName: "老孙" });
  assert.equal(view.status, "PENDING_CONFIRM");
  assert.equal(view.step, 2);
  assert.equal(view.audio.url, `/api/videos/${VIDEO}/audio-reviews/${context.reviewId}/audio`);
  assert.equal(view.audio.sizeBytes, 1234);
  assert.equal(view.audio.durationMs, 684000);
  const segments = view.transcript!.segments;
  assert.deepEqual([...new Set(segments.map((segment) => segment.speaker))], ["老孙", "刘梦娜", "王一凡"]);
  assert.equal(segments[0].isReviewer, true);
  assert.equal(segments[4].isReviewer, false);
  assert.match(segments[10].text, /是对置生义——/);
  assert.deepEqual(segments[10].corrections, [{ from: "对质生意", to: "对置生义" }]);
  const praise = view.proposal!.unaddressed.find((entry) => entry.segmentIds[0] === 2)!;
  assert.equal(praise.startMs, 31000);
  assert.equal(praise.speaker, "老孙");
  assert.match(praise.text, /基本功是到位的/);
  assert.equal(view.proposal!.model, "test-model");
  assert.equal(view.proposal!.promptVersion, "2026-10-21.1");
  assert.equal("dropped" in (view.proposal as object), false);
  // 兜底：未生成的任务即使行被别人拿到，视图里也没有提案和文字稿。
  const leaked = toAudioReviewView(pendingRow, { viewerDisplayName: "刘梦娜" });
  assert.equal(leaked.proposal, null);
  assert.equal(leaked.transcript, null);

  await confirm(context, ["c1", "c2"]);
  const generatedRow = (await loadAudioReviewForViewer(context.asDb, AUTHOR, VIDEO, context.reviewId)) as AudioReviewRow;
  const publicView = toAudioReviewView(generatedRow, { viewerDisplayName: "刘梦娜" });
  assert.equal(publicView.proposal!.changes.length, context.proposal.changes.length);
  assert.ok(publicView.proposal!.unaddressed.length > 0);
  assert.equal(publicView.transcript!.segments.length, 15);
  assert.deepEqual(publicView.selectedChangeIds, ["c1", "c2"]);
  assert.equal(publicView.reviewVersionId, generatedRow.review_version_id);
  assert.equal(publicView.reviewVersionNumber, 2);
  assert.ok(publicView.confirmedAt);
  // opinion.changeIds 与 change.opinionIds 互相一致，opinionIds[0] 是编号最小的主意见。
  for (const change of publicView.proposal!.changes) {
    const numbers = change.opinionIds.map((id) => publicView.proposal!.opinions.find((opinion) => opinion.id === id)!.number);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
    for (const id of change.opinionIds) {
      assert.ok(publicView.proposal!.opinions.find((opinion) => opinion.id === id)!.changeIds.includes(change.id));
    }
  }
  for (const opinion of publicView.proposal!.opinions) {
    for (const id of opinion.changeIds) {
      assert.ok(publicView.proposal!.changes.find((change) => change.id === id)!.opinionIds.includes(opinion.id));
    }
  }
});

// ---------------------------------------------------------------------------
// 替老孙上传（2026-10-19 秦欣欣进上传名单）：谁能上传是名单，录音里点评的人始终是老孙
// ---------------------------------------------------------------------------

const ASSISTANT: V04Actor = { userId: "user-qin", identityKey: "wecom:qin", displayName: "秦欣欣", sessionId: "s4", requestId: "req-4" };

test("access: 上传名单是老孙和秦欣欣；录音里点评的人始终是老孙", () => {
  assert.equal(isAudioReviewUploader("老孙"), true);
  assert.equal(isAudioReviewUploader(" 秦欣欣 "), true);
  assert.equal(isAudioReviewUploader("刘梦娜"), false);
  assert.equal(isAudioReviewUploader(null), false);
  assert.equal(AUDIO_REVIEW_CRITIC_NAME, "老孙");
  assert.equal(isAudioReviewCriticVersion("老孙"), true);
  assert.equal(isAudioReviewCriticVersion("秦欣欣"), false);
});

test("秦欣欣能建任务（包括她自己那一版），老孙本人的版本不行；名单外的人仍然 403；她的入口开着、在途任务看得见", async () => {
  const context = setup({ versions: [versionRow("v-liu", 1, AUTHOR), versionRow("v-qin", 2, ASSISTANT), versionRow("v-sun", 3, REVIEWER)] });
  const harness = deps(context.clock);
  const { row } = await createAudioReview(context.asDb, ASSISTANT, { videoId: VIDEO, body: createBody() }, harness.deps);
  assert.equal(review(context.db, row.id).reviewer_name, "秦欣欣");
  const own = await createAudioReview(context.asDb, ASSISTANT, { videoId: VIDEO, body: createBody({ baseVersionId: "v-qin" }) }, harness.deps);
  assert.equal(own.row.base_version_id, "v-qin");
  await expectError(createAudioReview(context.asDb, ASSISTANT, { videoId: VIDEO, body: createBody({ baseVersionId: "v-sun" }) }, harness.deps), 409, "AUDIO_REVIEW_NOT_ALLOWED");
  await expectError(createAudioReview(context.asDb, OTHER, { videoId: VIDEO, body: createBody({ baseVersionId: "v-liu" }) }, harness.deps), 403, "FORBIDDEN");

  assert.equal((await loadAudioReviewForViewer(context.asDb, ASSISTANT, VIDEO, row.id)).id, row.id);
  assert.equal((await listAudioReviewSummaries(context.asDb, VIDEO, "秦欣欣")).length, 2);
  const configured = readAudioReviewConfig({}, true);
  assert.equal((await loadAudioReviewStudioState(context.asDb, VIDEO, { displayName: "秦欣欣" }, configured)).audioReviewAvailable, true);
});

test("秦欣欣上传的录音：模型和热词里的点评人仍是老孙；视图里点评人是老孙、上传人是秦欣欣；确认后点评版归她，标签写老孙点评", async () => {
  const context = setup();
  const seen: string[] = [];
  const harness = deps(context.clock, {
    llm: [(llmContext) => {
      seen.push(llmContext.reviewerName);
      return { ok: true, content: JSON.stringify(buildFakeModelOutput(llmContext)), finishReason: "stop", usage: { total_tokens: 1 }, model: "m", durationMs: 1 };
    }],
  });
  const { row } = await createAudioReview(context.asDb, ASSISTANT, { videoId: VIDEO, body: createBody() }, harness.deps);
  Object.assign(context.db.reviews.get(row.id)!, { status: "TRANSCRIBING" });
  await advanceAudioReview(context.asDb, row.id, { deadline: deadlineFrom(context.clock), deps: harness.deps });
  assert.equal(review(context.db, row.id).status, "PENDING_CONFIRM");
  assert.deepEqual(seen, ["老孙"]);
  assert.match(harness.calls.submit[0].hotwordList, /老孙\|/);

  const view = toAudioReviewView(review(context.db, row.id) as AudioReviewRow, { viewerDisplayName: "秦欣欣" });
  assert.equal(view.reviewerName, "老孙");
  assert.equal(view.uploaderName, "秦欣欣");
  assert.ok(view.proposal);

  const changeIds = (review(context.db, row.id).proposal_json as { changes: Array<{ id: string }> }).changes.map((change) => change.id);
  const result = await runAudioReviewAction(context.asDb, ASSISTANT, { videoId: VIDEO, reviewId: row.id, body: { action: "CONFIRM", selectedChangeIds: changeIds.slice(0, 1) } }, harness.deps);
  const reviewVersion = context.db.versions.find((version) => version.id === result.reviewVersionId)!;
  assert.equal(reviewVersion.version_kind, "AUDIO_REVIEW");
  assert.equal(reviewVersion.owner_user_id, ASSISTANT.userId);
  assert.equal(reviewVersion.owner_name_snapshot, "秦欣欣");

  const label = { number: 2, baseNumber: 1, ownerName: "秦欣欣", ownerIsUploader: false, kind: "AUDIO_REVIEW" as const };
  assert.equal(formatClientLabel(label), "v2（老孙点评，基于v1）");
  assert.equal(formatServerLabel(label), formatClientLabel(label));
});

// ---------------------------------------------------------------------------
// 文字点评（docs/25 二之二，2026-10-21）：建任务认文档、TRANSCRIBING 读文字不调转写、失败原因、RETRY 重新解析
// ---------------------------------------------------------------------------

const DOCX = AUDIO_REVIEW_DOCX_CONTENT_TYPE;
const utf8 = (text: string) => new TextEncoder().encode(text);
const docBody = (extra: Record<string, unknown> = {}) =>
  createBody({ fileName: "捉迷藏点评.docx", contentType: "application/octet-stream", sizeBytes: 1234, ...extra });

const DOC_PARAGRAPHS = [
  "老孙对《捉迷藏》v1 的点评",
  "母题看浅了。这片子真正好的地方，是那些平时最体面、最正经的大人，突然被允许当一回小孩。",
  "井盖那个镜头，钻出来的是个警察，你写成“一个人”，这个信息很关键，要写出来。",
  "王一凡问：那它主导机制还算形式游戏吗？",
  "形式游戏没错。但辅助不是洞察共鸣，是对置生义——体面和幼稚放在一起，才生出意思来。",
  "评价给高了，我给 A。结尾回头一看街上没人，这个处理太常见了，收得软。",
];

function refusesFile(body: unknown, pattern: RegExp) {
  assert.throws(() => normalizeCreateAudioReviewBody(body), (error: unknown) => {
    assert.ok(error instanceof AudioReviewError, String(error));
    assert.equal(error.status, 400);
    assert.equal(error.code, "INVALID_AUDIO_FILE");
    assert.match(error.message, pattern);
    return true;
  });
}

test("create: documents are recognised by extension and typed by the server, up to 20MB; PDF and .doc get a way out", async () => {
  assert.deepEqual(normalizeCreateAudioReviewBody(docBody()), { baseVersionId: "v-liu", fileName: "捉迷藏点评.docx", contentType: DOCX, sizeBytes: 1234 });
  assert.equal(normalizeCreateAudioReviewBody(docBody({ fileName: "点评.MD", contentType: "" })).contentType, "text/markdown");
  assert.equal(normalizeCreateAudioReviewBody(docBody({ fileName: AUDIO_REVIEW_PASTED_FILE_NAME, contentType: "text/plain;charset=utf-8" })).contentType, "text/plain");
  // 浏览器给的类型不作数：扩展名是文档就按文档。
  assert.equal(normalizeCreateAudioReviewBody(docBody({ fileName: "点评.txt", contentType: "audio/mpeg" })).contentType, "text/plain");
  assert.equal(normalizeCreateAudioReviewBody(docBody({ sizeBytes: 20 * 1024 * 1024 })).sizeBytes, 20 * 1024 * 1024);
  refusesFile(docBody({ sizeBytes: 20 * 1024 * 1024 + 1 }), /^文档不能超过 20MB。$/);
  refusesFile(docBody({ sizeBytes: 0 }), /文档大小无效/);
  for (const fileName of ["点评.pdf", "点评.DOC"]) {
    refusesFile(docBody({ fileName, contentType: "application/pdf" }), /^暂不支持 PDF \/ 老格式 \.doc，请另存为 \.docx 或直接粘贴文字。$/);
  }
  refusesFile(docBody({ fileName: "点评.wps", contentType: "" }), /另存为 \.docx 或直接粘贴文字/);
  refusesFile(docBody({ fileName: "点评.zip", contentType: "application/zip" }), /或文档（\.docx、\.txt、\.md）/);
  refusesFile(docBody({ fileName: "" }), /^缺少文件名。$/);
  // 录音的规则不变。
  assert.equal(normalizeCreateAudioReviewBody(createBody()).contentType, "audio/mp4");
  refusesFile(createBody({ sizeBytes: 500 * 1024 * 1024 + 1 }), /^录音文件不能超过 500MB。$/);

  const context = setup();
  const harness = deps(context.clock);
  const { row } = await createAudioReview(context.asDb, REVIEWER, { videoId: VIDEO, body: docBody() }, harness.deps);
  assert.equal(review(context.db, row.id).audio_content_type, DOCX);
  assert.equal(review(context.db, row.id).audio_object_key, `audio-reviews/${row.id}/original`);
  assert.deepEqual(harness.calls.put, [[`audio-reviews/${row.id}/original`, { contentType: DOCX, expiresInSeconds: 900 }]]);
  assert.equal((context.db.audits[0].detail as { contentType: string }).contentType, DOCX);
  assert.equal(toAudioReviewView(row, { viewerDisplayName: "老孙" }).sourceKind, "DOCUMENT");
  assert.equal((await listAudioReviewSummaries(context.asDb, VIDEO, "老孙"))[0].sourceKind, "DOCUMENT");
});

async function documentReview(bytes: Uint8Array | null, script: Scripted = {}, body = docBody()) {
  const context = setup();
  const harness = deps(context.clock, script);
  const { row } = await createAudioReview(context.asDb, REVIEWER, { videoId: VIDEO, body }, harness.deps);
  if (bytes) harness.store.set(row.audio_object_key, bytes);
  return { ...context, ...harness, reviewId: row.id, objectKey: row.audio_object_key };
}

test("document: UPLOADED → read the file (no ASR) → paragraphs into transcript_json → understood in the same run with the document prompt", async () => {
  const context = await documentReview(buildDocx(DOC_PARAGRAPHS.map(wordParagraph).join("")), {
    // 模型按内容认出第 4 段是王一凡的提问。
    llm: [(llmContext) => {
      const output = buildFakeModelOutput(llmContext);
      return {
        ok: true,
        content: JSON.stringify({ ...output, speakers: { reviewer: "S0", labels: {}, others: [{ segmentId: 4, speaker: "王一凡" }] } }),
        finishReason: "stop", usage: { total_tokens: 1 }, model: "test-model", durationMs: 1,
      };
    }],
  });
  const uploaded = await runAudioReviewAction(context.asDb, REVIEWER, { videoId: VIDEO, reviewId: context.reviewId, body: { action: "UPLOADED" } }, context.deps);
  assert.equal(uploaded.advance, true);
  assert.equal(review(context.db, context.reviewId).status, "TRANSCRIBING");

  const result = await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
  assert.deepEqual(result, { advanced: true, status: "PENDING_CONFIRM" });
  const row = review(context.db, context.reviewId);
  // 不调转写：不提交、不轮询、不签录音下载链接、不等。
  assert.deepEqual(context.calls.submit, []);
  assert.deepEqual(context.calls.describe, []);
  assert.deepEqual(context.calls.get, []);
  assert.deepEqual(context.calls.sleeps, []);
  assert.deepEqual(context.calls.objects, [context.objectKey]);
  const transcript = row.transcript_json as { segments: Array<{ id: number; startMs: number; endMs: number; speakerId: string; text: string }>; durationMs: unknown; engine: string };
  assert.equal(transcript.engine, "DOCUMENT");
  assert.equal(transcript.durationMs, null);
  assert.deepEqual(transcript.segments.map((segment) => segment.text), DOC_PARAGRAPHS);
  assert.ok(transcript.segments.every((segment, index) => segment.id === index + 1 && segment.startMs === 0 && segment.endMs === 0 && segment.speakerId === "S0"));
  assert.equal(row.audio_duration_ms, null);
  assert.equal(row.asr_task_id, null);
  assert.equal(row.lease_until, null);
  assert.equal(row.prompt_version, "2026-10-21.1");
  // 模型拿到的是文字版提示词：每段 { id, 段, text }，没有时间和说话人标签。
  assert.equal(context.calls.messages.length, 1);
  assert.equal(context.calls.messages[0].system, AUDIO_REVIEW_DOCUMENT_SYSTEM_PROMPT);
  const user = JSON.parse(context.calls.messages[0].user) as { 文字稿: unknown[]; 任务: Record<string, string> };
  assert.deepEqual(user.文字稿[3], { id: 4, 段: 4, text: DOC_PARAGRAPHS[3] });
  assert.equal(user.任务.点评人, "老孙");

  // 视图：没有时长；默认都是老孙，只有模型列出的第 4 段是王一凡。
  const view = toAudioReviewView(row as AudioReviewRow, { viewerDisplayName: "老孙" });
  assert.equal(view.sourceKind, "DOCUMENT");
  assert.equal(view.audio.durationMs, null);
  assert.equal(view.audio.fileName, "捉迷藏点评.docx");
  assert.deepEqual(view.transcript!.segments.map((segment) => [segment.id, segment.speaker, segment.isReviewer]), [
    [1, "老孙", true], [2, "老孙", true], [3, "老孙", true], [4, "王一凡", false], [5, "老孙", true], [6, "老孙", true],
  ]);
  assert.ok(view.proposal!.opinions.every((opinion) => opinion.segmentIds.every((id) => id >= 1 && id <= DOC_PARAGRAPHS.length)));

  // 确认生成和录音一样，修订原因写「老孙点评 意见 N」。
  const changeIds = view.proposal!.changes.map((change) => change.id);
  const confirmed = await runAudioReviewAction(context.asDb, REVIEWER, { videoId: VIDEO, reviewId: context.reviewId, body: { action: "CONFIRM", selectedChangeIds: changeIds.slice(0, 2) } }, context.deps);
  assert.equal(review(context.db, context.reviewId).status, "GENERATED");
  assert.equal(context.db.versions.find((version) => version.id === confirmed.reviewVersionId)!.version_kind, "AUDIO_REVIEW");
  assert.ok(context.db.events.every((event) => /^老孙点评 意见 \d+(、\d+)*$/.test(String(event.reason))));
});

test("document: unreadable, empty, over-long or missing files fail the read step with a reason and never reach the model", async () => {
  const cases: Array<{ bytes: Uint8Array | null; reason: string; script?: Scripted; body?: Record<string, unknown> }> = [
    { bytes: buildDocx("<w:p/><w:p><w:r><w:t> </w:t></w:r></w:p>"), reason: AUDIO_REVIEW_DOCUMENT_REASONS.empty },
    { bytes: buildDocx(wordParagraph("字".repeat(100_001))), reason: AUDIO_REVIEW_DOCUMENT_REASONS.tooLong },
    { bytes: utf8("改了扩展名的文本，不是 ZIP"), reason: AUDIO_REVIEW_DOCUMENT_REASONS.brokenDocx },
    { bytes: null, reason: AUDIO_REVIEW_DOCUMENT_REASONS.missing },
    { bytes: buildDocx(wordParagraph("x")), reason: AUDIO_REVIEW_DOCUMENT_REASONS.storage, script: { getError: new Error("COS 503") } },
    { bytes: new Uint8Array([0x41, 0x00, 0x42]), reason: AUDIO_REVIEW_DOCUMENT_REASONS.undecodable, body: { fileName: "点评.txt" } },
  ];
  for (const item of cases) {
    const context = await documentReview(item.bytes, item.script, docBody(item.body));
    Object.assign(context.db.reviews.get(context.reviewId)!, { status: "TRANSCRIBING" });
    const result = await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
    assert.deepEqual(result, { advanced: true, status: null }, item.reason);
    const row = review(context.db, context.reviewId);
    assert.equal(row.status, "FAILED", item.reason);
    assert.equal(row.failed_step, "TRANSCRIBE");
    assert.equal(row.fail_reason, item.reason);
    assert.equal(row.transcript_json, null);
    assert.equal(row.lease_until, null);
    assert.equal(context.calls.llm, 0);
    assert.deepEqual(context.calls.submit, []);
    // 视图的进度停在第 2 步（读取文字）。
    assert.equal(toAudioReviewView(row as AudioReviewRow, { viewerDisplayName: "老孙" }).step, 1);
  }
  assert.equal(AUDIO_REVIEW_DOCUMENT_REASONS.empty, "文档里没有读到文字。");
  assert.match(AUDIO_REVIEW_DOCUMENT_REASONS.tooLong, /^文档超过 10 万字/);
  assert.equal(AUDIO_REVIEW_DOCUMENT_REASONS.brokenDocx, "Word 文件无法打开，请另存为 .docx 后重传。");
});

test("document: RETRY from FAILED(TRANSCRIBE) reads the file again instead of resubmitting to ASR", async () => {
  const context = await documentReview(utf8(" \n\n"), {}, docBody({ fileName: AUDIO_REVIEW_PASTED_FILE_NAME, contentType: "text/plain" }));
  Object.assign(context.db.reviews.get(context.reviewId)!, { status: "TRANSCRIBING" });
  await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
  assert.equal(review(context.db, context.reviewId).fail_reason, AUDIO_REVIEW_DOCUMENT_REASONS.empty);

  context.store.set(context.objectKey, utf8(`\ufeff${DOC_PARAGRAPHS.join("\r\n\r\n")}`));
  const retried = await runAudioReviewAction(context.asDb, REVIEWER, { videoId: VIDEO, reviewId: context.reviewId, body: { action: "RETRY" } }, context.deps);
  assert.equal(retried.advance, true);
  assert.equal(review(context.db, context.reviewId).status, "TRANSCRIBING");
  await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
  const row = review(context.db, context.reviewId);
  assert.equal(row.status, "PENDING_CONFIRM");
  assert.deepEqual(context.calls.objects, [context.objectKey, context.objectKey]);
  assert.deepEqual(context.calls.submit, []);
  assert.deepEqual((row.transcript_json as { segments: Array<{ text: string }> }).segments.map((segment) => segment.text), DOC_PARAGRAPHS);
});

test("recordings are untouched: still transcribed, never read back from storage, and given the recording prompt", async () => {
  const context = await inState("TRANSCRIBING");
  await advanceAudioReview(context.asDb, context.reviewId, { deadline: deadlineFrom(context.clock), deps: context.deps });
  assert.equal(review(context.db, context.reviewId).status, "PENDING_CONFIRM");
  assert.deepEqual(context.calls.objects, []);
  assert.equal(context.calls.submit.length, 1);
  assert.equal(context.calls.messages[0].system, AUDIO_REVIEW_SYSTEM_PROMPT);
  assert.equal(toAudioReviewView(review(context.db, context.reviewId) as AudioReviewRow, { viewerDisplayName: "老孙" }).sourceKind, "AUDIO");
});

test("the original-file link downloads documents as attachments under their own name; recordings stay inline", () => {
  assert.deepEqual(audioReviewOriginalFileOverrides({ audio_content_type: "audio/mp4", audio_file_name: "点评.m4a" }), {});
  assert.deepEqual(audioReviewOriginalFileOverrides({ audio_content_type: "text/plain", audio_file_name: AUDIO_REVIEW_PASTED_FILE_NAME }), {
    responseContentDisposition: `attachment; filename="review.txt"; filename*=UTF-8''${encodeURIComponent(AUDIO_REVIEW_PASTED_FILE_NAME)}`,
  });
  assert.deepEqual(audioReviewOriginalFileOverrides({ audio_content_type: DOCX, audio_file_name: "老孙's 点评(1).docx" }), {
    responseContentDisposition: `attachment; filename="review.docx"; filename*=UTF-8''%E8%80%81%E5%AD%99%27s%20%E7%82%B9%E8%AF%84%281%29.docx`,
  });
});
