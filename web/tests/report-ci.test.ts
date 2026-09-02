import assert from "node:assert/strict";
import test from "node:test";
import type { CosConfig } from "../storage/cos.ts";
import {
  extractCallbackJobIdHint,
  getDocJob,
  listDocQueues,
  pickActiveQueueId,
  submitDocJob,
  type CiFetch,
} from "../lib/report-ci.ts";
import {
  buildCiCallbackUrl,
  callbackTokenMatches,
  chooseConverterMode,
  CI_POLL_THROTTLE_MS,
  mergeCiJobResults,
  planDocProcessSubmission,
  resetCiQueueIdCacheForTests,
  resolveCiQueueId,
  shouldPollReport,
} from "../lib/report-converter.ts";
import { pageKeys } from "../lib/report-convert.ts";

const cosConfig: CosConfig = {
  region: "ap-shanghai",
  bucket: "hamark-videos-1250000000",
  secretId: "AKIDxxxx",
  secretKey: "secretxxxx",
  endpoint: "https://cos.ap-shanghai.myqcloud.com",
};

type Captured = { url: string; init?: RequestInit };

function fakeFetch(response: () => Response, captured: Captured[] = []): CiFetch {
  return async (url, init) => {
    captured.push({ url, init });
    return response();
  };
}

function throwingFetch(): CiFetch {
  return async () => {
    throw new Error("network down");
  };
}

// ---------------------------------------------------------------------------
// submitDocJob：请求拼装与结果解析
// ---------------------------------------------------------------------------

test("submitDocJob posts to <bucket>.ci.<region>.myqcloud.com/doc_jobs with a well-formed XML body", async () => {
  const captured: Captured[] = [];
  const fetchImpl = fakeFetch(
    () => new Response("<Response><JobsDetail><JobId>job-large-1</JobId><State>Submitted</State></JobsDetail></Response>", { status: 200 }),
    captured,
  );

  const result = await submitDocJob({
    cosConfig,
    queueId: "queue-doc-process-1",
    srcObjectKey: "reports/r1/original",
    srcType: "pptx",
    outputObjectTemplate: "reports/r1/pages/p${Number}@2x.jpg",
    imageParams: "imageMogr2/thumbnail/1600x/quality/85",
    callbackUrl: "https://hamark.example.com/api/reports/ci-callback?token=abc&x=1",
    fetchImpl,
  });

  assert.deepEqual(result, { ok: true, jobId: "job-large-1" });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "https://hamark-videos-1250000000.ci.ap-shanghai.myqcloud.com/doc_jobs");
  assert.equal(captured[0].init?.method, "POST");
  const headers = captured[0].init?.headers as Headers;
  assert.equal(headers.get("content-type"), "application/xml");
  assert.ok(headers.get("authorization")?.includes("q-sign-algorithm=sha1"));

  const body = String(captured[0].init?.body);
  assert.match(body, /<Tag>DocProcess<\/Tag>/);
  assert.match(body, /<Object>reports\/r1\/original<\/Object>/);
  assert.match(body, /<SrcType>pptx<\/SrcType>/);
  assert.match(body, /<ImageParams>imageMogr2\/thumbnail\/1600x\/quality\/85<\/ImageParams>/);
  assert.match(body, /<QueueId>queue-doc-process-1<\/QueueId>/);
  // & 在 XML 里必须转义成 &amp;，否则不是合法 XML。
  assert.match(body, /<CallBack>https:\/\/hamark\.example\.com\/api\/reports\/ci-callback\?token=abc&amp;x=1<\/CallBack>/);
});

test("submitDocJob maps a known CI error code to a readable Chinese reason", async () => {
  const fetchImpl = fakeFetch(
    () => new Response("<Response><Error><Code>NoSuchQueue</Code><Message>queue not found</Message></Error></Response>", { status: 400 }),
  );
  const result = await submitDocJob({
    cosConfig,
    queueId: "bogus",
    srcObjectKey: "reports/r1/original",
    srcType: "pdf",
    outputObjectTemplate: "reports/r1/pages/p${Number}.jpg",
    imageParams: "imageMogr2/thumbnail/480x/quality/80",
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /未开通或队列不存在/);
});

test("submitDocJob reports a readable reason when the transport itself throws", async () => {
  const result = await submitDocJob({
    cosConfig,
    queueId: "q1",
    srcObjectKey: "reports/r1/original",
    srcType: "pdf",
    outputObjectTemplate: "reports/r1/pages/p${Number}.jpg",
    imageParams: "imageMogr2/thumbnail/480x/quality/80",
    fetchImpl: throwingFetch(),
  });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /无法连接/);
});

