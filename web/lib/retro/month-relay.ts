// 接力推进（docs/26 6.3）：每推进完一步，在 after() 里向自己发一个内部推进请求，接着跑下一步。
// 请求只认 HMAC 令牌：内容是「任务 id + 步骤序号（relay_seq）」，密钥 RETRO_RELAY_SECRET；
// 令牌用一次作废（核对通过即把 relay_seq 加一），签发新令牌也会让旧令牌失效。无效一律 404。

import { createHmac, timingSafeEqual } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import { advanceRetroMonthJob, type RetroAdvanceResult, type RetroMonthDeps } from "./month-service";

export const RETRO_RELAY_HEADER = "x-retro-relay-token";
const RELAY_REQUEST_TIMEOUT_MS = 15_000;

export function signRetroRelayToken(secret: string, jobId: string, seq: number): string {
  const mac = createHmac("sha256", secret).update(`${jobId}:${seq}`, "utf8").digest("hex");
  return `${seq}.${mac}`;
}

export function parseRetroRelayToken(token: unknown): { seq: number; mac: string } | null {
  if (typeof token !== "string") return null;
  const match = /^(\d{1,9})\.([0-9a-f]{64})$/.exec(token.trim());
  return match ? { seq: Number(match[1]), mac: match[2] } : null;
}

export function verifyRetroRelaySignature(secret: string, jobId: string, token: unknown): number | null {
  const parsed = parseRetroRelayToken(token);
  if (!parsed) return null;
  const expected = Buffer.from(signRetroRelayToken(secret, jobId, parsed.seq).split(".")[1], "hex");
  const actual = Buffer.from(parsed.mac, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? parsed.seq : null;
}

/** 签发下一张令牌（relay_seq 加一，旧令牌随之失效）。任务已不在途时返回 null。 */
export async function issueRetroRelayToken(db: DbClient, jobId: string, secret: string): Promise<string | null> {
  const row = await db.prepare(
    `UPDATE retro_month_jobs SET relay_seq = relay_seq + 1
    WHERE id = ? AND status IN ('QUEUED', 'EXTRACTING', 'SUMMARIZING', 'DISTILLING')
    RETURNING relay_seq`,
  ).bind(jobId).first<QueryResultRow & { relay_seq: number }>();
  return row ? signRetroRelayToken(secret, jobId, Number(row.relay_seq)) : null;
}

/** 核对并作废一张令牌：签名对、序号是当前序号、任务仍在途，才返回 true。 */
export async function consumeRetroRelayToken(
  db: DbClient,
  input: { monthKey: string; jobId: string; token: unknown; secret: string | null },
): Promise<boolean> {
  const { monthKey, jobId, token, secret } = input;
  if (!secret) return false;
  const seq = verifyRetroRelaySignature(secret, jobId, token);
  if (seq == null) return false;
  const row = await db.prepare(
    `UPDATE retro_month_jobs SET relay_seq = relay_seq + 1
    WHERE id = ? AND month_key = ? AND relay_seq = ? AND status IN ('QUEUED', 'EXTRACTING', 'SUMMARIZING', 'DISTILLING')
    RETURNING id`,
  ).bind(jobId, monthKey, seq).first<QueryResultRow & { id: string }>();
  return Boolean(row);
}

export type RetroRelaySender = (input: { url: string; token: string }) => Promise<void>;

export function retroRelayUrl(origin: string, monthKey: string, jobId: string) {
  return `${origin.replace(/\/+$/, "")}/api/retro-months/${encodeURIComponent(monthKey)}/jobs/${encodeURIComponent(jobId)}/advance`;
}

/** 默认发送方式：POST 到自己的 advance 接口，只等它回 202，不等它把活干完。 */
export const fetchRetroRelay: RetroRelaySender = async ({ url, token }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "POST", headers: { [RETRO_RELAY_HEADER]: token }, signal: controller.signal, cache: "no-store" });
    // 接力接口只会回 202；别的状态（被会话代理挡下的 401、令牌无效的 404）都要记日志，方便排查。
    if (response.status !== 202) throw new Error(`接力请求返回 HTTP ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
};

export type AdvanceAndRelayInput = {
  jobId: string;
  monthKey: string;
  deadline: number;
  origin: string | null;
  secret: string | null;
  deps: RetroMonthDeps;
  send?: RetroRelaySender;
};

/** 推进一次；任务还在途就签发令牌、接力下一次。接力失败只记日志（月份页 GET 会兜底接上）。 */
export async function advanceAndRelay(db: DbClient, input: AdvanceAndRelayInput): Promise<RetroAdvanceResult & { relayed: boolean }> {
  const log = input.deps.log ?? ((message: string, detail?: unknown) => console.error(message, detail));
  const result = await advanceRetroMonthJob(db, input.jobId, { deadline: input.deadline, deps: input.deps });
  if (!result.relay || !input.secret || !input.origin) return { ...result, relayed: false };
  try {
    const token = await issueRetroRelayToken(db, input.jobId, input.secret);
    if (!token) return { ...result, relayed: false };
    await (input.send ?? fetchRetroRelay)({ url: retroRelayUrl(input.origin, input.monthKey, input.jobId), token });
    return { ...result, relayed: true };
  } catch (error) {
    log("[retro-month] 接力请求失败，等月份页 GET 兜底", error);
    return { ...result, relayed: false };
  }
}
