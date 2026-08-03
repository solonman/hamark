# Direct COS Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authenticated browsers play READY videos directly from Shanghai COS with three-hour scoped URLs, instead of proxying media bytes through Vercel.

**Architecture:** The existing authenticated detail route reads video metadata then creates a three-hour COS GET URL only for READY videos. The detail client uses it directly; the library preserves card navigation but no longer preloads every remote video. The legacy streaming route remains compatible but unused by these screens.

**Tech Stack:** Next.js 16, React 19, TypeScript, Node test runner, Tencent COS S3-compatible signatures.

---

### Task 1: Add a COS playback-URL generator

**Files:**

- Modify: `web/storage/cos.ts`
- Test: `web/tests/backend-adapters.test.mjs`

- [ ] **Step 1: Write the failing test**

Add a test that creates `CosVideoBucket` with fixed credentials and clock, calls `createPresignedGetUrl("videos/video_123/original", { expiresInSeconds: 10800, now })`, then asserts the COS hostname, video path, `q-sign-algorithm=sha1`, `q-sign-time=1785715200;1785726000`, `q-header-list=host`, and a SHA-1 signature. Assert that no attachment disposition is added.

- [ ] **Step 2: Verify the RED state**

Run `node --import tsx --test tests/backend-adapters.test.mjs`. It must fail because `createPresignedGetUrl` does not exist.

- [ ] **Step 3: Implement the minimum signer**

Add this method to `CosVideoBucket`, using the same virtual-host URL and SHA-1 signing primitives as the existing PUT signer:

```ts
async createPresignedGetUrl(key: string, {
  expiresInSeconds = 3 * 60 * 60,
  now = new Date(),
}: { expiresInSeconds?: number; now?: Date } = {}) {
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 3 * 60 * 60) {
    throw new Error("COS playback URL expiry must be between 1 and 10800 seconds.");
  }
  // Sign this one object as GET, with the required host header.
}
```

- [ ] **Step 4: Verify GREEN**

Run `node --import tsx --test tests/backend-adapters.test.mjs`; all adapter tests must pass.

- [ ] **Step 5: Commit**

Run `git add web/storage/cos.ts web/tests/backend-adapters.test.mjs && git commit -m "feat: sign direct COS playback URLs"`.

### Task 2: Expose a signed URL only to authenticated READY-detail reads

**Files:**

- Modify: `web/app/api/videos/[id]/route.ts`
- Modify: `web/lib/types.ts`
- Test: `web/tests/auth-access.test.ts`

- [ ] **Step 1: Write the failing test**

Read the detail route and assert it keeps `requireApiUser(request)`, selects `object_key`, calls `getVideoBucket().createPresignedGetUrl(video.object_key, { expiresInSeconds: 10800 })`, and returns `playbackUrl`.

- [ ] **Step 2: Verify the RED state**

Run `node --import tsx --test tests/auth-access.test.ts`. It must fail because the route has no object key or playback URL.

- [ ] **Step 3: Implement the minimum contract**

Add `object_key` to `VideoDetailRow` and its SQL select. Generate `playbackUrl` only for `video.status === "READY"` with a three-hour expiry; otherwise return `null`. Add `playbackUrl: string | null` to `VideoItem`.

- [ ] **Step 4: Verify GREEN**

Run `node --import tsx --test tests/auth-access.test.ts`; all authentication route checks must pass.

- [ ] **Step 5: Commit**

Run `git add web/app/api/videos/[id]/route.ts web/lib/types.ts web/tests/auth-access.test.ts && git commit -m "feat: expose scoped video playback URLs"`.

### Task 3: Switch the player and stop library stream preloads

**Files:**

- Modify: `web/app/videos/[id]/VideoDetailClient.tsx`
- Modify: `web/app/components/HomeClient.tsx`
- Test: `web/tests/source-content.test.mjs`

- [ ] **Step 1: Write the failing test**

Assert that the detail client contains `src={video.playbackUrl}` and the home client contains neither `/api/videos/${video.id}/stream` nor `preload="metadata"` inside its card poster.

- [ ] **Step 2: Verify the RED state**

Run `node --import tsx --test tests/source-content.test.mjs`. It must fail because both components still use the stream route.

- [ ] **Step 3: Implement the minimum UI change**

Render the detail video only when the status is READY and `playbackUrl` is present; otherwise show the existing unavailable panel with refresh guidance. Replace the home-card video element with the existing neutral poster placeholder, retaining the card link, index, and play-disc.

- [ ] **Step 4: Verify GREEN**

Run `node --import tsx --test tests/source-content.test.mjs`; all source checks must pass.

- [ ] **Step 5: Commit**

Run `git add web/app/videos/[id]/VideoDetailClient.tsx web/app/components/HomeClient.tsx web/tests/source-content.test.mjs && git commit -m "perf: play videos directly from COS"`.

### Task 4: Verify the regression surface

**Files:**

- Verify only: `web/`

- [ ] **Step 1: Run static checks**

Run `npm run lint`; expect exit status 0.

- [ ] **Step 2: Run the production build and full suite**

Run `npm test`; expect the Next production build and every Node test to pass.

- [ ] **Step 3: Validate after deployment**

With an authenticated employee account, confirm a READY-detail player requests the Shanghai COS hostname, play/pause/seek works within three hours, an UPLOADING record has no signed URL, and opening the library does not create media requests for visible cards.
