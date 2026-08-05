# Single User Analysis Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the video detail analysis entry reflect the current user's single analysis state: create, continue draft, or view/edit submitted work.

**Architecture:** The video detail API will query the current user's `annotations` row for the requested video and return a small `myAnalysis` object. The detail client will store that object and derive the CTA label from server-confirmed state while keeping all entries pointed at the existing practice page.

**Tech Stack:** Next.js App Router, TypeScript, React client components, existing D1-style DB adapter, Node test scripts.

---

### Task 1: API Contract Test

**Files:**
- Modify: `web/tests/source-content.test.mjs`
- Modify: `web/app/api/videos/[id]/route.ts`

- [ ] **Step 1: Write the failing test**

Add source-level assertions that the video detail route selects the current user's annotation status and returns `myAnalysis` in the JSON payload:

```js
test("video detail API returns current user's analysis status", async () => {
  const source = await readFile(
    new URL("../app/api/videos/[id]/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /WHERE video_id = \? AND author_email = \? AND deleted_at IS NULL/);
  assert.match(source, /\\.bind\\(id, user\\.identityKey\\)/);
  assert.match(source, /myAnalysis:/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- source-content`

Expected: FAIL because `route.ts` does not return `myAnalysis` yet.

- [ ] **Step 3: Write minimal implementation**

In `web/app/api/videos/[id]/route.ts`, add an `AnnotationRow` type, query the current user's `annotations` row inside the existing `Promise.all`, and return:

```ts
myAnalysis: myAnnotation
  ? {
      id: myAnnotation.id,
      status: myAnnotation.status,
      revision: myAnnotation.revision,
      updatedAt: myAnnotation.updated_at,
    }
  : null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- source-content`

Expected: PASS.

### Task 2: Frontend CTA Test

**Files:**
- Modify: `web/tests/source-content.test.mjs`
- Modify: `web/lib/types.ts`
- Modify: `web/app/videos/[id]/VideoDetailClient.tsx`

- [ ] **Step 1: Write the failing test**

Add source-level assertions that the detail client handles all three labels:

```js
test("video detail client labels my analysis CTA by status", async () => {
  const source = await readFile(
    new URL("../app/videos/[id]/VideoDetailClient.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /myAnalysis/);
  assert.match(source, /继续编辑我的分析 ↗/);
  assert.match(source, /查看并编辑我的分析 ↗/);
  assert.match(source, /写下我的分析 ↗/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- source-content`

Expected: FAIL because the client only renders the static `写下我的分析 ↗` label.

- [ ] **Step 3: Write minimal implementation**

In `web/lib/types.ts`, add:

```ts
export type MyAnalysisStatus = {
  id: string;
  status: "DRAFT" | "SUBMITTED";
  revision: number;
  updatedAt: string;
};
```

In `VideoDetailClient.tsx`, import the type, add state:

```ts
const [myAnalysis, setMyAnalysis] = useState<MyAnalysisStatus | null>(null);
```

Accept `myAnalysis?: MyAnalysisStatus | null` from the API response, set it after fetch, and derive:

```ts
const myAnalysisLabel =
  myAnalysis?.status === "SUBMITTED"
    ? "查看并编辑我的分析 ↗"
    : myAnalysis?.status === "DRAFT"
      ? "继续编辑我的分析 ↗"
      : "写下我的分析 ↗";
```

Use `{myAnalysisLabel}` in the section CTA.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- source-content`

Expected: PASS.

### Task 3: Final Verification

**Files:**
- Verify: `web/app/api/videos/[id]/route.ts`
- Verify: `web/app/videos/[id]/VideoDetailClient.tsx`
- Verify: `web/lib/types.ts`
- Verify: `web/tests/source-content.test.mjs`

- [ ] **Step 1: Run focused tests**

Run: `npm test -- source-content`

Expected: PASS.

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: PASS with no new lint errors.

- [ ] **Step 3: Review diff**

Run: `git diff -- web/app/api/videos/[id]/route.ts web/app/videos/[id]/VideoDetailClient.tsx web/lib/types.ts web/tests/source-content.test.mjs`

Expected: Diff only contains the API `myAnalysis` field, typed client state, CTA label derivation, and focused tests.
