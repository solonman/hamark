// 附件直传用的浏览器端小工具：XHR 直传（带进度）、并发 3 个、读图片／视频／音频的元数据。
// 写法照 components/visual/VisualUploadDialog.tsx（那边没导出，规格 4.3 说「上传方式照公共视觉」），
// 录音的直传和校验另用 V19AudioReviewUploadDialog 导出的 putAudioReviewFile／validateAudioReviewFile。

export function putFile(url: string, file: Blob, contentType: string, onProgress: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("Content-Type", contentType || "application/octet-stream");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) { onProgress(file.size); resolve(); }
      else reject(new Error("文件上传失败，请重试。"));
    });
    request.addEventListener("error", () => reject(new Error("文件上传失败，请检查网络后重试。")));
    request.send(file);
  });
}

/** 同时传 3 个（规格 4.3）。 */
export async function runWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function pull(): Promise<void> {
    const index = cursor;
    cursor += 1;
    if (index >= items.length) return;
    await worker(items[index]);
    return pull();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => pull()));
}

export function readImageDimensions(file: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const done = (value: { width: number; height: number }) => { URL.revokeObjectURL(url); resolve(value); };
    img.onload = () => done({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
    img.onerror = () => done({ width: 0, height: 0 });
    img.src = url;
  });
}

function readMediaMetadata(file: Blob, tag: "video" | "audio"): Promise<{ durationSeconds: number; width: number; height: number }> {
  return new Promise((resolve) => {
    const media = document.createElement(tag);
    const objectUrl = URL.createObjectURL(file);
    const finish = (value: { durationSeconds: number; width: number; height: number }) => {
      URL.revokeObjectURL(objectUrl);
      media.removeAttribute("src");
      media.load();
      resolve(value);
    };
    media.preload = "metadata";
    media.muted = true;
    media.onloadedmetadata = () => finish({
      durationSeconds: Number.isFinite(media.duration) ? Math.round(media.duration) : 0,
      width: tag === "video" ? (media as HTMLVideoElement).videoWidth || 0 : 0,
      height: tag === "video" ? (media as HTMLVideoElement).videoHeight || 0 : 0,
    });
    media.onerror = () => finish({ durationSeconds: 0, width: 0, height: 0 });
    media.src = objectUrl;
    media.load();
  });
}

export const readVideoMetadata = (file: Blob) => readMediaMetadata(file, "video");
export const readAudioMetadata = (file: Blob) => readMediaMetadata(file, "audio");

/** 下载（Word／Excel／PPT 浏览器打不开，点开就是下载；服务端回 Content-Disposition: attachment）。 */
export function triggerDownload(url: string, fileName: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
