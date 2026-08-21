import { getOptionalEnv, getRequiredEnv } from "../lib/env.ts";
import type {
  ObjectBody,
  ObjectRange,
  PresignedPutOptions,
  VideoBucket,
} from "./types.ts";

export type CosConfig = {
  region: string;
  bucket: string;
  secretId: string;
  secretKey: string;
  endpoint: string;
};

type FetchInitWithDuplex = RequestInit & { duplex?: "half" };
type CosFailureReason = "NOT_FOUND" | "AUTHORIZATION" | "SERVER" | "NETWORK" | "UNKNOWN";

class CosRequestError extends Error {
  constructor(
    readonly status: number,
    readonly reasonClass: CosFailureReason,
  ) {
    super(`COS request failed (${reasonClass}).`);
    this.name = "CosRequestError";
  }
}

export function cosFailureReason(error: unknown): CosFailureReason | null {
  return error instanceof CosRequestError ? error.reasonClass : null;
}

const unsignedPayload = "UNSIGNED-PAYLOAD";
const service = "s3";
const directRequestSignatureLifetimeSeconds = 10 * 60;

export function buildCosEndpoint(region: string) {
  return `https://cos.${region}.myqcloud.com`;
}

export function readCosConfig(): CosConfig {
  const region = getRequiredEnv("COS_REGION");
  return {
    region,
    bucket: getRequiredEnv("COS_BUCKET"),
    secretId: getRequiredEnv("COS_SECRET_ID"),
    secretKey: getRequiredEnv("COS_SECRET_KEY"),
    endpoint: getOptionalEnv("COS_ENDPOINT") ?? buildCosEndpoint(region),
  };
}

function encodePathSegment(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function objectPath(bucket: string, key: string) {
  return `/${encodePathSegment(bucket)}/${key.split("/").map(encodePathSegment).join("/")}`;
}

function virtualHostObjectUrl(bucket: string, region: string, key: string) {
  const url = new URL(buildCosEndpoint(region));
  url.hostname = `${bucket}.${url.hostname}`;
  url.pathname = `/${key.split("/").map(encodePathSegment).join("/")}`;
  return url.toString();
}

function amzDate(now = new Date()) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function shortDate(value: string) {
  return value.slice(0, 8);
}

function utf8(value: string) {
  return new TextEncoder().encode(value);
}

function arrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmac(key: ArrayBuffer, value: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, utf8(value));
}

async function hmacSha1(key: string, value: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    utf8(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", cryptoKey, utf8(value)));
}

async function sha256(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", utf8(value)));
}

async function sha1(value: string) {
  return hex(await crypto.subtle.digest("SHA-1", utf8(value)));
}

function isNativeCosEndpoint(endpoint: string) {
  try {
    return new URL(endpoint).hostname.toLowerCase().endsWith(".myqcloud.com");
  } catch {
    return false;
  }
}

function canonicalCosPairs(entries: Array<readonly [string, string]>) {
  return entries
    .map(([name, value]) => [name.toLowerCase(), value.trim()] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue))
    .map(([name, value]) => `${encodePathSegment(name)}=${encodePathSegment(value)}`)
    .join("&");
}

type CosSignatureFields = {
  "q-sign-algorithm": "sha1";
  "q-ak": string;
  "q-sign-time": string;
  "q-key-time": string;
  "q-header-list": string;
  "q-url-param-list": string;
  "q-signature": string;
};

async function createCosSignatureFields({
  method,
  url,
  headers,
  config,
  keyTime,
}: {
  method: string;
  url: URL;
  headers: Headers;
  config: CosConfig;
  keyTime: string;
}): Promise<CosSignatureFields> {
  const headerEntries = canonicalHeaders(headers)
    .filter(([name]) => name !== "authorization");
  const parameterEntries = Array.from(url.searchParams.entries())
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
  const headerList = headerEntries.map(([name]) => name).join(";");
  const parameterList = parameterEntries.map(([name]) => name).join(";");
  const httpString = [
    method.toLowerCase(),
    url.pathname,
    canonicalCosPairs(parameterEntries),
    canonicalCosPairs(headerEntries),
    "",
  ].join("\n");
  const stringToSign = `sha1\n${keyTime}\n${await sha1(httpString)}\n`;
  const signKey = await hmacSha1(config.secretKey, keyTime);
  return {
    "q-sign-algorithm": "sha1",
    "q-ak": config.secretId,
    "q-sign-time": keyTime,
    "q-key-time": keyTime,
    "q-header-list": headerList,
    "q-url-param-list": parameterList,
    "q-signature": await hmacSha1(signKey, stringToSign),
  };
}

