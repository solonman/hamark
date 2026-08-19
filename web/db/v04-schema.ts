import {
  V04_PAYLOAD_SCHEMA_VERSION,
  V04_PRODUCT_VERSION,
  V04_TAXONOMY_VERSION,
  V04_VOCABULARY_VERSION,
  V04_WORKFLOW_VERSION,
} from "../lib/v04-contract";
import {
  V04_VOCABULARY_APPROVED_HASHES,
  V04_VOCABULARY_OPTIONS,
} from "../lib/v04-vocabulary";

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;
const V04_WORKFLOW_CONTRACT_HASH = "437476f470b8cca0d6f21819ec0a16f72ed900192fb8748dd1d7873c91a79d45";

const vocabularyRows = V04_VOCABULARY_OPTIONS.map((option) => `(
    ${sqlText(V04_VOCABULARY_VERSION)},
    ${sqlText(option.fieldKey)},
    ${sqlText(option.optionId)},
    ${sqlText(option.labelZhCn)},
    ${sqlText(option.groupKey)},
    ${option.orderIndex},
    TRUE,
    '[]'::jsonb
  )`).join(",\n  ");

export const V04_SCHEMA_TABLES = [
  "annotation_vocabulary_versions",
  "annotation_vocabulary_options",
  "workflow_contract_versions",
  "app_role_memberships",
  "schema_migration_operations",
  "annotation_choice_values",
  "collaboration_workspaces",
  "collaboration_baselines",
  "collaboration_rounds",
  "annotation_submission_snapshots",
  "collaboration_revision_events",
  "collaboration_edit_leases",
  "expert_analysis_releases",
  "video_asset_cleanup_jobs",
] as const;

