"use client";

// 在上传人的浏览器里给本地文件算指纹：读的是本地文件，不走网络、不占服务器（docs/28 三）。
// 解不了码的格式（Chrome 里的 HEVC、HEIC 等）只留抽样 SHA-256，不报错。

import {
  MAX_VIDEO_FRAMES,
  sampleSha256,
  type UploadFingerprint,
  type UploadMediaKind,
} from "./model";
import { detectLetterbox, detectUniformBorder, hashRegion, rgbaToGray, type GrayImage } from "./phash";

/** 缩图的长边：够裁边和取 32×32，又不至于每帧读太多像素。 */
const SAMPLE_LONG_SIDE = 160;
const METADATA_TIMEOUT_MS = 10000;
const SEEK_TIMEOUT_MS = 4000;
/** 连续这么多帧跳不过去就放弃抽帧，只留文件指纹。 */
const MAX_SEEK_FAILURES = 5;
/** 抽帧总时长上限：超大或难解码的视频到点就停，用已经抽到的帧，不让查重拖住上传。 */
const FRAME_BUDGET_MS = 20000;

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|ts|mts|3gp)$/i;

export function guessMediaKind(file: File): UploadMediaKind {
  if (file.type.startsWith("video/") || VIDEO_EXTENSIONS.test(file.name)) return "VIDEO";
  if (file.type.startsWith("image/") || IMAGE_EXTENSIONS.test(file.name)) return "IMAGE";
  return "FILE";
}

function sampleSize(width: number, height: number) {
  const scale = SAMPLE_LONG_SIDE / Math.max(width, height, 1);
  return { width: Math.max(8, Math.round(width * Math.min(1, scale))), height: Math.max(8, Math.round(height * Math.min(1, scale))) };
}

function grabGray(context: CanvasRenderingContext2D, source: CanvasImageSource, width: number, height: number): GrayImage {
  context.drawImage(source, 0, 0, width, height);
  return rgbaToGray(context.getImageData(0, 0, width, height).data, width, height);
}

function waitFor(video: HTMLVideoElement, eventName: "loadedmetadata" | "seeked", timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    function finish(ok: boolean) {
      window.clearTimeout(timer);
      video.removeEventListener(eventName, onEvent);
      video.removeEventListener("error", onError);
      resolve(ok);
    }
    function onEvent() { finish(true); }
    function onError() { finish(false); }
    video.addEventListener(eventName, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

type VisualPart = Pick<UploadFingerprint, "hashes" | "mirrorHashes" | "width" | "height" | "durationMs">;

const EMPTY_VISUAL: VisualPart = { hashes: [], mirrorHashes: [], width: null, height: null, durationMs: null };

async function videoHashes(file: File): Promise<VisualPart> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    video.src = url;
    if (!(await waitFor(video, "loadedmetadata", METADATA_TIMEOUT_MS))) return EMPTY_VISUAL;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !video.videoWidth || !video.videoHeight) return EMPTY_VISUAL;
    const meta = { width: video.videoWidth, height: video.videoHeight, durationMs: Math.round(duration * 1000) };

    const size = sampleSize(video.videoWidth, video.videoHeight);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return { ...EMPTY_VISUAL, ...meta };

    // 从 0.5 秒起每秒一帧：两份来源的同一秒落在同一个镜头里的机会最大。
    const count = Math.min(MAX_VIDEO_FRAMES, Math.max(1, Math.floor(duration)));
    const frames: Array<GrayImage | null> = [];
    let failures = 0;
    const deadline = performance.now() + FRAME_BUDGET_MS;
    for (let index = 0; index < count && performance.now() < deadline; index += 1) {
      video.currentTime = Math.min(index + 0.5, Math.max(0, duration - 0.05));
      if (await waitFor(video, "seeked", SEEK_TIMEOUT_MS)) {
        frames.push(grabGray(context, video, size.width, size.height));
        failures = 0;
      } else {
        frames.push(null);
        failures += 1;
        if (failures >= MAX_SEEK_FAILURES) return { ...EMPTY_VISUAL, ...meta };
      }
    }

    const content = detectLetterbox(frames.filter((frame): frame is GrayImage => frame !== null));
    const hashes: Array<string | null> = [];
    const mirrorHashes: Array<string | null> = [];
    for (const frame of frames) {
      const result = frame ? hashRegion(frame, content) : { hash: null, mirror: null };
      hashes.push(result.hash);
      mirrorHashes.push(result.mirror);
    }
    return { hashes, mirrorHashes, ...meta };
  } catch {
    return EMPTY_VISUAL;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

async function decodeImage(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void } | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // 落到 <img>：Safari 里 HEIC 只有 <img> 认。
    }
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  const loaded = await new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = url;
  });
  if (!loaded || !image.naturalWidth) {
    URL.revokeObjectURL(url);
    return null;
  }
  return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
}

async function imageHashes(file: File): Promise<VisualPart> {
  const decoded = await decodeImage(file).catch(() => null);
  if (!decoded) return EMPTY_VISUAL;
  try {
    const size = sampleSize(decoded.width, decoded.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return { ...EMPTY_VISUAL, width: decoded.width, height: decoded.height };
    const gray = grabGray(context, decoded.source, size.width, size.height);
    const { hash, mirror } = hashRegion(gray, detectUniformBorder(gray));
    return { hashes: [hash], mirrorHashes: [mirror], width: decoded.width, height: decoded.height, durationMs: null };
  } catch {
    return EMPTY_VISUAL;
  } finally {
    decoded.release();
  }
}

export async function computeUploadFingerprint(file: File, kind: UploadMediaKind = guessMediaKind(file)): Promise<UploadFingerprint> {
  const [sha, visual] = await Promise.all([
    sampleSha256(file).catch(() => null),
    kind === "VIDEO" ? videoHashes(file) : kind === "IMAGE" ? imageHashes(file) : Promise.resolve(EMPTY_VISUAL),
  ]);
  return { size: file.size, name: file.name, sha, kind, ...visual };
}

// 同一个 File 只算一次：选文件时算好拿去查重，入库后登记指纹时直接取这一份。
const cache = new WeakMap<File, Promise<UploadFingerprint>>();

export function fingerprintFile(file: File, kind?: UploadMediaKind): Promise<UploadFingerprint> {
  let pending = cache.get(file);
  if (!pending) {
    pending = computeUploadFingerprint(file, kind);
    cache.set(file, pending);
  }
  return pending;
}