test("submitDocJob without a CallBack field omits the <CallBack> tag entirely", async () => {
  const captured: Captured[] = [];
  const fetchImpl = fakeFetch(
    () => new Response("<Response><JobsDetail><JobId>j1</JobId></JobsDetail></Response>", { status: 200 }),
    captured,
  );
  await submitDocJob({
    cosConfig,
    queueId: "q1",
    srcObjectKey: "reports/r1/original",
    srcType: "pdf",
    outputObjectTemplate: "reports/r1/pages/p${Number}.jpg",
    imageParams: "imageMogr2/thumbnail/480x/quality/80",
    fetchImpl,
  });
  assert.ok(!String(captured[0].init?.body).includes("<CallBack>"));
});

// ---------------------------------------------------------------------------
// getDocJob：State 分支与 PageInfo 解析
// ---------------------------------------------------------------------------

test("getDocJob reports Submitted/Running as non-terminal, with no page data", async () => {
  const fetchImpl = fakeFetch(() => new Response("<Response><JobsDetail><State>Running</State></JobsDetail></Response>", { status: 200 }));
  const outcome = await getDocJob({ cosConfig, jobId: "job-1", fetchImpl });
  assert.deepEqual(outcome, { ok: true, result: { state: "Running" } });
});

test("getDocJob parses a full Success with every page's PageNo/TgtUri", async () => {
  const xml = `<Response><JobsDetail><State>Success</State><Operation><DocProcessResult>
    <TotalPageCount>3</TotalPageCount><SuccPageCount>3</SuccPageCount><FailPageCount>0</FailPageCount>
    <PageInfo><PageNo>1</PageNo><TgtUri>reports/r1/pages/p1@2x.jpg</TgtUri></PageInfo>
    <PageInfo><PageNo>2</PageNo><TgtUri>reports/r1/pages/p2@2x.jpg</TgtUri></PageInfo>
    <PageInfo><PageNo>3</PageNo><TgtUri>reports/r1/pages/p3@2x.jpg</TgtUri></PageInfo>
  </DocProcessResult></Operation></JobsDetail></Response>`;
  const fetchImpl = fakeFetch(() => new Response(xml, { status: 200 }));
  const outcome = await getDocJob({ cosConfig, jobId: "job-1", fetchImpl });
  assert.equal(outcome.ok, true);
  const result = (outcome as { ok: true; result: import("../lib/report-ci.ts").DocJobResult }).result;
  assert.equal(result.state, "Success");
  if (result.state === "Success") {
    assert.equal(result.totalPageCount, 3);
    assert.equal(result.failPageCount, 0);
    assert.deepEqual(result.pages, [
      { pageNo: 1, tgtUri: "reports/r1/pages/p1@2x.jpg" },
      { pageNo: 2, tgtUri: "reports/r1/pages/p2@2x.jpg" },
      { pageNo: 3, tgtUri: "reports/r1/pages/p3@2x.jpg" },
    ]);
  }
});

test("getDocJob's Success can carry a partial page failure (fewer PageInfo entries than TotalPageCount)", async () => {
  const xml = `<Response><JobsDetail><State>Success</State><Operation><DocProcessResult>
    <TotalPageCount>3</TotalPageCount><SuccPageCount>2</SuccPageCount><FailPageCount>1</FailPageCount>
    <PageInfo><PageNo>1</PageNo><TgtUri>reports/r1/pages/p1@2x.jpg</TgtUri></PageInfo>
    <PageInfo><PageNo>3</PageNo><TgtUri>reports/r1/pages/p3@2x.jpg</TgtUri></PageInfo>
  </DocProcessResult></Operation></JobsDetail></Response>`;
  const fetchImpl = fakeFetch(() => new Response(xml, { status: 200 }));
  const outcome = await getDocJob({ cosConfig, jobId: "job-1", fetchImpl });
  assert.equal(outcome.ok, true);
  const result = (outcome as { ok: true; result: import("../lib/report-ci.ts").DocJobResult }).result;
  if (result.state === "Success") {
    assert.equal(result.failPageCount, 1);
    assert.equal(result.pages.length, 2);
    assert.ok(!result.pages.some((p) => p.pageNo === 2));
  } else {
    assert.fail("expected Success state");
  }
});

