// 上传查重的共用词表、接口载荷解析与指纹比对（纯函数，浏览器与服务端共用）。
// 口径见 docs/28_上传查重_实施规格_V0.1.md 三。

export const UPLOAD_DEDUP_LIBRARIES = ["VIDEO", "REPORT", "VISUAL", "RETRO", "AUDIO_REVIEW"] as const;
export type UploadDedupLibrary = (typeof UPLOAD_DEDUP_LIBRARIES)[number];

export const UPLOAD_FINGERPRINT_SOURCES = [
  "VIDEO",
  "REPORT",
  "VISUAL_ASSET",
  "RETRO_ASSET",
  "RETRO_RECORDING",
  "AUDIO_REVIEW",
] as const;
export type UploadFingerprintSource = (typeof UPLOAD_FINGERPRINT_SOURCES)[number];

/** 指纹归哪个库：复盘库的素材与录音算同一个库（规格二 #2）。 */
export const SOURCE_LIBRARY: Record<UploadFingerprintSource, UploadDedupLibrary> = {
  VIDEO: "VIDEO",
  REPORT: "REPORT",
  VISUAL_ASSET: "VISUAL",
  RETRO_ASSET: "RETRO",
  RETRO_RECORDING: "RETRO",
  AUDIO_REVIEW: "AUDIO_REVIEW",
};

export const UPLOAD_MEDIA_KINDS = ["VIDEO", "IMAGE", "FILE"] as const;
export type UploadMediaKind = (typeof UPLOAD_MEDIA_KINDS)[number];

/** 改了抽样方式或哈希算法就换版本号，只和同版本的指纹比内容相似。 */
export const UPLOAD_FINGERPRINT_ALGORITHM = "upload-fp/1";

/** 视频最多取前 180 秒、每秒一帧。 */
export const MAX_VIDEO_FRAMES = 180;
/** 一次查重最多带几个文件（公共视觉单条案例最多 12 段视频 + 24 张图）。 */
export const MAX_CHECK_FILES = 40;
/** 每个文件最多回几条重复。 */
export const MAX_MATCHES_PER_FILE = 5;

/** 视频两帧汉明距离不超过它就算对上。 */
export const VIDEO_FRAME_MATCH_DISTANCE = 12;
/** 视频序列允许错开的最大秒数（平台加的片头片尾）。 */
export const VIDEO_MAX_SHIFT_SECONDS = 15;
/** 对上的帧数 ÷ 较短一段的有效帧数，至少这么多才算内容相似。 */
export const VIDEO_SIMILAR_RATIO = 0.6;
export const VIDEO_SIMILAR_MIN_FRAMES = 3;
/** 图片哈希距离不超过它就算内容相似。 */
export const IMAGE_SIMILAR_DISTANCE = 10;

export type UploadFingerprint = {
  size: number;
  name: string;
  /** 抽样 SHA-256（十六进制）；读文件失败时为空，只剩字节数可比。 */
  sha: string | null;
  kind: UploadMediaKind;
  /** 视频每秒一帧、图片一项；null 是画面几乎全平、没有信息的帧。解不了码时为空数组。 */
  hashes: Array<string | null>;
  /** 同一批画面左右镜像后的哈希，只在查重时用，不入库。 */
  mirrorHashes: Array<string | null>;
  width: number | null;
  height: number | null;
  durationMs: number | null;
};

export type UploadDuplicateReason = "SAME_FILE" | "SIMILAR" | "SAME_SIZE" | "SAME_BATCH";

export type UploadDuplicateMatch = {
  reason: UploadDuplicateReason;
  /** 内容相似时的相似度（0–1）；其余为空。 */
  similarity: number | null;
  /** 和这次选的文件同名（只是辅助说明，不参与判断）。 */
  sameName: boolean;
  title: string;
  /** 条目里的哪一份：素材文件名、「点评录音第 2 段」之类；没有就空串。 */
  detail: string;
  href: string | null;
  uploaderName: string;
  uploadedAt: string;
  width: number | null;
  height: number | null;
};

export type UploadCheckFile = UploadFingerprint & { key: string };

export type UploadCheckInput = {
  library: UploadDedupLibrary;
  excludeOwnerId: string | null;
  files: UploadCheckFile[];
};

export type UploadRecordInput = {
  source: UploadFingerprintSource;
  targetId: string;
  fingerprint: UploadFingerprint;
};

