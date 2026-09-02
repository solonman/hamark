// 数据万象文档转码（CI DocProcess）异步任务的最小 HTTP 客户端：发现队列、提交任务、
// 查询任务，以及这几件事要用到的 XML 拼接/解析。这一层只碰网络，不碰数据库；
// 传输层可注入（`fetchImpl`），单测（tests/report-ci.test.ts）用假传输层覆盖，不
// 真正打生产的数据万象接口。落库、轮询节流、任务编排在 lib/report-converter.ts。
//
// 签名复用 storage/cos.ts 的 createCosAuthorization——数据万象与 COS 是同一套 q-sign
// 算法，只是主机换成 <bucket>.ci.<region>.myqcloud.com（不是 <bucket>.cos....）。
//
// 依据（核对于 2026-09-02，字段以英文文档为准，如与实际响应不一致以响应为准）：
//   - 提交文档转码任务 POST /doc_jobs：
//     https://cloud.tencent.com/document/product/460/46942
//   - 查询指定的文档转码任务 GET /doc_jobs/<JobId>（DocProcessResult.PageInfo 数组，
//     每项 PageNo / TgtUri，Excel 专属的 X-SheetPics/PicIndex/PicNum 用不上）：
//     https://cloud.tencent.com/document/product/460/46943
//   - 查询文档处理队列 GET /docqueue（响应用 <QueueList> 包一条，含 QueueId/Name/
//     State）：https://cloud.tencent.com/document/product/460/46946
//   - 开通文档处理会自动建一条名为 queue-doc-process-1 的队列，不需要手动建队列：
//     https://cloud.tencent.com/document/product/460/103608

import { createCosAuthorization, type CosConfig } from "@/storage/cos";

export type CiFetch = (input: string, init?: RequestInit) => Promise<Response>;

function ciHost(config: CosConfig) {
  return `${config.bucket}.ci.${config.region}.myqcloud.com`;
}

function ciUrl(config: CosConfig, path: string) {
  return `https://${ciHost(config)}${path}`;
}

// ---------------------------------------------------------------------------
// XML：手写小拼接/解析，只覆盖用得到的字段，不追求通用 XML 能力。
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 取第一个 `<tag>...</tag>` 的内容；找不到返回 null。不处理同名嵌套标签。 */
function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? unescapeXml(match[1].trim()) : null;
}

/** 取所有同名标签块的内容（不解嵌套），用于 PageInfo / QueueList 这类重复节点。 */
function extractBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) blocks.push(match[1]);
  return blocks;
}

// ---------------------------------------------------------------------------
// 已知错误码 → 人能看懂的中文提示。覆盖不到的错误退回通用文案，附带原始 Code/Message。
// ---------------------------------------------------------------------------

function mapKnownCiError(code: string | null): string | null {
  if (!code) return null;
  if (code === "NoSuchQueue" || code === "QueueNotExist" || code === "InvalidQueueId") {
    return "数据万象未开通或队列不存在，请在控制台确认「文档处理」已开启。";
  }
  if (code === "AccessDenied" || code === "SignatureDoesNotMatch" || code === "InvalidAccessKeyId") {
    return "数据万象鉴权失败，请检查 COS 密钥配置与权限（需要文档处理相关权限）。";
  }
  if (code === "NoSuchBucket") {
    return "数据万象找不到目标存储桶，请检查 COS_BUCKET 配置。";
  }
  return null;
}

function describeCiError(status: number, body: string): string {
  const code = extractTag(body, "Code");
  const message = extractTag(body, "Message");
  const known = mapKnownCiError(code);
  if (known) return known;
  if (message) return `数据万象返回错误：${message}${code ? `（${code}）` : ""}`;
  return `数据万象请求失败（HTTP ${status}）。`;
}

// ---------------------------------------------------------------------------
// 统一的签名请求：signedRequest 计算签名要读 Request 对象上已经设置好的全部头，
// 所以先把要发的头（host、content-type）都放上去再签，跟 storage/cos.ts 的
// CosVideoBucket.request 是同一套做法。
// ---------------------------------------------------------------------------

type CiRequestOutcome =
  | { kind: "response"; status: number; ok: boolean; text: string }
  | { kind: "network-error" };

