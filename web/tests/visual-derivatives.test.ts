import assert from "node:assert/strict";
import test from "node:test";
import type { DbClient } from "../db/index.ts";
import { VISUAL_LIMITS } from "../lib/visual-contract.ts";
import {
  buildVisualPicOperationsHeader,
  buildVisualPicOperationsPlan,
  chooseVisualDerivativeMode,
  parseVisualPicOperationsResponse,
  submitVisualImageDerivative,
  visualPicOperationsUrl,
  type VisualCiFetch,
} from "../lib/visual-derivatives.ts";
import type { CosConfig } from "../storage/cos.ts";

const cosConfig: CosConfig = {
  region: "ap-shanghai",
  bucket: "hamark-visual-1250000000",
  secretId: "AKIDxxxx",
  secretKey: "secretxxxx",
  endpoint: "https://cos.ap-shanghai.myqcloud.com",
};

// ---------------------------------------------------------------------------
// 模式选择：照 chooseConverterMode 的规则。
// ---------------------------------------------------------------------------

test("an explicit VISUAL_DERIVATIVES override always wins", () => {
  assert.equal(
    chooseVisualDerivativeMode({ visualDerivativesOverride: "script", isLocalDemo: false, hasCiCosConfig: true }),
    "script",
  );
  assert.equal(
    chooseVisualDerivativeMode({ visualDerivativesOverride: "ci", isLocalDemo: true, hasCiCosConfig: false }),
    "ci",
  );
});

test("local demo mode (no real COS) always falls back to script, override aside", () => {
  assert.equal(
    chooseVisualDerivativeMode({ visualDerivativesOverride: null, isLocalDemo: true, hasCiCosConfig: true }),
    "script",
  );
});

test("with a full COS config and no local demo, it defaults to ci; otherwise script", () => {
  assert.equal(
    chooseVisualDerivativeMode({ visualDerivativesOverride: null, isLocalDemo: false, hasCiCosConfig: true }),
    "ci",
  );
  assert.equal(
    chooseVisualDerivativeMode({ visualDerivativesOverride: null, isLocalDemo: false, hasCiCosConfig: false }),
    "script",
  );
});

test("an unrecognized override value is ignored, same as not setting it", () => {
  assert.equal(
    chooseVisualDerivativeMode({ visualDerivativesOverride: "banana", isLocalDemo: false, hasCiCosConfig: true }),
    "ci",
  );
});

// ---------------------------------------------------------------------------
// Pic-Operations：内容与两条规则（480w 缩略图、1600w 展示图）。
// ---------------------------------------------------------------------------

test("the Pic-Operations plan carries is_pic_info and exactly two rules, thumb then display", () => {
  const plan = buildVisualPicOperationsPlan("visual/c1/a1/thumb.jpg", "visual/c1/a1/display.jpg");
  assert.deepEqual(plan, {
    is_pic_info: 1,
    rules: [
      {
        fileid: "/visual/c1/a1/thumb.jpg",
        rule: `imageMogr2/auto-orient/thumbnail/${VISUAL_LIMITS.thumbnailWidth}x/format/jpg/quality/85`,
      },
      {
        fileid: "/visual/c1/a1/display.jpg",
        rule: `imageMogr2/auto-orient/thumbnail/${VISUAL_LIMITS.displayWidth}x/format/jpg/quality/85`,
      },
    ],
  });
  assert.equal(plan.rules[0].rule, "imageMogr2/auto-orient/thumbnail/480x/format/jpg/quality/85");
  assert.equal(plan.rules[1].rule, "imageMogr2/auto-orient/thumbnail/1600x/format/jpg/quality/85");
});

test("the header is that plan serialized as JSON, ready to hand to the Pic-Operations header", () => {
  const header = buildVisualPicOperationsHeader("visual/c1/a1/thumb.jpg", "visual/c1/a1/display.jpg");
  assert.deepEqual(JSON.parse(header), buildVisualPicOperationsPlan("visual/c1/a1/thumb.jpg", "visual/c1/a1/display.jpg"));
});

test("the request targets <bucket>.cos.<region>.myqcloud.com/<objectKey>?image_process", () => {
  const url = visualPicOperationsUrl(cosConfig, "visual/c1/a1/original.jpg");
  assert.equal(url, "https://hamark-visual-1250000000.cos.ap-shanghai.myqcloud.com/visual/c1/a1/original.jpg?image_process");
});

