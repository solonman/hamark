// 腾讯云录音文件识别：TC3-HMAC-SHA256 签名（对照官方文档的固定向量）、请求构造、热词、
// 结果解析与错误码映射。传输层全部是假的，不打腾讯云。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { signTc3Request, tc3Date } from "../lib/audio-review/tc3";
import {
  TENCENT_ASR_HOST,
  buildAsrHotwords,
  buildCreateRecTaskParams,
  createRecTask,
  describeAsrTaskFailure,
  describeTaskStatus,
  describeTencentAsrError,
  formatHotwordList,
  interpretTaskStatus,
  isHotwordParameterError,
  parseTencentAsrSegments,
  type AsrFetch,
} from "../lib/audio-review/tencent-asr";

// ---------------------------------------------------------------------------
// TC3 签名：https://cloud.tencent.com/document/api/1093/35641 的示例（核对于 2026-10-10）。
// 文档把密钥打了码（SecretKey 写成 32 个星号），示例签名就是用这个字面值算出来的，
// 所以连最终签名一起都能逐字对上。
// ---------------------------------------------------------------------------

const DOC_PAYLOAD = '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}';
const docInput = (secretKey: string) => ({
  service: "cvm",
  host: "cvm.tencentcloudapi.com",
  action: "DescribeInstances",
  version: "2017-03-12",
  region: "ap-guangzhou",
  payload: DOC_PAYLOAD,
  timestamp: 1551113065,
  credentials: { secretId: "AKID********************************", secretKey },
});

test("TC3 signature reproduces the official worked example byte for byte", async () => {
  const signed = await signTc3Request(docInput("********************************"));
  assert.equal(signed.hashedPayload, "35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064");
  assert.equal(
    signed.canonicalRequest,
    [
      "POST",
      "/",
      "",
      "content-type:application/json; charset=utf-8",
      "host:cvm.tencentcloudapi.com",
      "x-tc-action:describeinstances",
      "",
      "content-type;host;x-tc-action",
      "35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064",
    ].join("\n"),
  );
  assert.equal(signed.hashedCanonicalRequest, "7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84");
  assert.equal(
    signed.stringToSign,
    "TC3-HMAC-SHA256\n1551113065\n2019-02-25/cvm/tc3_request\n7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84",
  );
  assert.equal(signed.signature, "10b1a37a7301a02ca19a647ad722d5e43b4b3cff309d421d85b46093f6ab6c4f");
  assert.equal(
    signed.authorization,
    "TC3-HMAC-SHA256 Credential=AKID********************************/2019-02-25/cvm/tc3_request, " +
      "SignedHeaders=content-type;host;x-tc-action, " +
      "Signature=10b1a37a7301a02ca19a647ad722d5e43b4b3cff309d421d85b46093f6ab6c4f",
  );
  assert.deepEqual(signed.headers, {
    Authorization: signed.authorization,
    "Content-Type": "application/json; charset=utf-8",
    Host: "cvm.tencentcloudapi.com",
    "X-TC-Action": "DescribeInstances",
    "X-TC-Timestamp": "1551113065",
    "X-TC-Version": "2017-03-12",
    "X-TC-Region": "ap-guangzhou",
  });
});

test("TC3 signature matches the earlier revision of the same document page (partly masked key)", async () => {
  const signed = await signTc3Request(docInput("Gu5t9xGARNpq86cd98joQYCN3*******"));
  assert.equal(signed.signature, "be4f67d323c78ab9acb7395e43c0dbcf822a9cfac32fea2449a7bc7726b770a3");
});

test("TC3 uses the UTC date, a different key changes the signature, and no region means no region header", async () => {
  // 北京时间 26 日 00:30 在 UTC 还是 25 日：签名日期必须按 UTC 取，否则跨零点那半天全部签名失效。
  assert.equal(tc3Date(Date.parse("2019-02-26T00:30:00+08:00") / 1000), "2019-02-25");
  const a = await signTc3Request(docInput("key-a"));
  const b = await signTc3Request(docInput("key-b"));
  assert.notEqual(a.signature, b.signature);
  assert.equal(a.hashedCanonicalRequest, b.hashedCanonicalRequest);
  const noRegion = await signTc3Request({ ...docInput("key-a"), region: undefined });
  assert.equal("X-TC-Region" in noRegion.headers, false);
});

// ---------------------------------------------------------------------------
// CreateRecTask
// ---------------------------------------------------------------------------

