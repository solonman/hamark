-- V0.3.1-FROZEN review workflow. This migration is additive: historical
-- V0.2/V0.3 snapshots and legacy inline suggestions remain untouched.

ALTER TABLE annotations
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'DRAFT';
ALTER TABLE annotations
  ADD COLUMN IF NOT EXISTS active_base_snapshot_id TEXT REFERENCES annotation_snapshots(id);

ALTER TABLE annotation_snapshots
  ADD COLUMN IF NOT EXISTS base_snapshot_id TEXT REFERENCES annotation_snapshots(id);
ALTER TABLE annotation_snapshots
  ADD COLUMN IF NOT EXISTS version_number INTEGER;
ALTER TABLE annotation_snapshots
  ADD COLUMN IF NOT EXISTS revision_cause TEXT NOT NULL DEFAULT 'INITIAL';
ALTER TABLE annotation_snapshots
  ADD COLUMN IF NOT EXISTS workflow_status TEXT NOT NULL DEFAULT 'SUBMITTED';
ALTER TABLE annotation_snapshots
  ADD COLUMN IF NOT EXISTS submitted_at TEXT;

CREATE TABLE IF NOT EXISTS analysis_review_rounds (
  id TEXT PRIMARY KEY,
  annotation_id TEXT NOT NULL REFERENCES annotations(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  submitted_snapshot_id TEXT NOT NULL REFERENCES annotation_snapshots(id),
  round_number INTEGER NOT NULL,
  reviewer_email TEXT,
  reviewer_name TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  decision_note TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  CHECK (status IN ('PENDING', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED')),
  UNIQUE (annotation_id, round_number),
  UNIQUE (submitted_snapshot_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS analysis_review_rounds_one_active_idx
  ON analysis_review_rounds(annotation_id)
  WHERE status IN ('PENDING', 'IN_REVIEW');
CREATE INDEX IF NOT EXISTS analysis_review_rounds_snapshot_idx
  ON analysis_review_rounds(submitted_snapshot_id);

CREATE TABLE IF NOT EXISTS analysis_revision_events (
  id TEXT PRIMARY KEY,
  annotation_id TEXT NOT NULL REFERENCES annotations(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  review_round_id TEXT NOT NULL REFERENCES analysis_review_rounds(id),
  base_snapshot_id TEXT NOT NULL REFERENCES annotation_snapshots(id),
  target_key TEXT NOT NULL,
  target_label TEXT NOT NULL DEFAULT '',
  edit_type TEXT NOT NULL,
  anchor_start INTEGER NOT NULL,
  anchor_end INTEGER NOT NULL,
  original_text TEXT NOT NULL,
  original_text_hash TEXT NOT NULL,
  replacement_text TEXT NOT NULL DEFAULT '',
  reason TEXT,
  actor_email TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  source TEXT NOT NULL,
  linked_comment_id TEXT REFERENCES analysis_comments(id),
  status TEXT NOT NULL DEFAULT 'DRAFT',
  applied_revision INTEGER,
  materialized_snapshot_id TEXT REFERENCES annotation_snapshots(id),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  CHECK (edit_type IN ('RANGE_REPLACE', 'UNIT_REPLACE', 'INSERT', 'DELETE')),
  CHECK (actor_role IN ('AUTHOR', 'FINAL_REVIEWER')),
  CHECK (source IN ('SELF_REVISION', 'COMMENT_RESPONSE', 'FINAL_DIRECT_REVISION')),
  CHECK (status IN ('DRAFT', 'APPLIED', 'SUPERSEDED'))
);
CREATE INDEX IF NOT EXISTS analysis_revision_events_round_idx
  ON analysis_revision_events(review_round_id, created_at);
CREATE INDEX IF NOT EXISTS analysis_revision_events_target_idx
  ON analysis_revision_events(base_snapshot_id, target_key, created_at);

ALTER TABLE analysis_comments
  ADD COLUMN IF NOT EXISTS review_round_id TEXT REFERENCES analysis_review_rounds(id);
ALTER TABLE analysis_comments
  ADD COLUMN IF NOT EXISTS base_version_id TEXT REFERENCES annotation_snapshots(id);
ALTER TABLE analysis_comments
  ADD COLUMN IF NOT EXISTS workflow_status TEXT NOT NULL DEFAULT 'OPEN';
COMMENT ON COLUMN analysis_comments.workflow_status IS
  'OPEN | AUTHOR_MARKED_HANDLED | RESOLVED | REOPENED';
UPDATE analysis_comments
SET workflow_status = 'RESOLVED'
WHERE status = 'RESOLVED' AND workflow_status = 'OPEN';
ALTER TABLE analysis_comments
  ADD COLUMN IF NOT EXISTS resolved_by_email TEXT;
ALTER TABLE analysis_comments
  ADD COLUMN IF NOT EXISTS resolved_by_name TEXT;
ALTER TABLE analysis_comments
  ADD COLUMN IF NOT EXISTS final_conclusion TEXT;
ALTER TABLE analysis_comments
  ADD COLUMN IF NOT EXISTS linked_revision_event_id TEXT REFERENCES analysis_revision_events(id);
ALTER TABLE analysis_comments
  ADD COLUMN IF NOT EXISTS handled_in_snapshot_id TEXT REFERENCES annotation_snapshots(id);
ALTER TABLE analysis_comments
  ADD COLUMN IF NOT EXISTS reopened_at TEXT;
CREATE INDEX IF NOT EXISTS analysis_comments_review_round_idx
  ON analysis_comments(review_round_id, created_at);

CREATE TABLE IF NOT EXISTS approved_analysis_releases (
  id TEXT PRIMARY KEY,
  annotation_id TEXT NOT NULL REFERENCES annotations(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  release_number INTEGER NOT NULL,
  approved_snapshot_id TEXT NOT NULL REFERENCES annotation_snapshots(id),
  source_snapshot_id TEXT NOT NULL REFERENCES annotation_snapshots(id),
  source_review_round_id TEXT NOT NULL REFERENCES analysis_review_rounds(id),
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  approved_by_email TEXT NOT NULL,
  approved_by_name TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  expert_creative_grade TEXT NOT NULL,
  assignment_quality_grade TEXT,
  assignment_quality_version TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  replaces_release_id TEXT REFERENCES approved_analysis_releases(id),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  CHECK (expert_creative_grade IN ('S', 'A', 'B', 'C')),
  CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'WITHDRAWN')),
  UNIQUE (annotation_id, release_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS approved_analysis_releases_one_active_idx
  ON approved_analysis_releases(annotation_id)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS approved_analysis_releases_video_idx
  ON approved_analysis_releases(video_id, status, approved_at);
