# 视频管理功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让原上传者编辑作品元数据，并在没有任何已提交作业时永久删除视频。

**Architecture:** 在既有 `GET/DELETE /api/videos/:id` 路由上新增管理权限状态和 `PATCH` 元数据更新；永久删除先从 COS 删除当前视频与封面对象，再在数据库事务中清理草稿关联记录、删除视频行并写入审计日志。详情页用一个上传者专属管理区启动两个独立对话框，客户端只以服务端返回的权限状态控制可见性。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript、PostgreSQL（`DbClient`）、腾讯云 COS、Node 内置测试。

---

## File structure

- `web/app/api/videos/[id]/route.ts`：视频详情权限、PATCH 元数据更新、受提交作业保护的永久删除。
- `web/app/videos/[id]/VideoDetailClient.tsx`：管理入口、弹窗状态、成功后的页面状态更新与跳转。
- `web/app/videos/[id]/EditVideoDialog.tsx`：编辑标题、品牌、标签和说明的表单。
- `web/app/videos/[id]/DeleteVideoDialog.tsx`：不可逆删除的确认界面和请求状态。
- `web/app/globals.css`：管理操作、危险按钮和确认提示的局部样式。
- `web/tests/auth-access.test.ts`：路由的认证、同源防护、所有权与作业保护断言。
- `web/tests/source-content.test.mjs`：详情页管理入口与两个对话框的回归断言。

### Task 1: Guard and expose video management permissions

**Files:**
- Modify: `web/app/api/videos/[id]/route.ts`
- Modify: `web/tests/auth-access.test.ts`
- Modify: `web/tests/source-content.test.mjs`

- [ ] **Step 1: Write the failing tests for explicit management and deletion eligibility**

  Add these assertions to `web/tests/auth-access.test.ts`:

  ```ts
  test("video management exposes uploader permission and blocks deletion after a submission", async () => {
    const source = await readProjectFile("app/api/videos/[id]/route.ts");

    assert.match(source, /const canManage = video\.created_by_email === user\.identityKey/);
    assert.match(source, /SELECT 1 FROM annotation_snapshots WHERE video_id = \? LIMIT 1/);
    assert.match(source, /canDeletePermanently: canManage && !hasSubmittedAnalysis/);
  });
  ```

  Add a source-content test that asserts the detail client reads `canManage` and `canDeletePermanently` from its API response.

- [ ] **Step 2: Run the focused tests and verify they fail**

  Run: `cd web && node --import tsx --test tests/auth-access.test.ts tests/source-content.test.mjs`

  Expected: FAIL because the GET response does not yet calculate or return `canManage` and `canDeletePermanently`.

- [ ] **Step 3: Add the minimal GET query and response fields**

  In `web/app/api/videos/[id]/route.ts`, fetch the submission existence alongside snapshots and compute permissions without trusting the client:

  ```ts
  const [snapshots, myAnnotation, hasSubmission, playbackUrl, thumbnailUrl] = await Promise.all([
    // existing snapshot and personal-draft queries,
    db.prepare(
      "SELECT 1 FROM annotation_snapshots WHERE video_id = ? LIMIT 1",
    ).bind(id).first<{ "1": number }>(),
    // existing signed URL promises,
  ]);

  const canManage = video.created_by_email === user.identityKey;
  const hasSubmittedAnalysis = Boolean(hasSubmission);
  ```

  Return both fields at the top level:

  ```ts
  canManage,
  canDeletePermanently: canManage && !hasSubmittedAnalysis,
  ```

- [ ] **Step 4: Re-run the focused tests and verify they pass**

  Run: `cd web && node --import tsx --test tests/auth-access.test.ts tests/source-content.test.mjs`

  Expected: PASS.

- [ ] **Step 5: Commit the permission contract**

  ```bash
  git add web/app/api/videos/[id]/route.ts web/tests/auth-access.test.ts web/tests/source-content.test.mjs
  git commit -m "feat: expose video management permissions"
  ```

### Task 2: Add metadata editing API with ownership enforcement

**Files:**
- Modify: `web/app/api/videos/[id]/route.ts`
- Modify: `web/tests/auth-access.test.ts`

- [ ] **Step 1: Write a failing PATCH contract test**

  Add this test to `web/tests/auth-access.test.ts`:

  ```ts
  test("video metadata updates require the original uploader and normalize tags", async () => {
    const source = await readProjectFile("app/api/videos/[id]/route.ts");

    assert.match(source, /export async function PATCH/);
    assert.match(source, /requireSameOriginMutation\(request\)/);
    assert.match(source, /只有原上传者可以编辑视频信息/);
    assert.match(source, /\.map\(\(tag\) => tag\.trim\(\)\)\s*\.filter\(Boolean\)\s*\.slice\(0, 12\)/s);
    assert.match(source, /UPDATE videos\s+SET title = \?, brand = \?, description = \?, tags_json = \?,\s+updated_at = CURRENT_TIMESTAMP/s);
  });
  ```

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `cd web && node --import tsx --test tests/auth-access.test.ts`

  Expected: FAIL because no `PATCH` handler exists.

