import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { globSync } from "node:fs";

// 公共视觉库路由的门禁顺序断言：读源码，不接真数据库（同
// tests/report-trash.test.ts「读源码断言规则还在」的做法）。每个路由第一句是
// 开关检查；写操作（POST/PATCH/DELETE）在登录检查之前还要过同源校验；
// 管理员判定统一现查 isAppAdmin(user)，不复用陈旧判断。

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

const ROUTE_ROOT = "app/api/visual-cases";

type RouteSpec = {
  file: string;
  methods: Array<{ name: "GET" | "POST" | "PATCH" | "DELETE"; mutation: boolean }>;
};

const ROUTES: RouteSpec[] = [
  { file: `${ROUTE_ROOT}/route.ts`, methods: [{ name: "GET", mutation: false }, { name: "POST", mutation: true }] },
  { file: `${ROUTE_ROOT}/[id]/route.ts`, methods: [{ name: "GET", mutation: false }, { name: "PATCH", mutation: true }] },
  { file: `${ROUTE_ROOT}/[id]/complete/route.ts`, methods: [{ name: "POST", mutation: true }] },
  { file: `${ROUTE_ROOT}/[id]/assets/route.ts`, methods: [{ name: "POST", mutation: true }] },
  { file: `${ROUTE_ROOT}/[id]/assets/[assetId]/route.ts`, methods: [{ name: "DELETE", mutation: true }] },
  { file: `${ROUTE_ROOT}/[id]/assets/[assetId]/upload-url/route.ts`, methods: [{ name: "POST", mutation: true }] },
  { file: `${ROUTE_ROOT}/[id]/assets/[assetId]/stream/route.ts`, methods: [{ name: "GET", mutation: false }] },
  { file: `${ROUTE_ROOT}/[id]/assets/[assetId]/original/route.ts`, methods: [{ name: "GET", mutation: false }] },
  { file: `${ROUTE_ROOT}/[id]/favorite/route.ts`, methods: [{ name: "POST", mutation: true }] },
  { file: `${ROUTE_ROOT}/[id]/trash/route.ts`, methods: [{ name: "POST", mutation: true }] },
  { file: `${ROUTE_ROOT}/[id]/restore/route.ts`, methods: [{ name: "POST", mutation: true }] },
];

/** Extract the body of `export async function <name>(` up to the next top-level export, or EOF. */
function extractHandler(text: string, name: string): string {
  const start = text.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `expected an exported ${name} handler`);
  const rest = text.slice(start + 1);
  const nextExport = rest.search(/\nexport async function /);
  return nextExport === -1 ? text.slice(start) : text.slice(start, start + 1 + nextExport);
}

for (const route of ROUTES) {
  test(`${route.file}: every handler starts with the feature-flag gate`, async () => {
    const text = await source(`../${route.file}`);
    for (const method of route.methods) {
      const handler = extractHandler(text, method.name);
      const flagIndex = handler.indexOf("if (!isVisualFeatureEnabled()) return visualFeatureDisabledResponse();");
      assert.ok(flagIndex >= 0, `${route.file} ${method.name} is missing the feature-flag gate`);
      // 开关检查要在函数体的最前面：它之前不该有别的业务代码（只允许函数签名本身）。
      // 函数体的 `{` 紧跟在参数列表的 `)` 之后——不能直接找第一个 `{`，那会命中
      // `context: { params: ... }` 参数类型标注里的花括号。
      const bodyStart = handler.indexOf(") {");
      const between = handler.slice(bodyStart + 3, flagIndex).trim();
      assert.equal(between, "", `${route.file} ${method.name}: the feature-flag gate must be the first statement`);
    }
  });

  test(`${route.file}: mutation handlers check same-origin before the login check; read handlers don't require same-origin`, async () => {
    const text = await source(`../${route.file}`);
    for (const method of route.methods) {
      const handler = extractHandler(text, method.name);
      const originIndex = handler.indexOf("requireSameOriginMutation(request)");
      const userIndex = handler.indexOf("requireApiUser(request)");
      assert.ok(userIndex >= 0, `${route.file} ${method.name} is missing requireApiUser`);
      if (method.mutation) {
        assert.ok(originIndex >= 0, `${route.file} ${method.name} is a mutation and must call requireSameOriginMutation`);
        assert.ok(originIndex < userIndex, `${route.file} ${method.name}: same-origin check must run before the login check`);
      } else {
        assert.equal(originIndex, -1, `${route.file} ${method.name} is a read and should not require same-origin`);
      }
    }
  });
}