export const V04_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS annotation_vocabulary_versions (
    vocabulary_version TEXT PRIMARY KEY,
    taxonomy_version TEXT NOT NULL REFERENCES annotation_taxonomy_versions(taxonomy_version),
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED'))
  )`,
  `CREATE TABLE IF NOT EXISTS annotation_vocabulary_options (
    vocabulary_version TEXT NOT NULL REFERENCES annotation_vocabulary_versions(vocabulary_version),
    field_key TEXT NOT NULL,
    option_id TEXT NOT NULL,
    label TEXT NOT NULL,
    group_key TEXT NOT NULL,
    order_index INTEGER NOT NULL CHECK (order_index > 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    legacy_aliases_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    PRIMARY KEY (vocabulary_version, field_key, option_id),
    UNIQUE (vocabulary_version, field_key, order_index),
    CHECK (jsonb_typeof(legacy_aliases_json) = 'array')
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_contract_versions (
    workflow_version TEXT PRIMARY KEY,
    domain_key TEXT NOT NULL,
    product_version TEXT NOT NULL,
    taxonomy_version TEXT NOT NULL REFERENCES annotation_taxonomy_versions(taxonomy_version),
    vocabulary_version TEXT NOT NULL REFERENCES annotation_vocabulary_versions(vocabulary_version),
    payload_schema_version TEXT NOT NULL,
    contract_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_at TIMESTAMPTZ,
    CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED'))
  )`,
  `CREATE TABLE IF NOT EXISTS app_role_memberships (
    user_id TEXT NOT NULL REFERENCES users(id),
    role_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    granted_by_user_id TEXT REFERENCES users(id),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_by_user_id TEXT REFERENCES users(id),
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, role_key),
    CHECK (role_key IN ('EXPERT', 'SYSTEM_ADMIN')),
    CHECK (status IN ('ACTIVE', 'REVOKED')),
    CHECK ((status = 'ACTIVE' AND revoked_at IS NULL) OR status = 'REVOKED')
  )`,
  `CREATE TABLE IF NOT EXISTS schema_migration_operations (
    id TEXT PRIMARY KEY,
    operation_key TEXT NOT NULL UNIQUE,
    operation_type TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    contract_codes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL,
    preview_token TEXT NOT NULL,
    source_catalog_hash TEXT NOT NULL,
    target_catalog_hash TEXT NOT NULL,
    non_target_hash TEXT NOT NULL,
    actor_user_id TEXT NOT NULL REFERENCES users(id),
    idempotency_key TEXT NOT NULL UNIQUE,
    approval_reference TEXT,
    result_json JSONB,
    error_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    CHECK (operation_type IN ('SCHEMA_PREVIEW', 'SCHEMA_APPLY', 'CONTRACT_ACTIVATE')),
    CHECK (status IN ('PREVIEWED', 'APPLYING', 'APPLIED', 'FAILED')),
    CHECK (operation_type <> 'SCHEMA_PREVIEW' OR status = 'PREVIEWED'),
    CHECK (jsonb_typeof(contract_codes_json) = 'object')
  )`,
  `ALTER TABLE videos ADD COLUMN IF NOT EXISTS created_by_user_id TEXT REFERENCES users(id)`,
  `ALTER TABLE videos ADD COLUMN IF NOT EXISTS deleted_by_user_id TEXT REFERENCES users(id)`,
  `ALTER TABLE videos ADD COLUMN IF NOT EXISTS delete_reason TEXT`,
  `ALTER TABLE videos ADD COLUMN IF NOT EXISTS restore_until TIMESTAMPTZ`,
  `ALTER TABLE videos ADD COLUMN IF NOT EXISTS deletion_state TEXT`,
  `ALTER TABLE videos ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ`,
  `ALTER TABLE videos ADD COLUMN IF NOT EXISTS restored_by_user_id TEXT REFERENCES users(id)`,
  `DO $v04_video_deletion_check$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'videos_deletion_state_check'
        AND conrelid = 'videos'::regclass
    ) THEN
      ALTER TABLE videos ADD CONSTRAINT videos_deletion_state_check
        CHECK (deletion_state IS NULL OR deletion_state IN (
          'ACTIVE', 'TRASHED', 'PURGE_PENDING', 'ASSET_PURGED', 'PURGE_FAILED'
        ));
    END IF;
  END
  $v04_video_deletion_check$`,
  `ALTER TABLE annotations ADD COLUMN IF NOT EXISTS vocabulary_version TEXT`,
  `ALTER TABLE annotations ADD COLUMN IF NOT EXISTS payload_schema_version TEXT`,
  `ALTER TABLE annotations ADD COLUMN IF NOT EXISTS content_hash TEXT`,
  `ALTER TABLE annotations ADD COLUMN IF NOT EXISTS updated_by_user_id TEXT REFERENCES users(id)`,
  `ALTER TABLE shots ADD COLUMN IF NOT EXISTS subtitle_effect TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE annotation_snapshots ADD COLUMN IF NOT EXISTS workflow_version TEXT`,
  `ALTER TABLE annotation_snapshots ADD COLUMN IF NOT EXISTS vocabulary_version TEXT`,
  `ALTER TABLE annotation_snapshots ADD COLUMN IF NOT EXISTS payload_schema_version TEXT`,
  `ALTER TABLE annotation_snapshots ADD COLUMN IF NOT EXISTS created_by_user_id TEXT REFERENCES users(id)`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_user_id TEXT REFERENCES users(id)`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS request_id TEXT`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS workflow_version TEXT`,
  `CREATE TABLE IF NOT EXISTS annotation_choice_values (
    id TEXT PRIMARY KEY,
    annotation_id TEXT NOT NULL REFERENCES annotations(id),
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    field_key TEXT NOT NULL,
    selected_option_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    custom_text TEXT NOT NULL DEFAULT '',
    advanced_text TEXT NOT NULL DEFAULT '',
    vocabulary_version TEXT NOT NULL REFERENCES annotation_vocabulary_versions(vocabulary_version),
    legacy_raw_value JSONB,
    updated_by_user_id TEXT NOT NULL REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (annotation_id, target_type, target_id, field_key),
    CHECK (target_type IN ('ANNOTATION', 'SHOT_GROUP')),
    CHECK (jsonb_typeof(selected_option_ids) = 'array')
  )`,
  `CREATE TABLE IF NOT EXISTS collaboration_workspaces (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    domain_key TEXT NOT NULL,
    taxonomy_version TEXT NOT NULL REFERENCES annotation_taxonomy_versions(taxonomy_version),
    workflow_version TEXT NOT NULL REFERENCES workflow_contract_versions(workflow_version),
    vocabulary_version TEXT NOT NULL REFERENCES annotation_vocabulary_versions(vocabulary_version),
    canonical_annotation_id TEXT NOT NULL REFERENCES annotations(id) UNIQUE,
    active_round_id TEXT,
    current_working_snapshot_id TEXT,
    latest_submission_snapshot_id TEXT,
    active_expert_release_id TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (video_id, workflow_version),
    UNIQUE (id, canonical_annotation_id),
    CHECK (status IN ('ACTIVE', 'ARCHIVED', 'TRASHED'))
  )`,
  `CREATE TABLE IF NOT EXISTS collaboration_baselines (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL UNIQUE REFERENCES collaboration_workspaces(id),
    annotation_id TEXT NOT NULL REFERENCES annotations(id),
    source_kind TEXT NOT NULL,
    source_object_type TEXT,
    source_object_id TEXT,
    payload_json JSONB NOT NULL,
    content_hash TEXT NOT NULL,
    taxonomy_version TEXT NOT NULL,
    workflow_version TEXT NOT NULL,
    payload_schema_version TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, workspace_id),
    CHECK (source_kind IN ('EMPTY', 'V03_ADAPTER', 'V02_ADAPTER', 'LEGACY_APPROVED'))
  )`,
  `CREATE TABLE IF NOT EXISTS collaboration_rounds (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES collaboration_workspaces(id),
    annotation_id TEXT NOT NULL REFERENCES annotations(id),
    round_number INTEGER NOT NULL CHECK (round_number > 0),
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    base_type TEXT NOT NULL,
    base_baseline_id TEXT REFERENCES collaboration_baselines(id),
    base_submission_snapshot_id TEXT,
    starting_revision INTEGER NOT NULL CHECK (starting_revision >= 0),
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_by_user_id TEXT REFERENCES users(id),
    ended_at TIMESTAMPTZ,
    UNIQUE (workspace_id, round_number),
    UNIQUE (id, workspace_id),
    CHECK (status IN ('ACTIVE', 'CLOSED', 'SUPERSEDED', 'TRASHED')),
    CHECK (base_type IN ('BASELINE', 'SUBMISSION', 'RESTORE')),
    CHECK (
      (base_type = 'BASELINE' AND base_baseline_id IS NOT NULL AND base_submission_snapshot_id IS NULL)
      OR (base_type IN ('SUBMISSION', 'RESTORE') AND base_baseline_id IS NULL AND base_submission_snapshot_id IS NOT NULL)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS collaboration_rounds_one_active_idx
    ON collaboration_rounds(workspace_id) WHERE status = 'ACTIVE'`,
  `CREATE TABLE IF NOT EXISTS annotation_submission_snapshots (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES collaboration_workspaces(id),
    round_id TEXT NOT NULL REFERENCES collaboration_rounds(id),
    annotation_id TEXT NOT NULL REFERENCES annotations(id),
    video_id TEXT NOT NULL REFERENCES videos(id),
    submission_number INTEGER NOT NULL CHECK (submission_number > 0),
    source_working_snapshot_id TEXT NOT NULL REFERENCES annotation_snapshots(id),
    source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
    source_content_hash TEXT NOT NULL,
    payload_json JSONB NOT NULL,
    content_hash TEXT NOT NULL,
    taxonomy_version TEXT NOT NULL,
    workflow_version TEXT NOT NULL,
    vocabulary_version TEXT NOT NULL,
    payload_schema_version TEXT NOT NULL,
    submitted_by_user_id TEXT NOT NULL REFERENCES users(id),
    idempotency_key TEXT NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, submission_number),
    UNIQUE (workspace_id, idempotency_key),
    UNIQUE (id, workspace_id)
  )`,
  `CREATE TABLE IF NOT EXISTS collaboration_revision_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES collaboration_workspaces(id),
    round_id TEXT NOT NULL REFERENCES collaboration_rounds(id),
    annotation_id TEXT NOT NULL REFERENCES annotations(id),
    change_set_id TEXT NOT NULL,
    base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
    applied_revision INTEGER NOT NULL CHECK (applied_revision > base_revision),
    target_key TEXT NOT NULL,
    target_label_snapshot TEXT NOT NULL DEFAULT '',
    value_type TEXT NOT NULL,
    before_value_json JSONB NOT NULL,
    after_value_json JSONB NOT NULL,
    source_kind TEXT NOT NULL,
    source_object_type TEXT,
    source_object_id TEXT,
    reason TEXT,
    actor_user_id TEXT NOT NULL REFERENCES users(id),
    actor_name_snapshot TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (value_type IN ('TEXT', 'SINGLE_SELECT', 'MULTI_SELECT', 'CHOICE_WITH_CUSTOM', 'STRUCTURE')),
    CHECK (source_kind IN ('HUMAN_DIRECT', 'COMMENT_APPLY', 'HISTORY_RESTORE', 'AI_ACCEPTANCE_RESERVED', 'SYSTEM_MIGRATION'))
  )`,
  `CREATE INDEX IF NOT EXISTS collaboration_revision_events_round_idx
    ON collaboration_revision_events(round_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS collaboration_revision_events_target_idx
    ON collaboration_revision_events(workspace_id, target_key, created_at)`,
  `CREATE TABLE IF NOT EXISTS collaboration_edit_leases (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES collaboration_workspaces(id),
    round_id TEXT NOT NULL REFERENCES collaboration_rounds(id),
    holder_user_id TEXT NOT NULL REFERENCES users(id),
    session_id TEXT NOT NULL REFERENCES auth_sessions(id),
    tab_token_hash TEXT NOT NULL,
    lease_token_hash TEXT NOT NULL,
    lease_version INTEGER NOT NULL CHECK (lease_version > 0),
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    released_at TIMESTAMPTZ,
    release_reason TEXT,
    CHECK (status IN ('ACTIVE', 'RELEASED', 'EXPIRED')),
    CHECK (release_reason IS NULL OR release_reason IN ('USER_EXIT', 'EXPIRED', 'ADMIN_FORCE', 'ROUND_CLOSED'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS collaboration_edit_leases_one_active_idx
    ON collaboration_edit_leases(workspace_id) WHERE status = 'ACTIVE'`,
  `CREATE TABLE IF NOT EXISTS expert_analysis_releases (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES collaboration_workspaces(id),
    submission_snapshot_id TEXT NOT NULL REFERENCES annotation_submission_snapshots(id),
    grade TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    granted_by_user_id TEXT NOT NULL REFERENCES users(id),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_by_user_id TEXT REFERENCES users(id),
    ended_at TIMESTAMPTZ,
    supersedes_release_id TEXT REFERENCES expert_analysis_releases(id) DEFERRABLE INITIALLY DEFERRED,
    UNIQUE (id, workspace_id),
    CHECK (grade IN ('S', 'A', 'B', 'C')),
    CHECK (status IN ('ACTIVE', 'WITHDRAWN', 'SUPERSEDED'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS expert_analysis_releases_one_active_idx
    ON expert_analysis_releases(workspace_id) WHERE status = 'ACTIVE'`,
  `CREATE TABLE IF NOT EXISTS video_asset_cleanup_jobs (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    object_key_snapshot TEXT NOT NULL,
    thumbnail_key_snapshot TEXT,
    state TEXT NOT NULL,
    retention_until TIMESTAMPTZ NOT NULL,
    backup_manifest_json JSONB,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error TEXT,
    requested_by_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    CHECK (state IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'))
  )`,
  `DO $v04_round_submission_fk$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'collaboration_rounds_base_submission_workspace_fk'
        AND conrelid = 'collaboration_rounds'::regclass
    ) THEN
      ALTER TABLE collaboration_rounds
        ADD CONSTRAINT collaboration_rounds_base_submission_workspace_fk
        FOREIGN KEY (base_submission_snapshot_id, workspace_id)
        REFERENCES annotation_submission_snapshots(id, workspace_id)
        DEFERRABLE INITIALLY DEFERRED;
    END IF;
  END
  $v04_round_submission_fk$`,
  `DO $v04_workspace_pointer_fks$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaboration_workspaces_active_round_fk') THEN
      ALTER TABLE collaboration_workspaces ADD CONSTRAINT collaboration_workspaces_active_round_fk
        FOREIGN KEY (active_round_id, id) REFERENCES collaboration_rounds(id, workspace_id)
        DEFERRABLE INITIALLY DEFERRED;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaboration_workspaces_current_working_fk') THEN
      ALTER TABLE collaboration_workspaces ADD CONSTRAINT collaboration_workspaces_current_working_fk
        FOREIGN KEY (current_working_snapshot_id) REFERENCES annotation_snapshots(id)
        DEFERRABLE INITIALLY DEFERRED;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaboration_workspaces_latest_submission_fk') THEN
      ALTER TABLE collaboration_workspaces ADD CONSTRAINT collaboration_workspaces_latest_submission_fk
        FOREIGN KEY (latest_submission_snapshot_id, id) REFERENCES annotation_submission_snapshots(id, workspace_id)
        DEFERRABLE INITIALLY DEFERRED;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaboration_workspaces_active_expert_release_fk') THEN
      ALTER TABLE collaboration_workspaces ADD CONSTRAINT collaboration_workspaces_active_expert_release_fk
        FOREIGN KEY (active_expert_release_id, id) REFERENCES expert_analysis_releases(id, workspace_id)
        DEFERRABLE INITIALLY DEFERRED;
    END IF;
  END
  $v04_workspace_pointer_fks$`,
  `CREATE OR REPLACE FUNCTION validate_v04_choice_value()
  RETURNS trigger AS $v04_choice_guard$
  DECLARE
    option_value JSONB;
  BEGIN
    IF NEW.target_type = 'ANNOTATION' AND NEW.target_id <> NEW.annotation_id THEN
      RAISE EXCEPTION 'annotation choice target must equal annotation id';
    END IF;
    IF NEW.target_type = 'SHOT_GROUP' AND NOT EXISTS (
      SELECT 1 FROM shot_groups
      WHERE id = NEW.target_id AND annotation_id = NEW.annotation_id
    ) THEN
      RAISE EXCEPTION 'shot group choice target must belong to annotation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.selected_option_ids) item
      WHERE jsonb_typeof(item) <> 'string'
    ) THEN
      RAISE EXCEPTION 'selected option ids must be strings';
    END IF;
    FOR option_value IN SELECT item FROM jsonb_array_elements(NEW.selected_option_ids) item LOOP
      IF NOT EXISTS (
        SELECT 1 FROM annotation_vocabulary_options
        WHERE vocabulary_version = NEW.vocabulary_version
          AND field_key = NEW.field_key
          AND option_id = option_value #>> '{}'
          AND is_active
      ) THEN
        RAISE EXCEPTION 'selected option does not belong to active field vocabulary';
      END IF;
    END LOOP;
    IF (SELECT COUNT(*) FROM jsonb_array_elements(NEW.selected_option_ids)) <>
       (SELECT COUNT(DISTINCT item #>> '{}') FROM jsonb_array_elements(NEW.selected_option_ids) item) THEN
      RAISE EXCEPTION 'selected option ids must be unique';
    END IF;
    RETURN NEW;
  END;
  $v04_choice_guard$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS annotation_choice_values_validate ON annotation_choice_values`,
  `CREATE TRIGGER annotation_choice_values_validate
    BEFORE INSERT OR UPDATE ON annotation_choice_values
    FOR EACH ROW EXECUTE FUNCTION validate_v04_choice_value()`,
  `CREATE OR REPLACE FUNCTION validate_v04_collaboration_relationship()
  RETURNS trigger AS $v04_relation_guard$
  DECLARE
    workspace_annotation_id TEXT;
    workspace_video_id TEXT;
    workspace_workflow_version TEXT;
  BEGIN
    IF TG_TABLE_NAME = 'collaboration_workspaces' THEN
      IF NOT EXISTS (
        SELECT 1 FROM annotations a
        WHERE a.id = NEW.canonical_annotation_id
          AND a.video_id = NEW.video_id
          AND a.workflow_version = NEW.workflow_version
      ) THEN
        RAISE EXCEPTION 'workspace canonical annotation must match video and workflow';
      END IF;
      IF NEW.current_working_snapshot_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM annotation_snapshots s
        WHERE s.id = NEW.current_working_snapshot_id
          AND s.annotation_id = NEW.canonical_annotation_id
          AND s.video_id = NEW.video_id
          AND s.workflow_version = NEW.workflow_version
          AND s.snapshot_kind = 'WORKING'
      ) THEN
        RAISE EXCEPTION 'workspace working snapshot must match canonical annotation and workflow';
      END IF;
      RETURN NEW;
    END IF;

    SELECT canonical_annotation_id, video_id, workflow_version
      INTO workspace_annotation_id, workspace_video_id, workspace_workflow_version
      FROM collaboration_workspaces WHERE id = NEW.workspace_id;
    IF workspace_annotation_id IS NULL THEN
      RAISE EXCEPTION 'collaboration object requires an existing workspace';
    END IF;
    IF TG_TABLE_NAME IN ('collaboration_baselines', 'collaboration_rounds',
      'annotation_submission_snapshots', 'collaboration_revision_events')
      AND NEW.annotation_id <> workspace_annotation_id THEN
      RAISE EXCEPTION 'collaboration object annotation must match workspace canonical annotation';
    END IF;
    IF TG_TABLE_NAME = 'annotation_submission_snapshots' THEN
      IF NEW.video_id <> workspace_video_id OR NEW.workflow_version <> workspace_workflow_version THEN
        RAISE EXCEPTION 'submission video and workflow must match workspace';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM annotation_snapshots s
        WHERE s.id = NEW.source_working_snapshot_id
          AND s.annotation_id = workspace_annotation_id
          AND s.video_id = workspace_video_id
          AND s.workflow_version = workspace_workflow_version
          AND s.snapshot_kind = 'WORKING'
          AND s.revision = NEW.source_revision
          AND s.content_hash = NEW.source_content_hash
      ) THEN
        RAISE EXCEPTION 'submission source must be exact workspace working snapshot';
      END IF;
    END IF;
    IF TG_TABLE_NAME IN ('annotation_submission_snapshots', 'collaboration_revision_events',
      'collaboration_edit_leases') AND NOT EXISTS (
      SELECT 1 FROM collaboration_rounds r
      WHERE r.id = NEW.round_id AND r.workspace_id = NEW.workspace_id
    ) THEN
      RAISE EXCEPTION 'collaboration round must belong to workspace';
    END IF;
    IF TG_TABLE_NAME = 'expert_analysis_releases' AND NOT EXISTS (
      SELECT 1 FROM annotation_submission_snapshots s
      WHERE s.id = NEW.submission_snapshot_id AND s.workspace_id = NEW.workspace_id
    ) THEN
      RAISE EXCEPTION 'expert release must reference workspace submission';
    END IF;
    RETURN NEW;
  END;
  $v04_relation_guard$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS collaboration_workspaces_relation_guard ON collaboration_workspaces`,
  `CREATE TRIGGER collaboration_workspaces_relation_guard
    BEFORE INSERT OR UPDATE ON collaboration_workspaces
    FOR EACH ROW EXECUTE FUNCTION validate_v04_collaboration_relationship()`,
  ...[
    "collaboration_baselines",
    "collaboration_rounds",
    "annotation_submission_snapshots",
    "collaboration_revision_events",
    "collaboration_edit_leases",
    "expert_analysis_releases",
  ].flatMap((table) => [
    `DROP TRIGGER IF EXISTS ${table}_relation_guard ON ${table}`,
    `CREATE TRIGGER ${table}_relation_guard
      BEFORE INSERT OR UPDATE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION validate_v04_collaboration_relationship()`,
  ]),
  `CREATE OR REPLACE FUNCTION protect_v04_append_only_record()
  RETURNS trigger AS $v04_append_only_guard$
  BEGIN
    RAISE EXCEPTION 'V0.4 immutable records cannot be updated or deleted';
  END;
  $v04_append_only_guard$ LANGUAGE plpgsql`,
  ...[
    "collaboration_baselines",
    "annotation_submission_snapshots",
    "collaboration_revision_events",
  ].flatMap((table) => [
    `DROP TRIGGER IF EXISTS ${table}_immutable ON ${table}`,
    `CREATE TRIGGER ${table}_immutable
      BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION protect_v04_append_only_record()`,
  ]),
  `CREATE OR REPLACE FUNCTION protect_v04_working_snapshot()
  RETURNS trigger AS $v04_working_snapshot_guard$
  BEGIN
    IF OLD.workflow_version = ${sqlText(V04_WORKFLOW_VERSION)}
      AND OLD.snapshot_kind = 'WORKING' THEN
      RAISE EXCEPTION 'V0.4 working snapshots are immutable';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END;
  $v04_working_snapshot_guard$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS annotation_snapshots_v04_working_immutable ON annotation_snapshots`,
  `CREATE TRIGGER annotation_snapshots_v04_working_immutable
    BEFORE UPDATE OR DELETE ON annotation_snapshots
    FOR EACH ROW EXECUTE FUNCTION protect_v04_working_snapshot()`,
  `CREATE OR REPLACE FUNCTION protect_v04_expert_release()
  RETURNS trigger AS $v04_expert_release_guard$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'expert releases cannot be deleted';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.submission_snapshot_id IS DISTINCT FROM OLD.submission_snapshot_id
      OR NEW.grade IS DISTINCT FROM OLD.grade
      OR NEW.reason IS DISTINCT FROM OLD.reason
      OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
      OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
      OR NEW.supersedes_release_id IS DISTINCT FROM OLD.supersedes_release_id THEN
      RAISE EXCEPTION 'expert release content and source are immutable';
    END IF;
    IF OLD.status <> 'ACTIVE' OR NEW.status NOT IN ('WITHDRAWN', 'SUPERSEDED') THEN
      RAISE EXCEPTION 'invalid expert release status transition';
    END IF;
    IF NEW.ended_by_user_id IS NULL OR NEW.ended_at IS NULL THEN
      RAISE EXCEPTION 'ending expert release requires actor and time';
    END IF;
    RETURN NEW;
  END;
  $v04_expert_release_guard$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS expert_analysis_releases_immutable ON expert_analysis_releases`,
  `CREATE TRIGGER expert_analysis_releases_immutable
    BEFORE UPDATE OR DELETE ON expert_analysis_releases
    FOR EACH ROW EXECUTE FUNCTION protect_v04_expert_release()`,
  `CREATE OR REPLACE FUNCTION protect_schema_migration_operation()
  RETURNS trigger AS $schema_operation_guard$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'schema migration operations are immutable';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
      OR NEW.operation_type IS DISTINCT FROM OLD.operation_type
      OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
      OR NEW.contract_codes_json IS DISTINCT FROM OLD.contract_codes_json
      OR NEW.preview_token IS DISTINCT FROM OLD.preview_token
      OR NEW.source_catalog_hash IS DISTINCT FROM OLD.source_catalog_hash
      OR NEW.target_catalog_hash IS DISTINCT FROM OLD.target_catalog_hash
      OR NEW.non_target_hash IS DISTINCT FROM OLD.non_target_hash
      OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
      OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
      OR NEW.approval_reference IS DISTINCT FROM OLD.approval_reference
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'schema migration operation identity and preview evidence are immutable';
    END IF;
    IF OLD.operation_type = 'SCHEMA_PREVIEW' THEN
      RAISE EXCEPTION 'schema preview evidence is permanently immutable';
    ELSIF OLD.status = 'PREVIEWED' AND NEW.status NOT IN ('APPLYING', 'FAILED') THEN
      RAISE EXCEPTION 'previewed schema operation can only start or fail';
    ELSIF OLD.status = 'APPLYING' AND NEW.status NOT IN ('APPLIED', 'FAILED') THEN
      RAISE EXCEPTION 'applying schema operation can only finish or fail';
    ELSIF OLD.status IN ('APPLIED', 'FAILED') THEN
      RAISE EXCEPTION 'completed schema migration operation is permanently locked';
    END IF;
    RETURN NEW;
  END;
  $schema_operation_guard$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS schema_migration_operations_immutable ON schema_migration_operations`,
  `CREATE TRIGGER schema_migration_operations_immutable
    BEFORE UPDATE OR DELETE ON schema_migration_operations
    FOR EACH ROW EXECUTE FUNCTION protect_schema_migration_operation()`,
  `CREATE OR REPLACE FUNCTION protect_v04_version_contract()
  RETURNS trigger AS $v04_version_contract_guard$
  BEGIN
    IF TG_TABLE_NAME = 'annotation_taxonomy_versions'
      AND OLD.taxonomy_version <> ${sqlText(V04_TAXONOMY_VERSION)} THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'V0.4 version contracts cannot be deleted';
    END IF;
    IF TG_TABLE_NAME = 'workflow_contract_versions' THEN
      IF (to_jsonb(NEW) - 'status' - 'activated_at')
        IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'activated_at') THEN
        RAISE EXCEPTION 'V0.4 version contract identity and content are immutable';
      END IF;
    ELSIF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
      RAISE EXCEPTION 'V0.4 version contract identity and content are immutable';
    END IF;
    IF OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE' THEN
      IF TG_TABLE_NAME = 'workflow_contract_versions'
        AND to_jsonb(NEW) ->> 'activated_at' IS NULL THEN
        RAISE EXCEPTION 'workflow activation requires activated_at';
      END IF;
    ELSIF OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED' THEN
      IF TG_TABLE_NAME = 'workflow_contract_versions'
        AND to_jsonb(NEW) ->> 'activated_at' IS DISTINCT FROM to_jsonb(OLD) ->> 'activated_at' THEN
        RAISE EXCEPTION 'workflow activation time is immutable';
      END IF;
    ELSE
      RAISE EXCEPTION 'invalid V0.4 version contract lifecycle transition';
    END IF;
    RETURN NEW;
  END;
  $v04_version_contract_guard$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS annotation_taxonomy_versions_v04_immutable ON annotation_taxonomy_versions`,
  `CREATE TRIGGER annotation_taxonomy_versions_v04_immutable
    BEFORE UPDATE OR DELETE ON annotation_taxonomy_versions
    FOR EACH ROW EXECUTE FUNCTION protect_v04_version_contract()`,
  `DROP TRIGGER IF EXISTS annotation_vocabulary_versions_immutable ON annotation_vocabulary_versions`,
  `CREATE TRIGGER annotation_vocabulary_versions_immutable
    BEFORE UPDATE OR DELETE ON annotation_vocabulary_versions
    FOR EACH ROW EXECUTE FUNCTION protect_v04_version_contract()`,
  `DROP TRIGGER IF EXISTS workflow_contract_versions_immutable ON workflow_contract_versions`,
  `CREATE TRIGGER workflow_contract_versions_immutable
    BEFORE UPDATE OR DELETE ON workflow_contract_versions
    FOR EACH ROW EXECUTE FUNCTION protect_v04_version_contract()`,
  `DROP TRIGGER IF EXISTS annotation_vocabulary_options_immutable ON annotation_vocabulary_options`,
  `CREATE TRIGGER annotation_vocabulary_options_immutable
    BEFORE UPDATE OR DELETE ON annotation_vocabulary_options
    FOR EACH ROW EXECUTE FUNCTION protect_v04_append_only_record()`,
  `INSERT INTO annotation_taxonomy_versions (
    taxonomy_version, workflow_version, status, label
  ) VALUES (
    ${sqlText(V04_TAXONOMY_VERSION)},
    ${sqlText(V04_WORKFLOW_VERSION)},
    'DRAFT',
    'AI视频创意逆向工程 V0.4'
  ) ON CONFLICT (taxonomy_version) DO NOTHING`,
  `INSERT INTO annotation_vocabulary_versions (
    vocabulary_version, taxonomy_version, content_hash, status
  ) VALUES (
    ${sqlText(V04_VOCABULARY_VERSION)},
    ${sqlText(V04_TAXONOMY_VERSION)},
    ${sqlText(V04_VOCABULARY_APPROVED_HASHES.combined)},
    'DRAFT'
  ) ON CONFLICT (vocabulary_version) DO NOTHING`,
  `INSERT INTO annotation_vocabulary_options (
    vocabulary_version, field_key, option_id, label, group_key,
    order_index, is_active, legacy_aliases_json
  ) VALUES
  ${vocabularyRows}
  ON CONFLICT (vocabulary_version, field_key, option_id) DO NOTHING`,
  `INSERT INTO workflow_contract_versions (
    workflow_version, domain_key, product_version,
    taxonomy_version, vocabulary_version,
    payload_schema_version, contract_hash, status
  ) VALUES (
    ${sqlText(V04_WORKFLOW_VERSION)},
    'AD_VIDEO',
    ${sqlText(V04_PRODUCT_VERSION)},
    ${sqlText(V04_TAXONOMY_VERSION)},
    ${sqlText(V04_VOCABULARY_VERSION)},
    ${sqlText(V04_PAYLOAD_SCHEMA_VERSION)},
    ${sqlText(V04_WORKFLOW_CONTRACT_HASH)},
    'DRAFT'
  ) ON CONFLICT (workflow_version) DO NOTHING`,
  `DO $v04_contract_drift_guard$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM annotation_taxonomy_versions
      WHERE taxonomy_version = ${sqlText(V04_TAXONOMY_VERSION)}
        AND workflow_version = ${sqlText(V04_WORKFLOW_VERSION)}
        AND status = 'DRAFT'
    ) THEN
      RAISE EXCEPTION 'V0.4 taxonomy contract drift';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM annotation_vocabulary_versions
      WHERE vocabulary_version = ${sqlText(V04_VOCABULARY_VERSION)}
        AND taxonomy_version = ${sqlText(V04_TAXONOMY_VERSION)}
        AND content_hash = ${sqlText(V04_VOCABULARY_APPROVED_HASHES.combined)}
        AND status = 'DRAFT'
    ) THEN
      RAISE EXCEPTION 'V0.4 vocabulary contract drift';
    END IF;
    IF (SELECT COUNT(*) FROM annotation_vocabulary_options
      WHERE vocabulary_version = ${sqlText(V04_VOCABULARY_VERSION)}) <> 60 THEN
      RAISE EXCEPTION 'V0.4 vocabulary option count drift';
    END IF;
    IF EXISTS (
      WITH expected (
        vocabulary_version, field_key, option_id, label, group_key,
        order_index, is_active, legacy_aliases_json
      ) AS (VALUES
        ${vocabularyRows}
      )
      SELECT 1
      FROM expected e
      FULL JOIN annotation_vocabulary_options a
        ON a.vocabulary_version = e.vocabulary_version
       AND a.field_key = e.field_key
       AND a.option_id = e.option_id
      WHERE COALESCE(e.vocabulary_version, a.vocabulary_version) = ${sqlText(V04_VOCABULARY_VERSION)}
        AND (
          e.option_id IS NULL OR a.option_id IS NULL
          OR a.label IS DISTINCT FROM e.label
          OR a.group_key IS DISTINCT FROM e.group_key
          OR a.order_index IS DISTINCT FROM e.order_index
          OR a.is_active IS DISTINCT FROM e.is_active
          OR a.legacy_aliases_json IS DISTINCT FROM e.legacy_aliases_json
        )
    ) THEN
      RAISE EXCEPTION 'V0.4 vocabulary option content drift';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM workflow_contract_versions
      WHERE workflow_version = ${sqlText(V04_WORKFLOW_VERSION)}
        AND domain_key = 'AD_VIDEO'
        AND product_version = ${sqlText(V04_PRODUCT_VERSION)}
        AND taxonomy_version = ${sqlText(V04_TAXONOMY_VERSION)}
        AND vocabulary_version = ${sqlText(V04_VOCABULARY_VERSION)}
        AND payload_schema_version = ${sqlText(V04_PAYLOAD_SCHEMA_VERSION)}
        AND contract_hash = ${sqlText(V04_WORKFLOW_CONTRACT_HASH)}
        AND status = 'DRAFT'
    ) THEN
      RAISE EXCEPTION 'V0.4 workflow contract drift';
    END IF;
  END
  $v04_contract_drift_guard$`,
  ...V04_SCHEMA_TABLES.map((table) =>
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
  ),
  `DO $v04_revoke_public_roles$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${V04_SCHEMA_TABLES.join(", ")} FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${V04_SCHEMA_TABLES.join(", ")} FROM authenticated';
    END IF;
  END
  $v04_revoke_public_roles$`,
] as const;