test("getDocJob reports a whole-job Failed with its Code/Message", async () => {
  const xml = "<Response><JobsDetail><State>Failed</State><Code>InvalidParameter</Code><Message>encrypted document</Message></JobsDetail></Response>";
  const fetchImpl = fakeFetch(() => new Response(xml, { status: 200 }));
  const outcome = await getDocJob({ cosConfig, jobId: "job-1", fetchImpl });
  assert.deepEqual(outcome, {
    ok: true,
    result: { state: "Failed", code: "InvalidParameter", message: "encrypted document" },
  });
});

// ---------------------------------------------------------------------------
// 队列发现：GET /docqueue + pickActiveQueueId
// ---------------------------------------------------------------------------

test("listDocQueues parses every <QueueList> entry and pickActiveQueueId only considers Active ones", async () => {
  const xml = `<Response><TotalCount>2</TotalCount>
    <QueueList><QueueId>q-paused</QueueId><Name>queue-doc-process-1</Name><State>Paused</State></QueueList>
    <QueueList><QueueId>q-active</QueueId><Name>queue-doc-process-2</Name><State>Active</State></QueueList>
  </Response>`;
  const fetchImpl = fakeFetch(() => new Response(xml, { status: 200 }));
  const listed = await listDocQueues({ cosConfig, fetchImpl });
  assert.equal(listed.ok, true);
  if (listed.ok) {
    assert.equal(listed.queues.length, 2);
    assert.equal(pickActiveQueueId(listed.queues), "q-active");
  }
});

test("pickActiveQueueId prefers the auto-created default queue name when several are Active", () => {
  const queues = [
    { queueId: "q-other", name: "queue-manual", state: "Active" },
    { queueId: "q-default", name: "queue-doc-process-1", state: "Active" },
  ];
  assert.equal(pickActiveQueueId(queues), "q-default");
});

test("pickActiveQueueId returns null when nothing is Active", () => {
  assert.equal(pickActiveQueueId([{ queueId: "q1", name: "queue-doc-process-1", state: "Paused" }]), null);
  assert.equal(pickActiveQueueId([]), null);
});

// ---------------------------------------------------------------------------
// 回调体不可信：只挖 JobId 当线索
// ---------------------------------------------------------------------------

test("extractCallbackJobIdHint pulls JobId out of XML or JSON bodies, ignoring everything else", () => {
  assert.equal(
    extractCallbackJobIdHint("<Response><EventName>TransCodingFinish</EventName><JobsDetail><JobId>job-9</JobId><State>Success</State></JobsDetail></Response>"),
    "job-9",
  );
  assert.equal(extractCallbackJobIdHint('{"JobsDetail":{"JobId":"job-json-1","State":"Success"}}'), "job-json-1");
  assert.equal(extractCallbackJobIdHint("not xml or json at all"), null);
  assert.equal(extractCallbackJobIdHint(""), null);
});

// ---------------------------------------------------------------------------
// chooseConverterMode：纯决策
// ---------------------------------------------------------------------------

test("chooseConverterMode: explicit REPORT_CONVERTER override always wins", () => {
  assert.equal(chooseConverterMode({ reportConverterOverride: "script", isLocalDemo: false, hasCiCosConfig: true }), "script");
  assert.equal(chooseConverterMode({ reportConverterOverride: "ci", isLocalDemo: true, hasCiCosConfig: false }), "ci");
});

test("chooseConverterMode: local demo mode always falls back to script even with full CI config", () => {
  assert.equal(chooseConverterMode({ isLocalDemo: true, hasCiCosConfig: true }), "script");
});

test("chooseConverterMode: ci is the default once CI config is present outside local demo mode", () => {
  assert.equal(chooseConverterMode({ isLocalDemo: false, hasCiCosConfig: true }), "ci");
  assert.equal(chooseConverterMode({ isLocalDemo: false, hasCiCosConfig: false }), "script");
});

// ---------------------------------------------------------------------------
// planDocProcessSubmission / buildCiCallbackUrl：纯拼装
// ---------------------------------------------------------------------------

test("planDocProcessSubmission builds the large/small job params from the existing key convention", () => {
  const plan = planDocProcessSubmission({ id: "r1", objectKey: "reports/r1/original", sourceFormat: "PPTX" });
  assert.equal(plan.large.srcType, "pptx");
  assert.equal(plan.large.outputObjectTemplate, "reports/r1/pages/p${Number}@2x.jpg");
  assert.equal(plan.large.imageParams, "imageMogr2/thumbnail/1600x/quality/85");
  assert.equal(plan.small.outputObjectTemplate, "reports/r1/pages/p${Number}.jpg");
  assert.equal(plan.small.imageParams, "imageMogr2/thumbnail/480x/quality/80");
  assert.equal(plan.large.srcObjectKey, "reports/r1/original");
  assert.equal(plan.small.srcObjectKey, "reports/r1/original");
});