// ---------------------------------------------------------------------------
// XML 解析：成功（含 Width/Height）、成功但缺宽高、结果不完整、错误响应。
// ---------------------------------------------------------------------------

const SUCCESS_XML = `<UploadResult>
  <OriginalInfo>
    <Key>visual/c1/a1/original.jpg</Key>
    <ImageInfo>
      <Format>JPEG</Format>
      <Width>3000</Width>
      <Height>2000</Height>
    </ImageInfo>
  </OriginalInfo>
  <ProcessResults>
    <Object>
      <Key>visual/c1/a1/thumb.jpg</Key>
      <Format>jpg</Format>
      <Width>480</Width>
      <Height>320</Height>
    </Object>
    <Object>
      <Key>visual/c1/a1/display.jpg</Key>
      <Format>jpg</Format>
      <Width>1600</Width>
      <Height>1067</Height>
    </Object>
  </ProcessResults>
</UploadResult>`;

test("a successful response with OriginalInfo/ImageInfo reports the original width/height", () => {
  const result = parseVisualPicOperationsResponse(200, SUCCESS_XML);
  assert.deepEqual(result, { ok: true, width: 3000, height: 2000 });
});

test("a successful response missing OriginalInfo/ImageInfo still succeeds, just without width/height", () => {
  const xml = `<UploadResult><ProcessResults><Object><Key>t.jpg</Key></Object><Object><Key>d.jpg</Key></Object></ProcessResults></UploadResult>`;
  assert.deepEqual(parseVisualPicOperationsResponse(200, xml), { ok: true, width: null, height: null });
});

test("fewer than two <Object> results means the processing didn't fully complete — treated as a failure", () => {
  const xml = `<UploadResult><ProcessResults><Object><Key>t.jpg</Key></Object></ProcessResults></UploadResult>`;
  const result = parseVisualPicOperationsResponse(200, xml);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /未返回完整的派生图结果/);
});

test("a non-2xx response with a Code/Message is turned into a readable reason", () => {
  const xml = `<Response><Error><Code>NoSuchKey</Code><Message>key not found</Message></Error></Response>`;
  const result = parseVisualPicOperationsResponse(404, xml);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /数据万象返回错误：key not found（NoSuchKey）/);
});

test("a non-2xx response without a parseable Message falls back to a generic HTTP-status reason", () => {
  const result = parseVisualPicOperationsResponse(500, "not xml at all");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /HTTP 500/);
});

// ---------------------------------------------------------------------------
// 编排层：假 db + 假 fetch，覆盖“超 20MB 跳过”“失败写 FAILED”“成功写 READY”。
// 假 db 的写法同 tests/v04-migration-preview.test.ts：db.prepare 返回一个
// {bind,first,all,run} 的假实现，整体 as unknown as DbClient。
// ---------------------------------------------------------------------------

type Captured = { sql: string; values: unknown[] };

function fakeDb(): { db: DbClient; calls: Captured[] } {
  const calls: Captured[] = [];
  const db = {
    prepare(sql: string) {
      let boundValues: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          boundValues = values;
          return statement;
        },
        async run() {
          calls.push({ sql, values: boundValues });
          return { success: true, meta: { rows_read: 0, rows_written: 1 } };
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
      return statement;
    },
  } as unknown as DbClient;
  return { db, calls };
}

function fakeFetch(handler: () => Response): VisualCiFetch {
  return async () => handler();
}

test("an oversized image is marked FAILED without ever calling fetch", async () => {
  const { db, calls } = fakeDb();
  let fetchCalls = 0;
  const fetchImpl: VisualCiFetch = async () => {
    fetchCalls += 1;
    return new Response("", { status: 200 });
  };

  await submitVisualImageDerivative(
    db,
    { id: "asset1", caseId: "case1", objectKey: "visual/case1/asset1/original.jpg", fileSize: VISUAL_LIMITS.derivativeMaxBytes + 1 },
    { fetchImpl },
  );

  assert.equal(fetchCalls, 0, "an oversized image must not hit the network");
  const failedCall = calls.find((call) => call.sql.includes("derivative_status = 'FAILED'"));
  assert.ok(failedCall, "expected a FAILED update");
  assert.match(String(failedCall?.values[0]), /超过 20 MB 的处理上限/);
  // 从没写过 derivative_requested_at 的 PENDING 更新（超限直接判失败，不提交请求）。
  assert.equal(calls.some((call) => call.sql.includes("SET derivative_requested_at = now()")), false);
});

