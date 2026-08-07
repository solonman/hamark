import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { localDemoAppUrl, requireLocalDemoMode } from "@/lib/local-demo";
import type {
  ObjectBody,
  ObjectRange,
  PresignedPutOptions,
  VideoBucket,
} from "./types";

type LocalMetadata = {
  contentType?: string;
  customMetadata?: Record<string, string>;
};

export function localStorageRoot() {
  return path.join(
    /* turbopackIgnore: true */ process.cwd(),
    ".local-demo",
    "storage",
  );
}

export function localObjectPath(key: string) {
  const normalized = key.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("Invalid local object key.");
  }
  const root = localStorageRoot();
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Local object key escapes the storage root.");
  }
  return resolved;
}

function metadataPath(key: string) {
  return `${localObjectPath(key)}.metadata.json`;
}

async function readMetadata(key: string): Promise<LocalMetadata> {
  try {
    return JSON.parse(await readFile(metadataPath(key), "utf8")) as LocalMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function localObjectContentType(key: string) {
  return (await readMetadata(key)).contentType || "application/octet-stream";
}

export async function copyFileToLocalObject(
  source: string,
  key: string,
  metadata: LocalMetadata = {},
) {
  const destination = localObjectPath(key);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await writeFile(metadataPath(key), JSON.stringify(metadata), "utf8");
}

function toWebStream(filePath: string, range?: ObjectRange) {
  const stream = createReadStream(
    filePath,
    range
      ? { start: range.offset, end: range.offset + range.length - 1 }
      : undefined,
  );
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

export class LocalVideoBucket implements VideoBucket {
  constructor() {
    requireLocalDemoMode();
  }

  async createPresignedPutUrl(key: string, options: PresignedPutOptions) {
    void options;
    localObjectPath(key);
    return `${localDemoAppUrl()}/api/local-assets?key=${encodeURIComponent(key)}`;
  }

  async createPresignedGetUrl(
    key: string,
    options: { expiresInSeconds?: number; now?: Date } = {},
  ) {
    void options;
    localObjectPath(key);
    return `${localDemoAppUrl()}/api/local-assets?key=${encodeURIComponent(key)}`;
  }

  async put(
    key: string,
    body: ObjectBody,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ) {
    const destination = localObjectPath(key);
    await mkdir(path.dirname(destination), { recursive: true });
    if (body instanceof Uint8Array) {
      await writeFile(destination, body);
    } else if (body instanceof Blob) {
      await writeFile(destination, new Uint8Array(await body.arrayBuffer()));
    } else {
      await pipeline(
        Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>),
        createWriteStream(destination),
      );
    }
    await writeFile(
      metadataPath(key),
      JSON.stringify({
        contentType: options?.httpMetadata?.contentType,
        customMetadata: options?.customMetadata,
      }),
      "utf8",
    );
  }

  async head(key: string) {
    try {
      const info = await stat(localObjectPath(key));
      return {
        size: info.size,
        httpEtag: `\"local-${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}\"`,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async get(key: string, options?: { range?: ObjectRange }) {
    const object = await this.head(key);
    if (!object) return { body: null };
    return { body: toWebStream(localObjectPath(key), options?.range) };
  }

  async delete(key: string) {
    for (const target of [localObjectPath(key), metadataPath(key)]) {
      await unlink(target).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
}
