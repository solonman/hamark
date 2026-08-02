import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_BODY_BYTES = 4096;
export const MAX_CLOCK_SKEW_SECONDS = 60;

export class ProxyProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProxyProtocolError";
    this.code = code;
  }
}

export function signBody(secret, timestamp, rawBody) {
  const hmac = createHmac("sha256", secret);
  hmac.update(String(timestamp));
  hmac.update(".");
  hmac.update(toBuffer(rawBody));
  return hmac.digest("hex");
}

export function verifySignedBody({
  secret,
  timestamp,
  signature,
  rawBody,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  if (
    typeof timestamp !== "string"
    || !/^\d+$/.test(timestamp)
    || typeof signature !== "string"
    || !/^[a-fA-F0-9]{64}$/.test(signature)
  ) {
    return false;
  }

  const parsedTimestamp = Number(timestamp);
  if (
    !Number.isSafeInteger(parsedTimestamp)
    || !Number.isSafeInteger(nowSeconds)
    || Math.abs(nowSeconds - parsedTimestamp) > MAX_CLOCK_SKEW_SECONDS
  ) {
    return false;
  }

  try {
    const supplied = Buffer.from(signature, "hex");
    const expected = Buffer.from(signBody(secret, timestamp, rawBody), "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  } catch {
    return false;
  }
}

export function parseMemberRequest(rawBody) {
  const body = toBuffer(rawBody);
  if (body.byteLength > MAX_BODY_BYTES) {
    throw invalidRequest();
  }

  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw invalidRequest();
  }

  if (
    !isRecord(parsed)
    || typeof parsed.code !== "string"
    || parsed.code.trim().length === 0
    || parsed.code.length > 512
  ) {
    throw invalidRequest();
  }

  return parsed.code;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  throw invalidRequest();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequest() {
  return new ProxyProtocolError("INVALID_REQUEST", "Invalid member request.");
}
