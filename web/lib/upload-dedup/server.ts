// 上传查重的服务端：比对与登记（docs/28 四、五）。
//
// 指纹表只存「哪张表的哪一行、什么指纹」；那一行还在不在库里、叫什么、谁传的，每次查的时候
// 回各自的业务表按各库自己的软删除／状态口径现取（规格二 #3），不在指纹表里冗余一份。

import type { DbClient } from "@/db";
import { newId } from "@/lib/current-user";
import type { CurrentUser } from "@/lib/auth/types";
import {
  compareMatches,
  deserializeFrameHashes,
  imageSimilarity,
  MAX_MATCHES_PER_FILE,
  packHashes,
  serializeFrameHashes,
  SOURCE_LIBRARY,
  UPLOAD_FINGERPRINT_ALGORITHM,
  UPLOAD_FINGERPRINT_SOURCES,
  videoSimilarity,
  type UploadCheckFile,
  type UploadCheckInput,
  type UploadDedupLibrary,
  type UploadDuplicateMatch,
  type UploadDuplicateReason,
  type UploadFingerprintSource,
  type UploadRecordInput,
} from "./model";

type DescribedRow = {
  target_id: string;
  owner_id: string;
  title: string;
  detail: string | null;
  href: string | null;
  uploader_name: string | null;
  uploaded_at: string | null;
  file_name: string | null;
  file_size: string | number | null;
};

type SourceAdapter = {
  /**
   * 选出「还在库里」的行，列名统一成 DescribedRow；末尾留一个 `AND` 可以接的 WHERE。
   * `{id}` 与 `{size}` 是这张表的主键列和字节数列，供按 id 或按字节数筛选时替换。
   */
  select: string;
  id: string;
  size: string;
  /** 只有上传人能登记指纹：返回 uploader 一列，与当前用户的 identityKey 或 id 比。 */
  uploaderSql: string;
  uploaderField: "identityKey" | "id";
};

const ADAPTERS: Record<UploadFingerprintSource, SourceAdapter> = {
  VIDEO: {
    select: `SELECT v.id AS target_id, v.id AS owner_id, v.title, NULL AS detail,
        '/videos/' || v.id AS href, v.created_by_name AS uploader_name, v.created_at::text AS uploaded_at,
        v.original_name AS file_name, v.file_size
      FROM videos v
      WHERE v.deleted_at IS NULL AND v.status = 'READY'
        AND COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS'`,
    id: "v.id",
    size: "v.file_size",
    uploaderSql: `SELECT created_by_email AS uploader FROM videos WHERE id = ? AND deleted_at IS NULL`,
    uploaderField: "identityKey",
  },
  REPORT: {
    select: `SELECT r.id AS target_id, r.id AS owner_id, r.title, NULL AS detail,
        '/reports/' || r.id AS href, r.created_by_name AS uploader_name, r.created_at::text AS uploaded_at,
        r.original_name AS file_name, r.file_size
      FROM reports r
      WHERE r.deleted_at IS NULL AND r.status <> 'UPLOADING'`,
    id: "r.id",
    size: "r.file_size",
    uploaderSql: `SELECT created_by_email AS uploader FROM reports WHERE id = ? AND deleted_at IS NULL`,
    uploaderField: "identityKey",
  },
  VISUAL_ASSET: {
    select: `SELECT a.id AS target_id, a.case_id AS owner_id, c.title, a.original_name AS detail,
        '/visual/' || a.case_id AS href, c.created_by_name AS uploader_name, a.created_at::text AS uploaded_at,
        a.original_name AS file_name, a.file_size
      FROM visual_case_assets a
      JOIN visual_cases c ON c.id = a.case_id
      WHERE c.deleted_at IS NULL AND a.upload_status = 'READY'`,
    id: "a.id",
    size: "a.file_size",
    uploaderSql: `SELECT c.created_by_email AS uploader
      FROM visual_case_assets a JOIN visual_cases c ON c.id = a.case_id
      WHERE a.id = ? AND c.deleted_at IS NULL`,
    uploaderField: "identityKey",
  },
  RETRO_ASSET: {
    select: `SELECT a.id AS target_id, a.case_id AS owner_id, c.title, a.original_name AS detail,
        '/retro/' || a.case_id AS href, u.display_name AS uploader_name, a.created_at::text AS uploaded_at,
        a.original_name AS file_name, a.file_size
      FROM retro_case_assets a
      JOIN retro_cases c ON c.id = a.case_id
      LEFT JOIN users u ON u.id = a.created_by_user_id
      WHERE c.deleted_at IS NULL AND a.upload_status = 'READY'`,
    id: "a.id",
    size: "a.file_size",
    uploaderSql: `SELECT created_by_user_id AS uploader FROM retro_case_assets WHERE id = ?`,
    uploaderField: "id",
  },
  RETRO_RECORDING: {
    select: `SELECT r.id AS target_id, COALESCE(r.case_id, 'month:' || r.month_key) AS owner_id,
        COALESCE(c.title, r.month_key || ' 整场总结') AS title,
        '点评录音第 ' || r.part_no || ' 段' AS detail,
        CASE WHEN r.case_id IS NULL THEN '/retro/months/' || r.month_key ELSE '/retro/' || r.case_id END AS href,
        r.uploaded_by_name AS uploader_name, r.created_at::text AS uploaded_at,
        r.audio_file_name AS file_name, r.audio_size_bytes AS file_size
      FROM retro_recordings r
      LEFT JOIN retro_cases c ON c.id = r.case_id
      WHERE r.status NOT IN ('UPLOADING', 'REMOVED') AND (r.case_id IS NULL OR c.deleted_at IS NULL)`,
    id: "r.id",
    size: "r.audio_size_bytes",
    uploaderSql: `SELECT uploaded_by_user_id AS uploader FROM retro_recordings WHERE id = ?`,
    uploaderField: "id",
  },
  AUDIO_REVIEW: {
    select: `SELECT a.id AS target_id, a.video_id AS owner_id, v.title, '老孙点评' AS detail,
        '/videos/' || a.video_id AS href, a.reviewer_name AS uploader_name, a.created_at::text AS uploaded_at,
        a.audio_file_name AS file_name, a.audio_size_bytes AS file_size
      FROM audio_reviews a
      JOIN videos v ON v.id = a.video_id
      WHERE a.status NOT IN ('UPLOADING', 'ABANDONED') AND v.deleted_at IS NULL`,
    id: "a.id",
    size: "a.audio_size_bytes",
    uploaderSql: `SELECT reviewer_user_id AS uploader FROM audio_reviews WHERE id = ?`,
    uploaderField: "id",
  },
};

