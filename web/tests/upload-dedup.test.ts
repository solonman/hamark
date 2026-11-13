// 上传查重（docs/28）：载荷解析、抽样指纹、感知哈希对各种「不同来源」改动的稳健性、
// 帧序列错位对齐，以及指纹表的 schema 与生产迁移一致。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { UPLOAD_DEDUP_SCHEMA_STATEMENTS } from "../db/upload-dedup-schema";
import {
  compareFrameSequences,
  compareMatches,
  deserializeFrameHashes,
  packHashes,
  parseUploadCheckInput,
  parseUploadFingerprint,
  parseUploadRecordInput,
  sampleRanges,
  sampleSha256,
  SAMPLE_CHUNK_BYTES,
  serializeFrameHashes,
  videoSimilarity,
} from "../lib/upload-dedup/model";
import {
  detectLetterbox,
  detectUniformBorder,
  hashRegion,
  type GrayImage,
} from "../lib/upload-dedup/phash";

// ---------------------------------------------------------------------------
// 合成画面：同一个「场景」函数按不同分辨率取样，等于同一条片子的不同来源。

function scene(seed: number) {
  return (u: number, v: number) => {
    const wave = 60 * Math.sin(u * 17 + seed) * Math.cos(v * 11 + seed * 0.7);
    const blob = Math.hypot(u - 0.3 - (seed % 5) * 0.08, v - 0.6) < 0.18 ? 50 : 0;
    const bar = (Math.floor(u * 6 + seed) % 2) * 25;
    return Math.max(0, Math.min(255, 110 + wave + blob + bar));
  };
}

function render(fn: (u: number, v: number) => number, width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[y * width + x] = fn((x + 0.5) / width, (y + 0.5) / height);
  }
  return { width, height, data };
}

/** 上下加黑边：16:9 的画面塞进 4:3 的框。 */
function letterbox(image: GrayImage, bar: number): GrayImage {
  const height = image.height + bar * 2;
  const data = new Uint8Array(image.width * height);
  data.set(image.data, bar * image.width);
  return { width: image.width, height, data };
}

function withCornerWatermark(image: GrayImage): GrayImage {
  const data = Uint8Array.from(image.data);
  for (let y = 2; y < 10; y += 1) for (let x = 2; x < 18; x += 1) data[y * image.width + x] = 255;
  return { ...image, data };
}

function mirrored(image: GrayImage): GrayImage {
  const data = new Uint8Array(image.data.length);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) data[y * image.width + x] = image.data[y * image.width + (image.width - 1 - x)];
  }
  return { ...image, data };
}

function hashOf(image: GrayImage, crop: "letterbox" | "uniform" = "letterbox") {
  const content = crop === "letterbox" ? detectLetterbox([image]) : detectUniformBorder(image);
  return hashRegion(image, content);
}

function distance(a: string | null, b: string | null) {
  assert.ok(a && b, "两边都应当有哈希");
  return rawDistance(a, b);
}

function rawDistance(a: string, b: string) {
  let count = 0;
  for (let i = 0; i < 16; i += 1) {
    let x = Number.parseInt(a[i], 16) ^ Number.parseInt(b[i], 16);
    while (x) { count += x & 1; x >>= 1; }
  }
  return count;
}

// ---------------------------------------------------------------------------

test("载荷解析：字节数必填，坏哈希当空帧，文件类不收帧哈希，图片只留一项", () => {
  assert.equal(parseUploadFingerprint({ name: "a.mp4" }), null);
  assert.equal(parseUploadFingerprint({ size: -1 }), null);

  const video = parseUploadFingerprint({ size: 10, kind: "VIDEO", sha: "x", hashes: ["0123456789abcdef", "nope", null] });
  assert.equal(video?.sha, null);
  assert.deepEqual(video?.hashes, ["0123456789abcdef", null, null]);

  const file = parseUploadFingerprint({ size: 10, kind: "FILE", hashes: ["0123456789abcdef"] });
  assert.deepEqual(file?.hashes, []);

  const image = parseUploadFingerprint({ size: 10, kind: "IMAGE", hashes: ["0123456789abcdef", "fedcba9876543210"] });
  assert.deepEqual(image?.hashes, ["0123456789abcdef"]);

  assert.equal(parseUploadCheckInput({ library: "NOPE", files: [{ key: "0", size: 1 }] }), null);
  assert.equal(parseUploadCheckInput({ library: "VIDEO", files: [] }), null);
  assert.equal(parseUploadCheckInput({ library: "VIDEO", files: [{ size: 1 }] }), null, "每个文件要带 key");
  const check = parseUploadCheckInput({ library: "VIDEO", excludeOwnerId: " video_1 ", files: [{ key: "0", size: 5 }] });
  assert.equal(check?.excludeOwnerId, "video_1");

  assert.equal(parseUploadRecordInput({ source: "REPORT_FILE", targetId: "r", fingerprint: { size: 1 } }), null);
  assert.equal(parseUploadRecordInput({ source: "REPORT", targetId: "r_1", fingerprint: { size: 1 } })?.source, "REPORT");
});