test("CreateRecTask parameters follow docs/25 4.4", () => {
  assert.deepEqual(buildCreateRecTaskParams({ engine: "16k_zh_en_2.0", audioUrl: "https://cos/x", hotwordList: "老孙|10" }), {
    EngineModelType: "16k_zh_en_2.0",
    ChannelNum: 1,
    ResTextFormat: 2,
    SourceType: 0,
    Url: "https://cos/x",
    SpeakerDiarization: 1,
    SpeakerNumber: 0,
    ConvertNumMode: 1,
    FilterModal: 1,
    HotwordList: "老孙|10",
  });
  assert.equal("HotwordList" in buildCreateRecTaskParams({ engine: "e", audioUrl: "u", hotwordList: "" }), false);
});

test("hotwords: reviewer and reviewee first, vocabulary labels split on ／, at most 128, weight 10, none too long", () => {
  const words = buildAsrHotwords({ reviewerName: "老孙", revieweeName: "刘梦娜" });
  assert.deepEqual(words.slice(0, 2), ["老孙", "刘梦娜"]);
  assert.ok(words.includes("对置生义"));
  assert.ok(words.includes("张力按钮"));
  assert.ok(words.includes("创意思维链"));
  assert.ok(words.length <= 128);
  assert.equal(new Set(words).size, words.length);
  for (const word of words) {
    assert.doesNotMatch(word, /[／/,|，\s]/, word);
    assert.ok([...word].reduce((width, ch) => width + ((ch.codePointAt(0) ?? 0) <= 0xff ? 1 : 3), 0) <= 30, word);
  }
  const list = formatHotwordList(words);
  assert.match(list, /^老孙\|10,刘梦娜\|10,/);
  assert.equal(list.split(",").length, words.length);
});

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

