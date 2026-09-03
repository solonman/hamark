// 报告标注的版本链：每人一版、基版快照、默认最新版、乐观锁（revision）。
// 见 docs/19_报告逆向工程_实施规格_V0.1.md 三、3.1 / 3.3，五、`/annotation*` 三个接口。
//
// 报告是独立域，不挂视频侧的 collaboration_workspaces / 词表版本契约——那套是为镜头
// 字段服务的公共工作区 + 租约模型，报告没有租约、没有时间线，用不上。这里只复用
// V1.9 版本链已经验证过的三条规则（每人一版由 UNIQUE 兜底、新建版本固化基版快照、
// 默认展示最近更新的版本），直接从 lib/v19-version-chain.ts import 对应的纯函数，
// 不重新发明；表结构则是 db/report-schema.ts 里独立的 report_versions，不共用
// analysis_versions。
//
// payload 在这里是整份 ReportAnnotation（第一部分/第二部分/模块/单元/页），不是像
// V0.4 那样的字段级变更集：PUT 每次提交的都是客户端当前持有的完整标注快照，服务端
// 只做「乐观锁校验 + 结构校验 + 覆盖写」，没有变更集回放、没有 last-write-wins 的
// 字段级合并——一个人一个版本，同一版本内没有并发编辑者，整份覆盖足够安全。

import { createHash, randomUUID } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import {
  nextV19VersionNumber,
  pickV19ActorVersion,
  resolveV19DefaultVersion,
} from "@/lib/v19-version-chain";
import {
  emptyReportAnnotation,
  validateReportAnnotation,
  type ReportAnnotation,
} from "@/lib/report-structure";
// 集成版：见 lib/report-final-version.ts 顶部注释——这里与它互相 import，
// 引用只发生在函数体内部，同视频侧 lib/final-version.ts ↔ lib/v19-version-chain.ts
// 的双向引用一样安全。
import {
  intakeReportVersionIntoFinal,
  loadReportFinalTrace,
  loadReportFinalVersion,
  type LoadedReportFinalVersion,
  type ReportFinalIntakeResult,
  type ReportFinalSummary,
  type ReportFinalTraceIntake,
} from "@/lib/report-final-version";

export const REPORT_ANNOTATION_PAYLOAD_SCHEMA_VERSION = "report-annotation/1";

// ---------------------------------------------------------------------------
// Pure helpers re-exported under report-domain names — same tested logic as
// the V1.9 workspace version chain (每人一版 / 默认最新版), just named for
// this call site so consumers of this module never need to know it is a
// video-side import under the hood.
// ---------------------------------------------------------------------------

export const nextReportVersionNumber = nextV19VersionNumber;
export const resolveReportDefaultVersion = resolveV19DefaultVersion;
export const pickReportActorVersion = pickV19ActorVersion;

/** Stable key order (objects sorted, arrays left as-is) so hashing ignores insertion order. */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

/**
 * Canonical serialization used both to hash a payload and, indirectly, to
 * compare two payloads for equality. Takes `unknown` rather than
 * `ReportAnnotation` on purpose: hashing is a structural operation over
 * whatever JSON-serializable value it is handed (a full annotation, but
 * also useful for tests and for the empty/virtual payload), and tying it to
 * the annotation type would only add friction for no safety benefit.
 */
export function canonicalReportPayload(payload: unknown): string {
  return JSON.stringify(stableValue(payload));
}

export function hashReportPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalReportPayload(payload), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ReportVersionErrorCode =
  | "REPORT_NOT_FOUND"
  | "REPORT_NOT_READY"
  | "VERSION_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "VALIDATION_FAILED"
  | "ALREADY_HAS_VERSION"
  | "INVALID_INPUT"
  // 集成版专属：只有老孙能直接编辑集成版、能定稿/取消定稿/采纳（见
  // lib/report-final-version.ts spec 3.5/3.6）。
  | "FORBIDDEN";

const STATUS_BY_CODE: Record<ReportVersionErrorCode, number> = {
  REPORT_NOT_FOUND: 404,
  REPORT_NOT_READY: 409,
  VERSION_NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  VALIDATION_FAILED: 422,
  ALREADY_HAS_VERSION: 409,
  INVALID_INPUT: 400,
  FORBIDDEN: 403,
};

export class ReportVersionError extends Error {
  readonly status: number;

  constructor(
    readonly code: ReportVersionErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ReportVersionError";
    this.status = STATUS_BY_CODE[code];
  }
}