test("抽样范围：6MB 以内全文，更大取头、中、尾各 2MB", () => {
  assert.deepEqual(sampleRanges(100), [[0, 100]]);
  assert.deepEqual(sampleRanges(SAMPLE_CHUNK_BYTES * 3), [[0, SAMPLE_CHUNK_BYTES * 3]]);
  const size = 50 * 1024 * 1024;
  const ranges = sampleRanges(size);
  assert.equal(ranges.length, 3);
  assert.deepEqual(ranges[0], [0, SAMPLE_CHUNK_BYTES]);
  assert.deepEqual(ranges[2], [size - SAMPLE_CHUNK_BYTES, size]);
  assert.ok(ranges[1][0] < size / 2 && ranges[1][1] > size / 2);
});

test("抽样 SHA-256：同样的字节相同；抽到的段改一个字节就不同；字节数参与计算", async () => {
  const bytes = new Uint8Array(8 * 1024 * 1024).map((_, index) => index % 251);
  const a = await sampleSha256(new Blob([bytes]));
  assert.equal(a, await sampleSha256(new Blob([bytes.slice()])));
  assert.match(a, /^[0-9a-f]{64}$/);

  const changed = bytes.slice();
  changed[changed.length / 2] ^= 1;
  assert.notEqual(a, await sampleSha256(new Blob([changed])));

  const zeros = new Uint8Array(10);
  assert.notEqual(await sampleSha256(new Blob([zeros])), await sampleSha256(new Blob([zeros.subarray(0, 9)])));
});

test("感知哈希：改分辨率、加黑边、角上加水印都还认得出", () => {
  const original = hashOf(render(scene(1), 160, 90));
  assert.ok(distance(original.hash, hashOf(render(scene(1), 96, 54)).hash) <= 6, "缩小");
  assert.ok(distance(original.hash, hashOf(letterbox(render(scene(1), 160, 90), 20)).hash) <= 6, "上下黑边");
  assert.ok(distance(original.hash, hashOf(withCornerWatermark(render(scene(1), 160, 90))).hash) <= 4, "角标水印");
});

test("感知哈希：镜像翻转后用镜像哈希认得出；不同画面差得远；纯色帧不出哈希", () => {
  const image = render(scene(2), 160, 90);
  const flipped = hashOf(mirrored(image));
  assert.ok(distance(hashOf(image).mirror, flipped.hash) <= 2);
  assert.ok(distance(hashOf(image).hash, hashOf(render(scene(7), 160, 90)).hash) > 16);
  const flat = { width: 64, height: 36, data: new Uint8Array(64 * 36).fill(20) };
  assert.equal(hashOf(flat).hash, null);
});

test("图片的均匀色边（白边衬底）会被裁掉", () => {
  const image = render(scene(3), 120, 120);
  const padded = { width: 160, height: 160, data: new Uint8Array(160 * 160).fill(250) };
  for (let y = 0; y < 120; y += 1) padded.data.set(image.data.subarray(y * 120, y * 120 + 120), (y + 20) * 160 + 20);
  const rect = detectUniformBorder(padded);
  assert.deepEqual(rect, { left: 20, top: 20, right: 140, bottom: 140 });
  assert.ok(distance(hashOf(image, "uniform").hash, hashOf(padded, "uniform").hash) <= 4);
});

test("黑边按多数帧认：暗场景、整屏片头都不影响；整段全黑不裁", () => {
  const framed = [4, 5, 6, 7, 8, 9, 10, 11, 12].map((seed) => letterbox(render(scene(seed), 160, 90), 15));
  const darkScene = { width: 160, height: 120, data: new Uint8Array(160 * 120).fill(5) };
  // 平台片头：整屏有画面、没有黑边。
  const bumper = render(scene(50), 160, 120);
  assert.deepEqual(detectLetterbox([...framed, darkScene, bumper]), { left: 0, top: 15, right: 160, bottom: 105 });
  // 只有一帧是暗场景：不能因为它把整幅画当黑边。
  assert.deepEqual(detectLetterbox([render(scene(4), 160, 120), darkScene]), { left: 0, top: 0, right: 160, bottom: 120 });
  // 整段都是黑的：没有可投票的帧，不裁。
  assert.deepEqual(detectLetterbox([darkScene]), { left: 0, top: 0, right: 160, bottom: 120 });
});

// ---------------------------------------------------------------------------

