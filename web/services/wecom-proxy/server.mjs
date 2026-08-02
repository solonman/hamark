import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  MAX_BODY_BYTES,
  parseMemberRequest,
  verifySignedBody,
} from "./protocol.mjs";
import { WeComServiceError, createWeComService } from "./wecom.mjs";

export const REQUEST_DEADLINE_MS = 6500;

const STABLE_SERVICE_CODES = new Set([
  "AUTH_EXPIRED",
  "MEMBER_NOT_ALLOWED",
  "PROFILE_UNAVAILABLE",
  "WECOM_UNAVAILABLE",
  "PROXY_MISCONFIGURED",
]);

export function readProxyConfig(env = process.env) {
  const corpId = readRequiredEnv(env, "WECOM_CORP_ID");
  const secret = readRequiredEnv(env, "WECOM_SECRET");
  const proxySecret = readRequiredEnv(env, "WECOM_PROXY_SECRET");
  const host = env.HOST === undefined ? "127.0.0.1" : String(env.HOST).trim();
  const portValue = env.PORT === undefined ? "3201" : String(env.PORT);

  if (
    Buffer.byteLength(proxySecret, "utf8") < 32
    || host !== "127.0.0.1"
    || !/^\d+$/.test(portValue)
  ) {
    throw misconfigured();
  }

  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw misconfigured();
  }

  return { corpId, secret, proxySecret, host, port };
}

export function createProxyServer({
  proxySecret,
  wecomService,
  nowSeconds = () => Math.floor(Date.now() / 1000),
  logger = console,
  requestDeadlineMs = REQUEST_DEADLINE_MS,
}) {
  return createServer((request, response) => {
    handleRequest({
      request,
      response,
      proxySecret,
      wecomService,
      nowSeconds,
      logger,
      requestDeadlineMs,
    })
      .catch(() => {
        if (!response.destroyed && !response.headersSent) {
          sendJson(response, 500, { ok: false, error: "WECOM_UNAVAILABLE" });
        } else if (!response.destroyed) {
          response.end();
        }
      });
  });
}

export function startProxyServer(env = process.env) {
  const config = readProxyConfig(env);
  const wecomService = createWeComService({
    corpId: config.corpId,
    secret: config.secret,
  });
  const server = createProxyServer({
    proxySecret: config.proxySecret,
    wecomService,
  });
  server.listen(config.port, config.host);
  return server;
}

async function handleRequest({
  request,
  response,
  proxySecret,
  wecomService,
  nowSeconds,
  logger,
  requestDeadlineMs,
}) {
  const lifetime = createRequestLifetime(request, response, requestDeadlineMs);
  try {
    await handleActiveRequest({
      request,
      response,
      proxySecret,
      wecomService,
      nowSeconds,
      logger,
      signal: lifetime.signal,
    });
  } finally {
    lifetime.cleanup();
  }
}

