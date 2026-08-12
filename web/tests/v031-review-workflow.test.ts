import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { emptyAnnotation } from "../lib/annotation-server.ts";
import {
  canonicalRevisionValue,
  materializeRevisionEvents,
  sha256Text,
  type RevisionEventRecord,
} from "../lib/review-workflow.ts";

async function event(
  targetKey: string,
  originalText: string,
  replacementText: string,
  anchorStart: number,
  anchorEnd: number,
  editType: RevisionEventRecord["edit_type"] = "RANGE_REPLACE",
): Promise<RevisionEventRecord> {
  return {
    id: "revision_1",
    target_key: targetKey,
    edit_type: editType,
    anchor_start: anchorStart,
    anchor_end: anchorEnd,
    original_text: originalText,
    original_text_hash: await sha256Text(originalText),
    replacement_text: replacementText,
  };
}

test("V0.3.1 materializes an exact one-character correction without equal-length coupling", async () => {
  const payload = emptyAnnotation("video_1", "作者", "V0.3-PILOT");
  payload.commercialIntent = "这是购买决策";
  const correction = await event("core:commercial-intent", "是", "示范", 1, 2);
  const clean = await materializeRevisionEvents(payload, [correction]);
  assert.equal(clean.commercialIntent, "这示范购买决策");
  assert.equal(payload.commercialIntent, "这是购买决策", "基础快照不能被原地修改");
});

test("V0.3.2 materializes typed multi-select revisions without text anchoring", async () => {
  const payload = emptyAnnotation("video_1", "作者", "V0.3-PILOT");
  payload.creativeStructure!.mechanismAuxiliary = ["反转重释"];
  const original = ["反转重释"];
  const replacement = ["对置生义", "隐喻转译"];
  const structured: RevisionEventRecord = {
    id: "revision_structured",
    target_key: "structure:mechanism-auxiliary",
    edit_type: "UNIT_REPLACE",
    anchor_start: -1,
    anchor_end: -1,
    original_text: "",
    original_text_hash: await sha256Text(canonicalRevisionValue(original)),
    replacement_text: replacement.join(" · "),
    value_type: "MULTI_SELECT",
    original_value_json: canonicalRevisionValue(original),
    replacement_value_json: canonicalRevisionValue(replacement),
  };
  const clean = await materializeRevisionEvents(payload, [structured]);
  assert.deepEqual(clean.creativeStructure!.mechanismAuxiliary, replacement);
  assert.deepEqual(payload.creativeStructure!.mechanismAuxiliary, original);
});

test("V0.3.1 supports whole-unit rewrites and rejects stale anchors", async () => {
  const payload = emptyAnnotation("video_1", "作者", "V0.3-PILOT");
  payload.synopsis = "人物回家。";
  const rewrite = await event(
    "core:story-synopsis",
    payload.synopsis,
    "人物离开城市，最终回到家并与家人重逢。",
    0,
    payload.synopsis.length,
    "UNIT_REPLACE",
  );
  const clean = await materializeRevisionEvents(payload, [rewrite]);
  assert.match(clean.synopsis, /最终回到家/);

  const changed = structuredClone(payload);
  changed.synopsis = "原文已经变化。";
  await assert.rejects(
    materializeRevisionEvents(changed, [rewrite]),
    /CONTENT_CHANGED/,
  );
});

test("V0.3.1 migration is additive and separates rounds, revisions and approved releases", async () => {
  const migration = await readFile(
    new URL("../db/migrations/2026-08-12-v031-review-workflow.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS analysis_review_rounds/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS analysis_revision_events/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS approved_analysis_releases/);
  assert.match(migration, /AUTHOR_MARKED_HANDLED/);
  assert.match(migration, /reason TEXT/);
  assert.doesNotMatch(migration, /DROP TABLE|TRUNCATE|DELETE FROM annotation_snapshots/i);
});

test("review UI keeps optional reasons and display-only traces outside canonical content", async () => {
  const [ui, reviewRoute] = await Promise.all([
    readFile(new URL("../app/videos/[id]/AnalysisComments.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/analyses/[snapshotId]/review/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(ui, /原因（选填）/);
  assert.match(ui, /inline-revision-trace/);
  assert.match(ui, /保存到终审工作层/);
  assert.match(reviewRoute, /payload_json/);
  assert.match(reviewRoute, /approved_analysis_releases/);
});
