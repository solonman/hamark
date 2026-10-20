// 库首页卡片的封面图（docs/26 10.2，2026-10-20）：纯函数，单测在 tests/retro-doc-preview.test.ts。
//
// 顺序：「需求凭证 → 第 1 回合 → 第 2 回合 …」，每处按 position；先找第一张就绪图片（480w 缩略图），
// 没有图片再找第一个有截帧的视频，再没有找第一个就绪文档的第 1 页小图。一个都没有返回 null（文字封面）。

import type { RetroCaseCover } from "@/lib/retro-model";
import { retroDocPagesFromStored } from "./doc-preview";

export type RetroCoverCandidate = {
  id: string;
  caseId: string;
  /** null = 需求凭证（排最前）；否则是回合的 position。 */
  roundPosition: number | null;
  position: number;
  type: string;
  uploadStatus: string;
  derivativeStatus: string;
  thumbnailKey: string | null;
  /** 文档 pages_json 的第一项（或整份），只看第 1 页。 */
  firstPage: unknown;
};

export type RetroCoverPick = { key: string; kind: RetroCaseCover["kind"] };

const ownerRank = (candidate: RetroCoverCandidate) => (candidate.roundPosition === null ? -1 : candidate.roundPosition);

function firstDocPageKey(candidate: RetroCoverCandidate): string | null {
  const stored = Array.isArray(candidate.firstPage) ? candidate.firstPage : candidate.firstPage ? [candidate.firstPage] : [];
  const page = retroDocPagesFromStored(stored, candidate.caseId, candidate.id).find((item) => item.pageNo === 1);
  return page?.ok ? page.thumbKey : null;
}

export function pickRetroCaseCover(candidates: readonly RetroCoverCandidate[]): RetroCoverPick | null {
  const ordered = candidates
    .filter((candidate) => candidate.uploadStatus === "READY" && candidate.derivativeStatus === "READY")
    .sort((a, b) => ownerRank(a) - ownerRank(b) || a.position - b.position);
  const image = ordered.find((candidate) => candidate.type === "IMAGE" && candidate.thumbnailKey);
  if (image?.thumbnailKey) return { key: image.thumbnailKey, kind: "IMAGE" };
  const video = ordered.find((candidate) => candidate.type === "VIDEO" && candidate.thumbnailKey);
  if (video?.thumbnailKey) return { key: video.thumbnailKey, kind: "VIDEO" };
  for (const candidate of ordered) {
    if (candidate.type !== "DOC") continue;
    const key = firstDocPageKey(candidate);
    if (key) return { key, kind: "DOC" };
  }
  return null;
}
