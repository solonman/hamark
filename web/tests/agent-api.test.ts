// 外部 Agent 只读接口（docs/23_外部Agent只读API_V0.1.md）：令牌校验、参数解析、
// 中文可读视图用纯函数直接测；路由文件按文本断言（同 tests/report-final-api-contract.test.ts，
// 导入 route 模块会在加载时拉起 @/db）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AGENT_TOKEN_OWNER_NAMES, canManageAgentTokens } from "../lib/agent-api/access";
import {
  authenticateAgentRequest,
  hashAgentToken,
  mintAgentToken,
  type AgentTokenRecord,
} from "../lib/agent-api/auth";
import { isMissingTokenTable, normalizeAgentTokenName } from "../lib/agent-api/tokens";
import { AGENT_TOKEN_SCHEMA_STATEMENTS } from "../db/agent-token-schema";
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

test("token owners are exactly 老孙 and 晏恩华, matched on the trimmed display name", () => {
  assert.deepEqual([...AGENT_TOKEN_OWNER_NAMES], ["老孙", "晏恩华"]);
  assert.equal(canManageAgentTokens(" 老孙 "), true);
  assert.equal(canManageAgentTokens("晏恩华"), true);
  for (const name of ["演示同事", "", null, undefined, "老孙2"]) assert.equal(canManageAgentTokens(name), false);
});

test("mintAgentToken returns a prefixed token, its sha256, and a 4-char hint that never reveals the rest", () => {
  const { token, hash, hint } = mintAgentToken();
  assert.match(token, /^hmk_agent_[A-Za-z0-9_-]{43}$/);
  assert.equal(hash, hashAgentToken(token));
  assert.equal(hint, `hmk_agent_…${token.slice(-4)}`);
  assert.notEqual(mintAgentToken().token, token);
});

function lookupFor(records: Record<string, AgentTokenRecord>) {
  const seen: string[] = [];
  const lookup = async (tokenHash: string) => {
    seen.push(tokenHash);
    return records[tokenHash] ?? null;
  };
  return { lookup, seen };
}

test("a live token owned by an allowlisted, ACTIVE member authenticates; the lookup only ever sees the hash", async () => {
  const { token, hash } = mintAgentToken();
  const { lookup, seen } = lookupFor({ [hash]: { id: "t1", name: "研究助手", ownerName: "晏恩华", ownerStatus: "ACTIVE" } });
  assert.deepEqual(await authenticateAgentRequest(withAuth(`Bearer ${token}`), lookup), {
    ok: true, tokenId: "t1", tokenName: "研究助手", ownerName: "晏恩华",
  });
  assert.deepEqual(seen, [hash]);
});

test("missing, malformed, unknown or revoked tokens get 401 — malformed ones without touching the database", async () => {
  const { token } = mintAgentToken();
  const { lookup, seen } = lookupFor({});
  for (const header of [undefined, token, `Basic ${token}`, "Bearer ", "Bearer not-our-format", `Bearer hmk_agent_${"x".repeat(300)}`]) {
    const result = await authenticateAgentRequest(withAuth(header), lookup);
    assert.equal(result.ok, false, `header ${header} must be refused`);
    if (!result.ok) assert.equal(result.status, 401);
  }
  assert.deepEqual(seen, []);
  const unknown = await authenticateAgentRequest(withAuth(`Bearer ${token}`), lookup);
  assert.equal(unknown.ok, false);
});

test("a token stops working as soon as its owner leaves the allowlist or is deactivated", async () => {
  const { token, hash } = mintAgentToken();
  for (const record of [
    { id: "t1", name: "x", ownerName: "演示同事", ownerStatus: "ACTIVE" },
    { id: "t1", name: "x", ownerName: "老孙", ownerStatus: "DISABLED" },
  ]) {
    const { lookup } = lookupFor({ [hash]: record });
    const result = await authenticateAgentRequest(withAuth(`Bearer ${token}`), lookup);
    assert.equal(result.ok, false, JSON.stringify(record));
  }
});

test("token names are trimmed, required and capped at 40 characters", () => {
  assert.equal(normalizeAgentTokenName("  研究   助手 "), "研究 助手");
  assert.throws(() => normalizeAgentTokenName("   "), AgentApiError);
  assert.throws(() => normalizeAgentTokenName(undefined), AgentApiError);
  assert.equal(normalizeAgentTokenName("字".repeat(40)), "字".repeat(40));
  assert.throws(() => normalizeAgentTokenName("字".repeat(41)), AgentApiError);
});

