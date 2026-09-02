/**
 * PostgreSQL 常把时间戳写成 `YYYY-MM-DD HH:mm:ss[.ffffff][+TZ]` 而不是 ISO 8601
 * （空格代替 `T`，时区可能只有两位小时）；`new Date()` 直接吃这种格式会得到
 * Invalid Date。导出给需要把数据库时间戳转成 ISO 字符串的调用方复用
 * （例如 `lib/case-review-server.ts` 序列化 `updated_at`），不要各自复制一份。
 */
export function parseDatabaseDate(value: string) {
  let normalized = value.trim().replace(" ", "T");
  if (!/[zZ]$|[+-]\d{2}(?::?\d{2})?$/.test(normalized)) {
    normalized = `${normalized}Z`;
  } else if (/[+-]\d{2}$/.test(normalized)) {
    normalized = `${normalized}:00`;
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatShortDate(value: string) {
  const date = parseDatabaseDate(value);
  if (!date) return "未知日期";

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function formatLongDate(value: string) {
  const date = parseDatabaseDate(value);
  if (!date) return "未知日期";

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * `MM-DD HH:mm`，本地时区。给评论列表这类挤在一行里的时间戳用——
 * 比 `formatShortDate` 多带分钟，又不用 `formatLongDate` 那么长。
 * 写法仿照 `V04StudioClient.tsx` 的 `formatV19Date` / `formatV19Clock`：
 * 手动 pad，不经 `Intl.DateTimeFormat`。
 */
export function formatShortDateTime(value: string) {
  const date = parseDatabaseDate(value);
  if (!date) return "未知时间";

  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
