-- Add precise text anchors and version-bound revision suggestions.
-- Safe to run more than once; published annotation snapshots remain immutable.

ALTER TABLE analysis_comments
  ADD COLUMN IF NOT EXISTS anchor_start INTEGER NOT NULL DEFAULT -1;
ALTER TABLE analysis_comments
  ADD COLUMN IF NOT EXISTS anchor_end INTEGER NOT NULL DEFAULT -1;

CREATE TABLE IF NOT EXISTS analysis_revision_suggestions (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES annotation_snapshots(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  author_email TEXT NOT NULL,
  author_name TEXT NOT NULL,
  target_key TEXT NOT NULL,
  target_label TEXT NOT NULL DEFAULT '',
  selected_text TEXT NOT NULL DEFAULT '',
  anchor_start INTEGER NOT NULL DEFAULT 0,
  anchor_end INTEGER NOT NULL DEFAULT 0,
  replacement_text TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',
  decided_by_email TEXT,
  decided_by_name TEXT,
  decided_at TEXT,
  applied_revision INTEGER,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  deleted_at TEXT,
  CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED'))
);

CREATE INDEX IF NOT EXISTS analysis_revision_suggestions_submission_idx
  ON analysis_revision_suggestions(submission_id, created_at);
CREATE INDEX IF NOT EXISTS analysis_revision_suggestions_target_idx
  ON analysis_revision_suggestions(submission_id, target_key);