function sourcesOf(library: UploadDedupLibrary): UploadFingerprintSource[] {
  return UPLOAD_FINGERPRINT_SOURCES.filter((source) => SOURCE_LIBRARY[source] === library);
}

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** 生产在执行迁移之前没有这张表：查重退回只比字节数，登记静默跳过（规格四末段）。 */
async function fingerprintTableExists(db: DbClient): Promise<boolean> {
  const row = await db
    .prepare(`SELECT to_regclass('public.upload_fingerprints') IS NOT NULL AS ok`)
    .first<{ ok: boolean }>();
  return Boolean(row?.ok);
}

type Candidate = { source: UploadFingerprintSource; targetId: string; reason: UploadDuplicateReason; similarity: number | null };

type FingerprintRow = {
  source: UploadFingerprintSource;
  target_id: string;
  file_size: string | number;
  sample_sha256: string | null;
  media_kind: string;
  frame_hashes: string | null;
  width: number | null;
  height: number | null;
};

function candidateKey(candidate: Pick<Candidate, "source" | "targetId">) {
  return `${candidate.source}:${candidate.targetId}`;
}

/** 每个文件、每一行只留最强的那条理由。 */
function addCandidate(bucket: Map<string, Candidate>, candidate: Candidate) {
  const key = candidateKey(candidate);
  const existing = bucket.get(key);
  if (!existing || compareMatches(candidate, existing) < 0) bucket.set(key, candidate);
}

async function describe(
  db: DbClient,
  source: UploadFingerprintSource,
  targetIds: string[],
): Promise<Map<string, DescribedRow>> {
  const result = new Map<string, DescribedRow>();
  if (!targetIds.length) return result;
  const adapter = ADAPTERS[source];
  const rows = await db
    .prepare(`${adapter.select} AND ${adapter.id} IN (${placeholders(targetIds.length)})`)
    .bind(...targetIds)
    .all<DescribedRow>();
  for (const row of rows.results) result.set(row.target_id, row);
  return result;
}

