import { readJsonResponse } from "../../lib/http-json.ts";

/**
 * 走到确认这一步时，视频和封面都已经在 COS 上了，剩下的只是一个很小的请求。
 * 遇到 5xx 或网络中断就原地再确认几次；以前一次抖动就把人赶回去重新建条目、重传文件，
 * 库里还会留下一条永远"正在入库"的空壳。
 */
const defaultRetryDelaysMs = [1000, 2000] as const;

export class UploadConfirmationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "UploadConfirmationError";
  }
}

type ConfirmOptions = {
  fetch?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
};

export async function confirmVideoUpload(
  videoId: string,
  {
    fetch: send = (input, init) => fetch(input, init),
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    retryDelaysMs = defaultRetryDelaysMs,
  }: ConfirmOptions = {},
): Promise<"confirmed" | "unauthorized"> {
  for (let attempt = 0; ; attempt += 1) {
    const canRetry = attempt < retryDelaysMs.length;
    let response: Response;
    try {
      response = await send(`/api/videos/${videoId}/complete`, { method: "POST" });
    } catch {
      if (canRetry) {
        await wait(retryDelaysMs[attempt]);
        continue;
      }
      throw new UploadConfirmationError("网络中断，入库确认没能发出去。", true);
    }
    if (response.status === 401) return "unauthorized";
    if (response.status >= 500 && canRetry) {
      await wait(retryDelaysMs[attempt]);
      continue;
    }

    // 4xx 是服务端核对后明确拒绝（文件没传上、大小对不上、会话失效），再确认也没用，得从头来。
    const retryable = response.status >= 500;
    let data: { error?: string };
    try {
      data = await readJsonResponse<{ error?: string }>(response, "确认视频上传完成");
    } catch (reason) {
      throw new UploadConfirmationError(
        reason instanceof Error ? reason.message : "确认视频上传完成失败，请重试。",
        retryable,
      );
    }
    if (!response.ok) {
      throw new UploadConfirmationError(data.error || "视频上传完成确认失败，请重试。", retryable);
    }
    return "confirmed";
  }
}
