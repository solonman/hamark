// DeepSeek 调用：请求构造（docs/25 4.5 的参数）、响应解析、空内容、非法 JSON、HTTP 错误、超时。
// 传输层是假的，不真调 DeepSeek、不产生费用。
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEEPSEEK_MAX_TOKENS,
  buildDeepseekRequestBody,
  callDeepseekChat,
  describeDeepseekHttpError,
  parseModelJsonContent,
  type DeepseekFetch,
} from "../lib/audio-review/deepseek";

const messages = { system: "规则", user: "{\"作业\":{}}" };

function fakeFetch(respond: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: DeepseekFetch = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { calls, fetchImpl };
}

const options = (fetchImpl: DeepseekFetch, extra: Partial<Parameters<typeof callDeepseekChat>[1]> = {}) => ({
  apiKey: "sk-test",
  model: "deepseek-v4-pro",
  baseUrl: "https://api.deepseek.test",
  fetchImpl,
  ...extra,
});

const completion = (content: string | null, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({
  id: "c1",
  model: "deepseek-v4-pro",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, reasoning_content: "想了想" } }],
  usage: { prompt_tokens: 1200, completion_tokens: 800, total_tokens: 2000, completion_tokens_details: { reasoning_tokens: 500 } },
  ...extra,
}), { status: 200, headers: { "content-type": "application/json" } });

test("the request carries thinking, high reasoning effort, JSON mode and a 32000 token budget", () => {
  assert.deepEqual(buildDeepseekRequestBody("deepseek-v4-pro", messages), {
    model: "deepseek-v4-pro",
    messages: [
      { role: "system", content: "规则" },
      { role: "user", content: "{\"作业\":{}}" },
    ],
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    response_format: { type: "json_object" },
    max_tokens: 32000,
    stream: false,
  });
  assert.equal(DEEPSEEK_MAX_TOKENS, 32000);
});

test("a successful call posts to {base}/chat/completions with a bearer key and returns content and usage", async () => {
  const { calls, fetchImpl } = fakeFetch(() => completion("{\"opinions\":[]}"));
  const outcome = await callDeepseekChat(messages, options(fetchImpl));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.test/chat/completions");
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer sk-test");
  assert.equal(JSON.parse(String(calls[0].init.body)).model, "deepseek-v4-pro");
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.content, "{\"opinions\":[]}");
    assert.equal(outcome.finishReason, "stop");
    assert.deepEqual(outcome.usage, {
      prompt_tokens: 1200, completion_tokens: 800, total_tokens: 2000, completion_tokens_details: { reasoning_tokens: 500 },
    });
  }
});

test("empty content is a retryable failure that still records usage; a truncated empty answer says so", async () => {
  const empty = await callDeepseekChat(messages, options(fakeFetch(() => completion("")).fetchImpl));
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.equal(empty.reason, "模型返回了空内容。");
    assert.equal(empty.retryable, true);
    assert.ok(empty.usage);
  }
  const truncated = await callDeepseekChat(messages, options(fakeFetch(() => new Response(JSON.stringify({
    choices: [{ finish_reason: "length", message: { content: null } }],
  }), { status: 200 })).fetchImpl));
  assert.equal(truncated.ok, false);
  if (!truncated.ok) assert.match(truncated.reason, /截断/);
});

test("HTTP errors map to Chinese reasons; key and balance problems are not retried", async () => {
  for (const [status, pattern, retryable] of [
    [401, /DEEPSEEK_API_KEY/, false],
    [402, /余额不足/, false],
    [400, /请求格式/, false],
    [422, /参数/, false],
    [429, /频繁/, true],
    [503, /繁忙/, true],
  ] as const) {
    const outcome = await callDeepseekChat(messages, options(fakeFetch(() => new Response(
      JSON.stringify({ error: { message: "detail", type: "x" } }),
      { status },
    )).fetchImpl));
    assert.equal(outcome.ok, false, String(status));
    if (!outcome.ok) {
      assert.match(outcome.reason, pattern, String(status));
      assert.equal(outcome.retryable, retryable, String(status));
      assert.equal(outcome.status, status);
    }
  }
  assert.equal(describeDeepseekHttpError(418, null).retryable, false);
});

test("a call that does not answer within the timeout is aborted and reported as retryable", async () => {
  const { fetchImpl } = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }));
  const outcome = await callDeepseekChat(messages, options(fetchImpl, { timeoutMs: 20 }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(outcome.reason, /秒内没有返回结果/);
    assert.equal(outcome.retryable, true);
  }
});

test("network failures and non-JSON bodies are retryable", async () => {
  const network = await callDeepseekChat(messages, options(async () => { throw new TypeError("fetch failed"); }));
  assert.equal(network.ok, false);
  if (!network.ok) assert.equal(network.retryable, true);
  const html = await callDeepseekChat(messages, options(fakeFetch(() => new Response("<html>", { status: 200 })).fetchImpl));
  assert.equal(html.ok, false);
  if (!html.ok) assert.equal(html.retryable, true);
});

test("model content parsing accepts plain JSON, fenced JSON and JSON with a stray sentence; rejects the rest", () => {
  assert.deepEqual(parseModelJsonContent("{\"a\":1}"), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseModelJsonContent("```json\n{\"a\":1}\n```"), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseModelJsonContent("结果如下：{\"a\":1} 完毕"), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseModelJsonContent("[1,2]"), { ok: false, reason: "模型返回的内容不是合法的 JSON。" });
  assert.deepEqual(parseModelJsonContent("{\"a\":"), { ok: false, reason: "模型返回的内容不是合法的 JSON。" });
  assert.deepEqual(parseModelJsonContent("{\"a\":", "length"), { ok: false, reason: "模型输出过长被截断，JSON 不完整。" });
});
