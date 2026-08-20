import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { V04_SHOT_FIELD_KEYS } from "../lib/v04-contract.ts";
import { V04_UI_CASES } from "../lib/v04-ui-fixture.ts";
import { cloneV04UiDraft, v04PayloadChanges, v04PayloadToUiDraft, v04UiDraftToPayload } from "../lib/v04-ui-model.ts";
import { emptyV04DraftPayload } from "../lib/v04-domain.ts";
import { parseV04SchemaTestConfig } from "../scripts/verify-v04-schema.ts";

test("V0.4 UI payload adapter preserves 12 shot fields including subtitleEffect", () => {
  const ui = cloneV04UiDraft(V04_UI_CASES[0].draft);
  ui.shotGroups[0].shots[0].subtitleEffect = "字幕逐字淡入";
  ui.primaryMechanism.customText = "自定义机制说明";
  const payload = v04UiDraftToPayload(ui, emptyV04DraftPayload());
  const roundTrip = v04PayloadToUiDraft(payload);
  assert.equal(V04_SHOT_FIELD_KEYS.length, 12);
  assert.equal(roundTrip.shotGroups[0].shots[0].subtitleEffect, "字幕逐字淡入");
  assert.deepEqual(roundTrip.primaryMechanism.selectedOptionIds, ui.primaryMechanism.selectedOptionIds);
  assert.equal(roundTrip.primaryMechanism.customText, "自定义机制说明");
  assert.equal(payload.script.shotGroups[0].shots[0].orderIndex, 0);
});

test("V0.4 UI emits stable granular targets and reserves STRUCTURE for actual structure changes", () => {
  const beforeUi = cloneV04UiDraft(V04_UI_CASES[0].draft);
  const before = v04UiDraftToPayload(beforeUi, emptyV04DraftPayload());
  const afterUi = cloneV04UiDraft(beforeUi);
  afterUi.shotGroups[0].shots[0].subtitleEffect = "新的字幕特效";
  afterUi.creativeMotif = "新的创意母题";
  const after = v04UiDraftToPayload(afterUi, before);
  const changes = v04PayloadChanges(before, after);
  assert.deepEqual(changes.map((item) => item.targetKey).sort(), [
    `facts.creativeMotif`,
    `shot:${afterUi.shotGroups[0].shots[0].id}.subtitleEffect`,
  ].sort());
  assert.ok(changes.every((item) => item.valueType !== "STRUCTURE"));

  const structuralUi = cloneV04UiDraft(afterUi);
  structuralUi.shotGroups[0].shots.reverse();
  const structural = v04PayloadChanges(after, v04UiDraftToPayload(structuralUi, after));
  assert.equal(structural.length, 1);
  assert.equal(structural[0].targetKey, "script.structure");
  assert.equal(structural[0].valueType, "STRUCTURE");
});