test("buildCiCallbackUrl appends the report's token as a query parameter", () => {
  const url = buildCiCallbackUrl("https://hamark.example.com", "tok123");
  assert.equal(url, "https://hamark.example.com/api/reports/ci-callback?token=tok123");
});

// ---------------------------------------------------------------------------
// mergeCiJobResults：两个任务查询结果的合并决策（不吃回调体，只吃权威查询结果）
// ---------------------------------------------------------------------------

test("mergeCiJobResults: pending while either job hasn't reached a terminal state", () => {
  assert.deepEqual(
    mergeCiJobResults("r1", { state: "Running" }, { state: "Success", totalPageCount: 1, succPageCount: 1, failPageCount: 0, pages: [{ pageNo: 1, tgtUri: "x" }] }),
    { kind: "pending" },
  );
});

test("mergeCiJobResults: either job failing whole-job fails the report, naming which side", () => {
  const outcome = mergeCiJobResults(
    "r1",
    { state: "Failed", code: "InvalidParameter", message: "bad file" },
    { state: "Success", totalPageCount: 1, succPageCount: 1, failPageCount: 0, pages: [{ pageNo: 1, tgtUri: "x" }] },
  );
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") assert.match(outcome.reason, /大图任务失败/);
});

test("mergeCiJobResults: Pause/Cancel states are also treated as a whole-job failure", () => {
  const outcome = mergeCiJobResults(
    "r1",
    { state: "Success", totalPageCount: 1, succPageCount: 1, failPageCount: 0, pages: [{ pageNo: 1, tgtUri: "x" }] },
    { state: "Cancel", message: "operator cancelled" },
  );
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") assert.match(outcome.reason, /小图任务被取消/);
});

test("mergeCiJobResults: both Success and every page present on both sides marks every page OK", () => {
  const large = { state: "Success" as const, totalPageCount: 2, succPageCount: 2, failPageCount: 0, pages: [
    { pageNo: 1, tgtUri: "/reports/r1/pages/p1@2x.jpg" },
    { pageNo: 2, tgtUri: "reports/r1/pages/p2@2x.jpg" },
  ] };
  const small = { state: "Success" as const, totalPageCount: 2, succPageCount: 2, failPageCount: 0, pages: [
    { pageNo: 1, tgtUri: "reports/r1/pages/p1.jpg" },
    { pageNo: 2, tgtUri: "reports/r1/pages/p2.jpg" },
  ] };
  const outcome = mergeCiJobResults("r1", large, small);
  assert.equal(outcome.kind, "ready");
  if (outcome.kind === "ready") {
    assert.equal(outcome.pageCount, 2);
    assert.equal(outcome.notes.length, 0);
    // 前导斜杠会被去掉，跟仓库其余对象键的写法对齐（无前导斜杠）。
    assert.deepEqual(outcome.pages, [
      { pageNo: 1, renderStatus: "OK", thumbKey: "reports/r1/pages/p1.jpg", largeKey: "reports/r1/pages/p1@2x.jpg" },
      { pageNo: 2, renderStatus: "OK", thumbKey: "reports/r1/pages/p2.jpg", largeKey: "reports/r1/pages/p2@2x.jpg" },
    ]);
  }
});

test("mergeCiJobResults: a page missing from only one side is marked FAILED with the existing placeholder key", () => {
  const large = { state: "Success" as const, totalPageCount: 2, succPageCount: 1, failPageCount: 1, pages: [
    { pageNo: 1, tgtUri: "reports/r1/pages/p1@2x.jpg" },
  ] };
  const small = { state: "Success" as const, totalPageCount: 2, succPageCount: 2, failPageCount: 0, pages: [
    { pageNo: 1, tgtUri: "reports/r1/pages/p1.jpg" },
    { pageNo: 2, tgtUri: "reports/r1/pages/p2.jpg" },
  ] };
  const outcome = mergeCiJobResults("r1", large, small);
  assert.equal(outcome.kind, "ready");
  if (outcome.kind === "ready") {
    const page2 = outcome.pages.find((p) => p.pageNo === 2);
    const fallback = pageKeys("r1", 2);
    assert.deepEqual(page2, { pageNo: 2, renderStatus: "FAILED", thumbKey: fallback.thumbKey, largeKey: fallback.largeKey });
    assert.ok(outcome.notes.some((note) => note.includes("第 2 页") && note.includes("大图")));
    assert.ok(outcome.notes.some((note) => note.includes("大图失败 1 页")));
  }
});

