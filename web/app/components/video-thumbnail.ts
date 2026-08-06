"use client";

const THUMBNAIL_CONTENT_TYPE = "image/jpeg";
const THUMBNAIL_MAX_WIDTH = 1600;
const THUMBNAIL_QUALITY = 0.92;
const MEDIA_TIMEOUT_MS = 12000;
const BLACK_FRAME_AVERAGE_BRIGHTNESS = 18;
const BLACK_FRAME_BRIGHT_PIXEL_RATIO = 0.02;

function waitForMediaEvent(
  video: HTMLVideoElement,
  eventName: keyof HTMLMediaElementEventMap,
  errorMessage: string,
) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(errorMessage));
    }, MEDIA_TIMEOUT_MS);

    function cleanup() {
      window.clearTimeout(timeout);
      video.removeEventListener(eventName, handleEvent);
      video.removeEventListener("error", handleError);
    }

    function handleEvent() {
      cleanup();
      resolve();
    }

    function handleError() {
      cleanup();
      reject(new Error("浏览器无法读取该视频，暂时不能生成封面。"));
    }

    video.addEventListener(eventName, handleEvent, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("封面生成失败，请换一个浏览器可解码的视频。"));
          return;
        }
        resolve(blob);
      },
      THUMBNAIL_CONTENT_TYPE,
      THUMBNAIL_QUALITY,
    );
  });
}

function thumbnailCandidateTimes(duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  const candidates = [
    1,
    3,
    duration * 0.1,
    duration * 0.25,
    duration * 0.5,
  ];
  return Array.from(
    new Set(
      candidates
        .map((time) => Math.min(Math.max(0, time), Math.max(0, duration - 0.1)))
        .map((time) => Number(time.toFixed(2))),
    ),
  );
}

function isLikelyBlackFrame(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) return false;

  const sampleWidth = Math.min(64, canvas.width);
  const sampleHeight = Math.min(64, canvas.height);
  const image = context.getImageData(0, 0, sampleWidth, sampleHeight);
  let brightnessTotal = 0;
  let brightPixels = 0;
  const pixels = image.data.length / 4;

  for (let index = 0; index < image.data.length; index += 4) {
    const brightness =
      image.data[index] * 0.299 +
      image.data[index + 1] * 0.587 +
      image.data[index + 2] * 0.114;
    brightnessTotal += brightness;
    if (brightness > BLACK_FRAME_AVERAGE_BRIGHTNESS) brightPixels += 1;
  }

  return (
    brightnessTotal / pixels < BLACK_FRAME_AVERAGE_BRIGHTNESS &&
    brightPixels / pixels < BLACK_FRAME_BRIGHT_PIXEL_RATIO
  );
}

async function captureCanvasAtTime(
  video: HTMLVideoElement,
  captureTime: number,
  sourceWidth: number,
  sourceHeight: number,
) {
  if (captureTime > 0) {
    video.currentTime = captureTime;
    await waitForMediaEvent(video, "seeked", "定位封面帧超时，无法生成封面。");
  } else if (video.readyState < video.HAVE_CURRENT_DATA) {
    await waitForMediaEvent(video, "loadeddata", "读取封面帧超时，无法生成封面。");
  }

  const width = Math.min(THUMBNAIL_MAX_WIDTH, sourceWidth);
  const height = Math.round((sourceHeight / sourceWidth) * width);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("当前浏览器不支持生成视频封面。");
  }
  context.drawImage(video, 0, 0, width, height);
  return canvas;
}

export async function createThumbnailFromVideoFile(file: File) {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = objectUrl;

  try {
    video.load();
    await waitForMediaEvent(video, "loadedmetadata", "读取视频信息超时，无法生成封面。");

    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      throw new Error("视频尺寸不可用，无法生成封面。");
    }

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    let fallbackCanvas: HTMLCanvasElement | null = null;
    let canvas: HTMLCanvasElement | null = null;
    for (const captureTime of thumbnailCandidateTimes(duration)) {
      const candidate = await captureCanvasAtTime(
        video,
        captureTime,
        sourceWidth,
        sourceHeight,
      );
      fallbackCanvas ??= candidate;
      if (!isLikelyBlackFrame(candidate)) {
        canvas = candidate;
        break;
      }
    }

    const blob = await canvasToJpeg(canvas ?? fallbackCanvas!);
    return new File([blob], "thumbnail.jpg", {
      type: THUMBNAIL_CONTENT_TYPE,
      lastModified: Date.now(),
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
    video.removeAttribute("src");
    video.load();
  }
}