async function ciRequest(
  config: CosConfig,
  method: string,
  path: string,
  options: { body?: string; contentType?: string; fetchImpl?: CiFetch } = {},
): Promise<CiRequestOutcome> {
  const url = ciUrl(config, path);
  const headers = new Headers();
  if (options.contentType) headers.set("content-type", options.contentType);
  const unsigned = new Request(url, { method, headers, body: options.body });
  const signedHeaders = new Headers(unsigned.headers);
  signedHeaders.set("host", new URL(url).host);
  signedHeaders.set("authorization", await createCosAuthorization(unsigned, config));

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, { method, headers: signedHeaders, body: options.body });
  } catch {
    return { kind: "network-error" };
  }
  const text = await response.text();
  return { kind: "response", status: response.status, ok: response.ok, text };
}

// ---------------------------------------------------------------------------
// 队列发现：GET /docqueue。开通文档处理会自动建队列（默认名 queue-doc-process-1），
// 不需要手动创建；这里只挑一条 State=Active 的队列用。
// ---------------------------------------------------------------------------

export type CiQueue = { queueId: string; name: string; state: string };

export type ListDocQueuesOutcome =
  | { ok: true; queues: CiQueue[] }
  | { ok: false; reason: string };

export async function listDocQueues(params: {
  cosConfig: CosConfig;
  fetchImpl?: CiFetch;
}): Promise<ListDocQueuesOutcome> {
  const outcome = await ciRequest(params.cosConfig, "GET", "/docqueue?pageSize=100", {
    fetchImpl: params.fetchImpl,
  });
  if (outcome.kind === "network-error") {
    return { ok: false, reason: "无法连接数据万象服务查询文档处理队列。" };
  }
  if (!outcome.ok) {
    return { ok: false, reason: describeCiError(outcome.status, outcome.text) };
  }
  const queues = extractBlocks(outcome.text, "QueueList")
    .map((block): CiQueue | null => {
      const queueId = extractTag(block, "QueueId");
      if (!queueId) return null;
      return {
        queueId,
        name: extractTag(block, "Name") ?? "",
        state: extractTag(block, "State") ?? "",
      };
    })
    .filter((queue): queue is CiQueue => queue !== null);
  return { ok: true, queues };
}

/**
 * 从队列列表里挑一条能用的：优先选自动创建的默认队列名，其次任选一条 Active 的；
 * 没有 Active 队列时返回 null，调用方据此报"未开通/未启用"。纯函数，单测直接覆盖。
 */
export function pickActiveQueueId(
  queues: readonly CiQueue[],
  preferredName = "queue-doc-process-1",
): string | null {
  const active = queues.filter((queue) => queue.state === "Active");
  if (active.length === 0) return null;
  return (active.find((queue) => queue.name === preferredName) ?? active[0]).queueId;
}

// ---------------------------------------------------------------------------
// 提交任务：POST /doc_jobs，Tag=DocProcess。
// ---------------------------------------------------------------------------

export type SubmitDocJobParams = {
  cosConfig: CosConfig;
  queueId: string;
  srcObjectKey: string;
  /** 源文件后缀类型（如 "ppt"/"pptx"/"pdf"）；我们的原件对象键没有扩展名，必须显式给。 */
  srcType: string;
  /** 输出对象键模板，支持 `${Number}` 占位符表示页号；具体如何展开由 CI 决定，我们
   * 读回时用查询接口给的 TgtUri，不自己猜文件名。 */
  outputObjectTemplate: string;
  /** imageMogr2 管道串，例如 "imageMogr2/thumbnail/1600x/quality/85"。 */
  imageParams: string;
  callbackUrl?: string;
  fetchImpl?: CiFetch;
};

export type SubmitDocJobResult = { ok: true; jobId: string } | { ok: false; reason: string };

export async function submitDocJob(params: SubmitDocJobParams): Promise<SubmitDocJobResult> {
  const body = [
    "<Request>",
    "<Tag>DocProcess</Tag>",
    `<Input><Object>${escapeXml(params.srcObjectKey)}</Object></Input>`,
    "<Operation>",
    "<DocProcess>",
    `<SrcType>${escapeXml(params.srcType)}</SrcType>`,
    "<TgtType>jpg</TgtType>",
    "<StartPage>1</StartPage>",
    "<EndPage>-1</EndPage>",
    `<ImageParams>${escapeXml(params.imageParams)}</ImageParams>`,
    "</DocProcess>",
    "<Output>",
    `<Region>${escapeXml(params.cosConfig.region)}</Region>`,
    `<Bucket>${escapeXml(params.cosConfig.bucket)}</Bucket>`,
    `<Object>${escapeXml(params.outputObjectTemplate)}</Object>`,
    "</Output>",
    "</Operation>",
    `<QueueId>${escapeXml(params.queueId)}</QueueId>`,
    params.callbackUrl ? `<CallBack>${escapeXml(params.callbackUrl)}</CallBack>` : "",
    "</Request>",
  ].join("");

  const outcome = await ciRequest(params.cosConfig, "POST", "/doc_jobs", {
    body,
    contentType: "application/xml",
    fetchImpl: params.fetchImpl,
  });
  if (outcome.kind === "network-error") {
    return { ok: false, reason: "无法连接数据万象服务，请检查网络后重试。" };
  }
  if (!outcome.ok) {
    return { ok: false, reason: describeCiError(outcome.status, outcome.text) };
  }
  const jobId = extractTag(outcome.text, "JobId");
  if (!jobId) {
    return { ok: false, reason: "数据万象未返回任务 ID，响应格式异常。" };
  }
  return { ok: true, jobId };
}

