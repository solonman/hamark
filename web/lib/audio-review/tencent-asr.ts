// 腾讯云录音文件识别（docs/25 4.4）：CreateRecTask 提交、DescribeTaskStatus 查询。
// 只碰网络、不碰数据库；fetch 可注入，单测（tests/audio-review-asr.test.ts）用假传输层，
// 不真打腾讯云。所有失败都翻成中文原因，并标明是不是「过一会儿再试就可能好」的临时错误。
//
// 依据（核对于 2026-10-10）：
//   - 录音文件识别请求 CreateRecTask：https://cloud.tencent.com/document/api/1093/37823
//   - 录音文件识别结果查询 DescribeTaskStatus：https://cloud.tencent.com/document/api/1093/37822
//   - 公共参数与签名 v3：https://cloud.tencent.com/document/api/1093/35640、/35641

import { FACT_FIELDS, GROUP_FIELDS, SHOT_TEXT_FIELDS, vocabularyOptions } from "./fields";
import { signTc3Request, type Tc3Credentials } from "./tc3";
import type { AudioReviewTranscriptSegment } from "./transcript";
import { V04_UI_PATHS } from "@/lib/v04-ui-fixture";

export const TENCENT_ASR_HOST = "asr.tencentcloudapi.com";
export const TENCENT_ASR_SERVICE = "asr";
export const TENCENT_ASR_VERSION = "2019-06-14";
export const TENCENT_ASR_HOTWORD_WEIGHT = 10;
export const TENCENT_ASR_HOTWORD_LIMIT = 128;

export type AsrFetch = (input: string, init: RequestInit) => Promise<Response>;

export type TencentAsrOptions = {
  credentials: Tc3Credentials;
  fetchImpl?: AsrFetch;
  /** 签名时间（秒）；测试里固定。 */
  now?: () => number;
};

export type AsrErrorInfo = { reason: string; transient: boolean; code: string | null };

export type AsrSubmitOutcome =
  | { ok: true; taskId: string; usedHotwords: boolean }
  | ({ ok: false } & AsrErrorInfo);

export type AsrDescribeOutcome =
  | { kind: "PENDING"; status: 0 | 1 }
  | { kind: "SUCCESS"; segments: AudioReviewTranscriptSegment[]; durationMs: number | null }
  | { kind: "FAILED"; reason: string }
  | ({ kind: "ERROR" } & AsrErrorInfo);

// ---------------------------------------------------------------------------
// 请求参数
// ---------------------------------------------------------------------------

export type CreateRecTaskInput = {
  engine: string;
  /** 预签名 GET（3 小时）。 */
  audioUrl: string;
  /** 已经整理好的 `词|权重,词|权重`；空串表示不带热词。 */
  hotwordList: string;
};

export function buildCreateRecTaskParams(input: CreateRecTaskInput) {
  const params: Record<string, string | number> = {
    EngineModelType: input.engine,
    ChannelNum: 1,
    ResTextFormat: 2,
    SourceType: 0,
    Url: input.audioUrl,
    SpeakerDiarization: 1,
    SpeakerNumber: 0,
    ConvertNumMode: 1,
    FilterModal: 1,
  };
  if (input.hotwordList) params.HotwordList = input.hotwordList;
  return params;
}

/** 单个热词「最多 10 个汉字或 30 个字符」：汉字记 3，其余记 1。 */
function hotwordWidth(word: string) {
  let width = 0;
  for (const ch of word) width += (ch.codePointAt(0) ?? 0) <= 0xff ? 1 : 3;
  return width;
}

/**
 * 热词：「老孙」和被点评人姓名排最前，其次是通用机制标签（最容易被听成同音字，如「对置生义」），
 * 再是工作台字段名、主导路径细项名、桥段作用与故事参照类型。带「／」的标签拆开各算一个；
 * 去掉标点；超长的跳过；去重后最多 128 个，每个权重 10。
 */