/** 老数据（没有指纹的行）只能比字节数：字节数完全一样就给弱提示（规格二 #5）。 */
async function legacySizeCandidates(
  db: DbClient,
  source: UploadFingerprintSource,
  sizes: number[],
  hasTable: boolean,
): Promise<Array<{ targetId: string; size: number }>> {
  if (!sizes.length) return [];
  const adapter = ADAPTERS[source];
  const withoutFingerprint = hasTable
    ? ` AND NOT EXISTS (SELECT 1 FROM upload_fingerprints f WHERE f.source = '${source}' AND f.target_id = ${adapter.id})`
    : "";
  const rows = await db
    .prepare(`${adapter.select} AND ${adapter.size} IN (${placeholders(sizes.length)})${withoutFingerprint} LIMIT 50`)
    .bind(...sizes)
    .all<DescribedRow>();
  return rows.results.map((row) => ({ targetId: row.target_id, size: Number(row.file_size) }));
}

function similarityFor(file: UploadCheckFile, row: FingerprintRow): number | null {
  if (row.media_kind !== file.kind || !row.frame_hashes || !file.hashes.length) return null;
  const incoming = packHashes(file.hashes);
  const incomingMirror = packHashes(file.mirrorHashes);
  const existing = packHashes(deserializeFrameHashes(row.frame_hashes));
  return file.kind === "VIDEO"
    ? videoSimilarity(incoming, incomingMirror, existing)
    : file.kind === "IMAGE"
      ? imageSimilarity(incoming, incomingMirror, existing)
      : null;
}

export async function checkUploadDuplicates(
  db: DbClient,
  input: UploadCheckInput,
): Promise<Record<string, UploadDuplicateMatch[]>> {
  const hasTable = await fingerprintTableExists(db);
  const sources = sourcesOf(input.library);
  const sizes = Array.from(new Set(input.files.map((file) => file.size)));
  const perFile = new Map<string, Map<string, Candidate>>(input.files.map((file) => [file.key, new Map()]));

  if (hasTable) {
    // 3.1 同一个文件：同库、同字节数的指纹行，抽样 SHA-256 再确认。
    const sameSize = await db
      .prepare(
        `SELECT source, target_id, file_size, sample_sha256, media_kind, NULL AS frame_hashes, width, height
        FROM upload_fingerprints WHERE library = ? AND file_size IN (${placeholders(sizes.length)})`,
      )
      .bind(input.library, ...sizes)
      .all<FingerprintRow>();
    for (const file of input.files) {
      for (const row of sameSize.results) {
        if (Number(row.file_size) !== file.size) continue;
        // 两边都有抽样指纹却对不上，就一定不是同一个文件；有一边缺指纹时只能当「大小一样」。
        const reason: UploadDuplicateReason | null =
          file.sha && row.sample_sha256 ? (file.sha === row.sample_sha256 ? "SAME_FILE" : null) : "SAME_SIZE";
        if (reason) addCandidate(perFile.get(file.key)!, { source: row.source, targetId: row.target_id, reason, similarity: null });
      }
    }

    // 3.2 内容相似：同库同媒体类型的帧哈希整批拉出来在内存里比。
    for (const kind of ["VIDEO", "IMAGE"] as const) {
      const files = input.files.filter((file) => file.kind === kind && file.hashes.some(Boolean));
      if (!files.length) continue;
      const rows = await db
        .prepare(
          `SELECT source, target_id, file_size, NULL AS sample_sha256, media_kind, frame_hashes, width, height
          FROM upload_fingerprints
          WHERE library = ? AND media_kind = ? AND algorithm_version = ? AND frame_hashes IS NOT NULL`,
        )
        .bind(input.library, kind, UPLOAD_FINGERPRINT_ALGORITHM)
        .all<FingerprintRow>();
      for (const file of files) {
        for (const row of rows.results) {
          const similarity = similarityFor(file, row);
          if (similarity !== null) {
            addCandidate(perFile.get(file.key)!, { source: row.source, targetId: row.target_id, reason: "SIMILAR", similarity });
          }
        }
      }
    }
  }

  // 老数据：没有指纹的行只比字节数。
  for (const source of sources) {
    const legacy = await legacySizeCandidates(db, source, sizes, hasTable);
    for (const file of input.files) {
      for (const row of legacy) {
        if (row.size === file.size) {
          addCandidate(perFile.get(file.key)!, { source, targetId: row.targetId, reason: "SAME_SIZE", similarity: null });
        }
      }
    }
  }

  // 回业务表现取标题、上传人，同时把已删除、没传完的筛掉。
  const wanted = new Map<UploadFingerprintSource, Set<string>>();
  for (const bucket of perFile.values()) {
    for (const candidate of bucket.values()) {
      if (!wanted.has(candidate.source)) wanted.set(candidate.source, new Set());
      wanted.get(candidate.source)!.add(candidate.targetId);
    }
  }
  const described = new Map<string, DescribedRow>();
  for (const [source, ids] of wanted) {
    for (const [targetId, row] of await describe(db, source, Array.from(ids))) described.set(`${source}:${targetId}`, row);
  }
  const dimensions = await loadDimensions(db, hasTable, perFile);

  const results: Record<string, UploadDuplicateMatch[]> = {};
  for (const file of input.files) {
    const matches: UploadDuplicateMatch[] = [];
    for (const candidate of perFile.get(file.key)!.values()) {
      const row = described.get(candidateKey(candidate));
      if (!row || (input.excludeOwnerId && row.owner_id === input.excludeOwnerId)) continue;
      const size = dimensions.get(candidateKey(candidate));
      matches.push({
        reason: candidate.reason,
        similarity: candidate.similarity,
        sameName: Boolean(file.name && row.file_name && file.name === row.file_name),
        title: row.title,
        detail: row.detail ?? "",
        href: row.href,
        uploaderName: row.uploader_name ?? "",
        uploadedAt: row.uploaded_at ?? "",
        width: size?.width ?? null,
        height: size?.height ?? null,
      });
    }
    matches.sort(compareMatches);
    results[file.key] = matches.slice(0, MAX_MATCHES_PER_FILE);
  }
  return results;
}

