import { createHash, webcrypto } from "node:crypto";

const crypto = webcrypto;
const encoder = new TextEncoder();
const tokenKeyInfo = encoder.encode("hamark-wecom-token-v1");

export type EncryptedSecret = {
  ciphertext: string;
  iv: string;
};

const reservedAuthPaths = new Set([
  "/api/auth",
  "/callback",
  "/login",
  "/signin-with-chatgpt",
  "/signout-with-chatgpt",
]);

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes as Uint8Array<ArrayBuffer>;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizePathname(pathname: string): string | null {
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (
    !decodedPathname.startsWith("/") ||
    decodedPathname.startsWith("//") ||
    /[\u0000-\u001f\\]/u.test(decodedPathname)
  ) {
    return null;
  }

  if (decodedPathname.length > 1) {
    decodedPathname = decodedPathname.replace(/\/+$/u, "");
  }
  return decodedPathname;
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function getTokenCryptoKey(authSecret: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(authSecret),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: tokenKeyInfo,
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function hashToken(value: string): Promise<string> {
  return bytesToHex(await sha256Bytes(value));
}

export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\u0000-\u001f\\]/u.test(value)) {
    return "/";
  }

  let url: URL;
  try {
    url = new URL(value, "https://hamark.local");
  } catch {
    return "/";
  }

  if (url.origin !== "https://hamark.local") {
    return "/";
  }

  const normalizedPathname = normalizePathname(url.pathname);
  if (
    !normalizedPathname ||
    reservedAuthPaths.has(normalizedPathname) ||
    normalizedPathname.startsWith("/api/auth/")
  ) {
    return "/";
  }

  return `${normalizedPathname}${url.search}${url.hash}`;
}

export function buildIdentityKey(corpId: string, userId: string): string {
  const digest = createHash("sha256").update(`${corpId}\0${userId}`, "utf8").digest("hex");
  return `wecom:${digest}`;
}

export async function encryptSecret(value: string, authSecret: string): Promise<EncryptedSecret> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await getTokenCryptoKey(authSecret);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value)),
  );

  return {
    ciphertext: bytesToBase64Url(ciphertext),
    iv: bytesToBase64Url(iv),
  };
}

export async function decryptSecret(value: EncryptedSecret, authSecret: string): Promise<string> {
  const key = await getTokenCryptoKey(authSecret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(value.iv) },
    key,
    base64UrlToBytes(value.ciphertext),
  );

  return new TextDecoder().decode(plaintext);
}