test("every route that needs to know isAdmin calls isAppAdmin(user) fresh, not a cached/passed-in value", async () => {
  const adminAwareRoutes = [
    `${ROUTE_ROOT}/route.ts`,
    `${ROUTE_ROOT}/[id]/route.ts`,
    `${ROUTE_ROOT}/[id]/complete/route.ts`,
    `${ROUTE_ROOT}/[id]/assets/route.ts`,
    `${ROUTE_ROOT}/[id]/assets/[assetId]/route.ts`,
    `${ROUTE_ROOT}/[id]/assets/[assetId]/upload-url/route.ts`,
    `${ROUTE_ROOT}/[id]/assets/[assetId]/stream/route.ts`,
    `${ROUTE_ROOT}/[id]/assets/[assetId]/original/route.ts`,
    `${ROUTE_ROOT}/[id]/trash/route.ts`,
    `${ROUTE_ROOT}/[id]/restore/route.ts`,
  ];
  for (const file of adminAwareRoutes) {
    const text = await source(`../${file}`);
    assert.match(text, /isAdmin: await isAppAdmin\(user\)/, `${file} should compute isAdmin via isAppAdmin(user)`);
  }
});

test("the complete route's 409 error envelope carries {error, status, missing} for VisualCompleteIncompleteError, not just {error}", async () => {
  const text = await source(`../${ROUTE_ROOT}/[id]/complete/route.ts`);
  assert.match(
    text,
    /error instanceof VisualCompleteIncompleteError[\s\S]*status: "UPLOADING", missing: error\.missing \}[\s\S]*status: error\.status/,
  );
});

test("stream and original asset routes redirect (302) to a freshly signed URL rather than proxying bytes", async () => {
  for (const file of [
    `${ROUTE_ROOT}/[id]/assets/[assetId]/stream/route.ts`,
    `${ROUTE_ROOT}/[id]/assets/[assetId]/original/route.ts`,
  ]) {
    const text = await source(`../${file}`);
    assert.match(text, /status: 302/);
    assert.match(text, /Location: location/);
  }
});

test("GET routes set Cache-Control: no-store on their response", async () => {
  for (const file of [`${ROUTE_ROOT}/route.ts`, `${ROUTE_ROOT}/[id]/route.ts`]) {
    const text = await source(`../${file}`);
    assert.match(text, /response\.headers\.set\("Cache-Control", "no-store"\)/);
  }
});

test("complete and list/detail routes trigger CI derivative processing via after(), only when isVisualDerivativeCiMode()", async () => {
  const completeRoute = await source(`../${ROUTE_ROOT}/[id]/complete/route.ts`);
  assert.match(completeRoute, /import \{ after \} from "next\/server";/);
  assert.match(completeRoute, /if \(isVisualDerivativeCiMode\(\)\) \{\s*\n\s*after\(\(\) => runVisualDerivativesForCase\(db, id\)\);/);

  const listRoute = await source(`../${ROUTE_ROOT}/route.ts`);
  assert.match(listRoute, /if \(isVisualDerivativeCiMode\(\)\) \{\s*\n\s*after\(\(\) => runStaleVisualDerivatives\(db\)\);/);

  const detailRoute = await source(`../${ROUTE_ROOT}/[id]/route.ts`);
  assert.match(detailRoute, /if \(isVisualDerivativeCiMode\(\)\) \{\s*\n\s*after\(\(\) => runStaleVisualDerivatives\(db, \{ caseId: id \}\)\);/);
});

// ---------------------------------------------------------------------------
// sharp 只能在离线脚本里出现：任何 app/ 或 lib/ 运行时代码 import 它都会把原生
// 绑定带进 serverless 运行时。
// ---------------------------------------------------------------------------

test("no app/ or lib/ runtime file imports sharp — only scripts/visual-derivatives.ts may", async () => {
  const candidates = [
    ...globSync("app/**/*.{ts,tsx}", { cwd: new URL("..", import.meta.url) }),
    ...globSync("lib/**/*.ts", { cwd: new URL("..", import.meta.url) }),
  ];
  const offenders: string[] = [];
  for (const relativePath of candidates) {
    const text = await source(`../${relativePath}`);
    if (/from\s+["']sharp["']|import\(\s*["']sharp["']\s*\)/.test(text)) {
      offenders.push(relativePath);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the offline script is the one place sharp is loaded, and only via a dynamic import", async () => {
  const text = await source("../scripts/visual-derivatives.ts");
  assert.doesNotMatch(text, /^import sharp/m);
  assert.match(text, /await import\(specifier\)/);
});
