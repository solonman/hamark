import { cosFailureReason } from "../storage/cos.ts";

/**
 * 确认入库要先向 COS 核对刚传上去的文件，再写库，两头都可能临时抖一下。
 * 以前这里没接住，路由直接抛出去，浏览器只拿到一个空的 500，只能说"服务器返回了空响应"。
 * 接住以后回 503 和一句人话：文件已经在云端了，稍后再确认一次就行，不用重传。
 */
export function uploadCompletionFailure(videoId: string, error: unknown) {
  const storageReason = cosFailureReason(error);
  // 日志只记阶段和失败类别，不带对象键、签名 URL 或 SQL 细节。
  console.error("upload completion failed", {
    videoId,
    stage: storageReason ? "STORAGE" : "DATABASE",
    reason: storageReason ?? (error instanceof Error ? error.name : "UNKNOWN"),
  });
  return Response.json(
    {
      error: storageReason
        ? "暂时连不上视频存储，没能核对刚传上去的文件。文件已经在云端，请稍后再确认一次。"
        : "文件已经传上去了，但入库记录暂时没写进去。请稍后再确认一次。",
      retryable: true,
    },
    { status: 503 },
  );
}