- [ ] **Step 3: Implement the minimal PATCH handler**

  Add a `PATCH` handler after `GET` which:

  ```ts
  export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    const originError = requireSameOriginMutation(request);
    if (originError) return originError;
    const user = await requireApiUser(request);
    if (user instanceof Response) return user;
    const { id } = await context.params;
    const body = (await request.json()) as { title?: string; brand?: string; description?: string; tags?: string[] };
    const title = body.title?.trim();
    if (!title) return Response.json({ error: "请填写片名。" }, { status: 400 });
    const tags = (body.tags ?? []).map((tag) => tag.trim()).filter(Boolean).slice(0, 12);
    // Load active row, reject missing/non-owner, then update title/brand/description/tags_json.
  }
  ```

  Return the updated four fields in `video` so the client can patch local state. Keep `original_name`, object keys, status, and all annotation tables untouched.

- [ ] **Step 4: Re-run the focused test and verify it passes**

  Run: `cd web && node --import tsx --test tests/auth-access.test.ts`

  Expected: PASS.

- [ ] **Step 5: Commit the metadata API**

  ```bash
  git add web/app/api/videos/[id]/route.ts web/tests/auth-access.test.ts
  git commit -m "feat: allow uploaders to edit video metadata"
  ```

### Task 3: Replace soft deletion with guarded permanent deletion

**Files:**
- Modify: `web/app/api/videos/[id]/route.ts`
- Modify: `web/tests/auth-access.test.ts`

- [ ] **Step 1: Write failing deletion-protection tests**

  Replace the old soft-delete test with assertions that require submitted-work protection and COS removal:

  ```ts
  test("permanent video deletion rejects submitted work and removes current COS assets", async () => {
    const source = await readProjectFile("app/api/videos/[id]/route.ts");

    assert.match(source, /SELECT 1 FROM annotation_snapshots WHERE video_id = \? LIMIT 1/);
    assert.match(source, /已有作业提交，无法删除视频/);
    assert.match(source, /await bucket\.delete\(video\.object_key\)/);
    assert.match(source, /video\.thumbnail_key \? bucket\.delete\(video\.thumbnail_key\)/);
    assert.match(source, /DELETE FROM field_answers WHERE annotation_id IN \(SELECT id FROM annotations WHERE video_id = \?\)/);
    assert.match(source, /DELETE FROM shots WHERE annotation_id IN \(SELECT id FROM annotations WHERE video_id = \?\)/);
    assert.match(source, /DELETE FROM annotations WHERE video_id = \?/);
    assert.match(source, /DELETE FROM videos WHERE id = \? AND created_by_email = \?/);
  });
  ```

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `cd web && node --import tsx --test tests/auth-access.test.ts`

  Expected: FAIL because DELETE still updates `deleted_at` and has no submission guard or COS deletion.

- [ ] **Step 3: Implement permanent deletion in the existing DELETE handler**

  Expand the selected row to include `object_key` and `thumbnail_key`. After the uploader check, reject an existing submitted snapshot:

  ```ts
  const submitted = await db.prepare(
    "SELECT 1 FROM annotation_snapshots WHERE video_id = ? LIMIT 1",
  ).bind(id).first();
  if (submitted) {
    return Response.json({ error: "已有作业提交，无法删除视频。" }, { status: 409 });
  }
  ```

  Delete the current COS objects before opening the database transaction:

  ```ts
  const bucket = getVideoBucket();
  await bucket.delete(video.object_key);
  if (video.thumbnail_key) await bucket.delete(video.thumbnail_key);
  ```

  Use `withDbTransaction` to re-check the video row, ownership, and absence of snapshots immediately before deleting data. Then delete `field_answers`, `shots`, and `annotations` by `video_id`; delete the `videos` row; and insert a `VIDEO_PERMANENTLY_DELETED` audit event. If COS deletion fails, return a 500 response and leave all database rows intact. If the transaction detects a late submission, return 409; do not resurrect COS objects.

- [ ] **Step 4: Re-run the focused test and verify it passes**

  Run: `cd web && node --import tsx --test tests/auth-access.test.ts`

  Expected: PASS.

- [ ] **Step 5: Commit permanent deletion**

  ```bash
  git add web/app/api/videos/[id]/route.ts web/tests/auth-access.test.ts
  git commit -m "feat: permanently delete unused videos"
  ```

### Task 4: Build the edit and delete dialogs

**Files:**
- Create: `web/app/videos/[id]/EditVideoDialog.tsx`
- Create: `web/app/videos/[id]/DeleteVideoDialog.tsx`
- Modify: `web/tests/source-content.test.mjs`

