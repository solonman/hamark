"use client";

const THUMBNAIL_CONTENT_TYPE = "image/jpeg";
const THUMBNAIL_MAX_WIDTH = 1600;
const THUMBNAIL_QUALITY = 0.92;
const MEDIA_TIMEOUT_MS = 12000;

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
    const captureTime = duration > 2 ? 1 : Math.max(0, duration / 2);
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

    const blob = await canvasToJpeg(canvas);
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
