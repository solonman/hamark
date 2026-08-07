export type ObjectBody = ReadableStream<Uint8Array> | Blob | Uint8Array;

export type PresignedPutOptions = {
  contentType: string;
  expiresInSeconds?: number;
  now?: Date;
};

export type ObjectRange = {
  offset: number;
  length: number;
};

export interface VideoBucket {
  createPresignedPutUrl(key: string, options: PresignedPutOptions): Promise<string>;
  createPresignedGetUrl(
    key: string,
    options?: { expiresInSeconds?: number; now?: Date },
  ): Promise<string>;
  put(
    key: string,
    body: ObjectBody,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<void>;
  head(key: string): Promise<{ size: number; httpEtag?: string } | null>;
  get(
    key: string,
    options?: { range?: ObjectRange },
  ): Promise<{ body: ReadableStream<Uint8Array> | null }>;
  delete(key: string): Promise<void>;
}
