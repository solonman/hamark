-- V0.3 shared collaboration is additive. Existing annotations, snapshots,
-- review rounds, comments, revision events and releases remain untouched.

CREATE TABLE IF NOT EXISTS v03_collaboration_streams (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id),
  taxonomy_version TEXT NOT NULL DEFAULT 'V0.3-PILOT',
  canonical_annotation_id TEXT NOT NULL REFERENCES annotations(id),
  initial_baseline_id TEXT,
  active_round_id TEXT,
  active_release_id TEXT REFERENCES approved_analysis_releases(id),
  current_snapshot_id TEXT REFERENCES annotation_snapshots(id),
  source_author_email TEXT NOT NULL,
  source_author_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by_email TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  CHECK (taxonomy_version = 'V0.3-PILOT'),
  CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  UNIQUE (video_id, taxonomy_version),
  UNIQUE (canonical_annotation_id)
);

CREATE TABLE IF NOT EXISTS v03_collaboration_sources (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES v03_collaboration_streams(id),
  annotation_id TEXT NOT NULL REFERENCES annotations(id),
  relation_type TEXT NOT NULL,
  source_author_email TEXT NOT NULL,
  source_author_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  CHECK (relation_type IN ('CANONICAL', 'LEGACY_CONTRIBUTOR', 'MAPPED_SOURCE')),
  UNIQUE (stream_id, annotation_id)
);

CREATE TABLE IF NOT EXISTS v03_collaboration_baselines (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES v03_collaboration_streams(id),
  annotation_id TEXT NOT NULL REFERENCES annotations(id),
  source_type TEXT NOT NULL,
  source_snapshot_id TEXT REFERENCES annotation_snapshots(id),
  source_operation_key TEXT,
  payload_json JSONB NOT NULL,
  content_hash TEXT NOT NULL,
  source_author_email TEXT NOT NULL,
  source_author_name TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  CHECK (source_type IN ('V02_MAPPED', 'EXISTING_V03', 'APPROVED_RELEASE')),
  UNIQUE (stream_id)
);

CREATE TABLE IF NOT EXISTS v03_collaboration_rounds (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES v03_collaboration_streams(id),
  annotation_id TEXT NOT NULL REFERENCES annotations(id),
  round_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  base_type TEXT NOT NULL,
  base_baseline_id TEXT REFERENCES v03_collaboration_baselines(id),
  base_release_id TEXT REFERENCES approved_analysis_releases(id),
  base_snapshot_id TEXT REFERENCES annotation_snapshots(id),
  starting_revision INTEGER NOT NULL,
  candidate_snapshot_id TEXT REFERENCES annotation_snapshots(id),
  created_by_email TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  ended_by_email TEXT,
  ended_by_name TEXT,
  ended_at TEXT,
  CHECK (status IN ('ACTIVE', 'FINALIZED', 'SUPERSEDED', 'SOFT_DELETED')),
  CHECK (base_type IN ('INITIAL_BASELINE', 'APPROVED_RELEASE', 'RESTORED_RELEASE', 'EMPTY_INITIAL')),
  UNIQUE (stream_id, round_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS v03_collaboration_rounds_one_active_idx
  ON v03_collaboration_rounds(stream_id) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS v03_collaboration_revision_events (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES v03_collaboration_streams(id),
  round_id TEXT NOT NULL REFERENCES v03_collaboration_rounds(id),
  annotation_id TEXT NOT NULL REFERENCES annotations(id),
  change_set_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  applied_revision INTEGER NOT NULL,
  target_key TEXT NOT NULL,
  target_label TEXT NOT NULL DEFAULT '',
  value_type TEXT NOT NULL,
  before_value_json JSONB NOT NULL,
  after_value_json JSONB NOT NULL,
  reason TEXT,
  actor_email TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  CHECK (value_type IN ('TEXT', 'SINGLE_SELECT', 'MULTI_SELECT', 'STRUCTURE'))
);
CREATE INDEX IF NOT EXISTS v03_collaboration_revision_events_round_idx
  ON v03_collaboration_revision_events(round_id, created_at);
CREATE INDEX IF NOT EXISTS v03_collaboration_revision_events_target_idx
  ON v03_collaboration_revision_events(stream_id, target_key, created_at);

ALTER TABLE analysis_comments
  ADD COLUMN IF NOT EXISTS collaboration_round_id TEXT REFERENCES v03_collaboration_rounds(id);
ALTER TABLE analysis_comments
  ADD COLUMN IF NOT EXISTS base_working_revision INTEGER;
ALTER TABLE annotation_snapshots
  ADD COLUMN IF NOT EXISTS snapshot_kind TEXT NOT NULL DEFAULT 'SUBMISSION';
ALTER TABLE approved_analysis_releases
  ADD COLUMN IF NOT EXISTS collaboration_stream_id TEXT REFERENCES v03_collaboration_streams(id);
ALTER TABLE approved_analysis_releases
  ADD COLUMN IF NOT EXISTS collaboration_round_id TEXT REFERENCES v03_collaboration_rounds(id);

ALTER TABLE v03_collaboration_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE v03_collaboration_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE v03_collaboration_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE v03_collaboration_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE v03_collaboration_revision_events ENABLE ROW LEVEL SECURITY;
