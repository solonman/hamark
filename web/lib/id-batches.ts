/**
 * 按 ID 批量查询的接口（卡片状态、收藏与评级）单次最多收 200 个 ID。
 *
 * 库里的条目一旦超过这个数，前端就得拆成几批分头查、再把结果拼回来；
 * 服务端的上限照旧保留，挡的是一次塞进几千个 ID 的异常请求。
 */
export const MAX_IDS_PER_QUERY = 200;

export function chunkIds<T>(ids: readonly T[], size = MAX_IDS_PER_QUERY): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < ids.length; start += size) batches.push(ids.slice(start, start + size));
  return batches;
}