const HASH_PATTERN = /^[0-9a-f]{16}$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function optionalPositiveInt(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.round(number), 2_147_483_647) : null;
}

function parseHashList(value: unknown): Array<string | null> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_VIDEO_FRAMES).map((item) => (typeof item === "string" && HASH_PATTERN.test(item) ? item : null));
}

/** 浏览器送来的指纹，不合格的字段一律当没有；字节数是唯一的必填项。 */
export function parseUploadFingerprint(value: unknown): UploadFingerprint | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const size = Number(raw.size);
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  const kind = isOneOf(UPLOAD_MEDIA_KINDS, raw.kind) ? raw.kind : "FILE";
  const hashes = kind === "FILE" ? [] : parseHashList(raw.hashes);
  const mirrorHashes = kind === "FILE" ? [] : parseHashList(raw.mirrorHashes);
  return {
    size,
    name: typeof raw.name === "string" ? raw.name.slice(0, 255) : "",
    sha: typeof raw.sha === "string" && SHA_PATTERN.test(raw.sha) ? raw.sha : null,
    kind,
    hashes: kind === "IMAGE" ? hashes.slice(0, 1) : hashes,
    mirrorHashes: kind === "IMAGE" ? mirrorHashes.slice(0, 1) : mirrorHashes,
    width: optionalPositiveInt(raw.width),
    height: optionalPositiveInt(raw.height),
    durationMs: optionalPositiveInt(raw.durationMs),
  };
}

export function parseUploadCheckInput(value: unknown): UploadCheckInput | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!isOneOf(UPLOAD_DEDUP_LIBRARIES, raw.library) || !Array.isArray(raw.files)) return null;
  if (raw.files.length === 0 || raw.files.length > MAX_CHECK_FILES) return null;
  const files: UploadCheckFile[] = [];
  for (const item of raw.files) {
    const fingerprint = parseUploadFingerprint(item);
    const key = (item as Record<string, unknown> | null)?.key;
    if (!fingerprint || typeof key !== "string" || !key || key.length > 64) return null;
    files.push({ ...fingerprint, key });
  }
  const exclude = raw.excludeOwnerId;
  return {
    library: raw.library,
    excludeOwnerId: typeof exclude === "string" && exclude.trim() ? exclude.trim().slice(0, 128) : null,
    files,
  };
}

export function parseUploadRecordInput(value: unknown): UploadRecordInput | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!isOneOf(UPLOAD_FINGERPRINT_SOURCES, raw.source)) return null;
  if (typeof raw.targetId !== "string" || !raw.targetId.trim() || raw.targetId.length > 128) return null;
  const fingerprint = parseUploadFingerprint(raw.fingerprint);
  if (!fingerprint) return null;
  return { source: raw.source, targetId: raw.targetId.trim(), fingerprint };
}

// ---------------------------------------------------------------------------
// 哈希比对。64 位哈希拆成高低两个 32 位整数，避开 BigInt：一次查重要比上百万对。

export type PackedHashes = { hi: Uint32Array; lo: Uint32Array; valid: Uint8Array; validCount: number };

export function packHashes(hashes: ReadonlyArray<string | null>): PackedHashes {
  const hi = new Uint32Array(hashes.length);
  const lo = new Uint32Array(hashes.length);
  const valid = new Uint8Array(hashes.length);
  let validCount = 0;
  hashes.forEach((hash, index) => {
    if (!hash || !HASH_PATTERN.test(hash)) return;
    hi[index] = Number.parseInt(hash.slice(0, 8), 16) >>> 0;
    lo[index] = Number.parseInt(hash.slice(8), 16) >>> 0;
    valid[index] = 1;
    validCount += 1;
  });
  return { hi, lo, valid, validCount };
}

function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function hashDistance(a: PackedHashes, i: number, b: PackedHashes, j: number): number {
  return popcount32((a.hi[i] ^ b.hi[j]) >>> 0) + popcount32((a.lo[i] ^ b.lo[j]) >>> 0);
}

/**
 * 两段视频的帧序列（每秒一帧）在 ±maxShift 秒内逐秒错位对齐，取对上帧数最多的那个错位。
 * 返回对上的帧数与比例（÷ 较短一段的有效帧数）。
 */
