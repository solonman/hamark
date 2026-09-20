import { cosFailureReason } from "@/storage/cos";

/**
 * 公共视觉的接口要向对象存储核对刚传上去的文件、删掉移除的素材，这几步都可能被存储挡回来。
 * 存储层抛的是内部用的英文（`COS request failed (AUTHORIZATION).`），原样透给浏览器等于没说，
 * 所以这里按失败类别翻成人话——做法同视频域的 lib/upload-completion-failure.ts。
 *
 * 两类要分开说：
 * - 权限不足：重试多少次都一样，得管理员去腾讯云补授权（子账号原来只授权了 videos/、reports/）。
 * - 连不上／服务端抖动：稍后重试就行，文件多半已经在云端，不用重传。
 *
 * 不是存储的问题就返回 null，交给调用方按自己的业务语义处理。
 */
export function visualStorageFailureResponse(scope: string, error: unknown): Response | null {
  const reason = cosFailureReason(error);
  if (!reason) return null;
  // 日志只记阶段和类别，不带对象键与签名 URL。
  console.error("visual storage request failed", { scope, reason });

  if (reason === "AUTHORIZATION") {
    return Response.json(
      {
        error: "对象存储拒绝了这次请求：这个账号没有 visual/ 目录的读写权限。请管理员在腾讯云 CAM 里给 visual/* 补上与 videos/、reports/ 相同的对象读写授权，再重试。",
      },
      { status: 502 },
    );
  }

  return Response.json(
    {
      error: "暂时连不上对象存储，没能核对刚传上去的文件。文件多半已经在云端，稍后再试一次即可，不用重传。",
      retryable: true,
    },
    { status: 503 },
  );
}