// ---------------------------------------------------------------------------
// 查询任务：GET /doc_jobs/<JobId>。
// ---------------------------------------------------------------------------

export type DocJobPage = { pageNo: number; tgtUri: string };

export type DocJobResult =
  | { state: "Submitted" | "Running" }
  | { state: "Pause" | "Cancel"; message: string }
  | { state: "Failed"; code: string; message: string }
  | {
      state: "Success";
      totalPageCount: number;
      succPageCount: number;
      failPageCount: number;
      pages: DocJobPage[];
    };

export type GetDocJobOutcome = { ok: true; result: DocJobResult } | { ok: false; reason: string };

export async function getDocJob(params: {
  cosConfig: CosConfig;
  jobId: string;
  fetchImpl?: CiFetch;
}): Promise<GetDocJobOutcome> {
  const outcome = await ciRequest(params.cosConfig, "GET", `/doc_jobs/${encodeURIComponent(params.jobId)}`, {
    fetchImpl: params.fetchImpl,
  });
  if (outcome.kind === "network-error") {
    return { ok: false, reason: "无法连接数据万象服务查询任务状态。" };
  }
  if (!outcome.ok) {
    return { ok: false, reason: describeCiError(outcome.status, outcome.text) };
  }

  const text = outcome.text;
  const state = extractTag(text, "State");
  if (!state) {
    return { ok: false, reason: "数据万象任务查询响应格式异常，缺少 State 字段。" };
  }

  if (state === "Submitted" || state === "Running") {
    return { ok: true, result: { state } };
  }
  if (state === "Failed") {
    return {
      ok: true,
      result: {
        state,
        code: extractTag(text, "Code") ?? "",
        message: extractTag(text, "Message") ?? "任务失败，原因未知。",
      },
    };
  }
  if (state === "Pause" || state === "Cancel") {
    return { ok: true, result: { state, message: extractTag(text, "Message") ?? "" } };
  }
  if (state !== "Success") {
    return { ok: false, reason: `数据万象返回了未知的任务状态（${state}）。` };
  }

  const totalPageCount = Number(extractTag(text, "TotalPageCount") ?? "0") || 0;
  const succPageCount = Number(extractTag(text, "SuccPageCount") ?? "0") || 0;
  const failPageCount = Number(extractTag(text, "FailPageCount") ?? "0") || 0;
  const pages = extractBlocks(text, "PageInfo")
    .map((block): DocJobPage | null => {
      const pageNo = Number(extractTag(block, "PageNo"));
      const tgtUri = extractTag(block, "TgtUri");
      if (!Number.isInteger(pageNo) || pageNo <= 0 || !tgtUri) return null;
      return { pageNo, tgtUri };
    })
    .filter((page): page is DocJobPage => page !== null);

  return { ok: true, result: { state, totalPageCount, succPageCount, failPageCount, pages } };
}

// ---------------------------------------------------------------------------
// 回调体不可信：只允许从里面挖一个 JobId 当"查哪份报告"的线索，其余字段一律不读、
// 不用来判断成功/失败——那个判断只能来自上面 getDocJob 的权威查询结果。
// ---------------------------------------------------------------------------

export function extractCallbackJobIdHint(rawBody: string): string | null {
  const xmlMatch = rawBody.match(/<JobId>([^<]+)<\/JobId>/);
  if (xmlMatch) return xmlMatch[1].trim() || null;
  const jsonMatch = rawBody.match(/"JobId"\s*:\s*"([^"]+)"/);
  if (jsonMatch) return jsonMatch[1].trim() || null;
  return null;
}
