function parseDatabaseDate(value: string) {
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
