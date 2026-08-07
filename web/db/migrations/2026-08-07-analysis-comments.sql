-- Additive migration for version-bound inline comments and admin excellence marks.
-- Safe to run more than once; no existing annotation or review data is rewritten.

CREATE TABLE IF NOT EXISTS analysis_comments (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES annotation_snapshots(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  parent_id TEXT REFERENCES analysis_comments(id),
  author_email TEXT NOT NULL,
  author_name TEXT NOT NULL,
  target_key TEXT NOT NULL,
  target_label TEXT NOT NULL DEFAULT '',
  selected_text TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'COMMENT',
  status TEXT NOT NULL DEFAULT 'OPEN',
  is_excellent INTEGER NOT NULL DEFAULT 0,
  marked_by_email TEXT,
  marked_by_name TEXT,
  marked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  resolved_at TEXT,
  deleted_at TEXT,
  CHECK (kind IN ('COMMENT', 'EXPERT_NOTE')),
  CHECK (status IN ('OPEN', 'RESOLVED'))
);

CREATE INDEX IF NOT EXISTS analysis_comments_submission_idx
  ON analysis_comments(submission_id, created_at);
CREATE INDEX IF NOT EXISTS analysis_comments_parent_idx
  ON analysis_comments(parent_id, created_at);
CREATE INDEX IF NOT EXISTS analysis_comments_target_idx
  ON analysis_comments(submission_id, target_key);
