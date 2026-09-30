// 外部 Agent 只读接口（docs/23_外部Agent只读API_V0.1.md）：令牌校验、参数解析、
// 中文可读视图用纯函数直接测；路由文件按文本断言（同 tests/report-final-api-contract.test.ts，
// 导入 route 模块会在加载时拉起 @/db）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  authenticateAgentRequest,
  hashAgentToken,
  mintAgentToken,
  parseAgentApiKeys,
} from "../lib/agent-api/auth";
import {
  AgentApiError,
  isoOrNull,
  likePattern,
  parseAgentListQuery,
  parseAgentPayloadFormat,
  parseAgentVersionSelector,
} from "../lib/agent-api/params";
import { toReadableReportAnalysis, toReadableVideoAnalysis } from "../lib/agent-api/readable";
import { emptyV04DraftPayload } from "../lib/v04-domain";
import { V04_VOCABULARY_VERSION } from "../lib/v04-contract";
import type { ReportAnnotation } from "../lib/report-structure";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const codeOnly = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const withAuth = (value?: string) =>
  new Request("https://hamark.test/api/agent/v1/videos", value ? { headers: { authorization: value } } : {});

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

test("parseAgentApiKeys keeps well-formed name:sha256 entries and drops everything else", () => {
  const good = "a".repeat(64);
  const keys = parseAgentApiKeys(` bot-1:${good} ,\nbad name:${good},short:abc,:${good},bot_2:${"B".repeat(64)}`);
  assert.deepEqual(keys, [
    { name: "bot-1", hash: good },
    { name: "bot_2", hash: "b".repeat(64) },
  ]);
  assert.deepEqual(parseAgentApiKeys(undefined), []);
  assert.deepEqual(parseAgentApiKeys(""), []);
});

test("the API is invisible (404) until at least one key is configured", () => {
  const result = authenticateAgentRequest(withAuth("Bearer anything"), "");
  assert.deepEqual(result.ok ? null : [result.status, result.code], [404, "AGENT_API_DISABLED"]);
});

test("a minted token authenticates as its agent; missing, malformed or wrong tokens get 401", () => {
  const { token, entry } = mintAgentToken("research-bot");
  assert.ok(token.startsWith("hmk_agent_"));
  assert.equal(entry, `research-bot:${hashAgentToken(token)}`);
  const other = mintAgentToken("copy-bot");
  const keys = `${other.entry},${entry}`;

  assert.deepEqual(authenticateAgentRequest(withAuth(`Bearer ${token}`), keys), { ok: true, agent: "research-bot" });
  assert.deepEqual(authenticateAgentRequest(withAuth(`bearer ${other.token}`), keys), { ok: true, agent: "copy-bot" });

  for (const header of [undefined, token, `Basic ${token}`, `Bearer ${token}x`, "Bearer "]) {
    const result = authenticateAgentRequest(withAuth(header), keys);
    assert.equal(result.ok, false, `header ${header} must be refused`);
    if (!result.ok) assert.equal(result.status, 401);
  }
});

test("mintAgentToken refuses names that could not be parsed back out of AGENT_API_KEYS", () => {
  assert.throws(() => mintAgentToken("has space"));
  assert.throws(() => mintAgentToken("a:b"));
  assert.throws(() => mintAgentToken(""));
});

