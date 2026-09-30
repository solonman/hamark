// 外部 Agent 只读接口的查询参数解析。纯函数，不碰数据库。

export class AgentApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

export type AgentListQuery = {
  limit: number;
  offset: number;
  q: string | null;
  updatedSince: string | null;
  hasAnalysis: boolean;
};

/** 签名 URL 有效期：够 Agent 下载完一条视频，又不至于长期可转发。 */
export const AGENT_MEDIA_URL_TTL_SECONDS = 60 * 60;

export const AGENT_LIST_DEFAULT_LIMIT = 50;
export const AGENT_LIST_MAX_LIMIT = 200;

function intParam(value: string | null, name: string, fallback: number, min: number, max: number) {
  if (value === null || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new AgentApiError(400, "INVALID_PARAM", `${name} 必须是非负整数。`);
  }
  return Math.min(max, Math.max(min, Number(value)));
}

export function parseAgentListQuery(params: URLSearchParams): AgentListQuery {
  const q = params.get("q")?.trim() || null;
  if (q && q.length > 100) throw new AgentApiError(400, "INVALID_PARAM", "q 最长 100 个字符。");
  const updatedSinceRaw = params.get("updatedSince")?.trim() || null;
  let updatedSince: string | null = null;
  if (updatedSinceRaw) {
    const time = Date.parse(updatedSinceRaw);
    if (Number.isNaN(time)) {
      throw new AgentApiError(400, "INVALID_PARAM", "updatedSince 须为 ISO 8601 时间，例如 2026-09-01T00:00:00Z。");
    }
    updatedSince = new Date(time).toISOString();
  }
  const hasAnalysisRaw = params.get("hasAnalysis")?.trim().toLowerCase();
  if (hasAnalysisRaw && hasAnalysisRaw !== "true" && hasAnalysisRaw !== "false") {
    throw new AgentApiError(400, "INVALID_PARAM", "hasAnalysis 只能是 true 或 false。");
  }
  return {
    limit: intParam(params.get("limit"), "limit", AGENT_LIST_DEFAULT_LIMIT, 1, AGENT_LIST_MAX_LIMIT),
    offset: intParam(params.get("offset"), "offset", 0, 0, Number.MAX_SAFE_INTEGER),
    q,
    updatedSince,
    hasAnalysis: hasAnalysisRaw === "true",
  };
}

/** `final`（集成版，默认）/ `latest`（最近保存的个人版本）/ 具体版本 id。 */
export type AgentVersionSelector = { kind: "FINAL" } | { kind: "LATEST" } | { kind: "ID"; id: string };

export function parseAgentVersionSelector(params: URLSearchParams): AgentVersionSelector {
  const raw = params.get("version")?.trim() || "final";
  if (raw === "final") return { kind: "FINAL" };
  if (raw === "latest") return { kind: "LATEST" };
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(raw)) {
    throw new AgentApiError(400, "INVALID_PARAM", "version 只能是 final、latest 或版本 id。");
  }
  return { kind: "ID", id: raw };
}

/** `both`（默认）同时给原始 payload 与中文可读视图；`raw` / `readable` 只给其一。 */
export type AgentPayloadFormat = "both" | "raw" | "readable";

export function parseAgentPayloadFormat(params: URLSearchParams): AgentPayloadFormat {
  const raw = params.get("format")?.trim() || "both";
  if (raw === "both" || raw === "raw" || raw === "readable") return raw;
  throw new AgentApiError(400, "INVALID_PARAM", "format 只能是 both、raw 或 readable。");
}

/** ILIKE 模式里把用户输入的 % _ \ 当普通字符。 */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export function tagsFromJson(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const tags = JSON.parse(value);
    return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

/**
 * pg 把 TIMESTAMPTZ 读成 Date、TEXT 列读成字符串；对外统一成 ISO 字符串或 null。
 * 早期 SQLite 时代写入的 TEXT 时间形如 `2026-07-31 07:15:48`、不带时区，当时的
 * CURRENT_TIMESTAMP 是 UTC；不补 Z 的话 Date.parse 会按服务器本地时区解释，
 * 本机（东八区）与 Vercel（UTC）就会差出 8 小时。
 */
export function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  const hasZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(text);
  const time = Date.parse(hasZone || !/\d{2}:\d{2}/.test(text) ? text : `${text.replace(" ", "T")}Z`);
  return Number.isNaN(time) ? text : new Date(time).toISOString();
}