// ---------------------------------------------------------------------------
// shouldPollReport：轮询节流
// ---------------------------------------------------------------------------

test("shouldPollReport only polls PROCESSING reports, and only past the throttle window", () => {
  const now = new Date("2026-09-02T12:00:00Z");
  assert.equal(shouldPollReport({ status: "READY", ciCheckedAt: null }, now), false);
  assert.equal(shouldPollReport({ status: "PROCESSING", ciCheckedAt: null }, now), true);
  const justChecked = new Date(now.getTime() - 1_000).toISOString();
  assert.equal(shouldPollReport({ status: "PROCESSING", ciCheckedAt: justChecked }, now), false);
  const staleCheck = new Date(now.getTime() - CI_POLL_THROTTLE_MS - 1).toISOString();
  assert.equal(shouldPollReport({ status: "PROCESSING", ciCheckedAt: staleCheck }, now), true);
});

// ---------------------------------------------------------------------------
// 回调 token 匹配：不匹配就不认这份报告
// ---------------------------------------------------------------------------

test("callbackTokenMatches requires both sides present and equal", () => {
  assert.equal(callbackTokenMatches({ ciCallbackToken: "abc" }, "abc"), true);
  assert.equal(callbackTokenMatches({ ciCallbackToken: "abc" }, "def"), false);
  assert.equal(callbackTokenMatches({ ciCallbackToken: null }, "abc"), false);
  assert.equal(callbackTokenMatches({ ciCallbackToken: "abc" }, null), false);
});

// ---------------------------------------------------------------------------
// resolveCiQueueId：优先取显式覆盖；否则自动发现并缓存在进程内
// ---------------------------------------------------------------------------

test("resolveCiQueueId: an explicit COS_CI_DOC_QUEUE_ID override wins and never calls the transport", async (t) => {
  const previous = process.env.COS_CI_DOC_QUEUE_ID;
  process.env.COS_CI_DOC_QUEUE_ID = "queue-override";
  resetCiQueueIdCacheForTests();
  t.after(() => {
    if (previous === undefined) delete process.env.COS_CI_DOC_QUEUE_ID;
    else process.env.COS_CI_DOC_QUEUE_ID = previous;
    resetCiQueueIdCacheForTests();
  });

  let calls = 0;
  const fetchImpl: CiFetch = async () => {
    calls += 1;
    throw new Error("should not be called");
  };
  const result = await resolveCiQueueId(cosConfig, { fetchImpl });
  assert.deepEqual(result, { ok: true, queueId: "queue-override" });
  assert.equal(calls, 0);
});

test("resolveCiQueueId: with no override, auto-discovers an Active queue via GET /docqueue and caches it", async (t) => {
  const previous = process.env.COS_CI_DOC_QUEUE_ID;
  delete process.env.COS_CI_DOC_QUEUE_ID;
  resetCiQueueIdCacheForTests();
  t.after(() => {
    if (previous !== undefined) process.env.COS_CI_DOC_QUEUE_ID = previous;
    resetCiQueueIdCacheForTests();
  });

  let calls = 0;
  const xml = "<Response><QueueList><QueueId>q-auto</QueueId><Name>queue-doc-process-1</Name><State>Active</State></QueueList></Response>";
  const fetchImpl: CiFetch = async () => {
    calls += 1;
    return new Response(xml, { status: 200 });
  };

  const first = await resolveCiQueueId(cosConfig, { fetchImpl });
  assert.deepEqual(first, { ok: true, queueId: "q-auto" });
  assert.equal(calls, 1);

  // 第二次不应该再打一次 /docqueue——已经缓存在进程内。
  const second = await resolveCiQueueId(cosConfig, { fetchImpl });
  assert.deepEqual(second, { ok: true, queueId: "q-auto" });
  assert.equal(calls, 1);
});

test("resolveCiQueueId: no Active queue found reports a console-actionable Chinese reason", async (t) => {
  const previous = process.env.COS_CI_DOC_QUEUE_ID;
  delete process.env.COS_CI_DOC_QUEUE_ID;
  resetCiQueueIdCacheForTests();
  t.after(() => {
    if (previous !== undefined) process.env.COS_CI_DOC_QUEUE_ID = previous;
    resetCiQueueIdCacheForTests();
  });

  const fetchImpl: CiFetch = async () =>
    new Response("<Response><QueueList><QueueId>q1</QueueId><Name>queue-doc-process-1</Name><State>Paused</State></QueueList></Response>", { status: 200 });
  const result = await resolveCiQueueId(cosConfig, { fetchImpl });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /未找到已启用的文档处理队列/);
});