test("the env only ever stores hashes: a stored hash used as a token does not authenticate", () => {
  const { entry } = mintAgentToken("bot");
  const storedHash = entry.split(":")[1];
  const result = authenticateAgentRequest(withAuth(`Bearer ${storedHash}`), entry);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

test("list query defaults, clamps and validates", () => {
  assert.deepEqual(parseAgentListQuery(new URLSearchParams()), {
    limit: 50, offset: 0, q: null, updatedSince: null, hasAnalysis: false,
  });
  const parsed = parseAgentListQuery(new URLSearchParams("limit=999&offset=20&q= 欢迎回家 &hasAnalysis=true&updatedSince=2026-09-01"));
  assert.equal(parsed.limit, 200);
  assert.equal(parsed.offset, 20);
  assert.equal(parsed.q, "欢迎回家");
  assert.equal(parsed.hasAnalysis, true);
  assert.equal(parsed.updatedSince, "2026-09-01T00:00:00.000Z");
  assert.equal(parseAgentListQuery(new URLSearchParams("limit=0")).limit, 1);

  for (const bad of ["limit=-1", "limit=abc", "offset=1.5", "updatedSince=yesterday", "hasAnalysis=yes", `q=${"x".repeat(101)}`]) {
    assert.throws(() => parseAgentListQuery(new URLSearchParams(bad)), AgentApiError, bad);
  }
});

test("version selector defaults to 集成版 and only accepts final / latest / an id-shaped value", () => {
  assert.deepEqual(parseAgentVersionSelector(new URLSearchParams()), { kind: "FINAL" });
  assert.deepEqual(parseAgentVersionSelector(new URLSearchParams("version=latest")), { kind: "LATEST" });
  assert.deepEqual(parseAgentVersionSelector(new URLSearchParams("version=aver_123-abc")), { kind: "ID", id: "aver_123-abc" });
  assert.throws(() => parseAgentVersionSelector(new URLSearchParams("version=a' OR 1=1")), AgentApiError);
  assert.equal(parseAgentPayloadFormat(new URLSearchParams()), "both");
  assert.equal(parseAgentPayloadFormat(new URLSearchParams("format=readable")), "readable");
  assert.throws(() => parseAgentPayloadFormat(new URLSearchParams("format=xml")), AgentApiError);
});

test("likePattern escapes LIKE wildcards so a search for 100% does not match everything", () => {
  assert.equal(likePattern("100%_a\\b"), "%100\\%\\_a\\\\b%");
});

test("isoOrNull normalizes pg Date values and TEXT timestamps", () => {
  assert.equal(isoOrNull(new Date("2026-09-01T02:03:04Z")), "2026-09-01T02:03:04.000Z");
  assert.equal(isoOrNull("2026-09-01T02:03:04Z"), "2026-09-01T02:03:04.000Z");
  assert.equal(isoOrNull("2026-09-30 11:37:25.31204+08"), "2026-09-30T03:37:25.312Z");
  // SQLite 时代不带时区的 TEXT 时间按 UTC 解释，与服务器所在时区无关。
  assert.equal(isoOrNull("2026-07-31 07:15:48"), "2026-07-31T07:15:48.000Z");
  assert.equal(isoOrNull(null), null);
  assert.equal(isoOrNull(""), null);
});

// ---------------------------------------------------------------------------
// 中文可读视图
// ---------------------------------------------------------------------------

const choice = (ids: string[], customText = "", advancedText = "") => ({
  selectedOptionIds: ids, customText, advancedText, vocabularyVersion: V04_VOCABULARY_VERSION,
});

test("video readable view uses the studio's Chinese labels and resolves vocabulary option ids", () => {
  const payload = emptyV04DraftPayload();
  payload.factsAndCoreJudgement.commercialIntent = " 让归家成为品牌记忆 ";
  payload.factsAndCoreJudgement.mainMechanism = choice(["PENDING_NEW_MECHANISM"], "反向等待", "等待者换位");
  payload.factsAndCoreJudgement.storyReference = choice(["ENSEMBLE_LIFE"]);
  payload.factsAndCoreJudgement.creativeCarriers = ["STORY", "AUDIOVISUAL_RULE"];
  payload.factsAndCoreJudgement.overallCreativeRating = "A";
  payload.perceptionPath.primaryType = "LOVE";
  payload.perceptionPath.primaryDetails = { emotionalBase: "父女", mainCarrier: "门灯" };
  payload.perceptionPath.auxiliaryTypes = [{ type: "FUN", description: "反转", creativeRole: "收尾" }];
  payload.script.shotGroups = [
    {
      id: "g2", orderIndex: 2, bridgeName: "归来", keyCreativeDescription: "",
      primaryCreativeRole: choice(["ACCUMULATE_EMOTION"]), auxiliaryCreativeRole: choice([]),
      shots: [],
    },
    {
      id: "g1", orderIndex: 1, bridgeName: "等待", keyCreativeDescription: "深夜",
      primaryCreativeRole: choice(["ESTABLISH_CHARACTER_RELATIONSHIP"], "补充"), auxiliaryCreativeRole: choice([]),
      shots: [
        { id: "s2", orderIndex: 2, startTime: "00:03", endTime: "00:05", shotScale: "近景", cameraAngle: "", cameraMovement: "", visualContent: "开门", screenCopy: "", subtitleEffect: "", dialogue: "", voiceOver: "", soundEffect: "", music: "" },
        { id: "s1", orderIndex: 1, startTime: "00:00", endTime: "00:03", shotScale: "全景", cameraAngle: "", cameraMovement: "", visualContent: "亮灯", screenCopy: "", subtitleEffect: "", dialogue: "", voiceOver: "", soundEffect: "", music: "" },
      ],
    },
  ];

  const readable = toReadableVideoAnalysis(payload);
  const m1 = readable["第一模块｜全片事实与核心判断"];
  assert.equal(m1.商业意图, "让归家成为品牌记忆");
  assert.deepEqual(m1.创意主导手法及机制, { 机制: ["现有词表不适用／待形成新机制"], 手法: "反向等待", 进阶机制层: "等待者换位" });
  assert.deepEqual(m1.故事参照类型, { 选项: ["群像人生片"] });
  assert.deepEqual(m1.创意承重载体, ["故事", "视听规则"]);

  const m2 = readable["第二模块｜脚本反写"];
  assert.deepEqual(m2.map((g) => g.桥段名称), ["等待", "归来"]);
  assert.deepEqual(m2[0].桥段主创意作用, { 选项: ["建立人物／关系"], 自定义: "补充" });
  assert.deepEqual(m2[0].镜头.map((s) => [s.镜号, s["画面内容（镜头故事）"], s.景别]), [["1-1", "亮灯", "全景"], ["1-2", "开门", "近景"]]);

  const m3 = readable["第三模块｜主导感知类型发生路径与整体评价"];
  assert.equal(m3.主导路径, "有爱／情感");
  assert.equal(m3.主导路径细项.情感底板, "父女");
  assert.equal(m3.主导路径细项.主要承重元素, "门灯");
  assert.equal(m3.主导路径细项.情感如何累积, "");
  assert.deepEqual(m3.辅助路径, [{ 类型: "有趣／预期", 辅助路径说明: "反转", 辅助类型的创意作用: "收尾" }]);
  assert.equal(m3.整体创意评价, "A");
});

test("an untouched video payload still produces a complete, empty readable skeleton", () => {
  const readable = toReadableVideoAnalysis(emptyV04DraftPayload());
  assert.equal(readable["第三模块｜主导感知类型发生路径与整体评价"].主导路径, "");
  assert.deepEqual(readable["第三模块｜主导感知类型发生路径与整体评价"].主导路径细项, {});
});

test("report readable view derives 1 / 1-1 numbering, page ranges and page ownership like the studio", () => {
  const block = { id: "b1", name: "主标题", x: 1, y: 2, w: 50, h: 10, type: "标题", roles: ["核心结论"], style: "理性", rel: "展开", narr: "点题", mark: "" };
  const page = (n: number, mid: string | null, uid: string | null) => ({
    n, mid, uid, transition: n === 1, func: `第${n}页作用`, org: "", blocks: n === 2 ? [block] : [],
  });
  const annotation: ReportAnnotation = {
    background: { city: "上海", developer: "某开发商", projectBackground: "", businessBackground: "" },
    strategy: { narrative: "差异化", model: "标准型" },
    modules: [
      { id: "m-late", name: "营销行动", rel: "推导", role: "" },
      { id: "m-early", name: "营销命题", rel: "推导", role: "立论" },
    ],
    units: [
      { id: "u1", mid: "m-early", pid: null, name: "市场", rel: "并列", task: "讲清市场", role: "", psy: "认同", concl: "有机会" },
      { id: "u1a", mid: "m-early", pid: "u1", name: "竞品", rel: "对比", task: "", role: "", psy: "", concl: "" },
    ],
    pages: [page(4, "m-late", null), page(1, null, null), page(2, "m-early", "u1"), page(3, "m-early", "u1a")],
  };

  const readable = toReadableReportAnalysis(annotation);
  assert.deepEqual(readable.报告策略, { 竞争与提报策略: "差异化", 报告模型: "标准型" });
  assert.deepEqual(readable.结构.map((m) => [m.编号, m.模块名称, m.页码范围]), [["1", "营销命题", "p02–p03"], ["2", "营销行动", "p04"]]);
  const unit = readable.结构[0].讲述单元[0];
  assert.equal(unit.编号, "1-1");
  assert.equal(unit.页码范围, "p02–p03");
  assert.deepEqual(unit.直属页码, [2]);
  const child = (unit.下级单元 as Array<Record<string, unknown>>)[0];
  assert.equal(child.编号, "1-1-1");
  assert.equal(child.层级, "子单元");
  assert.deepEqual(readable.未归属页码, [1]);
  assert.deepEqual(readable.逐页.map((p) => [p.页码, p.所属]), [[1, "未归属"], [2, "单元 1-1"], [3, "单元 1-1-1"], [4, "模块 2"]]);
  assert.deepEqual(readable.逐页[1].组块[0], {
    序号: 1, 组块名称: "主标题", 内容类型: "标题", 组块作用: ["核心结论"], 文风类型: "理性",
    组块间组织关系: "展开", 叙述作用: "点题", 关键标记: "", "位置（页图百分比）": { x: 1, y: 2, w: 50, h: 10 },
  });
});

// ---------------------------------------------------------------------------
// 路由契约：只读、先鉴权、不绕进会带副作用的读取
// ---------------------------------------------------------------------------

const ROUTES = [
  "../app/api/agent/v1/route.ts",
  "../app/api/agent/v1/videos/route.ts",
  "../app/api/agent/v1/videos/[id]/route.ts",
  "../app/api/agent/v1/videos/[id]/analysis/route.ts",
  "../app/api/agent/v1/reports/route.ts",
  "../app/api/agent/v1/reports/[id]/route.ts",
  "../app/api/agent/v1/reports/[id]/analysis/route.ts",
];

test("every agent route exports only GET, and GET goes straight into agentRoute", async () => {
  for (const path of ROUTES) {
    const route = codeOnly(await source(path));
    const methods = [...route.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
    assert.deepEqual(methods, ["GET"], path);
    assert.match(route, /export async function GET\([^)]*\)[^{]*\{\s*return agentRoute\(request,/, path);
  }
});

test("report agent routes honour the report library switch; video ones do not need it", async () => {
  for (const path of ROUTES) {
    const route = codeOnly(await source(path));
    const isReport = path.includes("/reports");
    assert.equal(/requireReportFeature: true/.test(route), isReport, path);
  }
});

test("agent read services contain no write SQL and never call side-effecting loaders", async () => {
  for (const path of ["../lib/agent-api/video-read.ts", "../lib/agent-api/report-read.ts"]) {
    const code = codeOnly(await source(path));
    assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|UPSERT|TRUNCATE|ALTER|DROP)\b\s/i, path);
    assert.doesNotMatch(code, /\.run\(\)|withDbTransaction|FOR UPDATE/, path);
    assert.doesNotMatch(
      code,
      /listReports|loadReportDetail|pollReport|pollAllProcessing|ensureFinalVersion|ensureReportFinalVersion|save\w*Version|materialize|intake\w*Into|setFinal|setReportFinal|adopt/,
      path,
    );
  }
});

test("agent visibility filters match the site's libraries (business data only, no trash, READY)", async () => {
  const video = codeOnly(await source("../lib/agent-api/video-read.ts"));
  assert.match(video, /v\.deleted_at IS NULL/);
  assert.match(video, /COALESCE\(v\.data_scope, 'BUSINESS'\) = 'BUSINESS'/);
  assert.match(video, /COALESCE\(v\.deletion_state, 'ACTIVE'\) = 'ACTIVE'/);
  assert.match(video, /v\.status = 'READY'/);
  const report = codeOnly(await source("../lib/agent-api/report-read.ts"));
  assert.match(report, /r\.deleted_at IS NULL AND r\.status = 'READY'/);
  assert.match(report, /report_files WHERE report_id = \? AND deleted_at IS NULL/);
});

test("proxy lets /api/agent/ through without a session cookie so the route can check the Bearer token", async () => {
  const proxy = codeOnly(await source("../proxy.ts"));
  assert.match(proxy, /publicPrefixes = \[[^\]]*"\/api\/agent\/"/);
});
