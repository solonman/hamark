import type { V04ContentSummary } from "@/lib/v04-domain";

export function formatV04HistoryTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("zh-CN", { hour12: false });
}

export function describeV04ContentSummary(
  summary: V04ContentSummary | null | undefined,
  payloadBytes?: number,
) {
  if (!summary) {
    return payloadBytes
      ? `内容体积约 ${Math.max(1, Math.round(payloadBytes / 1024))} KB · 摘要未读取（版本较早）`
      : "内容摘要未读取（版本较早）";
  }
  if (summary.empty) return "空白版本 · 不含任何内容";
  return `${summary.bridgeCount} 个桥段 · ${summary.shotCount} 个镜头 · ${summary.filledFieldCount} 项已填`;
}

/**
 * What restoring this version would remove from the working draft. Restore
 * replaces the whole draft, so a version holding less than the current one is
 * a content-losing action and has to say so before it runs, not after.
 */
export function describeV04RestoreLoss(
  current: V04ContentSummary | null | undefined,
  target: V04ContentSummary | null | undefined,
) {
  if (!current || !target) return "";
  const losses = [
    { label: "个桥段", delta: current.bridgeCount - target.bridgeCount },
    { label: "个镜头", delta: current.shotCount - target.shotCount },
    { label: "项已填内容", delta: current.filledFieldCount - target.filledFieldCount },
  ].filter((item) => item.delta > 0);
  if (!losses.length) return "";
  return `该版本比当前工作稿少 ${losses.map((item) => `${item.delta} ${item.label}`).join("、")}。`;
}
