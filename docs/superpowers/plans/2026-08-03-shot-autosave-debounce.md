# Shot Autosave Debounce Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save a shot-analysis draft only after 2.5 seconds without edits, without losing edits that occur while a save is in flight.

**Architecture:** `PracticeClient` will make the edit sequence reactive so the trailing debounce resets for every character instead of only the first dirty transition. A save tracks the sequence captured at request start; its response updates only server metadata on newer local content, then schedules the newest version for a later save. Publishing flushes the latest sequence before submission.

**Tech Stack:** Next.js, React hooks, TypeScript, Node test runner.

---

### Task 1: Lock down per-edit debounce behavior

**Files:**

- Modify: `web/tests/source-content.test.mjs`
- Modify: `web/app/videos/[id]/practice/PracticeClient.tsx`

- [ ] **Step 1: Write the failing test**

Add a source-contract test that requires `PracticeClient.tsx` to keep an `editVersion` state, increment it from `markChanged`, schedule the save timer for `2500`, include `editVersion` in the timer effect dependencies, and render `修改约3秒自动保存`.

- [ ] **Step 2: Verify RED**

Run `node --import tsx --test tests/source-content.test.mjs`; the new test must fail because the component currently waits 900 ms and does not react to every edit sequence.

- [ ] **Step 3: Implement the minimum debounce**

Add `const [editVersion, setEditVersion] = useState(0);`. In `markChanged`, increment the ref then call `setEditVersion(editSequence.current)`. Change the timer delay to `2500` and add `editVersion` to its dependency list. Update the header copy to `修改约3秒自动保存`.

- [ ] **Step 4: Verify GREEN**

Run `node --import tsx --test tests/source-content.test.mjs`; all source tests must pass.

### Task 2: Preserve newer edits while a save completes

**Files:**

- Modify: `web/tests/source-content.test.mjs`
- Modify: `web/app/videos/[id]/practice/PracticeClient.tsx`

- [ ] **Step 1: Write the failing test**

Extend the source-contract test to require an in-flight save ref, a sequence comparison after the response, and metadata merging through `draftRef.current` so a completed old request cannot restore older shot text or an old revision.

- [ ] **Step 2: Verify RED**

Run `node --import tsx --test tests/source-content.test.mjs`; the new assertions must fail because `saveDraft` only updates React state and can schedule concurrent saves.

- [ ] **Step 3: Implement one-at-a-time save coordination**

Store the active save promise in a ref. Reuse it rather than start a concurrent save. When a response returns, merge its id/revision/timestamp into `draftRef.current`; only clear `dirty` when the captured sequence still matches. If there is a newer sequence, retain `dirty`, restore idle state after the active promise completes, and let the reactive debounce schedule the newest draft.

- [ ] **Step 4: Verify GREEN**

Run `node --import tsx --test tests/source-content.test.mjs`; all source tests must pass.

### Task 3: Flush current edits before publishing and verify

**Files:**

- Modify: `web/app/videos/[id]/practice/PracticeClient.tsx`
- Modify: `web/tests/source-content.test.mjs`
- Verify: `web/`

- [ ] **Step 1: Write the failing test**

Add a source assertion that `submitAssignment` calls a `saveLatestDraft` helper, which repeats saving if the edit sequence changes while it waits.

- [ ] **Step 2: Verify RED**

Run `node --import tsx --test tests/source-content.test.mjs`; it must fail because submission currently waits for only one save call.

- [ ] **Step 3: Implement the flush helper**

Add `saveLatestDraft` that captures the current sequence, awaits `saveDraft`, and repeats until the sequence no longer changes. Use it in `submitAssignment` whenever the draft is dirty or lacks an id.

- [ ] **Step 4: Verify GREEN and regressions**

Run `node --import tsx --test tests/source-content.test.mjs`, `npm run lint`, and `npm test`. Expect all commands to exit with status 0.

- [ ] **Step 5: Commit**

Run `git add web/app/videos/[id]/practice/PracticeClient.tsx web/tests/source-content.test.mjs docs/superpowers/plans/2026-08-03-shot-autosave-debounce.md && git commit -m "perf: debounce shot autosave"`.
