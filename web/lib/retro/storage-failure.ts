import { cosFailureReason } from "@/storage/cos";

/**
 * 复盘库的接口要向对象存储核对刚传上去的文件、删掉移除的附件，这几步都可能被存储挡回来。
 * 存储层抛的是内部用的英文（`COS request failed (AUTHORIZATION).`），原样透给浏览器等于没说，
 * 所以这里按失败类别翻成人话（做法同 lib/visual-storage-failure.ts）：
 * - 权限不足：重试多少次都一样，得管理员去腾讯云补授权 retro/* 的读写删；
 * - 连不上／服务端抖动：稍后重试就行，文件多半已经在云端，不用重传。
 * 不是存储的问题就返回 null，交给调用方按自己的业务语义处理。
 */
export function retroStorageFailure(scope: string, error: unknown): { status: number; code: string; message: string } | null {
  const reason = cosFailureReason(error);
  if (!reason) return null;
  // 日志只记阶段和类别，不带对象键与签名 URL。
  console.error("retro storage request failed", { scope, reason });
  if (reason === "AUTHORIZATION") {
    return {
      status: 502,
      code: "STORAGE_FORBIDDEN",
      message: "对象存储拒绝了这次请求：这个账号没有 retro/ 目录的读写权限。请管理员在腾讯云 CAM 里给 retro/* 补上与 videos/、reports/、visual/ 相同的对象读写授权，再重试。",
    };
  }
  return {
    status: 503,
    code: "STORAGE_UNAVAILABLE",
    message: "暂时连不上对象存储，没能核对刚传上去的文件。文件多半已经在云端，稍后再试一次即可，不用重传。",
  };
}
