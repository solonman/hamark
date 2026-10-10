// 腾讯云 API 3.0 签名方法 v3（TC3-HMAC-SHA256）。WebCrypto 实现，不引入 SDK、不新增依赖。
// 依据：https://cloud.tencent.com/document/api/1093/35641（语音识别「签名方法 v3」），
// 固定向量见 tests/audio-review-asr.test.ts。
//
// 只实现 POST + application/json 这一种用法（录音文件识别的两个接口都是它）：
//   CanonicalRequest = POST \n / \n (空查询串) \n
//                      content-type:…\nhost:…\nx-tc-action:<小写 action>\n \n
//                      content-type;host;x-tc-action \n hex(sha256(payload))
//   StringToSign     = TC3-HMAC-SHA256 \n <timestamp> \n <date>/<service>/tc3_request \n hex(sha256(CanonicalRequest))
//   SecretDate = HMAC("TC3"+SecretKey, date)；SecretService = HMAC(SecretDate, service)；
//   SecretSigning = HMAC(SecretService, "tc3_request")；Signature = hex(HMAC(SecretSigning, StringToSign))

export const TC3_ALGORITHM = "TC3-HMAC-SHA256";
export const TC3_JSON_CONTENT_TYPE = "application/json; charset=utf-8";

export type Tc3Credentials = { secretId: string; secretKey: string };

export type Tc3SignInput = {
  /** 产品名，如 `asr`、`cvm`；也是凭证范围里的 service。 */
  service: string;
  /** 如 `asr.tencentcloudapi.com`。 */
  host: string;
  /** 如 `CreateRecTask`。签名里用小写，请求头里原样。 */
  action: string;
  /** 如 `2019-06-14`。 */
  version: string;
  /** 录音文件识别不需要地域，不传就不带 X-TC-Region。 */
  region?: string;
  /** 请求体原文：签名对字节签，调用方发出去的必须是同一个字符串。 */
  payload: string;
  /** Unix 秒。 */
  timestamp: number;
  credentials: Tc3Credentials;
};

export type Tc3Signature = {
  canonicalRequest: string;
  hashedPayload: string;
  hashedCanonicalRequest: string;
  stringToSign: string;
  credentialScope: string;
  signature: string;
  authorization: string;
  /** 直接交给 fetch 的请求头。 */
  headers: Record<string, string>;
};

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmac(key: ArrayBuffer | Uint8Array, value: string) {
  const raw = key instanceof Uint8Array
    ? key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer
    : key;
  const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
}

/** 签名日期取 UTC，不是本地时间——跨零点时本地日期会让签名失效。 */
export function tc3Date(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

export async function signTc3Request(input: Tc3SignInput): Promise<Tc3Signature> {
  const date = tc3Date(input.timestamp);
  const hashedPayload = await sha256Hex(input.payload);
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalHeaders =
    `content-type:${TC3_JSON_CONTENT_TYPE}\nhost:${input.host}\nx-tc-action:${input.action.toLowerCase()}\n`;
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, hashedPayload].join("\n");
  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
  const credentialScope = `${date}/${input.service}/tc3_request`;
  const stringToSign = [TC3_ALGORITHM, String(input.timestamp), credentialScope, hashedCanonicalRequest].join("\n");

  const secretDate = await hmac(encoder.encode(`TC3${input.credentials.secretKey}`), date);
  const secretService = await hmac(secretDate, input.service);
  const secretSigning = await hmac(secretService, "tc3_request");
  const signature = hex(await hmac(secretSigning, stringToSign));
  const authorization =
    `${TC3_ALGORITHM} Credential=${input.credentials.secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    Authorization: authorization,
    "Content-Type": TC3_JSON_CONTENT_TYPE,
    Host: input.host,
    "X-TC-Action": input.action,
    "X-TC-Timestamp": String(input.timestamp),
    "X-TC-Version": input.version,
  };
  if (input.region) headers["X-TC-Region"] = input.region;

  return {
    canonicalRequest,
    hashedPayload,
    hashedCanonicalRequest,
    stringToSign,
    credentialScope,
    signature,
    authorization,
    headers,
  };
}
