// 客户需求复盘库的对象键与站内地址。对象存储只用一个前缀 retro/*（docs/26 八）：
//   retro/cases/{caseId}/assets/{assetId}/original.<ext>   附件原件（需求凭证与回合附件同一目录，归属看 round_id）
//   retro/cases/{caseId}/assets/{assetId}/cover.jpg        视频封面（浏览器截帧）
//   retro/cases/{caseId}/assets/{assetId}/thumb.jpg|display.jpg   图片派生图
//   retro/cases/{caseId}/assets/{assetId}/pages/p{N}@2x.jpg|p{N}.jpg   文档逐页预览（1600w 大图、480w 小图，N 从 1 起）
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

export type RetroPageSize = "large" | "small";

export function retroAssetPagesDir(caseId: string, assetId: string): string {
  return `${retroAssetDir(caseId, assetId)}/pages/`;
}

/** 数据万象 doc_jobs 的输出模板：`${Number}` 由数据万象换成页号（从 1 起）。 */
/**
 * 数据万象 doc_jobs 的输出模板。表格（Excel、CSV）必须带 ${SheetID}，否则数据万象直接拒收
 * （「Output.Object must contain ${SheetID}」）；读回时用查询结果里的 TgtUri，不靠这里猜文件名。
 */
export function retroAssetPageTemplate(caseId: string, assetId: string, size: RetroPageSize, spreadsheet = false): string {
  const name = spreadsheet ? "s${SheetID}p${Number}" : "p${Number}";
  return `${retroAssetPagesDir(caseId, assetId)}${name}${size === "large" ? "@2x" : ""}.jpg`;
}

export function retroAssetPageKey(caseId: string, assetId: string, pageNo: number, size: RetroPageSize): string {
  return `${retroAssetPagesDir(caseId, assetId)}p${pageNo}${size === "large" ? "@2x" : ""}.jpg`;
}

export function retroRecordingObjectKey(recordingId: string): string {
  return `retro/recordings/${recordingId}/original`;
}

export function retroRecordingAudioPath(recordingId: string): string {
  return `/api/retro-recordings/${encodeURIComponent(recordingId)}/audio`;
}

function retroAssetApiBase(caseId: string, assetId: string): string {
  return `/api/retro-cases/${encodeURIComponent(caseId)}/assets/${encodeURIComponent(assetId)}`;
}

/** 站内播放：只有视频、音频有，走 stream。 */
export function retroAssetStreamPath(caseId: string, assetId: string, type: RetroAssetType): string | null {
  return type === "VIDEO" || type === "AUDIO" ? `${retroAssetApiBase(caseId, assetId)}/stream` : null;
}

/** 新行 id：前缀 + UUID（案例 rtc、回合 rnd、附件 rta、录音 rtr）。自己写一份，免得拉进只能在 Next 里加载的会话模块。 */
export function retroNewId(prefix: "rtc" | "rnd" | "rta" | "rtr"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