function fakeTencent(responses: Array<Record<string, unknown> | Error>) {
  const calls: Call[] = [];
  const fetchImpl: AsrFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

const options = (fetchImpl: AsrFetch) => ({
  credentials: { secretId: "AKIDtest", secretKey: "secret" },
  fetchImpl,
  now: () => 1760000000,
});

test("CreateRecTask posts a signed JSON request to asr.tencentcloudapi.com and returns the task id", async () => {
  const { calls, fetchImpl } = fakeTencent([{ Response: { Data: { TaskId: 1234567 }, RequestId: "r1" } }]);
  const outcome = await createRecTask({ engine: "16k_zh_en_2.0", audioUrl: "https://cos/a.m4a", hotwordList: "老孙|10" }, options(fetchImpl));
  assert.deepEqual(outcome, { ok: true, taskId: "1234567", usedHotwords: true, engine: "16k_zh_en_2.0" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://${TENCENT_ASR_HOST}/`);
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["X-TC-Action"], "CreateRecTask");
  assert.equal(headers["X-TC-Version"], "2019-06-14");
  assert.equal(headers["X-TC-Timestamp"], "1760000000");
  assert.match(headers.Authorization, /^TC3-HMAC-SHA256 Credential=AKIDtest\/\d{4}-\d{2}-\d{2}\/asr\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/);
  assert.equal(calls[0].body.Url, "https://cos/a.m4a");
  assert.equal(calls[0].body.SpeakerDiarization, 1);
});

test("an invalid hotword parameter is retried once without hotwords", async () => {
  const { calls, fetchImpl } = fakeTencent([
    { Response: { Error: { Code: "InvalidParameterValue.ErrorInvalidHotword", Message: "hotword list invalid" }, RequestId: "r1" } },
    { Response: { Data: { TaskId: 99 }, RequestId: "r2" } },
  ]);
  const outcome = await createRecTask({ engine: "e", audioUrl: "u", hotwordList: "坏词|10" }, options(fetchImpl));
  assert.deepEqual(outcome, { ok: true, taskId: "99", usedHotwords: false, engine: "e" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.HotwordList, "坏词|10");
  assert.equal("HotwordList" in calls[1].body, false);
  assert.equal(isHotwordParameterError("InvalidParameter", "热词格式错误"), true);
  assert.equal(isHotwordParameterError("InvalidParameter", "Url invalid"), false);
  assert.equal(isHotwordParameterError("AuthFailure", "hotword"), false);
});

const NO_AMOUNT = {
  Response: { Error: { Code: "FailedOperation.UserHasNoAmount", Message: "Resource pack exhausted! Please purchase resource packs！" }, RequestId: "r" },
};

test("an exhausted large-model resource pack falls back to the general 16k_zh engine and reports the engine used", async () => {
  const { calls, fetchImpl } = fakeTencent([NO_AMOUNT, { Response: { Data: { TaskId: 17044704621 }, RequestId: "r2" } }]);
  const outcome = await createRecTask({ engine: "16k_zh_en_2.0", audioUrl: "u", hotwordList: "老孙|10" }, options(fetchImpl));
  assert.deepEqual(outcome, { ok: true, taskId: "17044704621", usedHotwords: true, engine: "16k_zh" });
  assert.deepEqual(calls.map((call) => call.body.EngineModelType), ["16k_zh_en_2.0", "16k_zh"]);
  assert.equal(calls[1].body.HotwordList, "老孙|10");
});

test("both fallbacks can apply in turn: hotwords dropped first, then the engine switched", async () => {
  const { calls, fetchImpl } = fakeTencent([
    { Response: { Error: { Code: "InvalidParameter", Message: "HotwordList invalid" }, RequestId: "r1" } },
    NO_AMOUNT,
    { Response: { Data: { TaskId: 7 }, RequestId: "r3" } },
  ]);
  const outcome = await createRecTask({ engine: "16k_zh_en", audioUrl: "u", hotwordList: "坏词|10" }, options(fetchImpl));
  assert.deepEqual(outcome, { ok: true, taskId: "7", usedHotwords: false, engine: "16k_zh" });
  assert.deepEqual(calls.map((call) => [call.body.EngineModelType, "HotwordList" in call.body]), [
    ["16k_zh_en", true],
    ["16k_zh_en", false],
    ["16k_zh", false],
  ]);
});

test("no fallback when the general engine itself has no quota left", async () => {
  const { calls, fetchImpl } = fakeTencent([NO_AMOUNT]);
  const outcome = await createRecTask({ engine: "16k_zh", audioUrl: "u", hotwordList: "" }, options(fetchImpl));
  assert.equal(calls.length, 1);
  assert.deepEqual(outcome, { ok: false, reason: "腾讯云语音识别额度不足（大模型资源包已用完）。", transient: false, code: "FailedOperation.UserHasNoAmount" });
});

test("other submission errors are not retried and come back in Chinese", async () => {
  const { calls, fetchImpl } = fakeTencent([
    { Response: { Error: { Code: "AuthFailure.SignatureFailure", Message: "signature mismatch" }, RequestId: "r1" } },
  ]);
  const outcome = await createRecTask({ engine: "e", audioUrl: "u", hotwordList: "老孙|10" }, options(fetchImpl));
  assert.equal(calls.length, 1);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(outcome.reason, /鉴权失败/);
    assert.equal(outcome.transient, false);
  }
});

test("a network failure is transient", async () => {
  const { fetchImpl } = fakeTencent([new TypeError("fetch failed")]);
  const outcome = await createRecTask({ engine: "e", audioUrl: "u", hotwordList: "" }, options(fetchImpl));
  assert.deepEqual(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.transient, true);
    assert.match(outcome.reason, /网络异常/);
  }
});

test("error codes map to Chinese reasons: auth, arrears, rate limit, download, internal", () => {
  const auth = describeTencentAsrError("AuthFailure.SecretIdNotFound", "x");
  assert.match(auth.reason, /鉴权失败/);
  assert.equal(auth.transient, false);
  assert.match(describeTencentAsrError("AuthFailure.UnauthorizedOperation", "no permission").reason, /没有权限/);
  const noAmount = describeTencentAsrError("FailedOperation.UserHasNoAmount", "Resource pack exhausted! Please purchase resource packs！");
  assert.equal(noAmount.reason, "腾讯云语音识别额度不足（大模型资源包已用完）。");
  assert.equal(noAmount.transient, false);
  const arrears = describeTencentAsrError("FailedOperation.UserHasNoFreeAmount", "欠费");
  assert.match(arrears.reason, /欠费/);
  assert.equal(arrears.transient, false);
  assert.match(describeTencentAsrError("ResourceUnavailable.InArrears", null).reason, /欠费/);
  const limit = describeTencentAsrError("RequestLimitExceeded", "too many");
  assert.match(limit.reason, /频率/);
  assert.equal(limit.transient, true);
  assert.match(describeTencentAsrError("FailedOperation.ErrorDownFile", "download failed").reason, /下载录音/);
  assert.equal(describeTencentAsrError("InternalError", "oops").transient, true);
  assert.match(describeTencentAsrError("Something.Else", "raw message").reason, /raw message/);
});

// ---------------------------------------------------------------------------
// DescribeTaskStatus
// ---------------------------------------------------------------------------

test("status 0 and 1 are pending; 3 maps ErrorMsg to a Chinese reason", () => {
  assert.deepEqual(interpretTaskStatus({ Status: 0 }), { kind: "PENDING", status: 0 });
  assert.deepEqual(interpretTaskStatus({ Status: 1 }), { kind: "PENDING", status: 1 });
  assert.deepEqual(interpretTaskStatus({ Status: 3, ErrorMsg: "Failed to download audio file!" }), {
    kind: "FAILED",
    reason: describeAsrTaskFailure("Failed to download audio file!"),
  });
  assert.match(describeAsrTaskFailure("Failed to download audio file!"), /下载/);
  assert.match(describeAsrTaskFailure("audio decode failed"), /格式/);
  assert.match(describeAsrTaskFailure("音频时长超过限制"), /上限/);
  assert.match(describeAsrTaskFailure("unknown"), /识别失败：unknown/);
  assert.equal(interpretTaskStatus({ Status: 9 }).kind, "ERROR");
});

test("success parses ResultDetail into segments with S-prefixed speakers and converts AudioDuration seconds to ms", () => {
  const outcome = interpretTaskStatus({
    Status: 2,
    AudioDuration: 684.25,
    Result: "ignored when ResultDetail is present",
    ResultDetail: [
      { FinalSentence: "好，下一个。", StartMs: 8000, EndMs: 9500, SpeakerId: 0 },
      { FinalSentence: "  ", StartMs: 9500, EndMs: 9600, SpeakerId: 0 },
      { FinalSentence: "我当时觉得是个反转。", StartMs: 185000, EndMs: 191000, SpeakerId: 1 },
    ],
  });
  assert.deepEqual(outcome, {
    kind: "SUCCESS",
    durationMs: 684250,
    segments: [
      { id: 1, startMs: 8000, endMs: 9500, speakerId: "S0", text: "好，下一个。" },
      { id: 2, startMs: 185000, endMs: 191000, speakerId: "S1", text: "我当时觉得是个反转。" },
    ],
  });
});

test("without ResultDetail the Result text lines are parsed; nothing recognised is a failure", () => {
  assert.deepEqual(parseTencentAsrSegments({
    Result: "[0:8.020,0:9.500,0]  好，下一个。\n[3:5.000,3:11.000,1]  我当时觉得是个反转。\n",
  }), [
    { id: 1, startMs: 8020, endMs: 9500, speakerId: "S0", text: "好，下一个。" },
    { id: 2, startMs: 185000, endMs: 191000, speakerId: "S1", text: "我当时觉得是个反转。" },
  ]);
  assert.deepEqual(interpretTaskStatus({ Status: 2, ResultDetail: [], Result: "" }), {
    kind: "FAILED",
    reason: "录音里没有识别出说话内容，请确认录音是否完整。",
  });
});

test("DescribeTaskStatus sends the numeric TaskId and surfaces transient query errors", async () => {
  const { calls, fetchImpl } = fakeTencent([
    { Response: { Data: { TaskId: 42, Status: 1 }, RequestId: "r1" } },
    { Response: { Error: { Code: "RequestLimitExceeded", Message: "slow down" }, RequestId: "r2" } },
  ]);
  assert.deepEqual(await describeTaskStatus("42", options(fetchImpl)), { kind: "PENDING", status: 1 });
  assert.deepEqual(calls[0].body, { TaskId: 42 });
  assert.equal((calls[0].init.headers as Record<string, string>)["X-TC-Action"], "DescribeTaskStatus");
  const limited = await describeTaskStatus("42", options(fetchImpl));
  assert.equal(limited.kind, "ERROR");
  if (limited.kind === "ERROR") assert.equal(limited.transient, true);
});

// ---------------------------------------------------------------------------
// 真实返回（2026-10-10 总负责用真实账号、通用引擎 16k_zh、合成的三人点评录音跑出来的 Data 全文）。
// 通用引擎不做说话人分离：三个人全标成 SpeakerId 0；错字很多（时间瓦、对质生利、张韵……）。
// ---------------------------------------------------------------------------

test("a real 16k_zh DescribeTaskStatus result parses into segments in ms with every speaker labelled S0", () => {
  const data = JSON.parse(readFileSync(new URL("./fixtures/audio-review-asr-16k_zh.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const outcome = interpretTaskStatus(data);
  assert.equal(outcome.kind, "SUCCESS");
  if (outcome.kind !== "SUCCESS") return;
  assert.equal(outcome.durationMs, 143488);
  assert.equal(outcome.segments.length, 15);
  assert.deepEqual(outcome.segments[0], {
    id: 1, startMs: 390, endMs: 5680, speakerId: "S0", text: "好，下一个问那个捉迷藏天子在家就看过了，我直接说。",
  });
  assert.deepEqual([...new Set(outcome.segments.map((segment) => segment.speakerId))], ["S0"]);
  assert.match(outcome.segments[1].text, /时间瓦/);
  assert.match(outcome.segments[11].text, /对质生利/);
  for (let index = 1; index < outcome.segments.length; index += 1) {
    assert.ok(outcome.segments[index].startMs >= outcome.segments[index - 1].endMs);
  }
  // 退回解析 Result 文本得到同样的起止时间。
  const fromText = parseTencentAsrSegments({ Result: data.Result });
  assert.deepEqual(
    fromText.map((segment) => [segment.startMs, segment.endMs]),
    outcome.segments.map((segment) => [segment.startMs, segment.endMs]),
  );
});