/** Route-layer convenience: turn a thrown error into the JSON response to send. */
export function reportVersionErrorResponse(error: unknown): Response {
  if (error instanceof ReportVersionError) {
    return Response.json(
      {
        error: error.message,
        code: error.code,
        ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
      },
      { status: error.status },
    );
  }
  console.error("报告版本链操作失败", error);
  return Response.json({ error: "操作未完成，请稍后重试。" }, { status: 500 });
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReportVersionActor = {
  userId: string;
  displayName: string;
  /** Optional — only used for audit-log attribution on 集成版 writes (spec 3.5/3.6). */
  email?: string | null;
};

export type ReportVersionRecord = {
  id: string | null;
  number: number;
  ownerUserId: string;
  ownerName: string;
  baseNumber: number | null;
  createdAt: string;
  updatedAt: string;
  isMine: boolean;
  isVirtual: boolean;
  /** true when this version was manually created from 集成版's payload rather than another editor's (spec 五、13). */
  baseIsFinal: boolean;
};

export type ReportCurrentVersion = ReportVersionRecord & {
  payload: ReportAnnotation;
  basePayload: ReportAnnotation | null;
  revision: number;
  contentHash: string;
  /** true when `current` is 集成版 itself rather than a per-editor version (spec 四、4.1). */
  isFinal: boolean;
};

export type ReportVersionChain = {
  versions: ReportVersionRecord[];
  current: ReportCurrentVersion;
  latestId: string | null;
  mineId: string | null;
  /** null only when the report has no real version yet at all (spec 二、11). */
  final: ReportFinalSummary | null;
  /** Only populated on request (`?version=` unset or `=final`) — spec 四、4.1. */
  finalTrace?: { originPayload: ReportAnnotation; intakes: ReportFinalTraceIntake[] };
};

export type ReportSaveInput = {
  /** The id of the actor's own version, if they already know it; null otherwise. */
  versionId: string | null;
  /** Which version to base a brand-new version on, when the actor has none yet. */
  baseVersionId: string | null;
  revision: number;
  payload: unknown;
  now?: Date;
};

export type ReportSaveResult = {
  version: ReportCurrentVersion;
  revision: number;
  changed: boolean;
  finalIntake: ReportFinalIntakeResult;
};

export type ReportCreateFromInput = {
  fromVersionId: string;
  now?: Date;
};

// ---------------------------------------------------------------------------
// Row shapes and small DB helpers
// ---------------------------------------------------------------------------

type ReportRow = QueryResultRow & {
  id: string;
  status: string;
  deleted_at: string | null;
};

type ReportVersionRow = QueryResultRow & {
  id: string;
  report_id: string;
  version_number: number;
  owner_user_id: string;
  owner_name_snapshot: string;
  base_version_id: string | null;
  base_version_number: number | null;
  base_payload_json: ReportAnnotation | string | null;
  base_captured_at: string | null;
  payload_json: ReportAnnotation | string;
  content_hash: string;
  revision: number;
  payload_schema_version: string;
  base_is_final: boolean;
  created_at: string;
  updated_at: string;
};

const VERSION_COLUMNS = `id, report_id, version_number, owner_user_id, owner_name_snapshot,
  base_version_id, base_version_number, base_payload_json, base_captured_at,
  payload_json, content_hash, revision, payload_schema_version, base_is_final, created_at, updated_at`;

const genId = (prefix: string) => `${prefix}_${randomUUID()}`;
const iso = (value: Date) => value.toISOString();

function parseJsonPayload(value: ReportAnnotation | string): ReportAnnotation {
  return typeof value === "string" ? (JSON.parse(value) as ReportAnnotation) : value;
}

/** Loads the report row and rejects anything that cannot be annotated right now. */
export async function requireReadyReport(db: DbClient, reportId: string, lock = false): Promise<ReportRow> {
  const row = await db
    .prepare(`SELECT id, status, deleted_at FROM reports WHERE id = ? ${lock ? "FOR UPDATE" : ""}`)
    .bind(reportId)
    .first<ReportRow>();
  if (!row || row.deleted_at) {
    throw new ReportVersionError("REPORT_NOT_FOUND", "报告不存在。");
  }
  if (row.status !== "READY") {
    throw new ReportVersionError("REPORT_NOT_READY", "报告尚未生成页图，暂不能标注。");
  }
  return row;
}

export async function loadPageNumbers(db: DbClient, reportId: string): Promise<number[]> {
  const { results } = await db
    .prepare(`SELECT page_no FROM report_pages WHERE report_id = ? ORDER BY page_no ASC`)
    .bind(reportId)
    .all<{ page_no: number } & QueryResultRow>();
  return results.map((row) => Number(row.page_no));
}

async function listVersionRows(db: DbClient, reportId: string) {
  return (
    await db
      .prepare(`SELECT ${VERSION_COLUMNS} FROM report_versions WHERE report_id = ? ORDER BY version_number ASC`)
      .bind(reportId)
      .all<ReportVersionRow>()
  ).results;
}

async function findVersionById(db: DbClient, id: string) {
  return db
    .prepare(`SELECT ${VERSION_COLUMNS} FROM report_versions WHERE id = ?`)
    .bind(id)
    .first<ReportVersionRow>();
}

async function findVersionByOwner(db: DbClient, reportId: string, ownerUserId: string) {
  return db
    .prepare(`SELECT ${VERSION_COLUMNS} FROM report_versions WHERE report_id = ? AND owner_user_id = ?`)
    .bind(reportId, ownerUserId)
    .first<ReportVersionRow>();
}

function toSummary(row: ReportVersionRow, actorUserId: string): ReportVersionRecord {
  return {
    id: row.id,
    number: Number(row.version_number),
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name_snapshot,
    baseNumber:
      row.base_version_number === null || row.base_version_number === undefined
        ? null
        : Number(row.base_version_number),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isMine: row.owner_user_id === actorUserId,
    isVirtual: false,
    baseIsFinal: Boolean(row.base_is_final),
  };
}

function toCurrentVersion(row: ReportVersionRow, actorUserId: string): ReportCurrentVersion {
  return {
    ...toSummary(row, actorUserId),
    payload: parseJsonPayload(row.payload_json),
    basePayload: row.base_payload_json == null ? null : parseJsonPayload(row.base_payload_json),
    revision: Number(row.revision),
    contentHash: row.content_hash,
    isFinal: false,
  };
}

/** `current` when the viewer is looking at 集成版 instead of a per-editor version (spec 4.1). */
function finalToCurrentVersion(final: LoadedReportFinalVersion): ReportCurrentVersion {
  return {
    id: final.id,
    number: 0,
    ownerUserId: "",
    ownerName: "集成版",
    baseNumber: null,
    createdAt: final.createdAt,
    updatedAt: final.updatedAt,
    isMine: false,
    isVirtual: final.isVirtual,
    baseIsFinal: false,
    isFinal: true,
    payload: final.payload,
    basePayload: null,
    revision: final.revision,
    contentHash: final.contentHash,
  };
}

/**
 * The not-yet-created v1 that a viewer sees before anyone has saved anything
 * for this report. Reports have no workspace-creator concept to attribute it
 * to (unlike V1.9's video workspace, `reports` only stores a free-text
 * uploader name/email, not a `created_by_user_id`), so the virtual version is
 * always attributed to whoever is looking at it right now — it becomes real
 * and theirs the moment they save.
 */
export function virtualReportVersion(
  ownerUserId: string,
  ownerName: string,
  actorUserId: string,
  updatedAt: string,
): ReportVersionRecord {
  return {
    id: null,
    number: 1,
    ownerUserId,
    ownerName,
    baseNumber: null,
    createdAt: updatedAt,
    updatedAt,
    isMine: ownerUserId === actorUserId,
    isVirtual: true,
    baseIsFinal: false,
  };
}

// ---------------------------------------------------------------------------
// Read path — never writes.
// ---------------------------------------------------------------------------

export async function loadReportVersionChain(
  db: DbClient,
  reportId: string,
  actor: ReportVersionActor,
  options: { versionId?: string; includeFinalTrace?: boolean } = {},
): Promise<ReportVersionChain> {
  await requireReadyReport(db, reportId);
  const rows = await listVersionRows(db, reportId);

  if (rows.length === 0) {
    // spec 二、11: 集成版只在报告有至少一个真实版本时才有意义——一份还没被
    // 任何人保存过的报告，final 保持 null，行为完全同改动前。
    const pageNumbers = await loadPageNumbers(db, reportId);
    const payload = emptyReportAnnotation(pageNumbers);
    const nowIso = new Date().toISOString();
    const virtual = virtualReportVersion(actor.userId, actor.displayName, actor.userId, nowIso);
    return {
      versions: [virtual],
      current: { ...virtual, payload, basePayload: null, revision: 1, contentHash: hashReportPayload(payload), isFinal: false },
      latestId: null,
      mineId: null,
      final: null,
    };
  }

  const summaries = rows.map((row) => toSummary(row, actor.userId));
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (options.versionId && options.versionId !== "final" && !byId.has(options.versionId)) {
    throw new ReportVersionError("VERSION_NOT_FOUND", "指定的版本不存在。");
  }
  const defaultSummary = resolveReportDefaultVersion(summaries);
  const mineSummary = pickReportActorVersion(summaries, actor.userId);
  const mineId = mineSummary ? (mineSummary.id as string) : null;

  // spec 二、11: 报告已有真实版本时，集成版有意义（含虚拟），未显式指定某个
  // 具体真实版本时默认展示它，而不是"最近更新的那一版"（改动前的默认规则）。
  const finalLoaded = await loadReportFinalVersion(db, reportId);
  const final: ReportFinalSummary = {
    id: finalLoaded.id,
    status: finalLoaded.status,
    doneAt: finalLoaded.doneAt,
    doneByName: finalLoaded.doneByName,
    updatedAt: finalLoaded.updatedAt,
    pendingCount: finalLoaded.pendingCount,
    isVirtual: finalLoaded.isVirtual,
  };

  const requestedRow = options.versionId && options.versionId !== "final" ? byId.get(options.versionId) : undefined;
  const current = requestedRow ? toCurrentVersion(requestedRow, actor.userId) : finalToCurrentVersion(finalLoaded);

  const finalTrace = options.includeFinalTrace ? await loadReportFinalTrace(db, reportId) : undefined;

  return {
    versions: summaries,
    current,
    latestId: defaultSummary.id,
    mineId,
    final,
    ...(finalTrace ? { finalTrace } : {}),
  };
}

// ---------------------------------------------------------------------------
// Write path.
// ---------------------------------------------------------------------------

/** Saves the actor's own version — spec 五, `PUT /api/reports/[id]/annotation`. */
export async function saveReportVersion(
  db: DbClient,
  reportId: string,
  actor: ReportVersionActor,
  input: ReportSaveInput,
): Promise<ReportSaveResult> {
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    throw new ReportVersionError("INVALID_INPUT", "保存请求缺少有效的 revision。");
  }
  const now = input.now ?? new Date();

  return db.withTransaction(async (tx) => {
    await requireReadyReport(tx, reportId, true);
    const pageNumbers = await loadPageNumbers(tx, reportId);
    const mine = await findVersionByOwner(tx, reportId, actor.userId);

    if (mine) {
      if (input.versionId && input.versionId !== mine.id) {
        throw new ReportVersionError(
          "VERSION_NOT_FOUND",
          "要保存的版本与你拥有的版本不一致，请刷新后重试。",
        );
      }
      if (Number(mine.revision) !== input.revision) {
        throw new ReportVersionError("REVISION_CONFLICT", "这一版已被更新，请刷新后再保存。", {
          serverRevision: Number(mine.revision),
        });
      }
      const validated = validateReportAnnotation(input.payload, pageNumbers);
      if (!validated.ok) {
        throw new ReportVersionError("VALIDATION_FAILED", "标注内容不符合规则，未保存。", {
          errors: validated.errors,
        });
      }
      const nextHash = hashReportPayload(validated.value);
      // 汇入的 before 是这一版*自己*上一次保存的内容（不是 origin，不是
      // base）——天然精确，不受 3.3 版级回填粒度局限影响（spec 3.4）。
      const beforePayload = parseJsonPayload(mine.payload_json);
      if (nextHash === mine.content_hash) {
        const finalIntake = await intakeReportVersionIntoFinal(tx, reportId, {
          before: beforePayload,
          after: beforePayload,
          sourceVersionId: mine.id,
          sourceVersionNumber: Number(mine.version_number),
          actorUserId: actor.userId,
          actorName: actor.displayName,
          now,
        });
        return {
          version: toCurrentVersion(mine, actor.userId),
          revision: Number(mine.revision),
          changed: false,
          finalIntake,
        };
      }
      const nextRevision = Number(mine.revision) + 1;
      const savedAt = iso(now);
      await tx
        .prepare(
          `UPDATE report_versions
          SET payload_json = ?::jsonb, content_hash = ?, revision = ?, updated_at = ?::timestamptz
          WHERE id = ?`,
        )
        .bind(JSON.stringify(validated.value), nextHash, nextRevision, savedAt, mine.id)
        .run();
      const updated: ReportVersionRow = {
        ...mine,
        payload_json: validated.value,
        content_hash: nextHash,
        revision: nextRevision,
        updated_at: savedAt,
      };
      const finalIntake = await intakeReportVersionIntoFinal(tx, reportId, {
        before: beforePayload,
        after: validated.value,
        sourceVersionId: mine.id,
        sourceVersionNumber: Number(mine.version_number),
        actorUserId: actor.userId,
        actorName: actor.displayName,
        now,
      });
      return {
        version: toCurrentVersion(updated, actor.userId),
        revision: nextRevision,
        changed: true,
        finalIntake,
      };
    }

    // No version of my own yet: create it based on baseVersionId, or the
    // current default version when the caller does not name one — spec
    // 五「无自己版本时按"基于当前看的版本"创建」.
    if (input.versionId) {
      throw new ReportVersionError("VERSION_NOT_FOUND", "指定的版本不存在或不属于你。");
    }
    const allRows = await listVersionRows(tx, reportId);
    let baseRow: ReportVersionRow | null = null;
    if (input.baseVersionId) {
      baseRow = allRows.find((row) => row.id === input.baseVersionId) ?? null;
      if (!baseRow) throw new ReportVersionError("VERSION_NOT_FOUND", "指定的基版不存在。");
    } else if (allRows.length > 0) {
      const summaries = allRows.map((row) => toSummary(row, actor.userId));
      const defaultSummary = resolveReportDefaultVersion(summaries);
      baseRow = allRows.find((row) => row.id === defaultSummary.id) ?? null;
    }
    // baseRow stays null exactly when this call creates the report's very first version.

    const validated = validateReportAnnotation(input.payload, pageNumbers);
    if (!validated.ok) {
      throw new ReportVersionError("VALIDATION_FAILED", "标注内容不符合规则，未保存。", {
        errors: validated.errors,
      });
    }

    const versionNumber = nextReportVersionNumber(allRows.map((row) => Number(row.version_number)));
    const newId = genId("report_version");
    const savedAt = iso(now);
    const contentHash = hashReportPayload(validated.value);
    const basePayload = baseRow ? parseJsonPayload(baseRow.payload_json) : null;

    // ON CONFLICT DO NOTHING rather than catching the unique violation: inside
    // a Postgres transaction a raised constraint error aborts the whole
    // transaction, so re-reading afterwards would fail too. A no-op here means
    // a concurrent request from this same actor won the owner slot (or the
    // version number) first — the re-read below picks up whichever won, so a
    // race never surfaces to the person who just typed.
    await tx
      .prepare(
        `INSERT INTO report_versions (
          id, report_id, version_number, owner_user_id, owner_name_snapshot,
          base_version_id, base_version_number, base_payload_json, base_captured_at,
          payload_json, content_hash, revision, payload_schema_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::timestamptz, ?::jsonb, ?, 1, ?, ?::timestamptz, ?::timestamptz)
        ON CONFLICT DO NOTHING`,
      )
      .bind(
        newId,
        reportId,
        versionNumber,
        actor.userId,
        actor.displayName,
        baseRow?.id ?? null,
        baseRow ? Number(baseRow.version_number) : null,
        basePayload ? JSON.stringify(basePayload) : null,
        baseRow ? savedAt : null,
        JSON.stringify(validated.value),
        contentHash,
        REPORT_ANNOTATION_PAYLOAD_SCHEMA_VERSION,
        savedAt,
        savedAt,
      )
      .run();

    const created = await findVersionByOwner(tx, reportId, actor.userId);
    if (!created) {
      throw new ReportVersionError("REVISION_CONFLICT", "保存时发生并发冲突，请重试。");
    }
    // 首次创建版本：before = 基版内容（没有基版时是空白初始标注），这个定义
    // 与这一版自己的 base_payload_json 完全一致——3.3 回填时直接复用
    // base_payload_json 做 before 正是因为这里就是这样定义的（spec 3.4）。
    const finalIntake = await intakeReportVersionIntoFinal(tx, reportId, {
      before: basePayload ?? emptyReportAnnotation(pageNumbers),
      after: validated.value,
      sourceVersionId: created.id,
      sourceVersionNumber: Number(created.version_number),
      actorUserId: actor.userId,
      actorName: actor.displayName,
      now,
    });
    return {
      version: toCurrentVersion(created, actor.userId),
      revision: Number(created.revision),
      changed: true,
      finalIntake,
    };
  });
}