function sequence(seeds: number[], width = 160, height = 90, transform: (image: GrayImage) => GrayImage = (image) => image) {
  return seeds.map((seed) => hashOf(transform(render(scene(seed), width, height))));
}

test("帧序列：另一来源加了 3 秒片头、改了分辨率、加了黑边，仍判为内容相似", () => {
  const shots = [10, 10, 11, 11, 12, 13, 13, 14, 15, 15, 16, 17, 17, 18, 19, 19, 20, 21, 22, 22];
  const original = sequence(shots);
  const repost = [
    ...sequence([90, 91, 92]),
    ...sequence(shots, 128, 72, (image) => letterbox(image, 12)),
  ];
  const incoming = packHashes(repost.map((frame) => frame.hash));
  const incomingMirror = packHashes(repost.map((frame) => frame.mirror));
  const existing = packHashes(original.map((frame) => frame.hash));
  const similarity = videoSimilarity(incoming, incomingMirror, existing);
  assert.ok(similarity !== null && similarity >= 0.9, `相似度 ${similarity}`);
});

test("帧序列：镜像搬运也认得出；同风格的另一条片子不算相似", () => {
  const shots = [30, 31, 31, 32, 33, 34, 34, 35, 36, 37];
  const original = sequence(shots);
  const flipped = sequence(shots, 160, 90, mirrored);
  const similarity = videoSimilarity(
    packHashes(flipped.map((frame) => frame.hash)),
    packHashes(flipped.map((frame) => frame.mirror)),
    packHashes(original.map((frame) => frame.hash)),
  );
  assert.ok(similarity !== null && similarity >= 0.9, `镜像相似度 ${similarity}`);

  const other = sequence([40, 41, 41, 42, 43, 44, 44, 45, 46, 47]);
  assert.equal(
    videoSimilarity(
      packHashes(other.map((frame) => frame.hash)),
      packHashes(other.map((frame) => frame.mirror)),
      packHashes(original.map((frame) => frame.hash)),
    ),
    null,
  );
});

test("帧序列对齐：错位超过范围就对不上；空帧不参与", () => {
  const hashes = ["0000000000000000", "ffffffffffffffff", "00000000ffffffff", "ffffffff00000000"];
  const a = packHashes([...hashes, null]);
  assert.equal(a.validCount, 4);
  assert.deepEqual(compareFrameSequences(a, packHashes(hashes)), { matched: 4, ratio: 1 });
  const shifted = packHashes([...Array(20).fill(null), ...hashes]);
  assert.equal(compareFrameSequences(a, shifted, 15).matched, 0);
  assert.equal(compareFrameSequences(a, shifted, 20).matched, 4);
});

test("帧哈希入库格式往返；全是空帧不入库", () => {
  const list = ["0123456789abcdef", null, "fedcba9876543210"];
  assert.equal(serializeFrameHashes(list), "0123456789abcdef - fedcba9876543210");
  assert.deepEqual(deserializeFrameHashes("0123456789abcdef - fedcba9876543210"), list);
  assert.equal(serializeFrameHashes([null, null]), null);
});

test("重复按强弱排序：同一个文件 > 同批 > 相似（高者在前）> 大小一样", () => {
  const sorted = [
    { reason: "SAME_SIZE" as const, similarity: null },
    { reason: "SIMILAR" as const, similarity: 0.7 },
    { reason: "SAME_FILE" as const, similarity: null },
    { reason: "SIMILAR" as const, similarity: 0.95 },
    { reason: "SAME_BATCH" as const, similarity: null },
  ].sort(compareMatches);
  assert.deepEqual(sorted.map((m) => `${m.reason}${m.similarity ?? ""}`), ["SAME_FILE", "SAME_BATCH", "SIMILAR0.95", "SIMILAR0.7", "SAME_SIZE"]);
});

// ---------------------------------------------------------------------------

function normalizeSql(sql: string) {
  return sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").replace(/\s*;\s*$/, "").trim();
}

test("指纹表：schema 模块与生产迁移逐句一致，已接进 bootstrap，开了 RLS", async () => {
  const migration = await readFile(new URL("../db/migrations/2026-11-13-upload-fingerprints.sql", import.meta.url), "utf8");
  const body = normalizeSql(migration).replace(/^BEGIN; /, "").replace(/ COMMIT$/, "");
  for (const statement of UPLOAD_DEDUP_SCHEMA_STATEMENTS) {
    assert.ok(body.includes(normalizeSql(statement)), `迁移里缺：${statement.slice(0, 60)}`);
  }
  assert.match(UPLOAD_DEDUP_SCHEMA_STATEMENTS.join("\n"), /ENABLE ROW LEVEL SECURITY/);
  const bootstrap = await readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8");
  assert.match(bootstrap, /\.\.\.UPLOAD_DEDUP_SCHEMA_STATEMENTS/);
});
