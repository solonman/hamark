// 录音点评改写的身份口径（docs/25 二、1）。纯函数，浏览器和服务端共用。
//
// 两件事分开：
//   - 谁能上传：名单里的人（按企微显示名判定，与 isCaseReviewer、AGENT_TOKEN_OWNER_NAMES 同一做法）。
//     2026-10-19 加「秦欣欣」：她替老孙上传，录音里点评的人仍是老孙。
//   - 录音里点评的人：始终是老孙。AI 只认他的话，点评版也一律叫「老孙录音点评」；
//     点评版的归属人则是实际上传、确认的那个人（她能直接改，别人改进自己的版本）。

import { CASE_REVIEWER_NAME } from "@/lib/case-review";

export const AUDIO_REVIEW_CRITIC_NAME = CASE_REVIEWER_NAME;

/** 点评版的统一叫法（2026-10-21 起录音、文字都叫「老孙点评」，不再叫「老孙录音点评」）。 */
export const AUDIO_REVIEW_VERSION_LABEL = `${AUDIO_REVIEW_CRITIC_NAME}点评`;

export const AUDIO_REVIEW_UPLOADER_NAMES: readonly string[] = [CASE_REVIEWER_NAME, "秦欣欣"];

export function isAudioReviewUploader(displayName: string | null | undefined): boolean {
  return AUDIO_REVIEW_UPLOADER_NAMES.includes((displayName ?? "").trim());
}

/** 老孙自己的版本不挂点评：他点评的是别人的作业。按版本归属人的显示名判定。 */
export function isAudioReviewCriticVersion(ownerName: string | null | undefined): boolean {
  return (ownerName ?? "").trim() === AUDIO_REVIEW_CRITIC_NAME;
}