test("a missing agent_api_tokens table is recognised so callers can say 'run the migration' instead of 500", () => {
  assert.equal(isMissingTokenTable({ code: "42P01", message: 'relation "agent_api_tokens" does not exist' }), true);
  assert.equal(isMissingTokenTable({ code: "42P01", message: 'relation "videos" does not exist' }), false);
  assert.equal(isMissingTokenTable(new Error("boom")), false);
});

test("the token table stores only hashes, soft-revokes, is RLS-closed, and the migration file mirrors the schema module", async () => {
  const schema = AGENT_TOKEN_SCHEMA_STATEMENTS.join("\n");
  assert.match(schema, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(schema, /revoked_at TIMESTAMPTZ/);
  assert.doesNotMatch(schema, /\btoken TEXT/);
  assert.match(schema, /ALTER TABLE agent_api_tokens ENABLE ROW LEVEL SECURITY/);
  const migration = await source("../db/migrations/2026-09-30-agent-api-tokens.sql");
  for (const fragment of ["token_hash TEXT NOT NULL UNIQUE", "token_hint TEXT NOT NULL", "owner_user_id TEXT NOT NULL REFERENCES users(id)", "agent_api_tokens_owner_idx", "ENABLE ROW LEVEL SECURITY", "REVOKE ALL ON TABLE agent_api_tokens FROM anon"]) {
    assert.ok(migration.includes(fragment), fragment);
  }
  const bootstrap = await source("../db/bootstrap.ts");
  assert.match(bootstrap, /\.\.\.AGENT_TOKEN_SCHEMA_STATEMENTS/);
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

// ---------------------------------------------------------------------------
// 站内令牌管理（/api/agent-tokens）：企微登录 + 名单，写操作先过同源
// ---------------------------------------------------------------------------

test("token management routes: GET/POST on the collection, DELETE (soft revoke) on one token, all through agentTokenRoute", async () => {
  const collection = codeOnly(await source("../app/api/agent-tokens/route.ts"));
  const single = codeOnly(await source("../app/api/agent-tokens/[id]/route.ts"));
  const methods = (code: string) => [...code.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(methods(collection), ["GET", "POST"]);
  assert.deepEqual(methods(single), ["DELETE"]);
  assert.match(collection, /GET\(request: Request\) \{\s*return agentTokenRoute\(request, \{ mutation: false \}/);
  assert.match(collection, /POST\(request: Request\) \{\s*return agentTokenRoute\(request, \{ mutation: true \}/);
  assert.match(single, /return agentTokenRoute\(request, \{ mutation: true \}[\s\S]*revokeAgentToken\(db, user\.id, id\)/);
  assert.match(collection, /listAgentTokens\(db, user\.id\)/);
  assert.match(collection, /createAgentToken\(db, user\.id, body\.name\)/);
});

test("agentTokenRoute checks same-origin before the session, then the allowlist, before doing anything", async () => {
  const wrapper = codeOnly(await source("../lib/agent-api/token-route.ts"));
  const origin = wrapper.indexOf("requireSameOriginMutation(request)");
  const login = wrapper.indexOf("requireApiUser(request)");
  const allow = wrapper.indexOf("canManageAgentTokens(user.displayName)");
  const op = wrapper.indexOf("await op(");
  assert.ok(origin > 0 && origin < login && login < allow && allow < op);
});

test("token service scopes every read and write to the owner, and revoke never deletes rows", async () => {
  const code = codeOnly(await source("../lib/agent-api/tokens.ts"));
  assert.match(code, /FROM agent_api_tokens WHERE owner_user_id = \?/);
  assert.match(code, /WHERE id = \? AND owner_user_id = \?/);
  assert.doesNotMatch(code, /DELETE FROM/);
  assert.match(code, /WHERE t\.token_hash = \? AND t\.revoked_at IS NULL/);
});

test("/api/agent-tokens stays behind the session cookie — only /api/agent/ (with the slash) is public", async () => {
  const proxy = codeOnly(await source("../proxy.ts"));
  assert.match(proxy, /"\/api\/agent\/"/);
  assert.doesNotMatch(proxy, /"\/api\/agent"[,\]]/);
  assert.equal("/api/agent-tokens".startsWith("/api/agent/"), false);
});

test("only allowlisted members see the menu entry and can open the page", async () => {
  const menu = codeOnly(await source("../app/components/UserMenu.tsx"));
  assert.match(menu, /canManageAgentTokens\(user\.displayName\) \? <Link href="\/agent-tokens">/);
  const page = codeOnly(await source("../app/agent-tokens/page.tsx"));
  assert.match(page, /if \(!canManageAgentTokens\(user\.displayName\)\)/);
});
