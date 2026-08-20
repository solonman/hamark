export async function readJsonResponse<T>(response: Response, operation: string): Promise<T> {
  const body = await response.text();
  const status = `HTTP ${response.status}`;
  if (!body.trim()) {
    throw new Error(
      `${operation}失败：服务器返回了空响应（${status}）。请稍后重试；若问题持续，请把操作时间告知管理员。`,
    );
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(
      `${operation}失败：服务器返回了无法识别的响应（${status}）。请稍后重试；若问题持续，请联系管理员。`,
    );
  }
}
