export type ObjectBody = ReadableStream<Uint8Array> | Blob | Uint8Array;

export type PresignedPutOptions = {
  contentType: string;
  expiresInSeconds?: number;
  now?: Date;
};

/**
 * 预签名 GET 的可选响应头覆盖（COS 的 response-content-* 查询参数，签名时一并纳入）。
 * 用在 302 跳转的场景：Word／Excel／PPT 要以附件下载、PDF 要在浏览器里内联打开，
 * 但存进去的 Content-Type 来自浏览器、不一定可靠。本机存储忽略这两项。
 */
export type PresignedGetOptions = {
  expiresInSeconds?: number;
  now?: Date;
  responseContentDisposition?: string;
  responseContentType?: string;
};

export type ObjectRange = {
  offset: number;
  length: number;
};

export interface VideoBucket {
  createPresignedPutUrl(key: string, options: PresignedPutOptions): Promise<string>;
  createPresignedGetUrl(key: string, options?: PresignedGetOptions): Promise<string>;
  put(
    key: string,
    body: ObjectBody,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      ifNoneMatch?: "*";
    },
  ): Promise<void>;
  head(key: string): Promise<{
    size: number;
    httpEtag?: string;
    contentType?: string;
    customMetadata?: Record<string, string>;
  } | null>;
  get(
    key: string,
    options?: { range?: ObjectRange },
  ): Promise<{ body: ReadableStream<Uint8Array> | null }>;
  delete(key: string): Promise<void>;
}