export function compareFrameSequences(
  a: PackedHashes,
  b: PackedHashes,
  maxShift = VIDEO_MAX_SHIFT_SECONDS,
  maxDistance = VIDEO_FRAME_MATCH_DISTANCE,
): { matched: number; ratio: number } {
  const shorter = Math.min(a.validCount, b.validCount);
  if (shorter === 0) return { matched: 0, ratio: 0 };
  let best = 0;
  for (let shift = -maxShift; shift <= maxShift; shift += 1) {
    const start = Math.max(0, -shift);
    const end = Math.min(a.valid.length, b.valid.length - shift);
    if (end - start <= best) continue;
    let matched = 0;
    for (let i = start; i < end; i += 1) {
      const j = i + shift;
      if (a.valid[i] && b.valid[j] && hashDistance(a, i, b, j) <= maxDistance) matched += 1;
    }
    if (matched > best) best = matched;
  }
  return { matched: best, ratio: best / shorter };
}

/** 新视频（原样与镜像各比一次）与库里一段视频是否内容相似；相似时给出相似度。 */
export function videoSimilarity(
  incoming: PackedHashes,
  incomingMirror: PackedHashes,
  existing: PackedHashes,
): number | null {
  let best = 0;
  for (const candidate of [incoming, incomingMirror]) {
    if (!candidate.validCount) continue;
    const { matched, ratio } = compareFrameSequences(candidate, existing);
    if (matched >= VIDEO_SIMILAR_MIN_FRAMES && ratio > best) best = ratio;
  }
  return best >= VIDEO_SIMILAR_RATIO ? Math.min(best, 1) : null;
}

/** 新图片（原样与镜像）与库里一张图片的哈希距离是否在阈值内；相似时给出相似度。 */
export function imageSimilarity(incoming: PackedHashes, incomingMirror: PackedHashes, existing: PackedHashes): number | null {
  if (!existing.valid[0]) return null;
  let best = Infinity;
  for (const candidate of [incoming, incomingMirror]) {
    if (candidate.valid[0]) best = Math.min(best, hashDistance(candidate, 0, existing, 0));
  }
  return best <= IMAGE_SIMILAR_DISTANCE ? 1 - best / 64 : null;
}

/** 入库存的是空格分隔的十六进制，空帧写 `-`。 */
export function serializeFrameHashes(hashes: ReadonlyArray<string | null>): string | null {
  if (!hashes.some(Boolean)) return null;
  return hashes.map((hash) => hash ?? "-").join(" ");
}

export function deserializeFrameHashes(value: string | null | undefined): Array<string | null> {
  if (!value) return [];
  return value.split(" ").map((item) => (HASH_PATTERN.test(item) ? item : null));
}

const REASON_RANK: Record<UploadDuplicateReason, number> = { SAME_FILE: 0, SAME_BATCH: 1, SIMILAR: 2, SAME_SIZE: 3 };

/** 同一个文件 ＞ 同批重复 ＞ 内容相似（相似度降序）＞ 疑似（大小一样）。 */
export function compareMatches(a: Pick<UploadDuplicateMatch, "reason" | "similarity">, b: Pick<UploadDuplicateMatch, "reason" | "similarity">) {
  return REASON_RANK[a.reason] - REASON_RANK[b.reason] || (b.similarity ?? 0) - (a.similarity ?? 0);
}

/** 抽样 SHA-256 取哪几段：6MB 以内全文；更大的取开头、正中、末尾各 2MB。 */
export const SAMPLE_CHUNK_BYTES = 2 * 1024 * 1024;

export function sampleRanges(size: number): Array<[number, number]> {
  if (size <= SAMPLE_CHUNK_BYTES * 3) return [[0, size]];
  const middle = Math.floor(size / 2 - SAMPLE_CHUNK_BYTES / 2);
  return [
    [0, SAMPLE_CHUNK_BYTES],
    [middle, middle + SAMPLE_CHUNK_BYTES],
    [size - SAMPLE_CHUNK_BYTES, size],
  ];
}

/** 抽样 SHA-256：字节数（8 字节小端）打头，后接各段内容。浏览器与 Node 都能跑。 */
export async function sampleSha256(blob: Blob): Promise<string> {
  const header = new ArrayBuffer(8);
  new DataView(header).setBigUint64(0, BigInt(blob.size), true);
  const parts: BlobPart[] = [header];
  for (const [start, end] of sampleRanges(blob.size)) parts.push(blob.slice(start, end));
  const buffer = await new Blob(parts).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