- [ ] **Step 1: Write failing client-source tests**

  Add assertions that require the two new components to use the expected mutation endpoints and user-facing safeguards:

  ```js
  const [editDialog, deleteDialog] = await Promise.all([
    readFile(new URL("../app/videos/[id]/EditVideoDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/DeleteVideoDialog.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(editDialog, /method: "PATCH"/);
  assert.match(editDialog, /编辑作品信息/);
  assert.match(deleteDialog, /method: "DELETE"/);
  assert.match(deleteDialog, /永久删除后无法恢复/);
  ```

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `cd web && node --import tsx --test tests/source-content.test.mjs`

  Expected: FAIL with `ENOENT` because the dialog component files do not exist.

- [ ] **Step 3: Implement the two focused dialog components**

  `EditVideoDialog.tsx` must take `{ videoId, video, onClose, onSaved }`, initialize controlled fields from `video`, normalize comma-separated tags at submit, and call:

  ```ts
  const response = await fetch(`/api/videos/${videoId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, brand, description, tags: tags.split(/[，,]/).map((tag) => tag.trim()) }),
  });
  ```

  `DeleteVideoDialog.tsx` must take `{ videoId, onClose, onDeleted }`, show the irreversible warning, disable dismissal while pending, and call:

  ```ts
  const response = await fetch(`/api/videos/${videoId}`, { method: "DELETE" });
  ```

  Both components must redirect to `/login?return_to=...` on `401`, retain their error state for non-401 failures, and use `role="dialog"`, `aria-modal="true"`, and a unique labelled heading.

- [ ] **Step 4: Re-run the focused test and verify it passes**

  Run: `cd web && node --import tsx --test tests/source-content.test.mjs`

  Expected: PASS.

- [ ] **Step 5: Commit the dialogs**

  ```bash
  git add web/app/videos/[id]/EditVideoDialog.tsx web/app/videos/[id]/DeleteVideoDialog.tsx web/tests/source-content.test.mjs
  git commit -m "feat: add video edit and deletion dialogs"
  ```

### Task 5: Wire uploader management into the detail page and style it

**Files:**
- Modify: `web/app/videos/[id]/VideoDetailClient.tsx`
- Modify: `web/app/globals.css`
- Modify: `web/tests/source-content.test.mjs`

- [ ] **Step 1: Write a failing detail-page source test**

  Add this test to `web/tests/source-content.test.mjs`:

  ```js
  test("video detail exposes management controls only from server-provided permissions", async () => {
    const detail = await readFile(new URL("../app/videos/[id]/VideoDetailClient.tsx", import.meta.url), "utf8");
    assert.match(detail, /canManage/);
    assert.match(detail, /canDeletePermanently/);
    assert.match(detail, /编辑信息/);
    assert.match(detail, /永久删除/);
    assert.match(detail, /<EditVideoDialog/);
    assert.match(detail, /<DeleteVideoDialog/);
    assert.match(detail, /window\.location\.assign\("\/"\)/);
  });
  ```

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `cd web && node --import tsx --test tests/source-content.test.mjs`

  Expected: FAIL because the existing detail page only has `canReplaceOriginal` and `ReplaceVideoDialog`.

- [ ] **Step 3: Add the management section and local state updates**

  In `VideoDetailClient.tsx`:

  - Replace `canReplaceOriginal` with API-fed `canManage` and `canDeletePermanently` state; set both only from the GET response.
  - Add `editOpen` and `deleteOpen` state, import both dialogs, and render their buttons only when `canManage` is true.
  - Keep `替换原视频` available for every `canManage` uploader; show `永久删除` only if `canDeletePermanently` is true.
  - Pass the current `video` to the edit dialog and update local `title`, `brand`, `description`, and `tags` in `onSaved`.
  - On deletion success, call `window.location.assign("/")`.

  Use a compact actions wrapper with a neutral `管理作品` label, ordinary outline controls for edit/replace, and an explicitly dangerous delete button. Do not hide the delete button behind client-calculated submission status.

- [ ] **Step 4: Add focused styles**

  In `web/app/globals.css`, add styles for `.video-management-actions` and `.delete-video-button`, including keyboard focus treatment and a restrained red danger state:

  ```css
  .delete-video-button {
    border-color: #b9341f;
    color: #b9341f;
  }

  .delete-video-button:hover,
  .delete-video-button:focus-visible {
    border-color: #8d2011;
    background: #fff1ed;
    color: #8d2011;
    outline: none;
  }
  ```

  Reuse `.upload-dialog`, `.form-grid`, `.form-error`, and `.dialog-actions` for both dialogs. Add a short `.delete-video-warning` block with a pale red background and readable text contrast.

- [ ] **Step 5: Re-run the focused test and verify it passes**

  Run: `cd web && node --import tsx --test tests/source-content.test.mjs`

  Expected: PASS.

- [ ] **Step 6: Run the full quality gate**

  Run: `cd web && npm test && npm run lint`

  Expected: the production build, all Node tests, and ESLint complete with exit code 0.

- [ ] **Step 7: Commit the detail-page integration**

  ```bash
  git add web/app/videos/[id]/VideoDetailClient.tsx web/app/globals.css web/tests/source-content.test.mjs
  git commit -m "feat: manage videos from detail page"
  ```