/** Manual "create my version from this specific history version" — POST .../versions. */
export async function createReportVersionFrom(
  db: DbClient,
  reportId: string,
  actor: ReportVersionActor,
  input: ReportCreateFromInput,
): Promise<ReportSaveResult> {
  if (!input.fromVersionId?.trim()) {
    throw new ReportVersionError("INVALID_INPUT", "创建版本需要指定来源版本。");
  }
  const now = input.now ?? new Date();
  const alreadyOwnsVersion = () =>
    new ReportVersionError(
      "ALREADY_HAS_VERSION",
      "你已经拥有本报告的版本，无法再手动创建新版本；请直接在自己的版本上编辑。",
    );

  return db.withTransaction(async (tx) => {
    await requireReadyReport(tx, reportId, true);

    const mine = await findVersionByOwner(tx, reportId, actor.userId);
    if (mine) throw alreadyOwnsVersion();

    const allRows = await listVersionRows(tx, reportId);
    const versionNumber = nextReportVersionNumber(allRows.map((row) => Number(row.version_number)));
    const newId = genId("report_version");
    const savedAt = iso(now);

    // "基于集成版创建我的版本"（spec 五、13）：集成版的 id 不在 report_versions
    // 里，base_version_id/number 记 null，靠 base_is_final 标记来源——同视频侧
    // insertVersionFromFinal 的处理方式。报告没有单独的下拉选基版 UI，这条路径
    // 只由 POST .../versions 以 fromVersionId === "final" 触发（见五、13）。
    let basePayload: ReportAnnotation;
    let baseContentHash: string;
    let baseVersionId: string | null;
    let baseVersionNumber: number | null;
    let baseIsFinal: boolean;
    if (input.fromVersionId === "final") {
      const finalLoaded = await loadReportFinalVersion(tx, reportId);
      basePayload = finalLoaded.payload;
      baseContentHash = finalLoaded.contentHash;
      baseVersionId = null;
      baseVersionNumber = null;
      baseIsFinal = true;
    } else {
      const baseRow = allRows.find((row) => row.id === input.fromVersionId);
      if (!baseRow) {
        throw new ReportVersionError("VERSION_NOT_FOUND", "指定的来源版本不存在。");
      }
      basePayload = parseJsonPayload(baseRow.payload_json);
      baseContentHash = baseRow.content_hash;
      baseVersionId = baseRow.id;
      baseVersionNumber = Number(baseRow.version_number);
      baseIsFinal = false;
    }

    const inserted = await tx
      .prepare(
        `INSERT INTO report_versions (
          id, report_id, version_number, owner_user_id, owner_name_snapshot,
          base_version_id, base_version_number, base_payload_json, base_captured_at,
          payload_json, content_hash, revision, payload_schema_version, base_is_final, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::timestamptz, ?::jsonb, ?, 1, ?, ?, ?::timestamptz, ?::timestamptz)
        ON CONFLICT DO NOTHING
        RETURNING id`,
      )
      .bind(
        newId,
        reportId,
        versionNumber,
        actor.userId,
        actor.displayName,
        baseVersionId,
        baseVersionNumber,
        JSON.stringify(basePayload),
        savedAt,
        JSON.stringify(basePayload),
        baseContentHash,
        REPORT_ANNOTATION_PAYLOAD_SCHEMA_VERSION,
        baseIsFinal,
        savedAt,
        savedAt,
      )
      .first<{ id: string } & QueryResultRow>();

    if (!inserted) {
      // A no-op insert here can only mean a concurrent call from this same
      // actor already created their version first.
      throw alreadyOwnsVersion();
    }
    const created = await findVersionById(tx, inserted.id);
    if (!created) throw new ReportVersionError("VERSION_NOT_FOUND", "新建版本写入后读取失败。");
    // 这一版此刻的内容与基版（普通版本或集成版）完全相同，diff 出的记录数
    // 天然是 0——调这一下只是为了在集成版还从没被物化过时把它物化好，并让
    // 响应里的 pending 计数准确，不会产生任何新的汇入记录。
    const finalIntake = await intakeReportVersionIntoFinal(tx, reportId, {
      before: basePayload,
      after: basePayload,
      sourceVersionId: created.id,
      sourceVersionNumber: Number(created.version_number),
      actorUserId: actor.userId,
      actorName: actor.displayName,
      now,
    });
    return {
      version: toCurrentVersion(created, actor.userId),
      revision: 1,
      changed: true,
      finalIntake,
    };
  });
}