test("server workflow state remains a read-model field rather than a UI recomputation", () => {
  const sources = [
    new URL("../components/v04/V04LibraryClient.tsx", import.meta.url),
    new URL("../components/v04/V04DetailClient.tsx", import.meta.url),
    new URL("../components/v04/V04WorkspaceClient.tsx", import.meta.url),
  ];
  return Promise.all(sources.map(async (url) => {
    const source = await import("node:fs/promises").then(({ readFile }) => readFile(url, "utf8"));
    assert.doesNotMatch(source, /deriveV04UiWorkState\s*\(/);
  }));
});

const hasExplicitPostgresEnvironment = Boolean(
  process.env.NODE_ENV === "test" &&
  process.env.V04_TEST_RUN_ID &&
  process.env.V04_TEST_DATABASE_URL,
);

test("V0.4 relationship trigger reads only fields owned by each attached table", {
  skip: hasExplicitPostgresEnvironment ? false : "V04 TEST_ONLY environment not provided",
}, async () => {
  const config = parseV04SchemaTestConfig(process.env);
  const client = new pg.Client({
    connectionString: config.connectionString,
    ssl: false,
    application_name: `hamark_v04_trigger_${config.runId}`,
  });
  const suffix = config.runId.replaceAll("-", "_");
  const ids = Object.fromEntries([
    "userA", "userB", "sessionA", "sessionB", "videoA", "videoB",
    "annotationA", "annotationB", "snapshotA", "snapshotB", "workspaceA", "workspaceB",
    "baselineA", "baselineB", "roundA", "roundB", "submissionA", "submissionB",
    "revisionA", "leaseA", "leaseB", "expertA",
  ].map((key) => [key, `test_only_trigger_${suffix}_${key}`])) as Record<string, string>;
  const expectRejected = async (name: string, sql: string, values: unknown[] = []) => {
    await client.query(`SAVEPOINT ${name}`);
    try {
      await assert.rejects(client.query(sql, values));
    } finally {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await client.query(`RELEASE SAVEPOINT ${name}`);
    }
  };

  await client.connect();
  await client.query("BEGIN");
  try {
    await client.query(`INSERT INTO users (
      id, wecom_corp_id, wecom_user_id, identity_key, display_name, email,
      status, last_login_at, last_synced_at, created_at, updated_at
    ) VALUES
      ($1, 'test', $1, $1, 'Trigger A', 'trigger-a@example.test', 'ACTIVE', '', '', '', ''),
      ($2, 'test', $2, $2, 'Trigger B', 'trigger-b@example.test', 'ACTIVE', '', '', '', '')`,
    [ids.userA, ids.userB]);
    await client.query(`INSERT INTO auth_sessions (
      id, user_id, token_hash, expires_at, last_seen_at, created_at
    ) VALUES
      ($1, $2, $1, '2099-01-01', '', ''),
      ($3, $4, $3, '2099-01-01', '', '')`,
    [ids.sessionA, ids.userA, ids.sessionB, ids.userB]);
    await client.query(`INSERT INTO videos (
      id, title, object_key, original_name, created_by_email, created_by_name,
      created_by_user_id, data_scope, test_run_id
    ) VALUES
      ($1, 'TEST_ONLY trigger A', $1, 'a.mp4', 'trigger-a@example.test', 'Trigger A', $2, 'TEST_ONLY', $3),
      ($4, 'TEST_ONLY trigger B', $4, 'b.mp4', 'trigger-b@example.test', 'Trigger B', $5, 'TEST_ONLY', $3)`,
    [ids.videoA, ids.userA, config.runId, ids.videoB, ids.userB]);
    await client.query(`INSERT INTO annotations (
      id, video_id, author_email, author_name, taxonomy_version, workflow_version,
      status, revision, vocabulary_version, payload_schema_version, content_hash,
      updated_by_user_id
    ) VALUES
      ($1, $2, 'trigger-a@example.test', 'Trigger A', 'AD_VIDEO_TAXONOMY_V1',
       'AD_VIDEO_WORKFLOW_V1', 'DRAFT', 1, 'AD_VIDEO_VOCAB_V1', 'AD_VIDEO_PAYLOAD_V1', 'working-a', $3),
      ($4, $5, 'trigger-b@example.test', 'Trigger B', 'AD_VIDEO_TAXONOMY_V1',
       'AD_VIDEO_WORKFLOW_V1', 'DRAFT', 1, 'AD_VIDEO_VOCAB_V1', 'AD_VIDEO_PAYLOAD_V1', 'working-b', $6)`,
    [ids.annotationA, ids.videoA, ids.userA, ids.annotationB, ids.videoB, ids.userB]);
    await client.query(`INSERT INTO annotation_snapshots (
      id, annotation_id, video_id, author_email, author_name, taxonomy_version,
      revision, payload_json, content_hash, snapshot_kind, workflow_version,
      vocabulary_version, payload_schema_version, created_by_user_id
    ) VALUES
      ($1, $2, $3, 'trigger-a@example.test', 'Trigger A', 'AD_VIDEO_TAXONOMY_V1',
       1, '{}', 'working-a', 'WORKING', 'AD_VIDEO_WORKFLOW_V1', 'AD_VIDEO_VOCAB_V1', 'AD_VIDEO_PAYLOAD_V1', $4),
      ($5, $6, $7, 'trigger-b@example.test', 'Trigger B', 'AD_VIDEO_TAXONOMY_V1',
       1, '{}', 'working-b', 'WORKING', 'AD_VIDEO_WORKFLOW_V1', 'AD_VIDEO_VOCAB_V1', 'AD_VIDEO_PAYLOAD_V1', $8)`,
    [ids.snapshotA, ids.annotationA, ids.videoA, ids.userA, ids.snapshotB, ids.annotationB, ids.videoB, ids.userB]);

    await client.query(`INSERT INTO collaboration_workspaces (
      id, video_id, domain_key, taxonomy_version, workflow_version, vocabulary_version,
      canonical_annotation_id, created_by_user_id
    ) VALUES
      ($1, $2, 'AD_VIDEO', 'AD_VIDEO_TAXONOMY_V1', 'AD_VIDEO_WORKFLOW_V1', 'AD_VIDEO_VOCAB_V1', $3, $4),
      ($5, $6, 'AD_VIDEO', 'AD_VIDEO_TAXONOMY_V1', 'AD_VIDEO_WORKFLOW_V1', 'AD_VIDEO_VOCAB_V1', $7, $8)`,
    [ids.workspaceA, ids.videoA, ids.annotationA, ids.userA, ids.workspaceB, ids.videoB, ids.annotationB, ids.userB]);
    await expectRejected("bad_workspace", `INSERT INTO collaboration_workspaces (
      id, video_id, domain_key, taxonomy_version, workflow_version, vocabulary_version,
      canonical_annotation_id, created_by_user_id
    ) VALUES ('${ids.workspaceA}_bad', $1, 'AD_VIDEO', 'AD_VIDEO_TAXONOMY_V1',
      'AD_VIDEO_WORKFLOW_V1', 'AD_VIDEO_VOCAB_V1', $2, $3)`, [ids.videoB, ids.annotationA, ids.userA]);

    await client.query(`INSERT INTO collaboration_baselines (
      id, workspace_id, annotation_id, source_kind, payload_json, content_hash,
      taxonomy_version, workflow_version, payload_schema_version, created_by_user_id
    ) VALUES
      ($1, $2, $3, 'EMPTY', '{}', 'baseline-a', 'AD_VIDEO_TAXONOMY_V1', 'AD_VIDEO_WORKFLOW_V1', 'AD_VIDEO_PAYLOAD_V1', $4),
      ($5, $6, $7, 'EMPTY', '{}', 'baseline-b', 'AD_VIDEO_TAXONOMY_V1', 'AD_VIDEO_WORKFLOW_V1', 'AD_VIDEO_PAYLOAD_V1', $8)`,
    [ids.baselineA, ids.workspaceA, ids.annotationA, ids.userA, ids.baselineB, ids.workspaceB, ids.annotationB, ids.userB]);
    await expectRejected("bad_baseline", `UPDATE collaboration_baselines SET annotation_id = $1 WHERE id = $2`,
      [ids.annotationB, ids.baselineA]);

    await client.query(`INSERT INTO collaboration_rounds (
      id, workspace_id, annotation_id, round_number, status, base_type,
      base_baseline_id, starting_revision, created_by_user_id
    ) VALUES
      ($1, $2, $3, 1, 'ACTIVE', 'BASELINE', $4, 0, $5),
      ($6, $7, $8, 1, 'ACTIVE', 'BASELINE', $9, 0, $10)`,
    [ids.roundA, ids.workspaceA, ids.annotationA, ids.baselineA, ids.userA,
      ids.roundB, ids.workspaceB, ids.annotationB, ids.baselineB, ids.userB]);
    await expectRejected("bad_round", `UPDATE collaboration_rounds SET annotation_id = $1 WHERE id = $2`,
      [ids.annotationB, ids.roundA]);
    await client.query(`UPDATE collaboration_workspaces
      SET active_round_id = CASE id WHEN $1 THEN $2 ELSE $3 END,
          current_working_snapshot_id = CASE id WHEN $1 THEN $4 ELSE $5 END
      WHERE id IN ($1, $6)`,
    [ids.workspaceA, ids.roundA, ids.roundB, ids.snapshotA, ids.snapshotB, ids.workspaceB]);
    await expectRejected("bad_workspace_snapshot", `UPDATE collaboration_workspaces
      SET current_working_snapshot_id = $1 WHERE id = $2`, [ids.snapshotB, ids.workspaceA]);

    const insertSubmission = `INSERT INTO annotation_submission_snapshots (
      id, workspace_id, round_id, annotation_id, video_id, submission_number,
      source_working_snapshot_id, source_revision, source_content_hash, payload_json,
      content_hash, taxonomy_version, workflow_version, vocabulary_version,
      payload_schema_version, submitted_by_user_id, idempotency_key
    ) VALUES ($1,$2,$3,$4,$5,$11,$6,1,$7,'{}',$8,'AD_VIDEO_TAXONOMY_V1',
      'AD_VIDEO_WORKFLOW_V1','AD_VIDEO_VOCAB_V1','AD_VIDEO_PAYLOAD_V1',$9,$10)`;
    await client.query(insertSubmission,
      [ids.submissionA, ids.workspaceA, ids.roundA, ids.annotationA, ids.videoA,
        ids.snapshotA, "working-a", "submission-a", ids.userA, `${ids.submissionA}-key`, 1]);
    await client.query(insertSubmission,
      [ids.submissionB, ids.workspaceB, ids.roundB, ids.annotationB, ids.videoB,
        ids.snapshotB, "working-b", "submission-b", ids.userB, `${ids.submissionB}-key`, 1]);
    await expectRejected("bad_submission_round", insertSubmission,
      [`${ids.submissionA}_bad`, ids.workspaceA, ids.roundB, ids.annotationA, ids.videoA,
        ids.snapshotA, "working-a", "submission-a-bad", ids.userA, `${ids.submissionA}-bad-key`, 2]);

    await client.query(`INSERT INTO collaboration_revision_events (
      id, workspace_id, round_id, annotation_id, change_set_id, base_revision,
      applied_revision, target_key, target_label_snapshot, value_type,
      before_value_json, after_value_json, source_kind, actor_user_id, actor_name_snapshot
    ) VALUES ($1,$2,$3,$4,$5,1,2,'facts.creativeMotif','创意母题','TEXT','"a"','"b"',
      'HUMAN_DIRECT',$6,'Trigger A')`,
    [ids.revisionA, ids.workspaceA, ids.roundA, ids.annotationA, `${ids.revisionA}-change`, ids.userA]);
    await expectRejected("bad_revision_round", `INSERT INTO collaboration_revision_events (
      id, workspace_id, round_id, annotation_id, change_set_id, base_revision,
      applied_revision, target_key, target_label_snapshot, value_type,
      before_value_json, after_value_json, source_kind, actor_user_id, actor_name_snapshot
    ) VALUES ($1,$2,$3,$4,$5,1,2,'facts.creativeMotif','创意母题','TEXT','"a"','"b"',
      'HUMAN_DIRECT',$6,'Trigger A')`,
    [`${ids.revisionA}_bad`, ids.workspaceA, ids.roundB, ids.annotationA, `${ids.revisionA}-bad-change`, ids.userA]);

    await client.query(`INSERT INTO collaboration_edit_leases (
      id, workspace_id, round_id, holder_user_id, session_id, tab_token_hash,
      lease_token_hash, lease_version, expires_at
    ) VALUES
      ($1,$2,$3,$4,$5,'tab-a','lease-a',1,now()+interval '120 seconds'),
      ($6,$7,$8,$9,$10,'tab-b','lease-b',1,now()+interval '120 seconds')`,
    [ids.leaseA, ids.workspaceA, ids.roundA, ids.userA, ids.sessionA,
      ids.leaseB, ids.workspaceB, ids.roundB, ids.userB, ids.sessionB]);
    await expectRejected("bad_lease_round", `UPDATE collaboration_edit_leases SET round_id = $1 WHERE id = $2`,
      [ids.roundB, ids.leaseA]);

    await client.query(`INSERT INTO expert_analysis_releases (
      id, workspace_id, submission_snapshot_id, grade, reason, granted_by_user_id
    ) VALUES ($1,$2,$3,'A','TEST_ONLY trigger',$4)`,
    [ids.expertA, ids.workspaceA, ids.submissionA, ids.userA]);
    await expectRejected("bad_expert_submission", `INSERT INTO expert_analysis_releases (
      id, workspace_id, submission_snapshot_id, grade, reason, granted_by_user_id
    ) VALUES ($1,$2,$3,'B','TEST_ONLY invalid',$4)`,
    [`${ids.expertA}_bad`, ids.workspaceB, ids.submissionA, ids.userB]);

    const counts = await client.query<{ table_name: string; row_count: string }>(`
      SELECT 'baseline' AS table_name, count(*)::text AS row_count FROM collaboration_baselines WHERE id IN ($1,$2)
      UNION ALL SELECT 'round', count(*)::text FROM collaboration_rounds WHERE id IN ($3,$4)
      UNION ALL SELECT 'submission', count(*)::text FROM annotation_submission_snapshots WHERE id IN ($5,$6)
      UNION ALL SELECT 'revision', count(*)::text FROM collaboration_revision_events WHERE id=$7
      UNION ALL SELECT 'lease', count(*)::text FROM collaboration_edit_leases WHERE id IN ($8,$9)
      UNION ALL SELECT 'expert', count(*)::text FROM expert_analysis_releases WHERE id=$10`,
    [ids.baselineA, ids.baselineB, ids.roundA, ids.roundB, ids.submissionA, ids.submissionB,
      ids.revisionA, ids.leaseA, ids.leaseB, ids.expertA]);
    assert.deepEqual(Object.fromEntries(counts.rows.map((row) => [row.table_name, Number(row.row_count)])), {
      baseline: 2, round: 2, submission: 2, revision: 1, lease: 2, expert: 1,
    });
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
