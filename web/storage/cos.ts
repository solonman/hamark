import { getOptionalEnv, getRequiredEnv } from "../lib/env.ts";

export type CosConfig = {
  region: string;
  bucket: string;
  secretId: string;
  secretKey: string;
  endpoint: string;
};

type ObjectBody = ReadableStream<Uint8Array> | Blob | Uint8Array;
type FetchInitWithDuplex = RequestInit & { duplex?: "half" };

export type PresignedPutOptions = {
  contentType: string;
  expiresInSeconds?: number;
  now?: Date;
};

export type ObjectRange = {
  offset: number;
  length: number;
};

const unsignedPayload = "UNSIGNED-PAYLOAD";
const service = "s3";

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

async function signRequest(
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

function metadataHeaders(metadata?: Record<string, string>) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(metadata ?? {})) {
    headers.set(`x-amz-meta-${key.toLowerCase()}`, value);
  }
  return headers;
}

export class CosVideoBucket {
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

  private async request(
    method: string,
    key: string,
    init: FetchInitWithDuplex = {},
  ) {
    const request = new Request(this.url(key), {
      ...init,
      method,
    });
    const headers = await signRequest(request, this.config);
    const fetchInit: FetchInitWithDuplex = { headers };
    if (init.duplex) fetchInit.duplex = init.duplex;
    const response = await fetch(request, fetchInit as RequestInit);
    if (!response.ok) {
      throw new Error(`COS ${method} ${key} failed with ${response.status}`);
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
    const headerList = "content-type;host";
    const httpHeaders = [
      `content-type=${encodePathSegment(contentType)}`,
      `host=${encodePathSegment(url.host)}`,
    ].join("&");
    const httpString = `put\n${url.pathname}\n\n${httpHeaders}\n`;
    const stringToSign = `sha1\n${keyTime}\n${await sha1(httpString)}\n`;
    const signKey = await hmacSha1(this.config.secretKey, keyTime);
    const signature = await hmacSha1(signKey, stringToSign);
    const parameters = new URLSearchParams({
      "q-sign-algorithm": "sha1",
      "q-ak": this.config.secretId,
      "q-sign-time": keyTime,
      "q-key-time": keyTime,
      "q-header-list": headerList,
      "q-url-param-list": "",
      "q-signature": signature,
    });
    url.search = parameters.toString();
    return url.toString();
  }

  async put(
    key: string,
    body: ObjectBody,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ) {
    const headers = metadataHeaders(options?.customMetadata);
    if (options?.httpMetadata?.contentType) {
      headers.set("content-type", options.httpMetadata.contentType);
    }
    const requestBody = body instanceof Uint8Array ? new Blob([arrayBuffer(body)]) : body;
    await this.request("PUT", key, {
      body: requestBody,
      headers,
      duplex: body instanceof ReadableStream ? "half" : undefined,
    });
  }

  async head(key: string) {
    const response = await this.request("HEAD", key).catch((error) => {
      if (error instanceof Error && error.message.endsWith(" 404")) return null;
      throw error;
    });
    if (!response) return null;
    return {
      size: Number(response.headers.get("content-length") ?? 0),
      httpEtag: response.headers.get("etag") ?? undefined,
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