export function buildAsrHotwords(input: { reviewerName: string; revieweeName: string }) {
  const words: string[] = [input.reviewerName, input.revieweeName];
  const labelParts = (label: string) => [label, ...label.split("／")];
  for (const option of vocabularyOptions("generalMechanism")) words.push(...labelParts(option.labelZhCn));
  for (const field of FACT_FIELDS) words.push(field.name.replace(/（.*?）/g, ""));
  words.push("主导机制", "辅助机制", "手法", "进阶机制层", "主导路径", "辅助路径", "主导路径细项", "桥段", "镜头");
  for (const field of GROUP_FIELDS) words.push(field.name);
  for (const field of SHOT_TEXT_FIELDS) words.push(...labelParts(field.label.replace(/（.*?）/g, "")));
  for (const path of V04_UI_PATHS) {
    words.push(...labelParts(path.label));
    for (const name of path.fields) words.push(...labelParts(name));
  }
  for (const option of vocabularyOptions("bridgeCreativeRole")) words.push(...labelParts(option.labelZhCn));
  for (const option of vocabularyOptions("storyReferenceType")) words.push(option.labelZhCn);

  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of words) {
    const word = (raw ?? "").replace(/[\s,，|｜/／、。.：:；;（）()《》"“”'‘’!！?？]/g, "");
    if (!word || seen.has(word) || hotwordWidth(word) > 30) continue;
    seen.add(word);
    result.push(word);
    if (result.length >= TENCENT_ASR_HOTWORD_LIMIT) break;
  }
  return result;
}

export function formatHotwordList(words: readonly string[]) {
  return words.slice(0, TENCENT_ASR_HOTWORD_LIMIT).map((word) => `${word}|${TENCENT_ASR_HOTWORD_WEIGHT}`).join(",");
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

const AUTH_HINT = "请检查 TENCENT_ASR_SECRET_ID / TENCENT_ASR_SECRET_KEY（未配置时用的是 COS_SECRET_*）是否正确，以及该子账号是否有语音识别 CreateRecTask、DescribeTaskStatus 的权限。";

/** 接口级错误码（Response.Error.Code）→ 中文原因 + 是否临时。 */
export function describeTencentAsrError(code: string | null, message: string | null): AsrErrorInfo {
  const text = message?.trim() ?? "";
  const c = code ?? "";
  if (c === "AuthFailure.UnauthorizedOperation" || c.startsWith("UnauthorizedOperation")) {
    if (/欠费|arrear|isolat|余额|no ?amount|未开通|not ?open/i.test(`${c} ${text}`)) {
      return { reason: "腾讯云语音识别未开通或账户欠费，请到腾讯云控制台确认「录音文件识别」可用。", transient: false, code: c };
    }
    return { reason: `腾讯云转写没有权限。${AUTH_HINT}`, transient: false, code: c };
  }
  if (c.startsWith("AuthFailure")) {
    return { reason: `腾讯云转写鉴权失败。${AUTH_HINT}`, transient: false, code: c };
  }
  if (/InArrears|Arrears|NoAmount|NoFreeAmount|ServiceIsolate|UserNotRegistered|ResourceInsufficient|OutOfQuota/i.test(c) ||
    /欠费|余额不足|未开通|已隔离/.test(text)) {
    return { reason: "腾讯云语音识别账户欠费或未开通，请到腾讯云控制台确认「录音文件识别」可用。", transient: false, code: c };
  }
  if (c.startsWith("RequestLimitExceeded") || c.startsWith("LimitExceeded")) {
    return { reason: "腾讯云转写请求超出频率限制，稍后会自动重试。", transient: true, code: c };
  }
  if (/download|下载|ErrorDownFile/i.test(`${c} ${text}`)) {
    return { reason: "腾讯云没能下载录音文件，请重试；仍然失败时请重新上传。", transient: false, code: c };
  }
  if (c.startsWith("InternalError") || c === "ResourceUnavailable" || c.startsWith("FailedOperation.ServiceBusy")) {
    return { reason: "腾讯云转写服务暂时异常，稍后会自动重试。", transient: true, code: c };
  }
  if (c.startsWith("InvalidParameter") || c.startsWith("MissingParameter") || c.startsWith("UnsupportedOperation")) {
    return { reason: `提交转写的参数不被接受：${text || c}`, transient: false, code: c };
  }
  if (c.startsWith("FailedOperation")) {
    return { reason: `腾讯云识别失败：${text || c}`, transient: false, code: c };
  }
  return { reason: `腾讯云转写返回错误：${text || c || "未知错误"}`, transient: false, code: c || null };
}

/** 热词参数无效（格式、长度、个数不被接受）时，去掉热词再提交一次。 */
export function isHotwordParameterError(code: string | null, message: string | null) {
  return Boolean(code?.startsWith("InvalidParameter")) && /hot ?word|热词/i.test(`${code} ${message ?? ""}`);
}

/** 任务级失败（Status=3 的 ErrorMsg）→ 中文原因。 */
export function describeAsrTaskFailure(errorMsg: string | null | undefined) {
  const text = errorMsg?.trim() ?? "";
  if (/download|下载/i.test(text)) return "腾讯云没能下载录音文件（链接过期或存储权限不够），请重试；仍然失败时请重新上传。";
  if (/decode|解码|format|格式|codec/i.test(text)) return "录音格式无法识别，请转成 mp3 或 m4a 后重新上传。";
  if (/duration|时长|too long|exceed|超过|超出/i.test(text)) return "录音时长或大小超出了转写上限，请截短后重新上传。";
  if (/silen|静音|no ?speech|empty/i.test(text)) return "录音里没有识别出说话内容，请确认录音是否完整。";
  return text ? `腾讯云识别失败：${text}` : "腾讯云识别失败，请重试。";
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

type CallOutcome =
  | { ok: true; data: Record<string, unknown> }
  | ({ ok: false; message: string | null } & AsrErrorInfo);

export async function callTencentAsr(
  action: "CreateRecTask" | "DescribeTaskStatus",
  params: Record<string, unknown>,
  options: TencentAsrOptions,
): Promise<CallOutcome> {
  const payload = JSON.stringify(params);
  const timestamp = options.now ? options.now() : Math.floor(Date.now() / 1000);
  const signed = await signTc3Request({
    service: TENCENT_ASR_SERVICE,
    host: TENCENT_ASR_HOST,
    action,
    version: TENCENT_ASR_VERSION,
    payload,
    timestamp,
    credentials: options.credentials,
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`https://${TENCENT_ASR_HOST}/`, {
      method: "POST",
      headers: signed.headers,
      body: payload,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, reason: "连接腾讯云语音识别失败（网络异常），稍后会自动重试。", transient: true, code: null, message: null };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      reason: `腾讯云语音识别返回了无法识别的内容（HTTP ${response.status}），稍后会自动重试。`,
      transient: true,
      code: null,
      message: null,
    };
  }
  const envelope = (body as { Response?: Record<string, unknown> } | null)?.Response;
  if (!envelope || typeof envelope !== "object") {
    return {
      ok: false,
      reason: `腾讯云语音识别返回了无法识别的内容（HTTP ${response.status}），稍后会自动重试。`,
      transient: true,
      code: null,
      message: null,
    };
  }
  const error = envelope.Error as { Code?: unknown; Message?: unknown } | undefined;
  if (error) {
    const code = typeof error.Code === "string" ? error.Code : null;
    const message = typeof error.Message === "string" ? error.Message : null;
    return { ok: false, message, ...describeTencentAsrError(code, message) };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: `腾讯云语音识别请求失败（HTTP ${response.status}），稍后会自动重试。`,
      transient: response.status >= 500 || response.status === 429,
      code: null,
      message: null,
    };
  }
  const data = envelope.Data;
  if (!data || typeof data !== "object") {
    return { ok: false, reason: "腾讯云语音识别没有返回任务数据。", transient: true, code: null, message: null };
  }
  return { ok: true, data: data as Record<string, unknown> };
}

export async function createRecTask(input: CreateRecTaskInput, options: TencentAsrOptions): Promise<AsrSubmitOutcome> {
  let usedHotwords = Boolean(input.hotwordList);
  let outcome = await callTencentAsr("CreateRecTask", buildCreateRecTaskParams(input), options);
  if (!outcome.ok && usedHotwords && isHotwordParameterError(outcome.code, outcome.message)) {
    usedHotwords = false;
    outcome = await callTencentAsr("CreateRecTask", buildCreateRecTaskParams({ ...input, hotwordList: "" }), options);
  }
  if (!outcome.ok) return { ok: false, reason: outcome.reason, transient: outcome.transient, code: outcome.code };
  const taskId = outcome.data.TaskId;
  if (typeof taskId !== "number" && typeof taskId !== "string") {
    return { ok: false, reason: "腾讯云没有返回转写任务编号。", transient: true, code: null };
  }
  return { ok: true, taskId: String(taskId), usedHotwords };
}

export async function describeTaskStatus(taskId: string, options: TencentAsrOptions): Promise<AsrDescribeOutcome> {
  const numericId = Number(taskId);
  const outcome = await callTencentAsr(
    "DescribeTaskStatus",
    { TaskId: Number.isSafeInteger(numericId) ? numericId : taskId },
    options,
  );
  if (!outcome.ok) return { kind: "ERROR", reason: outcome.reason, transient: outcome.transient, code: outcome.code };
  return interpretTaskStatus(outcome.data);
}

/** DescribeTaskStatus 的 Data → 结果。Status：0 等待、1 执行中、2 成功、3 失败。 */
export function interpretTaskStatus(data: Record<string, unknown>): AsrDescribeOutcome {
  const status = Number(data.Status);
  if (status === 0 || status === 1) return { kind: "PENDING", status };
  if (status === 3) {
    return { kind: "FAILED", reason: describeAsrTaskFailure(typeof data.ErrorMsg === "string" ? data.ErrorMsg : null) };
  }
  if (status !== 2) return { kind: "ERROR", reason: "腾讯云返回了未知的任务状态，稍后会自动重试。", transient: true, code: null };
  const segments = parseTencentAsrSegments(data);
  if (segments.length === 0) {
    return { kind: "FAILED", reason: "录音里没有识别出说话内容，请确认录音是否完整。" };
  }
  const seconds = Number(data.AudioDuration);
  return {
    kind: "SUCCESS",
    segments,
    // AudioDuration 单位是秒（浮点）。
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
  };
}

/**
 * 每句一段：优先读 ResultDetail（ResTextFormat=2 带说话人和起止毫秒），text 取 FinalSentence；
 * 万一没有 ResultDetail，退回解析 Result 文本里的 `[分:秒.毫秒,分:秒.毫秒,说话人]  文字` 行。
 */
export function parseTencentAsrSegments(data: Record<string, unknown>): AudioReviewTranscriptSegment[] {
  const segments: AudioReviewTranscriptSegment[] = [];
  const detail = Array.isArray(data.ResultDetail) ? data.ResultDetail : [];
  for (const item of detail) {
    if (!item || typeof item !== "object") continue;
    const sentence = item as Record<string, unknown>;
    const text = typeof sentence.FinalSentence === "string" ? sentence.FinalSentence.trim() : "";
    if (!text) continue;
    const speaker = Number(sentence.SpeakerId);
    segments.push({
      id: segments.length + 1,
      startMs: Math.max(0, Math.round(Number(sentence.StartMs) || 0)),
      endMs: Math.max(0, Math.round(Number(sentence.EndMs) || 0)),
      speakerId: `S${Number.isInteger(speaker) && speaker >= 0 ? speaker : 0}`,
      text,
    });
  }
  if (segments.length > 0 || typeof data.Result !== "string") return segments;

  const line = /^\[(\d+):(\d+(?:\.\d+)?),(\d+):(\d+(?:\.\d+)?)(?:,(\d+))?\]\s*(.*)$/;
  for (const raw of data.Result.split(/\r?\n/)) {
    const match = line.exec(raw.trim());
    if (!match || !match[6].trim()) continue;
    const toMs = (minutes: string, seconds: string) => Math.round((Number(minutes) * 60 + Number(seconds)) * 1000);
    segments.push({
      id: segments.length + 1,
      startMs: toMs(match[1], match[2]),
      endMs: toMs(match[3], match[4]),
      speakerId: `S${match[5] ?? 0}`,
      text: match[6].trim(),
    });
  }
  return segments;
}
