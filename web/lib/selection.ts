export function toggleLimitedSelection(
  values: string[],
  value: string,
  limit: number | null = 2,
) {
  if (values.includes(value)) return values.filter((item) => item !== value);
  const next = [...values, value];
  return limit == null ? next : next.slice(-limit);
}