export async function createCosAuthorization(
  request: Request,
  config: CosConfig,
  {
    now = new Date(),
    expiresInSeconds = directRequestSignatureLifetimeSeconds,
  }: { now?: Date; expiresInSeconds?: number } = {},
) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set("host", url.host);
  const startTime = Math.floor(now.getTime() / 1000);
  const keyTime = `${startTime};${startTime + expiresInSeconds}`;
  const fields = await createCosSignatureFields({
    method: request.method,
    url,
    headers,
    config,
    keyTime,
  });
  return Object.entries(fields).map(([name, value]) => `${name}=${value}`).join("&");
}

async function signingKey(secretKey: string, date: string, region: string) {
  const kDate = await hmac(arrayBuffer(utf8(`AWS4${secretKey}`)), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function canonicalHeaders(headers: Headers) {
  return Array.from(headers.entries())
    .map(([name, value]) => [name.toLowerCase(), value.trim()] as const)
    .sort(([a], [b]) => a.localeCompare(b));
}

async function signAwsRequest(
  request: Request,
  config: CosConfig,
  now = new Date(),
) {
  const dateTime = amzDate(now);
  const date = shortDate(dateTime);
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set("host", url.host);
  headers.set("x-amz-content-sha256", unsignedPayload);
  headers.set("x-amz-date", dateTime);

  const headerEntries = canonicalHeaders(headers);
  const signedHeaders = headerEntries.map(([name]) => name).join(";");
  const canonicalHeaderText = headerEntries
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");
  const canonicalRequest = [
    request.method,
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaderText,
    signedHeaders,
    unsignedPayload,
  ].join("\n");
  const scope = `${date}/${config.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    dateTime,
    scope,
    await sha256(canonicalRequest),
  ].join("\n");
  const key = await signingKey(config.secretKey, date, config.region);
  const signature = hex(await hmac(key, stringToSign));
  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${config.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
  return headers;
}

function metadataHeaders(
  metadata: Record<string, string> | undefined,
  prefix: "x-cos-meta" | "x-amz-meta",
) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(metadata ?? {})) {
    headers.set(`${prefix}-${key.toLowerCase()}`, value);
  }
  return headers;
}

function responseMetadata(headers: Headers) {
  const metadata: Record<string, string> = {};
  // Read the S3-compatible form first and let the native COS form win if both exist.
  for (const prefix of ["x-amz-meta-", "x-cos-meta-"] as const) {
    for (const [name, value] of headers.entries()) {
      if (name.startsWith(prefix)) metadata[name.slice(prefix.length)] = value;
    }
  }
  return metadata;
}

function responseErrorCode(headers: Headers) {
  return headers.get("x-cos-error-code")?.trim()
    || headers.get("x-amz-error-code")?.trim()
    || "";
}

function classifyCosFailure(status: number, headers: Headers): CosFailureReason {
  const code = responseErrorCode(headers);
  if (status === 404 && (!code || code === "NoSuchKey" || code === "NotFound")) {
    return "NOT_FOUND";
  }
  if (status === 401 || status === 403 || code === "AccessDenied"
    || code === "InvalidAccessKeyId" || code === "SignatureDoesNotMatch") {
    return "AUTHORIZATION";
  }
  if (status >= 500) return "SERVER";
  return "UNKNOWN";
}

export class CosVideoBucket implements VideoBucket {
  private readonly config: CosConfig;

  constructor(config = readCosConfig()) {
    this.config = config;
  }

  private url(key: string) {
    if (this.config.endpoint === buildCosEndpoint(this.config.region)) {
      return virtualHostObjectUrl(this.config.bucket, this.config.region, key);
    }
    const endpoint = this.config.endpoint.replace(/\/$/, "");
    return `${endpoint}${objectPath(this.config.bucket, key)}`;
  }

  private metadataPrefix() {
    return isNativeCosEndpoint(this.config.endpoint)
      ? "x-cos-meta" as const
      : "x-amz-meta" as const;
  }

  private async request(
    method: string,
    key: string,
    init: FetchInitWithDuplex = {},
  ) {
    const request = new Request(this.url(key), {
      ...init,
      method,
    });
    const headers = new Headers(request.headers);
    if (isNativeCosEndpoint(this.config.endpoint)) {
      headers.set("host", new URL(request.url).host);
      headers.set("authorization", await createCosAuthorization(request, this.config));
    } else {
      const awsHeaders = await signAwsRequest(request, this.config);
      for (const [name, value] of awsHeaders.entries()) headers.set(name, value);
    }
    const signedRequest = new Request(request, { headers });
    let response: Response;
    try {
      response = await fetch(signedRequest);
    } catch {
      throw new CosRequestError(0, "NETWORK");
    }
    if (!response.ok) {
      throw new CosRequestError(response.status, classifyCosFailure(response.status, response.headers));
    }
    return response;
  }

  async createPresignedPutUrl(
    key: string,
    {
      contentType,
      expiresInSeconds = 600,
      now = new Date(),
    }: PresignedPutOptions,
  ) {
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 900) {
      throw new Error("COS upload URL expiry must be between 1 and 900 seconds.");
    }

    // COS allows server-side path-style requests but requires virtual-hosted URLs for browser uploads.
    const url = new URL(virtualHostObjectUrl(this.config.bucket, this.config.region, key));
    const startTime = Math.floor(now.getTime() / 1000);
    const keyTime = `${startTime};${startTime + expiresInSeconds}`;
    const headers = new Headers({
      "content-type": contentType,
      host: url.host,
    });
    const fields = await createCosSignatureFields({
      method: "PUT", url, headers, config: this.config, keyTime,
    });
    const parameters = new URLSearchParams(fields);
    url.search = parameters.toString();
    return url.toString();
  }

  async createPresignedGetUrl(
    key: string,
    {
      expiresInSeconds = 3 * 60 * 60,
      now = new Date(),
    }: { expiresInSeconds?: number; now?: Date } = {},
  ) {
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 3 * 60 * 60) {
      throw new Error("COS playback URL expiry must be between 1 and 10800 seconds.");
    }

    const url = new URL(virtualHostObjectUrl(this.config.bucket, this.config.region, key));
    const startTime = Math.floor(now.getTime() / 1000);
    const keyTime = `${startTime};${startTime + expiresInSeconds}`;
    const headers = new Headers({ host: url.host });
    const fields = await createCosSignatureFields({
      method: "GET", url, headers, config: this.config, keyTime,
    });
    const parameters = new URLSearchParams(fields);
    url.search = parameters.toString();
    return url.toString();
  }

  async put(
    key: string,
    body: ObjectBody,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      ifNoneMatch?: "*";
    },
  ) {
    const headers = metadataHeaders(options?.customMetadata, this.metadataPrefix());
    if (options?.httpMetadata?.contentType) {
      headers.set("content-type", options.httpMetadata.contentType);
    }
    if (options?.ifNoneMatch) headers.set("if-none-match", options.ifNoneMatch);
    const requestBody = body instanceof Uint8Array ? new Blob([arrayBuffer(body)]) : body;
    await this.request("PUT", key, {
      body: requestBody,
      headers,
      duplex: body instanceof ReadableStream ? "half" : undefined,
    });
  }

  async head(key: string) {
    const response = await this.request("HEAD", key).catch((error) => {
      if (error instanceof CosRequestError && error.reasonClass === "NOT_FOUND") return null;
      throw error;
    });
    if (!response) return null;
    return {
      size: Number(response.headers.get("content-length") ?? 0),
      httpEtag: response.headers.get("etag") ?? undefined,
      contentType: response.headers.get("content-type") ?? undefined,
      customMetadata: responseMetadata(response.headers),
    };
  }

  async get(key: string, options?: { range?: ObjectRange }) {
    const headers = new Headers();
    if (options?.range) {
      headers.set(
        "range",
        `bytes=${options.range.offset}-${options.range.offset + options.range.length - 1}`,
      );
    }
    const response = await this.request("GET", key, { headers });
    return {
      body: response.body,
    };
  }

  async delete(key: string) {
    await this.request("DELETE", key);
  }
}