async function handleActiveRequest({
  request,
  response,
  proxySecret,
  wecomService,
  nowSeconds,
  logger,
  signal,
}) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/health" && url.search === "") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (
    request.method !== "POST"
    || url.pathname !== "/v1/member-by-code"
    || url.search !== ""
  ) {
    request.resume();
    sendJson(response, 404, { ok: false, error: "INVALID_REQUEST" });
    return;
  }

  if (request.headers["content-type"] !== "application/json") {
    request.resume();
    sendJson(response, 400, { ok: false, error: "INVALID_REQUEST" });
    return;
  }

  let rawBody;
  try {
    rawBody = await readLimitedBody(request, signal);
  } catch (error) {
    if (signal.aborted) {
      if (!response.destroyed) {
        sendJson(response, 503, { ok: false, error: "WECOM_UNAVAILABLE" });
      }
      return;
    }
    const status = error instanceof BodyTooLargeError ? 413 : 400;
    sendJson(response, status, { ok: false, error: "INVALID_REQUEST" });
    return;
  }

  const timestamp = readSingleHeader(request.headers["x-hamark-timestamp"]);
  const signature = readSingleHeader(request.headers["x-hamark-signature"]);
  if (!verifySignedBody({
    secret: proxySecret,
    timestamp,
    signature,
    rawBody,
    nowSeconds: nowSeconds(),
  })) {
    sendJson(response, 401, { ok: false, error: "INVALID_SIGNATURE" });
    return;
  }

  let code;
  try {
    code = parseMemberRequest(rawBody);
  } catch {
    sendJson(response, 400, { ok: false, error: "INVALID_REQUEST" });
    return;
  }

  try {
    if (signal.aborted) {
      throw new WeComServiceError("WECOM_UNAVAILABLE");
    }
    const member = await wecomService.getMemberByCode(code, { signal });
    sendJson(response, 200, { ok: true, member });
  } catch (error) {
    if (response.destroyed) {
      return;
    }
    const code = error instanceof WeComServiceError && STABLE_SERVICE_CODES.has(error.code)
      ? error.code
      : "WECOM_UNAVAILABLE";
    logger?.error?.("WeCom proxy request failed.", { code });
    sendJson(response, statusForServiceCode(code), { ok: false, error: code });
  }
}

function readLimitedBody(request, signal) {
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string" && Number(contentLength) > MAX_BODY_BYTES) {
    request.resume();
    return Promise.reject(new BodyTooLargeError());
  }

  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const settle = (operation, value) => {
      if (settled) {
        return;
      }
      settled = true;
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
      signal.removeEventListener("abort", onSignalAbort);
      operation(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.resume();
        settle(rejectBody, new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => settle(resolveBody, Buffer.concat(chunks, size));
    const onError = () => settle(rejectBody, new Error("Request body failed."));
    const onAborted = () => settle(rejectBody, new Error("Request body aborted."));
    const onSignalAbort = () => {
      request.resume();
      settle(rejectBody, new Error("Request deadline exceeded."));
    };

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
    signal.addEventListener("abort", onSignalAbort, { once: true });
    if (signal.aborted) {
      onSignalAbort();
    }
  });
}

function createRequestLifetime(request, response, deadlineMs) {
  const controller = new AbortController();
  const safeDeadlineMs = Number.isFinite(deadlineMs) && deadlineMs > 0
    ? deadlineMs
    : REQUEST_DEADLINE_MS;
  const timer = setTimeout(() => controller.abort(), safeDeadlineMs);
  timer.unref?.();
  const onRequestAborted = () => controller.abort();
  const onResponseClose = () => {
    if (!response.writableEnded) {
      controller.abort();
    }
  };
  request.on("aborted", onRequestAborted);
  response.on("close", onResponseClose);

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      request.off("aborted", onRequestAborted);
      response.off("close", onResponseClose);
    },
  };
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(payload);
}

function statusForServiceCode(code) {
  switch (code) {
    case "AUTH_EXPIRED":
      return 401;
    case "MEMBER_NOT_ALLOWED":
      return 403;
    case "WECOM_UNAVAILABLE":
      return 503;
    case "PROFILE_UNAVAILABLE":
      return 502;
    case "PROXY_MISCONFIGURED":
    default:
      return 500;
  }
}

function readRequiredEnv(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw misconfigured();
  }
  return value;
}

function readSingleHeader(value) {
  return typeof value === "string" ? value : "";
}

function misconfigured() {
  return new WeComServiceError("PROXY_MISCONFIGURED", "Proxy configuration is invalid.");
}

class BodyTooLargeError extends Error {}

function isDirectExecution() {
  return Boolean(
    process.argv[1]
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href,
  );
}

if (isDirectExecution()) {
  try {
    const server = startProxyServer();
    server.on("error", () => {
      process.stderr.write("WeCom proxy failed to start.\n");
      process.exitCode = 1;
    });
  } catch {
    process.stderr.write("WeCom proxy configuration is invalid.\n");
    process.exitCode = 1;
  }
}
