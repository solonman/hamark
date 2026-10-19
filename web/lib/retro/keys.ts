// 客户需求复盘库的对象键与站内地址。对象存储只用一个前缀 retro/*（docs/26 八）：
//   retro/cases/{caseId}/assets/{assetId}/original.<ext>   附件原件（需求凭证与回合附件同一目录，归属看 round_id）
//   retro/cases/{caseId}/assets/{assetId}/cover.jpg        视频封面（浏览器截帧）
//   retro/cases/{caseId}/assets/{assetId}/thumb.jpg|display.jpg   图片派生图
//   retro/recordings/{id}/original                          点评录音

import type { RetroAssetType } from "@/lib/retro-model";
import { visualObjectExtension } from "@/lib/visual-model";

export function retroAssetDir(caseId: string, assetId: string): string {
  return `retro/cases/${caseId}/assets/${assetId}`;
}

export function retroAssetOriginalKey(caseId: string, assetId: string, originalName: string | null | undefined): string {
  return `${retroAssetDir(caseId, assetId)}/original.${visualObjectExtension(originalName)}`;
}

export function retroAssetCoverKey(caseId: string, assetId: string): string {
  return `${retroAssetDir(caseId, assetId)}/cover.jpg`;
}

export function retroAssetThumbKey(caseId: string, assetId: string): string {
  return `${retroAssetDir(caseId, assetId)}/thumb.jpg`;
}

export function retroAssetDisplayKey(caseId: string, assetId: string): string {
  return `${retroAssetDir(caseId, assetId)}/display.jpg`;
}

export function retroRecordingObjectKey(recordingId: string): string {
  return `retro/recordings/${recordingId}/original`;
}

export function retroRecordingAudioPath(recordingId: string): string {
  return `/api/retro-recordings/${encodeURIComponent(recordingId)}/audio`;
}

/** 站内打开地址：图片原图、PDF、Office 下载走 original；视频、音频走 stream（规格 4.3、九）。 */
export function retroAssetOpenPath(caseId: string, assetId: string, type: RetroAssetType): string {
  const base = `/api/retro-cases/${encodeURIComponent(caseId)}/assets/${encodeURIComponent(assetId)}`;
  return type === "VIDEO" || type === "AUDIO" ? `${base}/stream` : `${base}/original`;
}

/** 新行 id：前缀 + UUID（案例 rtc、回合 rnd、附件 rta、录音 rtr）。自己写一份，免得拉进只能在 Next 里加载的会话模块。 */
export function retroNewId(prefix: "rtc" | "rnd" | "rta" | "rtr"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
