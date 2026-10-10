// 转写结果在库里（audio_reviews.transcript_json）的形状，以及读它的小工具。
// 腾讯云的结果只保留 24 小时，拿到就落库；之后一切（提示词、校验、展示）都只读这一份。

export type AudioReviewTranscriptSegment = {
  /** 从 1 起的句序号；模型引用片段、意见引用原话都用它。 */
  id: number;
  startMs: number;
  endMs: number;
  /** 说话人分离的编号：S0、S1…（腾讯云 SpeakerId 0、1… 前面加 S）。 */
  speakerId: string;
  text: string;
};

export type AudioReviewTranscript = {
  segments: AudioReviewTranscriptSegment[];
  durationMs: number | null;
  engine: string;
};

export function parseStoredTranscript(value: unknown): AudioReviewTranscript | null {
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.segments)) return null;
  const segments: AudioReviewTranscriptSegment[] = [];
  for (const item of record.segments) {
    if (!item || typeof item !== "object") continue;
    const segment = item as Record<string, unknown>;
    const id = Number(segment.id);
    const text = typeof segment.text === "string" ? segment.text : "";
    if (!Number.isInteger(id) || !text.trim()) continue;
    segments.push({
      id,
      startMs: Math.max(0, Number(segment.startMs) || 0),
      endMs: Math.max(0, Number(segment.endMs) || 0),
      speakerId: typeof segment.speakerId === "string" && segment.speakerId ? segment.speakerId : "S0",
      text,
    });
  }
  return {
    segments,
    durationMs: record.durationMs == null ? null : Number(record.durationMs) || null,
    engine: typeof record.engine === "string" ? record.engine : "",
  };
}

export function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** 模型看到的时间：mm:ss（超过一小时写 h:mm:ss），与界面上的时间点一致。 */
export function transcriptClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 说话人里说得最多（按字数）的那一位——模型没认出老孙时的兜底。 */
export function dominantSpeaker(segments: readonly AudioReviewTranscriptSegment[]) {
  const totals = new Map<string, number>();
  for (const segment of segments) {
    totals.set(segment.speakerId, (totals.get(segment.speakerId) ?? 0) + segment.text.length);
  }
  let best = "S0";
  let bestCount = -1;
  for (const [speaker, count] of totals) {
    if (count > bestCount) {
      best = speaker;
      bestCount = count;
    }
  }
  return best;
}
