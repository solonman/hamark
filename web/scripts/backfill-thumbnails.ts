import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { spawn } from "node:child_process";

import { getDbClient, getVideoBucket } from "../db/index.ts";
import { applySchema } from "../db/bootstrap.ts";

type VideoWithoutThumbnail = {
  id: string;
  object_key: string;
};

const thumbnailContentType = "image/jpeg";

function positiveIntegerFromEnv(name: string) {
  const value = process.env[name];
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer when set.`);
  }
  return parsed;
}

function commandExists(command: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, ["-version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

function runFfmpeg(inputPath: string, outputPath: string, seekSeconds: number) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    String(seekSeconds),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    "scale='min(1600,iw)':-2",
    "-q:v",
    "2",
    outputPath,
  ];

  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

async function extractThumbnail(inputPath: string, outputPath: string) {
  try {
    await runFfmpeg(inputPath, outputPath, 1);
  } catch {
    await runFfmpeg(inputPath, outputPath, 0);
  }
}

async function downloadVideo(objectKey: string, outputPath: string) {
  const object = await getVideoBucket().get(objectKey);
  if (!object.body) {
    throw new Error(`COS object ${objectKey} did not return a readable body.`);
  }
  await pipeline(
    Readable.fromWeb(object.body as NodeReadableStream<Uint8Array>),
    createWriteStream(outputPath),
  );
}

async function loadPendingVideos() {
  const limit = positiveIntegerFromEnv("THUMBNAIL_BACKFILL_LIMIT");
  const db = getDbClient();
  let query = `SELECT id, object_key
    FROM videos
    WHERE status = 'READY'
      AND deleted_at IS NULL
      AND (thumbnail_key IS NULL OR thumbnail_key = '')
    ORDER BY created_at ASC`;
  if (limit) query += " LIMIT ?";
  const statement = db.prepare(query);
  const result = limit
    ? await statement.bind(limit).all<VideoWithoutThumbnail>()
    : await statement.all<VideoWithoutThumbnail>();
  return result.results;
}

async function backfillVideo(video: VideoWithoutThumbnail) {
  const db = getDbClient();
  const bucket = getVideoBucket();
  const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
  const workDir = await mkdtemp(path.join(tmpdir(), `hamark-thumbnail-${video.id}-`));
  const videoPath = path.join(workDir, "source-video");
  const thumbnailPath = path.join(workDir, "thumbnail.jpg");

  try {
    await downloadVideo(video.object_key, videoPath);
    await extractThumbnail(videoPath, thumbnailPath);
    const thumbnail = await readFile(thumbnailPath);
    await bucket.put(thumbnailKey, thumbnail, {
      httpMetadata: { contentType: thumbnailContentType },
      customMetadata: {
        videoId: video.id,
        generatedBy: "thumbnail-backfill",
      },
    });
    await db
      .prepare(
        `UPDATE videos
        SET thumbnail_key = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND (thumbnail_key IS NULL OR thumbnail_key = '')`,
      )
      .bind(thumbnailKey, video.id)
      .run();
    console.log(`Backfilled thumbnail for ${video.id}: ${thumbnailKey}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function main() {
  if (!(await commandExists("ffmpeg"))) {
    throw new Error("ffmpeg is required. Install it before running thumbnail backfill.");
  }

  await applySchema();
  const videos = await loadPendingVideos();
  if (videos.length === 0) {
    console.log("No READY videos need thumbnail backfill.");
    return;
  }

  console.log(`Backfilling thumbnails for ${videos.length} READY video(s).`);
  for (const video of videos) {
    await backfillVideo(video);
  }
}

await main();