test("a network failure is marked FAILED with a readable reason", async () => {
  const { db, calls } = fakeDb();
  const fetchImpl: VisualCiFetch = async () => {
    throw new Error("network down");
  };

  // readCosConfig() needs real env vars; set the four required ones for this test only.
  const originalEnv = { ...process.env };
  process.env.COS_REGION = cosConfig.region;
  process.env.COS_BUCKET = cosConfig.bucket;
  process.env.COS_SECRET_ID = cosConfig.secretId;
  process.env.COS_SECRET_KEY = cosConfig.secretKey;
  try {
    await submitVisualImageDerivative(
      db,
      { id: "asset2", caseId: "case1", objectKey: "visual/case1/asset2/original.jpg", fileSize: 1024 },
      { fetchImpl },
    );
  } finally {
    process.env = originalEnv;
  }

  const failedCall = calls.find((call) => call.sql.includes("derivative_status = 'FAILED'"));
  assert.ok(failedCall, "expected a FAILED update");
  assert.match(String(failedCall?.values[0]), /无法连接数据万象服务/);
});

test("a non-2xx CI response is marked FAILED with the parsed reason", async () => {
  const { db, calls } = fakeDb();
  const fetchImpl = fakeFetch(
    () => new Response("<Response><Error><Code>AccessDenied</Code><Message>bad key</Message></Error></Response>", { status: 403 }),
  );

  const originalEnv = { ...process.env };
  process.env.COS_REGION = cosConfig.region;
  process.env.COS_BUCKET = cosConfig.bucket;
  process.env.COS_SECRET_ID = cosConfig.secretId;
  process.env.COS_SECRET_KEY = cosConfig.secretKey;
  try {
    await submitVisualImageDerivative(
      db,
      { id: "asset3", caseId: "case1", objectKey: "visual/case1/asset3/original.jpg", fileSize: 1024 },
      { fetchImpl },
    );
  } finally {
    process.env = originalEnv;
  }

  const failedCall = calls.find((call) => call.sql.includes("derivative_status = 'FAILED'"));
  assert.ok(failedCall, "expected a FAILED update");
  assert.match(String(failedCall?.values[0]), /bad key/);
});

test("a successful CI response is marked READY with the thumb/display keys and reported width/height", async () => {
  const { db, calls } = fakeDb();
  let requestUrl = "";
  let picOperationsHeader = "";
  const fetchImpl: VisualCiFetch = async (url, init) => {
    requestUrl = url;
    picOperationsHeader = new Headers(init?.headers).get("Pic-Operations") ?? "";
    return new Response(SUCCESS_XML, { status: 200 });
  };

  const originalEnv = { ...process.env };
  process.env.COS_REGION = cosConfig.region;
  process.env.COS_BUCKET = cosConfig.bucket;
  process.env.COS_SECRET_ID = cosConfig.secretId;
  process.env.COS_SECRET_KEY = cosConfig.secretKey;
  try {
    await submitVisualImageDerivative(
      db,
      { id: "asset4", caseId: "case1", objectKey: "visual/case1/asset4/original.jpg", fileSize: 1024 },
      { fetchImpl },
    );
  } finally {
    process.env = originalEnv;
  }

  assert.equal(requestUrl, "https://hamark-visual-1250000000.cos.ap-shanghai.myqcloud.com/visual/case1/asset4/original.jpg?image_process");
  assert.deepEqual(JSON.parse(picOperationsHeader), buildVisualPicOperationsPlan("visual/case1/asset4/thumb.jpg", "visual/case1/asset4/display.jpg"));

  const readyCall = calls.find((call) => call.sql.includes("derivative_status = 'READY'"));
  assert.ok(readyCall, "expected a READY update");
  assert.deepEqual(readyCall?.values, [
    "visual/case1/asset4/thumb.jpg",
    "visual/case1/asset4/display.jpg",
    3000,
    2000,
    "asset4",
  ]);
  // 提交前先落过一次 derivative_requested_at（兜底重提交用它判断「PENDING 超过 60 秒」）。
  assert.ok(calls.some((call) => call.sql.includes("SET derivative_requested_at = now()")));
});