async function loadDimensions(
  db: DbClient,
  hasTable: boolean,
  perFile: Map<string, Map<string, Candidate>>,
): Promise<Map<string, { width: number | null; height: number | null }>> {
  const result = new Map<string, { width: number | null; height: number | null }>();
  if (!hasTable) return result;
  const keys = new Set<string>();
  for (const bucket of perFile.values()) for (const key of bucket.keys()) keys.add(key);
  if (!keys.size) return result;
  const pairs = Array.from(keys, (key) => [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)]);
  const rows = await db
    .prepare(
      `SELECT source, target_id, width, height FROM upload_fingerprints
      WHERE (source, target_id) IN (${pairs.map(() => "(?, ?)").join(", ")})`,
    )
    .bind(...pairs.flat())
    .all<{ source: string; target_id: string; width: number | null; height: number | null }>();
  for (const row of rows.results) result.set(`${row.source}:${row.target_id}`, { width: row.width, height: row.height });
  return result;
}

export type RecordResult = { recorded: boolean; reason?: "NO_TABLE" | "NOT_FOUND" | "FORBIDDEN" };

/** 登记一份新上传的指纹；同一行再登记（视频换片）就整行换成新的（规格四）。 */
export async function recordUploadFingerprint(
  db: DbClient,
  input: UploadRecordInput,
  user: Pick<CurrentUser, "id" | "identityKey">,
): Promise<RecordResult> {
  if (!(await fingerprintTableExists(db))) return { recorded: false, reason: "NO_TABLE" };
  const adapter = ADAPTERS[input.source];
  const owner = await db.prepare(adapter.uploaderSql).bind(input.targetId).first<{ uploader: string | null }>();
  if (!owner) return { recorded: false, reason: "NOT_FOUND" };
  if (owner.uploader !== user[adapter.uploaderField]) return { recorded: false, reason: "FORBIDDEN" };

  const { fingerprint } = input;
  await db
    .prepare(
      `INSERT INTO upload_fingerprints (
        id, library, source, target_id, file_size, sample_sha256, media_kind, frame_hashes,
        width, height, duration_ms, algorithm_version, created_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source, target_id) DO UPDATE SET
        file_size = EXCLUDED.file_size,
        sample_sha256 = EXCLUDED.sample_sha256,
        media_kind = EXCLUDED.media_kind,
        frame_hashes = EXCLUDED.frame_hashes,
        width = EXCLUDED.width,
        height = EXCLUDED.height,
        duration_ms = EXCLUDED.duration_ms,
        algorithm_version = EXCLUDED.algorithm_version,
        created_by_user_id = EXCLUDED.created_by_user_id,
        updated_at = now()`,
    )
    .bind(
      newId("ufp"),
      SOURCE_LIBRARY[input.source],
      input.source,
      input.targetId,
      fingerprint.size,
      fingerprint.sha,
      fingerprint.kind,
      fingerprint.kind === "FILE" ? null : serializeFrameHashes(fingerprint.hashes),
      fingerprint.width,
      fingerprint.height,
      fingerprint.durationMs,
      UPLOAD_FINGERPRINT_ALGORITHM,
      user.id,
    )
    .run();
  return { recorded: true };
}
